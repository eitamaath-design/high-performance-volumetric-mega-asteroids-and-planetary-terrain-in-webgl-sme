/**
 * Cross-Engine Deterministic 3D Value & FBM Noise
 *
 * Uses pure 32-bit integer arithmetic (`Math.imul` + XOR-shifts) normalized by
 * exact 2^-32 (`(h >>> 0) / 4294967296.0`) with ZERO transcendental (`Math.sin`)
 * calls so V8, SpiderMonkey, and JavaScriptCore produce bit-identical terrain
 * across all planetary scales (10P / 30P / 50P, 8000u+ coordinates).
 */

export class DeterministicNoise3D {
    constructor(seed = 1337) {
        this.seed = seed | 0;
        this._octCache = [
            { valid: false, X: 0, Y: 0, Z: 0, c000: 0, c100: 0, c010: 0, c110: 0, c001: 0, c101: 0, c011: 0, c111: 0 },
            { valid: false, X: 0, Y: 0, Z: 0, c000: 0, c100: 0, c010: 0, c110: 0, c001: 0, c101: 0, c011: 0, c111: 0 },
            { valid: false, X: 0, Y: 0, Z: 0, c000: 0, c100: 0, c010: 0, c110: 0, c001: 0, c101: 0, c011: 0, c111: 0 },
            { valid: false, X: 0, Y: 0, Z: 0, c000: 0, c100: 0, c010: 0, c110: 0, c001: 0, c101: 0, c011: 0, c111: 0 }
        ];
    }

    /**
     * Pure 32-bit integer avalanche hash in [0, 1).
     * Zero Math.sin / transcendental functions for cross-engine determinism.
     */
    hash(x, y, z) {
        let h = this.seed;
        h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
        h = Math.imul(h ^ (y | 0), 0x165667b1);
        h = Math.imul(h ^ (z | 0), 0x85ebca6b);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        h = Math.imul(h, 0x297a2d39);
        h ^= h >>> 15;
        return (h >>> 0) / 4294967296.0;
    }

    noiseOct(x, y, z, oct) {
        const X = Math.floor(x);
        const Y = Math.floor(y);
        const Z = Math.floor(z);
        const xd = x - X;
        const yd = y - Y;
        const zd = z - Z;
        const u = xd * xd * (3.0 - 2.0 * xd);
        const v = yd * yd * (3.0 - 2.0 * yd);
        const w = zd * zd * (3.0 - 2.0 * zd);

        const cache = this._octCache[oct];
        if (!cache || !cache.valid || cache.X !== X || cache.Y !== Y || cache.Z !== Z) {
            const c000 = this.hash(X, Y, Z);
            const c100 = this.hash(X + 1, Y, Z);
            const c010 = this.hash(X, Y + 1, Z);
            const c110 = this.hash(X + 1, Y + 1, Z);
            const c001 = this.hash(X, Y, Z + 1);
            const c101 = this.hash(X + 1, Y, Z + 1);
            const c011 = this.hash(X, Y + 1, Z + 1);
            const c111 = this.hash(X + 1, Y + 1, Z + 1);
            if (!cache) {
                const x00 = c000 * (1.0 - u) + c100 * u;
                const x10 = c010 * (1.0 - u) + c110 * u;
                const x01 = c001 * (1.0 - u) + c101 * u;
                const x11 = c011 * (1.0 - u) + c111 * u;
                const y0 = x00 * (1.0 - v) + x10 * v;
                const y1 = x01 * (1.0 - v) + x11 * v;
                return y0 * (1.0 - w) + y1 * w;
            }
            cache.valid = true;
            cache.X = X;
            cache.Y = Y;
            cache.Z = Z;
            cache.c000 = c000;
            cache.c100 = c100;
            cache.c010 = c010;
            cache.c110 = c110;
            cache.c001 = c001;
            cache.c101 = c101;
            cache.c011 = c011;
            cache.c111 = c111;
        }

        const x00 = cache.c000 * (1.0 - u) + cache.c100 * u;
        const x10 = cache.c010 * (1.0 - u) + cache.c110 * u;
        const x01 = cache.c001 * (1.0 - u) + cache.c101 * u;
        const x11 = cache.c011 * (1.0 - u) + cache.c111 * u;
        const y0 = x00 * (1.0 - v) + x10 * v;
        const y1 = x01 * (1.0 - v) + x11 * v;
        return y0 * (1.0 - w) + y1 * w;
    }

    noise(x, y, z) {
        return this.noiseOct(x, y, z, 0);
    }

    fbm(x, y, z, octaves = 3) {
        let val = 0.0;
        let amp = 0.5;
        let freq = 1.0;
        for (let i = 0; i < octaves; i++) {
            val += this.noiseOct(x * freq, y * freq, z * freq, i) * amp;
            freq *= 2.0;
            amp *= 0.5;
        }
        return val;
    }
}

export { DeterministicNoise3D as FastNoise3D };
