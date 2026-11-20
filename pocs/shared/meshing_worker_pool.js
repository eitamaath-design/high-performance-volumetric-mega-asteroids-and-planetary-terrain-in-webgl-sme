/**
 * Reusable Bounded ESM Web Worker Pool for Asynchronous Voxel Meshing
 *
 * Features:
 * - Bounded worker pool size (2..4 workers derived from navigator.hardwareConcurrency)
 * - Explicit FIFO jobQueue + per-worker inFlight Map with maxInFlightPerWorker backpressure
 * - Monotonic world epoch cancellation (setEpoch) cancelling stale queued jobs pre-dispatch
 *   and dropping stale late worker responses
 * - Automated worker crash recovery (onerror / onmessageerror) with immediate terminate()
 *   and transparent respawn, transferable-safe payload reconstruction, and bounded maxRetries
 */

function cloneValueWithBufferMap(value, bufferMap, seen) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return bufferMap.has(value) ? bufferMap.get(value) : value;
    }
    if (ArrayBuffer.isView(value)) {
        const mappedBuf = bufferMap.get(value.buffer);
        if (!mappedBuf) {
            return value;
        }
        if (value instanceof DataView) {
            return new DataView(mappedBuf, value.byteOffset, value.byteLength);
        }
        const TypedArrayCtor = value.constructor;
        return new TypedArrayCtor(mappedBuf, value.byteOffset, value.length);
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const arr = new Array(value.length);
        seen.set(value, arr);
        for (let i = 0; i < value.length; i++) {
            arr[i] = cloneValueWithBufferMap(value[i], bufferMap, seen);
        }
        return arr;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        const obj = proto === null ? Object.create(null) : {};
        seen.set(value, obj);
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            obj[k] = cloneValueWithBufferMap(value[k], bufferMap, seen);
        }
        return obj;
    }
    return value;
}

function createTransferableBackup(payload, transferables) {
    const bufferMap = new Map();
    for (let i = 0; i < transferables.length; i++) {
        const tb = transferables[i];
        if (tb instanceof ArrayBuffer && !bufferMap.has(tb)) {
            bufferMap.set(tb, tb.slice(0));
        }
    }
    const payloadTemplate = cloneValueWithBufferMap(payload, bufferMap, new Map());
    return {
        payloadTemplate,
        backupBuffers: Array.from(bufferMap.values())
    };
}

function rebuildFromTransferableBackup(backup) {
    const retryBufferMap = new Map();
    for (let i = 0; i < backup.backupBuffers.length; i++) {
        const buf = backup.backupBuffers[i];
        retryBufferMap.set(buf, buf.slice(0));
    }
    const payload = cloneValueWithBufferMap(backup.payloadTemplate, retryBufferMap, new Map());
    return {
        payload,
        transferables: Array.from(retryBufferMap.values())
    };
}

export class MeshingWorkerPool {
    /**
     * @param {string} workerUrl - URL of the Web Worker script
     * @param {object} [options]
     * @param {number} [options.poolSize] - Requested pool size, clamped to [2, 4]
     * @param {number} [options.maxRetries=2] - Max retry attempts per job after worker errors
     * @param {number} [options.maxInFlightPerWorker=1] - Concurrent in-flight jobs per worker slot
     * @param {WorkerOptions} [options.workerOptions] - Options forwarded to `new Worker(...)`
     * @param {Function} [options.onCrash] - Optional crash hook receiving diagnostic metadata
     */
    constructor(workerUrl, options = {}) {
        const hc = (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency))
            ? navigator.hardwareConcurrency
            : 3;
        const requested = options.poolSize !== undefined ? Number(options.poolSize) : hc;
        this.poolSize = Math.max(2, Math.min(4, Math.floor(Number.isFinite(requested) ? requested : 3)));

        const reqRetries = options.maxRetries !== undefined ? Number(options.maxRetries) : 2;
        this.maxRetries = Math.max(0, Math.floor(Number.isFinite(reqRetries) ? reqRetries : 2));

        const reqInFlight = options.maxInFlightPerWorker !== undefined ? Number(options.maxInFlightPerWorker) : 1;
        this.maxInFlightPerWorker = Math.max(1, Math.floor(Number.isFinite(reqInFlight) ? reqInFlight : 1));

        this.workerUrl = workerUrl;
        this.workerOptions = options.workerOptions || undefined;
        this.onCrash = typeof options.onCrash === 'function' ? options.onCrash : null;

        this.currentEpoch = 0;
        this.nextRequestId = 1;
        this.jobQueue = [];
        this.workers = [];
        this._disposed = false;

        this.respawnCount = 0;
        this.cancelledCount = 0;
        this.completedCount = 0;
        this.failedCount = 0;

        for (let i = 0; i < this.poolSize; i++) {
            const slot = { id: i, worker: null, inFlight: new Map(), alive: false };
            this.workers.push(slot);
            this._spawnWorker(slot);
        }
    }

    get queueLength() {
        return this.jobQueue.length;
    }

    get inFlightCount() {
        let count = 0;
        for (let i = 0; i < this.workers.length; i++) {
            count += this.workers[i].inFlight.size;
        }
        return count;
    }

    getStats() {
        let aliveWorkers = 0;
        for (let i = 0; i < this.workers.length; i++) {
            if (this.workers[i].alive) aliveWorkers++;
        }
        return {
            poolSize: this.poolSize,
            aliveWorkers,
            maxRetries: this.maxRetries,
            maxInFlightPerWorker: this.maxInFlightPerWorker,
            currentEpoch: this.currentEpoch,
            queueLength: this.queueLength,
            inFlightCount: this.inFlightCount,
            respawnCount: this.respawnCount,
            cancelledCount: this.cancelledCount,
            completedCount: this.completedCount,
            failedCount: this.failedCount,
            disposed: this._disposed
        };
    }

    /**
     * Advance the active world epoch monotonically and immediately cancel any queued
     * stale-epoch jobs prior to worker dispatch.
     */
    setEpoch(epoch) {
        if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= this.currentEpoch) {
            return;
        }
        this.currentEpoch = epoch;
        if (this.jobQueue.length === 0) return;

        const retained = [];
        for (let i = 0; i < this.jobQueue.length; i++) {
            const entry = this.jobQueue[i];
            if (entry.job.epoch < this.currentEpoch) {
                if (!entry.settled) {
                    entry.settled = true;
                    entry.transferableBackup = null;
                    this.cancelledCount++;
                    entry.resolve({
                        cancelled: true,
                        requestId: entry.requestId,
                        epoch: entry.job.epoch
                    });
                }
            } else {
                retained.push(entry);
            }
        }
        this.jobQueue = retained;
    }

    /**
     * Enqueue a meshing job for asynchronous worker execution.
     */
    enqueue(job = {}) {
        if (this._disposed) {
            return Promise.reject(new Error('MeshingWorkerPool has been disposed'));
        }
        const jobEpoch = (job && job.epoch !== undefined) ? job.epoch : this.currentEpoch;
        if (jobEpoch < this.currentEpoch) {
            this.cancelledCount++;
            return Promise.resolve({
                cancelled: true,
                requestId: 0,
                epoch: jobEpoch
            });
        }

        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const entry = {
                requestId,
                job: { ...job, epoch: jobEpoch },
                resolve,
                reject,
                retries: 0,
                settled: false,
                transferableBackup: null
            };
            this.jobQueue.push(entry);
            this._pumpQueue();
        });
    }

    _spawnWorker(slot) {
        if (this._disposed) return;
        const worker = new Worker(this.workerUrl, this.workerOptions);
        slot.worker = worker;
        slot.alive = true;

        worker.onmessage = (e) => {
            if (slot.worker !== worker) return;
            const data = e.data;
            if (!data || data.requestId === undefined) return;

            const entry = slot.inFlight.get(data.requestId);
            if (!entry) return;
            slot.inFlight.delete(data.requestId);

            if (!entry.settled) {
                if (entry.job.epoch < this.currentEpoch) {
                    entry.settled = true;
                    entry.transferableBackup = null;
                    this.cancelledCount++;
                    entry.resolve({
                        cancelled: true,
                        requestId: entry.requestId,
                        epoch: entry.job.epoch
                    });
                } else if (data.success === false) {
                    this._handleFailedEntry(entry, new Error(data.error || 'Worker job reported failure'));
                } else {
                    entry.settled = true;
                    entry.transferableBackup = null;
                    this.completedCount++;
                    entry.resolve(data);
                }
            }

            this._pumpQueue();
        };

        worker.onerror = (err) => this._handleWorkerCrash(slot, worker, err, 'error');
        worker.onmessageerror = (err) => this._handleWorkerCrash(slot, worker, err, 'messageerror');
    }

    _handleWorkerCrash(slot, workerInstance, event, kind = 'error') {
        if (slot.worker !== workerInstance || !slot.alive) return;
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        slot.alive = false;
        slot.worker = null;
        try {
            workerInstance.terminate();
        } catch (_) {}

        const affected = Array.from(slot.inFlight.values());
        slot.inFlight.clear();

        const errMsg = (event && event.message)
            ? event.message
            : `Worker ${kind} on slot ${slot.id}`;
        console.warn(`[MeshingWorkerPool] Worker slot ${slot.id} failed (${kind}): ${errMsg}. Respawning...`);

        if (!this._disposed) {
            this.respawnCount++;
            this._spawnWorker(slot);
        }

        if (this.onCrash) {
            try {
                this.onCrash({
                    slotId: slot.id,
                    kind,
                    message: errMsg,
                    affectedCount: affected.length,
                    respawnCount: this.respawnCount
                });
            } catch (_) {}
        }

        // Re-queue in reverse order so unshifted jobs keep original FIFO priority
        for (let i = affected.length - 1; i >= 0; i--) {
            this._handleFailedEntry(affected[i], new Error(errMsg));
        }

        this._pumpQueue();
    }

    _handleFailedEntry(entry, err) {
        if (entry.settled) return;

        if (entry.job.epoch < this.currentEpoch) {
            entry.settled = true;
            entry.transferableBackup = null;
            this.cancelledCount++;
            entry.resolve({
                cancelled: true,
                requestId: entry.requestId,
                epoch: entry.job.epoch
            });
            return;
        }

        if (!this._disposed && entry.retries < this.maxRetries) {
            entry.retries++;
            entry.requestId = this.nextRequestId++;
            this.jobQueue.unshift(entry);
            return;
        }

        entry.settled = true;
        entry.transferableBackup = null;
        this.failedCount++;
        entry.reject(err instanceof Error ? err : new Error(String(err || 'Worker job failed')));
    }

    _pumpQueue() {
        if (this._disposed || this.jobQueue.length === 0) return;

        while (this.jobQueue.length > 0) {
            const head = this.jobQueue[0];
            if (head.settled) {
                this.jobQueue.shift();
                continue;
            }
            if (head.job.epoch < this.currentEpoch) {
                this.jobQueue.shift();
                head.settled = true;
                head.transferableBackup = null;
                this.cancelledCount++;
                head.resolve({
                    cancelled: true,
                    requestId: head.requestId,
                    epoch: head.job.epoch
                });
                continue;
            }

            let bestSlot = null;
            let bestLoad = Infinity;
            for (let i = 0; i < this.workers.length; i++) {
                const slot = this.workers[i];
                if (!slot.alive || !slot.worker) continue;
                const load = slot.inFlight.size;
                if (load < this.maxInFlightPerWorker && load < bestLoad) {
                    bestLoad = load;
                    bestSlot = slot;
                    if (load === 0) break;
                }
            }

            if (!bestSlot) break;

            const entry = this.jobQueue.shift();
            this._dispatchToSlot(bestSlot, entry);
        }
    }

    _extractPayloadAndTransferables(built) {
        if (built && typeof built === 'object' && built.payload !== undefined) {
            return {
                rawPayload: built.payload || {},
                transferables: Array.isArray(built.transferables) ? built.transferables : []
            };
        }
        return {
            rawPayload: built || {},
            transferables: []
        };
    }

    _dispatchToSlot(slot, entry) {
        if (entry.settled) return;

        if (entry.job.epoch < this.currentEpoch) {
            entry.settled = true;
            entry.transferableBackup = null;
            this.cancelledCount++;
            entry.resolve({
                cancelled: true,
                requestId: entry.requestId,
                epoch: entry.job.epoch
            });
            return;
        }

        try {
            let rawPayload;
            let transferables;

            if (typeof entry.job.buildPayload === 'function') {
                const built = entry.job.buildPayload(entry.retries, entry.job);
                ({ rawPayload, transferables } = this._extractPayloadAndTransferables(built));
            } else if (entry.retries > 0 && typeof entry.job.onRetryBuildPayload === 'function') {
                const built = entry.job.onRetryBuildPayload(entry.retries, entry.job);
                ({ rawPayload, transferables } = this._extractPayloadAndTransferables(built));
            } else if (entry.retries === 0) {
                rawPayload = entry.job.payload || {};
                transferables = Array.isArray(entry.job.transferables) ? entry.job.transferables : [];
                if (transferables.length > 0 && this.maxRetries > 0) {
                    entry.transferableBackup = createTransferableBackup(rawPayload, transferables);
                }
            } else if (entry.transferableBackup) {
                const rebuilt = rebuildFromTransferableBackup(entry.transferableBackup);
                rawPayload = rebuilt.payload;
                transferables = rebuilt.transferables;
            } else {
                rawPayload = entry.job.payload || {};
                transferables = [];
            }

            const payload = { ...rawPayload, requestId: entry.requestId };
            slot.inFlight.set(entry.requestId, entry);
            slot.worker.postMessage(payload, transferables || []);
        } catch (err) {
            slot.inFlight.delete(entry.requestId);
            this._handleFailedEntry(entry, err);
            this._pumpQueue();
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;

        const queued = this.jobQueue.splice(0, this.jobQueue.length);
        for (let i = 0; i < queued.length; i++) {
            const entry = queued[i];
            if (!entry.settled) {
                entry.settled = true;
                entry.transferableBackup = null;
                entry.reject(new Error('MeshingWorkerPool disposed'));
            }
        }

        for (let i = 0; i < this.workers.length; i++) {
            const slot = this.workers[i];
            slot.alive = false;
            const worker = slot.worker;
            slot.worker = null;
            if (worker) {
                try {
                    worker.terminate();
                } catch (_) {}
            }
            const inFlight = Array.from(slot.inFlight.values());
            slot.inFlight.clear();
            for (let j = 0; j < inFlight.length; j++) {
                const entry = inFlight[j];
                if (!entry.settled) {
                    entry.settled = true;
                    entry.transferableBackup = null;
                    entry.reject(new Error('MeshingWorkerPool disposed'));
                }
            }
        }
    }

    terminate() {
        this.dispose();
    }
}
