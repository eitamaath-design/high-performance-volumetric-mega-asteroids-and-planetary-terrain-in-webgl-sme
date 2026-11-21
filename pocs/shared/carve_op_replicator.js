/**
 * 28-Byte Binary CarveOp Codec & Deterministic Multiplayer Replicator
 *
 * Exact 28-byte little-endian DataView layout:
 *   0..3  : uint32  simTick
 *   4..5  : uint16  playerId
 *   6     : uint8   opType     (0 = carve, 1 = reinforce, 2 = breach)
 *   7     : uint8   materialId (0 = void, 1 = rock, 2 = ore, 3 = armor)
 *   8..11 : float32 x
 *   12..15: float32 y
 *   16..19: float32 z
 *   20..23: float32 radius
 *   24..27: uint32  seqId
 */

export const CARVE_OP_BYTE_LENGTH = 28;

export const CARVE_OP_TYPE = Object.freeze({
    carve: 0,
    reinforce: 1,
    breach: 2
});

export const CARVE_OP_TYPE_NAME = Object.freeze(['carve', 'reinforce', 'breach']);

function normalizeOpType(opType) {
    if (typeof opType === 'number') {
        if (opType === 1) return 1;
        if (opType === 2) return 2;
        return 0;
    }
    if (opType === 'reinforce') return 1;
    if (opType === 'breach') return 2;
    return 0;
}

function toDataView(bufferOrView, byteOffset = 0, requiredBytes = CARVE_OP_BYTE_LENGTH) {
    if (bufferOrView instanceof ArrayBuffer) {
        if (byteOffset < 0 || byteOffset + requiredBytes > bufferOrView.byteLength) {
            throw new RangeError(`Buffer too small: need ${requiredBytes} bytes at offset ${byteOffset}, got ${bufferOrView.byteLength}`);
        }
        return new DataView(bufferOrView, byteOffset, requiredBytes);
    }
    if (ArrayBuffer.isView(bufferOrView)) {
        const totalOffset = bufferOrView.byteOffset + byteOffset;
        if (byteOffset < 0 || byteOffset + requiredBytes > bufferOrView.byteLength) {
            throw new RangeError(`BufferView too small: need ${requiredBytes} bytes at offset ${byteOffset}, got ${bufferOrView.byteLength}`);
        }
        return new DataView(bufferOrView.buffer, totalOffset, requiredBytes);
    }
    throw new TypeError('Expected ArrayBuffer or ArrayBufferView');
}

/**
 * Encode a single CarveOp into an exact 28-byte little-endian binary record.
 * Returns the target ArrayBuffer (or ArrayBufferView if supplied).
 */
export function encodeCarveOp(op, buffer = new ArrayBuffer(CARVE_OP_BYTE_LENGTH), byteOffset = 0) {
    const view = toDataView(buffer, byteOffset, CARVE_OP_BYTE_LENGTH);
    const opTypeCode = normalizeOpType(op.opType);
    const defaultMat = opTypeCode === 1 ? 3 : 0;

    view.setUint32(0, (op.simTick >>> 0), true);
    view.setUint16(4, (op.playerId & 0xffff), true);
    view.setUint8(6, opTypeCode & 0xff);
    view.setUint8(7, ((op.materialId !== undefined ? op.materialId : defaultMat) & 0xff));
    view.setFloat32(8, Number(op.x) || 0, true);
    view.setFloat32(12, Number(op.y) || 0, true);
    view.setFloat32(16, Number(op.z) || 0, true);
    view.setFloat32(20, Number(op.radius) || 0, true);
    view.setUint32(24, (op.seqId >>> 0), true);

    return buffer;
}

/**
 * Decode a single 28-byte little-endian CarveOp record.
 */
export function decodeCarveOp(buffer, byteOffset = 0) {
    const view = toDataView(buffer, byteOffset, CARVE_OP_BYTE_LENGTH);
    const opType = view.getUint8(6);
    return {
        simTick: view.getUint32(0, true),
        playerId: view.getUint16(4, true),
        opType,
        opName: CARVE_OP_TYPE_NAME[opType] || 'carve',
        materialId: view.getUint8(7),
        x: view.getFloat32(8, true),
        y: view.getFloat32(12, true),
        z: view.getFloat32(16, true),
        radius: view.getFloat32(20, true),
        seqId: view.getUint32(24, true)
    };
}

/**
 * Encode an array of CarveOps into a contiguous ArrayBuffer (ops.length * 28 bytes).
 */
export function encodeCarveOpBatch(ops) {
    const count = Array.isArray(ops) ? ops.length : 0;
    const buffer = new ArrayBuffer(count * CARVE_OP_BYTE_LENGTH);
    for (let i = 0; i < count; i++) {
        encodeCarveOp(ops[i], buffer, i * CARVE_OP_BYTE_LENGTH);
    }
    return buffer;
}

/**
 * Decode a contiguous binary batch buffer into an array of CarveOp objects.
 */
export function decodeCarveOpBatch(buffer) {
    const byteLength = buffer instanceof ArrayBuffer
        ? buffer.byteLength
        : (ArrayBuffer.isView(buffer) ? buffer.byteLength : -1);
    if (byteLength < 0) {
        throw new TypeError('Expected ArrayBuffer or ArrayBufferView');
    }
    if (byteLength % CARVE_OP_BYTE_LENGTH !== 0) {
        throw new RangeError(`CarveOp batch byteLength (${byteLength}) is not a multiple of ${CARVE_OP_BYTE_LENGTH}`);
    }
    const count = byteLength / CARVE_OP_BYTE_LENGTH;
    const ops = new Array(count);
    for (let i = 0; i < count; i++) {
        ops[i] = decodeCarveOp(buffer, i * CARVE_OP_BYTE_LENGTH);
    }
    return ops;
}

/**
 * Canonical deterministic comparator: (simTick, playerId, seqId) ascending.
 * Ensures all peers converge on the exact same CSG ordering regardless of
 * P2P packet arrival jitter.
 */
export function compareCarveOps(a, b) {
    const tickDiff = (a.simTick >>> 0) - (b.simTick >>> 0);
    if (tickDiff !== 0) return tickDiff;
    const playerDiff = (a.playerId & 0xffff) - (b.playerId & 0xffff);
    if (playerDiff !== 0) return playerDiff;
    return (a.seqId >>> 0) - (b.seqId >>> 0);
}

/**
 * Deterministic 32-bit PRNG (Mulberry32, pure Math.imul).
 */
function createDeterministicRng(seed = 2026) {
    let state = seed | 0;
    return function nextFloat() {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
    };
}

/**
 * Generate a realistic, 100% deterministic multi-pilot simultaneous carve/reinforce/breach
 * workload around the asteroid surface for stress testing and late-join verification.
 */
export function generateMultiplayerStressOps({
    pilotCount = 30,
    radius = 4800,
    ticks = 10,
    seed = 2026
} = {}) {
    const rng = createDeterministicRng(seed);
    const ops = [];
    const goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));

    // Distribute pilots across the asteroid surface on a Fibonacci sphere with deterministic jitter
    const pilots = [];
    for (let p = 0; p < pilotCount; p++) {
        const y = 1.0 - (2.0 * (p + 0.5)) / Math.max(1, pilotCount);
        const rHoriz = Math.sqrt(Math.max(0.0, 1.0 - y * y));
        const theta = goldenAngle * p + (rng() - 0.5) * 0.12;
        const nx = Math.cos(theta) * rHoriz;
        const nz = Math.sin(theta) * rHoriz;
        const ny = y;
        const baseBrush = 95.0 + rng() * 50.0;
        pilots.push({
            playerId: p + 1,
            nx,
            ny,
            nz,
            baseBrush,
            radialDepth: 0.99
        });
    }

    for (let tick = 1; tick <= ticks; tick++) {
        for (let p = 0; p < pilotCount; p++) {
            const pilot = pilots[p];
            // Advance slightly inward each tick to simulate continuous mining tunnel + reinforcement + breach
            const radial = radius * pilot.radialDepth;
            pilot.radialDepth = Math.max(0.84, pilot.radialDepth - 0.014);

            const jitter = radius * 0.008;
            const x = pilot.nx * radial + (rng() - 0.5) * jitter;
            const y = pilot.ny * radial + (rng() - 0.5) * jitter;
            const z = pilot.nz * radial + (rng() - 0.5) * jitter;

            let opType = CARVE_OP_TYPE.carve;
            let materialId = 0;
            if (tick % 4 === 0 && p % 3 === 0) {
                opType = CARVE_OP_TYPE.reinforce;
                materialId = 3;
            } else if (tick % 5 === 0 && p % 5 === 0) {
                opType = CARVE_OP_TYPE.breach;
                materialId = 0;
            }

            // Round-trip through 28-byte binary codec to guarantee exact float32 wire parity
            const raw = {
                simTick: tick,
                playerId: pilot.playerId,
                opType,
                materialId,
                x,
                y,
                z,
                radius: pilot.baseBrush,
                seqId: tick
            };
            const packet = encodeCarveOp(raw);
            ops.push(decodeCarveOp(packet));
        }
    }

    ops.sort(compareCarveOps);
    return ops;
}

/**
 * Tracks local CarveOps, serializes/deserializes compact 28-byte late-join snapshots,
 * and deterministically replays out-of-order network packets into an applyOp callback.
 */
export class CarveOpReplicator {
    constructor({ localPlayerId = 1 } = {}) {
        this.localPlayerId = localPlayerId & 0xffff;
        this.nextSeqId = 1;
        this.log = [];
        this._appliedKeys = new Set();
        this.totalBytesEncoded = 0;
        this.totalOpsReplayed = 0;
    }

    _opKey(op) {
        return `${op.simTick >>> 0}:${op.playerId & 0xffff}:${op.seqId >>> 0}`;
    }

    recordLocalOp({
        simTick = 1,
        opType = CARVE_OP_TYPE.carve,
        materialId,
        x,
        y,
        z,
        radius,
        playerId = this.localPlayerId,
        seqId = null
    }) {
        const assignedSeq = seqId !== null && seqId !== undefined ? (seqId >>> 0) : (this.nextSeqId++ >>> 0);
        const opTypeCode = normalizeOpType(opType);
        const resolvedMat = materialId !== undefined ? materialId : (opTypeCode === 1 ? 3 : 0);

        const packet = encodeCarveOp({
            simTick,
            playerId,
            opType: opTypeCode,
            materialId: resolvedMat,
            x,
            y,
            z,
            radius,
            seqId: assignedSeq
        });
        const canonicalOp = decodeCarveOp(packet);
        const key = this._opKey(canonicalOp);
        this._appliedKeys.add(key);
        this.log.push(canonicalOp);
        this.totalBytesEncoded += CARVE_OP_BYTE_LENGTH;
        return { op: canonicalOp, packet };
    }

    /**
     * Serialize all recorded operations in canonical (simTick, playerId, seqId) order
     * for late-joining peers.
     */
    serializeSnapshot() {
        const sorted = [...this.log].sort(compareCarveOps);
        return encodeCarveOpBatch(sorted);
    }

    exportSnapshot() {
        return this.serializeSnapshot();
    }

    /**
     * Deserialize a binary late-join snapshot into canonically ordered CarveOps.
     */
    deserializeSnapshot(buffer) {
        const ops = decodeCarveOpBatch(buffer);
        ops.sort(compareCarveOps);
        return ops;
    }

    importSnapshot(buffer) {
        return this.deserializeSnapshot(buffer);
    }

    /**
     * Deterministically replay out-of-order CarveOps (array or binary ArrayBuffer/View)
     * in strict canonical (simTick, playerId, seqId) order.
     */
    async replayOps(opsOrBuffer, applyOp, { deduplicate = true, recordToLog = true } = {}) {
        const decoded = (opsOrBuffer instanceof ArrayBuffer || ArrayBuffer.isView(opsOrBuffer))
            ? decodeCarveOpBatch(opsOrBuffer)
            : (Array.isArray(opsOrBuffer) ? opsOrBuffer.map(op => decodeCarveOp(encodeCarveOp(op))) : []);

        decoded.sort(compareCarveOps);

        const appliedOps = [];
        for (let i = 0; i < decoded.length; i++) {
            const op = decoded[i];
            const key = this._opKey(op);
            if (deduplicate && this._appliedKeys.has(key)) {
                continue;
            }
            if (typeof applyOp === 'function') {
                await applyOp(op, i);
            }
            this._appliedKeys.add(key);
            if (recordToLog) {
                this.log.push(op);
            }
            this.totalOpsReplayed++;
            appliedOps.push(op);
        }

        return {
            appliedCount: appliedOps.length,
            totalBytes: appliedOps.length * CARVE_OP_BYTE_LENGTH,
            ops: appliedOps
        };
    }

    clear() {
        this.log.length = 0;
        this._appliedKeys.clear();
        this.nextSeqId = 1;
        this.totalBytesEncoded = 0;
        this.totalOpsReplayed = 0;
    }

    getStats() {
        return {
            localPlayerId: this.localPlayerId,
            recordedOps: this.log.length,
            totalBytesEncoded: this.totalBytesEncoded,
            snapshotBytes: this.log.length * CARVE_OP_BYTE_LENGTH,
            totalOpsReplayed: this.totalOpsReplayed
        };
    }
}
