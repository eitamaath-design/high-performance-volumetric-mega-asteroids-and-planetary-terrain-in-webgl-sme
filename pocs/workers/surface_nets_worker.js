/**
 * Unified Isosurface Extraction Web Worker
 * Supports:
 *  - mode: 'surface_nets' (default): Dual-Grid Surface Nets with configurable 1- or 2-voxel halo,
 *    LOD boundary sealing (extendPosX/Y/Z), and optional carveField exterior-crust culling (PoC 1 & PoC 3).
 *  - mode: 'dual_contour': Adaptive QEF Dual Contouring with 3-iteration scalar Gauss-Seidel
 *    regularized gradient descent and LOD boundary sealing (PoC 2).
 *
 * Uses reusable growable scratch TypedArrays to eliminate per-chunk GC churn,
 * returning exact-sized sliced copies as zero-copy Transferable ArrayBuffers.
 */

const _cornerX = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]);
const _cornerY = new Uint8Array([0, 0, 1, 1, 0, 0, 1, 1]);
const _cornerZ = new Uint8Array([0, 0, 0, 0, 1, 1, 1, 1]);
const _edgeC1 = new Uint8Array([0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3]);
const _edgeC2 = new Uint8Array([1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7]);

const _cVals = new Float32Array(8);
const _cornerIdx = new Int32Array(8);
const _edgePts = new Float32Array(36);
const _edgeNorms = new Float32Array(36);

let _cellVertMap = new Int32Array(36 * 36 * 36);
let _verts = new Float32Array(16384 * 3);
let _norms = new Float32Array(16384 * 3);
let _cols = new Float32Array(16384 * 3);
let _matWeights = new Float32Array(16384 * 3);
let _mats = new Uint8Array(16384);
let _extFlags = new Uint8Array(16384);
let _indices = new Uint32Array(65536 * 3);
const _triGradOut = new Float32Array(3);

function sampleTrilinearGradient(voxelData, pRes, pRes2, fx, fy, fz, out) {
    const maxC = pRes - 2;
    const maxI0 = pRes - 3;
    const cx = fx < 1.0 ? 1.0 : (fx > maxC ? maxC : fx);
    const cy = fy < 1.0 ? 1.0 : (fy > maxC ? maxC : fy);
    const cz = fz < 1.0 ? 1.0 : (fz > maxC ? maxC : fz);

    let x0 = Math.floor(cx);
    if (x0 > maxI0) x0 = maxI0;
    let y0 = Math.floor(cy);
    if (y0 > maxI0) y0 = maxI0;
    let z0 = Math.floor(cz);
    if (z0 > maxI0) z0 = maxI0;

    const tx = cx - x0;
    const ty = cy - y0;
    const tz = cz - z0;
    const omx = 1.0 - tx;
    const omy = 1.0 - ty;
    const omz = 1.0 - tz;

    const base = x0 + y0 * pRes + z0 * pRes2;
    const i000 = base;
    const i100 = base + 1;
    const i010 = base + pRes;
    const i110 = base + pRes + 1;
    const i001 = base + pRes2;
    const i101 = base + pRes2 + 1;
    const i011 = base + pRes2 + pRes;
    const i111 = base + pRes2 + pRes + 1;

    const gx00 = (voxelData[i000 + 1] - voxelData[i000 - 1]) * omx + (voxelData[i100 + 1] - voxelData[i100 - 1]) * tx;
    const gx10 = (voxelData[i010 + 1] - voxelData[i010 - 1]) * omx + (voxelData[i110 + 1] - voxelData[i110 - 1]) * tx;
    const gx01 = (voxelData[i001 + 1] - voxelData[i001 - 1]) * omx + (voxelData[i101 + 1] - voxelData[i101 - 1]) * tx;
    const gx11 = (voxelData[i011 + 1] - voxelData[i011 - 1]) * omx + (voxelData[i111 + 1] - voxelData[i111 - 1]) * tx;
    const gx = (gx00 * omy + gx10 * ty) * omz + (gx01 * omy + gx11 * ty) * tz;

    const gy00 = (voxelData[i000 + pRes] - voxelData[i000 - pRes]) * omx + (voxelData[i100 + pRes] - voxelData[i100 - pRes]) * tx;
    const gy10 = (voxelData[i010 + pRes] - voxelData[i010 - pRes]) * omx + (voxelData[i110 + pRes] - voxelData[i110 - pRes]) * tx;
    const gy01 = (voxelData[i001 + pRes] - voxelData[i001 - pRes]) * omx + (voxelData[i101 + pRes] - voxelData[i101 - pRes]) * tx;
    const gy11 = (voxelData[i011 + pRes] - voxelData[i011 - pRes]) * omx + (voxelData[i111 + pRes] - voxelData[i111 - pRes]) * tx;
    const gy = (gy00 * omy + gy10 * ty) * omz + (gy01 * omy + gy11 * ty) * tz;

    const gz00 = (voxelData[i000 + pRes2] - voxelData[i000 - pRes2]) * omx + (voxelData[i100 + pRes2] - voxelData[i100 - pRes2]) * tx;
    const gz10 = (voxelData[i010 + pRes2] - voxelData[i010 - pRes2]) * omx + (voxelData[i110 + pRes2] - voxelData[i110 - pRes2]) * tx;
    const gz01 = (voxelData[i001 + pRes2] - voxelData[i001 - pRes2]) * omx + (voxelData[i101 + pRes2] - voxelData[i101 - pRes2]) * tx;
    const gz11 = (voxelData[i011 + pRes2] - voxelData[i011 - pRes2]) * omx + (voxelData[i111 + pRes2] - voxelData[i111 - pRes2]) * tx;
    const gz = (gz00 * omy + gz10 * ty) * omz + (gz01 * omy + gz11 * ty) * tz;

    const lenSq = gx * gx + gy * gy + gz * gz;
    if (lenSq > 1e-12) {
        const invLen = 1.0 / Math.sqrt(lenSq);
        out[0] = gx * invLen;
        out[1] = gy * invLen;
        out[2] = gz * invLen;
    } else {
        out[0] = 0.0;
        out[1] = 1.0;
        out[2] = 0.0;
    }
}

function ensureCellMapCapacity(totalCells) {
    if (totalCells > _cellVertMap.length) {
        _cellVertMap = new Int32Array(totalCells);
    }
    const view = _cellVertMap.subarray(0, totalCells);
    view.fill(-1);
    return view;
}

function ensureVertexCapacity(vCount) {
    if (vCount * 3 > _verts.length) {
        const nextVerts = Math.max(_verts.length * 2, vCount * 3);
        const nv = new Float32Array(nextVerts); nv.set(_verts); _verts = nv;
        const nn = new Float32Array(nextVerts); nn.set(_norms); _norms = nn;
        const nc = new Float32Array(nextVerts); nc.set(_cols); _cols = nc;
        const nw = new Float32Array(nextVerts); nw.set(_matWeights); _matWeights = nw;
        const nextCount = nextVerts / 3;
        const nm = new Uint8Array(nextCount); nm.set(_mats); _mats = nm;
        const nf = new Uint8Array(nextCount); nf.set(_extFlags); _extFlags = nf;
    }
}

function pushTriAligned(i0, i1, i2, iCount, cullExterior) {
    if (cullExterior && _extFlags[i0] && _extFlags[i1] && _extFlags[i2]) {
        return iCount;
    }
    const o0 = i0 * 3, o1 = i1 * 3, o2 = i2 * 3;
    const ax = _verts[o0], ay = _verts[o0 + 1], az = _verts[o0 + 2];
    const bx = _verts[o1], by = _verts[o1 + 1], bz = _verts[o1 + 2];
    const cx = _verts[o2], cy = _verts[o2 + 1], cz = _verts[o2 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    const nx = _norms[o0], ny = _norms[o0 + 1], nz = _norms[o0 + 2];

    if (iCount + 3 > _indices.length) {
        const ni = new Uint32Array(_indices.length * 2);
        ni.set(_indices);
        _indices = ni;
    }
    _indices[iCount] = i0;
    if (gx * nx + gy * ny + gz * nz >= 0.0) {
        _indices[iCount + 1] = i1;
        _indices[iCount + 2] = i2;
    } else {
        _indices[iCount + 1] = i2;
        _indices[iCount + 2] = i1;
    }
    return iCount + 3;
}

function runSurfaceNets(data) {
    const {
        res,
        voxelData,
        materialData,
        carveField = null,
        minBounds,
        cellSize,
        halo = 2,
        extendPosX = false,
        extendPosY = false,
        extendPosZ = false
    } = data;

    const pRes = res + 2 * halo + 1;
    const pRes2 = pRes * pRes;
    const cellCount = res + 2 * halo;
    const cellCount2 = cellCount * cellCount;
    const cellVertMap = ensureCellMapCapacity(cellCount * cellCount * cellCount);

    const cellStart = halo === 1 ? 0 : 1;
    const endX = halo === 1 ? (res + 1) : (extendPosX ? res + 2 : res + 1);
    const endY = halo === 1 ? (res + 1) : (extendPosY ? res + 2 : res + 1);
    const endZ = halo === 1 ? (res + 1) : (extendPosZ ? res + 2 : res + 1);
    const quadStart = halo === 1 ? 1 : 2;
    const quadEndX = halo === 1 ? res : endX;
    const quadEndY = halo === 1 ? res : endY;
    const quadEndZ = halo === 1 ? res : endZ;

    const minX = minBounds[0];
    const minY = minBounds[1];
    const minZ = minBounds[2];
    const hasCarveField = Boolean(carveField && carveField.length >= voxelData.length);
    const extThresh = -cellSize * 0.85;

    let vCount = 0;
    let iCount = 0;
    let minCX = endX, maxCX = cellStart;
    let minCY = endY, maxCY = cellStart;
    let minCZ = endZ, maxCZ = cellStart;

    // Step 1: Dual vertex generation per sign-changing cell
    for (let cz = cellStart; cz <= endZ; cz++) {
        const zBase = cz * pRes2;
        for (let cy = cellStart; cy <= endY; cy++) {
            const yzBase = zBase + cy * pRes;
            for (let cx = cellStart; cx <= endX; cx++) {
                const i0 = yzBase + cx;
                const v0 = voxelData[i0];
                const v1 = voxelData[i0 + 1];
                const v2 = voxelData[i0 + pRes];
                const v3 = voxelData[i0 + pRes + 1];
                const i4 = i0 + pRes2;
                const v4 = voxelData[i4];
                const v5 = voxelData[i4 + 1];
                const v6 = voxelData[i4 + pRes];
                const v7 = voxelData[i4 + pRes + 1];

                const neg0 = v0 < 0.0, neg1 = v1 < 0.0, neg2 = v2 < 0.0, neg3 = v3 < 0.0;
                const neg4 = v4 < 0.0, neg5 = v5 < 0.0, neg6 = v6 < 0.0, neg7 = v7 < 0.0;
                if (
                    neg0 === neg1 && neg0 === neg2 && neg0 === neg3 &&
                    neg0 === neg4 && neg0 === neg5 && neg0 === neg6 && neg0 === neg7
                ) {
                    continue;
                }

                _cVals[0] = v0; _cVals[1] = v1; _cVals[2] = v2; _cVals[3] = v3;
                _cVals[4] = v4; _cVals[5] = v5; _cVals[6] = v6; _cVals[7] = v7;
                _cornerIdx[0] = i0; _cornerIdx[1] = i0 + 1; _cornerIdx[2] = i0 + pRes; _cornerIdx[3] = i0 + pRes + 1;
                _cornerIdx[4] = i4; _cornerIdx[5] = i4 + 1; _cornerIdx[6] = i4 + pRes; _cornerIdx[7] = i4 + pRes + 1;

                let rockCount = 0;
                let oreCount = 0;
                let armorCount = 0;
                let maxCarveVal = -1e6;

                for (let c = 0; c < 8; c++) {
                    const cIdx = _cornerIdx[c];
                    if (hasCarveField) {
                        const cv = carveField[cIdx];
                        if (cv > maxCarveVal) maxCarveVal = cv;
                    }
                    if (_cVals[c] < 0.0) {
                        const m = materialData ? materialData[cIdx] : 1;
                        if (m === 3) armorCount++;
                        else if (m === 2) oreCount++;
                        else rockCount++;
                    }
                }

                let vx = 0, vy = 0, vz = 0;
                let edgeCount = 0;
                for (let e = 0; e < 12; e++) {
                    const c1 = _edgeC1[e];
                    const c2 = _edgeC2[e];
                    const ev1 = _cVals[c1];
                    const ev2 = _cVals[c2];
                    if ((ev1 < 0.0) !== (ev2 < 0.0)) {
                        const denom = ev1 - ev2;
                        const t = Math.abs(denom) > 1e-6 ? ev1 / denom : 0.5;
                        const p1x = _cornerX[c1], p1y = _cornerY[c1], p1z = _cornerZ[c1];
                        const p2x = _cornerX[c2], p2y = _cornerY[c2], p2z = _cornerZ[c2];
                        vx += cx + p1x + t * (p2x - p1x);
                        vy += cy + p1y + t * (p2y - p1y);
                        vz += cz + p1z + t * (p2z - p1z);
                        edgeCount++;
                    }
                }

                if (edgeCount === 0) continue;
                const invEdge = 1.0 / edgeCount;
                vx *= invEdge;
                vy *= invEdge;
                vz *= invEdge;

                const wx = minX + (vx - halo) * cellSize;
                const wy = minY + (vy - halo) * cellSize;
                const wz = minZ + (vz - halo) * cellSize;

                // Exact trilinear interpolation of central-difference SDF gradient at fractional dual-vertex (vx, vy, vz)
                sampleTrilinearGradient(voxelData, pRes, pRes2, vx, vy, vz, _triGradOut);
                const unx = _triGradOut[0];
                const uny = _triGradOut[1];
                const unz = _triGradOut[2];

                const totalMat = rockCount + oreCount + armorCount;
                let wRock = 1.0, wOre = 0.0, wArmor = 0.0;
                if (totalMat > 0) {
                    const invMat = 1.0 / totalMat;
                    wRock = rockCount * invMat;
                    wOre = oreCount * invMat;
                    wArmor = armorCount * invMat;
                }

                let domMat = 1;
                if (oreCount > rockCount && oreCount >= armorCount) domMat = 2;
                if (armorCount > 0) domMat = 3;

                let rCol, gCol, bCol;
                if (domMat === 3) {
                    rCol = 0.12; gCol = 0.90; bCol = 0.98;
                } else if (domMat === 2) {
                    rCol = 0.95; gCol = 0.70; bCol = 0.15;
                } else if (hasCarveField) {
                    rCol = 0.40; gCol = 0.44; bCol = 0.48;
                } else {
                    const strata = 0.5 + 0.5 * Math.sin(wy * 0.02 + wx * 0.01);
                    rCol = 0.42 + 0.08 * strata;
                    gCol = 0.44 + 0.07 * strata;
                    bCol = 0.48 + 0.09 * strata;
                }

                const vIdx = vCount++;
                ensureVertexCapacity(vCount);
                cellVertMap[cx + cy * cellCount + cz * cellCount2] = vIdx;
                if (cx < minCX) minCX = cx;
                if (cx > maxCX) maxCX = cx;
                if (cy < minCY) minCY = cy;
                if (cy > maxCY) maxCY = cy;
                if (cz < minCZ) minCZ = cz;
                if (cz > maxCZ) maxCZ = cz;

                const vOff = vIdx * 3;
                _verts[vOff] = wx; _verts[vOff + 1] = wy; _verts[vOff + 2] = wz;
                _norms[vOff] = unx; _norms[vOff + 1] = uny; _norms[vOff + 2] = unz;
                _cols[vOff] = rCol; _cols[vOff + 1] = gCol; _cols[vOff + 2] = bCol;
                _matWeights[vOff] = wRock; _matWeights[vOff + 1] = wOre; _matWeights[vOff + 2] = wArmor;
                _mats[vIdx] = domMat;
                _extFlags[vIdx] = (hasCarveField && maxCarveVal < extThresh) ? 1 : 0;
            }
        }
    }

    if (vCount === 0) {
        return { vCount: 0, iCount: 0 };
    }

    const sMinX = minCX > quadStart ? minCX : quadStart;
    const sMaxX = maxCX + 1 < quadEndX ? maxCX + 1 : quadEndX;
    const sMinY = minCY > quadStart ? minCY : quadStart;
    const sMaxY = maxCY + 1 < quadEndY ? maxCY + 1 : quadEndY;
    const sMinZ = minCZ > quadStart ? minCZ : quadStart;
    const sMaxZ = maxCZ + 1 < quadEndZ ? maxCZ + 1 : quadEndZ;

    // Step 2: Emit quads across active interior & boundary edges
    for (let pz = sMinZ; pz <= sMaxZ; pz++) {
        const zBase = pz * pRes2;
        const cZBase = pz * cellCount2;
        const cZPrev = cZBase - cellCount2;
        for (let py = sMinY; py <= sMaxY; py++) {
            const yzBase = zBase + py * pRes;
            const cYZBase = cZBase + py * cellCount;
            const cYPrevZ = cYZBase - cellCount;
            const cYZPrev = cZPrev + py * cellCount;
            const cYPrevZPrev = cYZPrev - cellCount;
            for (let px = sMinX; px <= sMaxX; px++) {
                const dIdx = yzBase + px;
                const d0Neg = voxelData[dIdx] < 0.0;

                // X-axis edge
                if (d0Neg !== (voxelData[dIdx + 1] < 0.0)) {
                    const v0 = cellVertMap[px + cYPrevZPrev];
                    const v1 = cellVertMap[px + cYZPrev];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[px + cYPrevZ];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v1, v2, iCount, hasCarveField);
                        iCount = pushTriAligned(v0, v2, v3, iCount, hasCarveField);
                    }
                }

                // Y-axis edge
                if (d0Neg !== (voxelData[dIdx + pRes] < 0.0)) {
                    const v0 = cellVertMap[(px - 1) + cYZPrev];
                    const v1 = cellVertMap[px + cYZPrev];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[(px - 1) + cYZBase];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v2, v1, iCount, hasCarveField);
                        iCount = pushTriAligned(v0, v3, v2, iCount, hasCarveField);
                    }
                }

                // Z-axis edge
                if (d0Neg !== (voxelData[dIdx + pRes2] < 0.0)) {
                    const v0 = cellVertMap[(px - 1) + cYPrevZ];
                    const v1 = cellVertMap[px + cYPrevZ];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[(px - 1) + cYZBase];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v1, v2, iCount, hasCarveField);
                        iCount = pushTriAligned(v0, v2, v3, iCount, hasCarveField);
                    }
                }
            }
        }
    }

    return { vCount, iCount };
}

function runDualContour(data) {
    const {
        res,
        voxelData,
        materialData,
        minBounds,
        cellSize,
        extendPosX = false,
        extendPosY = false,
        extendPosZ = false
    } = data;

    const pRes = res + 5;
    const pRes2 = pRes * pRes;
    const endX = extendPosX ? res + 2 : res + 1;
    const endY = extendPosY ? res + 2 : res + 1;
    const endZ = extendPosZ ? res + 2 : res + 1;
    const cellCount = res + 4;
    const cellCount2 = cellCount * cellCount;
    const cellVertMap = ensureCellMapCapacity(cellCount * cellCount * cellCount);

    const minX = minBounds[0];
    const minY = minBounds[1];
    const minZ = minBounds[2];
    const pad = cellSize * 0.02;

    let vCount = 0;
    let iCount = 0;
    let minCX = endX, maxCX = 1;
    let minCY = endY, maxCY = 1;
    let minCZ = endZ, maxCZ = 1;

    // Step 1: Solve regularized scalar QEF for each dual cell [1 .. end]
    for (let cz = 1; cz <= endZ; cz++) {
        const zBase = cz * pRes2;
        for (let cy = 1; cy <= endY; cy++) {
            const yzBase = zBase + cy * pRes;
            for (let cx = 1; cx <= endX; cx++) {
                const i0 = yzBase + cx;
                const v0 = voxelData[i0];
                const v1 = voxelData[i0 + 1];
                const v2 = voxelData[i0 + pRes];
                const v3 = voxelData[i0 + pRes + 1];
                const i4 = i0 + pRes2;
                const v4 = voxelData[i4];
                const v5 = voxelData[i4 + 1];
                const v6 = voxelData[i4 + pRes];
                const v7 = voxelData[i4 + pRes + 1];

                const neg0 = v0 < 0.0, neg1 = v1 < 0.0, neg2 = v2 < 0.0, neg3 = v3 < 0.0;
                const neg4 = v4 < 0.0, neg5 = v5 < 0.0, neg6 = v6 < 0.0, neg7 = v7 < 0.0;
                if (
                    neg0 === neg1 && neg0 === neg2 && neg0 === neg3 &&
                    neg0 === neg4 && neg0 === neg5 && neg0 === neg6 && neg0 === neg7
                ) {
                    continue;
                }

                _cVals[0] = v0; _cVals[1] = v1; _cVals[2] = v2; _cVals[3] = v3;
                _cVals[4] = v4; _cVals[5] = v5; _cVals[6] = v6; _cVals[7] = v7;
                _cornerIdx[0] = i0; _cornerIdx[1] = i0 + 1; _cornerIdx[2] = i0 + pRes; _cornerIdx[3] = i0 + pRes + 1;
                _cornerIdx[4] = i4; _cornerIdx[5] = i4 + 1; _cornerIdx[6] = i4 + pRes; _cornerIdx[7] = i4 + pRes + 1;

                let rockCount = 0;
                let oreCount = 0;
                let armorCount = 0;
                for (let c = 0; c < 8; c++) {
                    if (_cVals[c] < 0.0) {
                        const m = materialData ? materialData[_cornerIdx[c]] : 1;
                        if (m === 3) armorCount++;
                        else if (m === 2) oreCount++;
                        else rockCount++;
                    }
                }

                let edgeCount = 0;
                let mx = 0, my = 0, mz = 0;

                for (let e = 0; e < 12; e++) {
                    const c1 = _edgeC1[e];
                    const c2 = _edgeC2[e];
                    const ev1 = _cVals[c1];
                    const ev2 = _cVals[c2];

                    if ((ev1 < 0.0) !== (ev2 < 0.0)) {
                        const denom = ev1 - ev2;
                        const t = Math.abs(denom) > 1e-6 ? ev1 / denom : 0.5;
                        const p1x = _cornerX[c1], p1y = _cornerY[c1], p1z = _cornerZ[c1];
                        const p2x = _cornerX[c2], p2y = _cornerY[c2], p2z = _cornerZ[c2];
                        const ix = cx + p1x + t * (p2x - p1x);
                        const iy = cy + p1y + t * (p2y - p1y);
                        const iz = cz + p1z + t * (p2z - p1z);

                        const px = minX + (ix - 2) * cellSize;
                        const py = minY + (iy - 2) * cellSize;
                        const pz = minZ + (iz - 2) * cellSize;
                        const off = edgeCount * 3;
                        _edgePts[off] = px;
                        _edgePts[off + 1] = py;
                        _edgePts[off + 2] = pz;
                        mx += px; my += py; mz += pz;

                        sampleTrilinearGradient(voxelData, pRes, pRes2, ix, iy, iz, _triGradOut);
                        _edgeNorms[off] = _triGradOut[0];
                        _edgeNorms[off + 1] = _triGradOut[1];
                        _edgeNorms[off + 2] = _triGradOut[2];
                        edgeCount++;
                    }
                }

                if (edgeCount === 0) continue;
                const invN = 1.0 / edgeCount;
                mx *= invN; my *= invN; mz *= invN;

                // Stable regularized QEF gradient descent (zero-allocation scalar math)
                let qx = mx, qy = my, qz = mz;
                const lambda = 0.12;
                const stepSize = 0.35;

                for (let iter = 0; iter < 3; iter++) {
                    let gx = 0, gy = 0, gz = 0;
                    for (let p = 0; p < edgeCount; p++) {
                        const off = p * 3;
                        const nx = _edgeNorms[off], ny = _edgeNorms[off + 1], nz = _edgeNorms[off + 2];
                        const dx = qx - _edgePts[off], dy = qy - _edgePts[off + 1], dz = qz - _edgePts[off + 2];
                        const dotVal = (nx * dx + ny * dy + nz * dz) * invN;
                        gx += nx * dotVal;
                        gy += ny * dotVal;
                        gz += nz * dotVal;
                    }
                    gx += (qx - mx) * lambda;
                    gy += (qy - my) * lambda;
                    gz += (qz - mz) * lambda;
                    qx -= gx * stepSize;
                    qy -= gy * stepSize;
                    qz -= gz * stepSize;
                }

                // Clamp QEF vertex strictly inside world bounds of cell (cx, cy, cz)
                const cellMinX = minX + (cx - 2) * cellSize;
                const cellMinY = minY + (cy - 2) * cellSize;
                const cellMinZ = minZ + (cz - 2) * cellSize;

                if (qx < cellMinX + pad) qx = cellMinX + pad;
                else if (qx > cellMinX + cellSize - pad) qx = cellMinX + cellSize - pad;
                if (qy < cellMinY + pad) qy = cellMinY + pad;
                else if (qy > cellMinY + cellSize - pad) qy = cellMinY + cellSize - pad;
                if (qz < cellMinZ + pad) qz = cellMinZ + pad;
                else if (qz > cellMinZ + cellSize - pad) qz = cellMinZ + cellSize - pad;

                // Smooth trilinearly-interpolated SDF gradient at solved QEF dual vertex
                const invCellSize = 1.0 / cellSize;
                sampleTrilinearGradient(
                    voxelData,
                    pRes,
                    pRes2,
                    (qx - minX) * invCellSize + 2.0,
                    (qy - minY) * invCellSize + 2.0,
                    (qz - minZ) * invCellSize + 2.0,
                    _triGradOut
                );
                const anx = _triGradOut[0];
                const any = _triGradOut[1];
                const anz = _triGradOut[2];

                const totalMat = rockCount + oreCount + armorCount;
                let wRock = 1.0, wOre = 0.0, wArmor = 0.0;
                if (totalMat > 0) {
                    const invMat = 1.0 / totalMat;
                    wRock = rockCount * invMat;
                    wOre = oreCount * invMat;
                    wArmor = armorCount * invMat;
                }

                let domMat = 1;
                if (oreCount > rockCount && oreCount >= armorCount) domMat = 2;
                if (armorCount > 0) domMat = 3;

                let rCol, gCol, bCol;
                if (domMat === 3) {
                    rCol = 0.12; gCol = 0.90; bCol = 0.98;
                } else if (domMat === 2) {
                    rCol = 0.95; gCol = 0.70; bCol = 0.15;
                } else {
                    const strata = 0.5 + 0.5 * Math.sin(qy * 0.02);
                    rCol = 0.44 + 0.08 * strata;
                    gCol = 0.46 + 0.06 * strata;
                    bCol = 0.50 + 0.10 * strata;
                }

                const vIdx = vCount++;
                ensureVertexCapacity(vCount);
                cellVertMap[cx + cy * cellCount + cz * cellCount2] = vIdx;
                if (cx < minCX) minCX = cx;
                if (cx > maxCX) maxCX = cx;
                if (cy < minCY) minCY = cy;
                if (cy > maxCY) maxCY = cy;
                if (cz < minCZ) minCZ = cz;
                if (cz > maxCZ) maxCZ = cz;

                const vOff = vIdx * 3;
                _verts[vOff] = qx; _verts[vOff + 1] = qy; _verts[vOff + 2] = qz;
                _norms[vOff] = anx; _norms[vOff + 1] = any; _norms[vOff + 2] = anz;
                _cols[vOff] = rCol; _cols[vOff + 1] = gCol; _cols[vOff + 2] = bCol;
                _matWeights[vOff] = wRock; _matWeights[vOff + 1] = wOre; _matWeights[vOff + 2] = wArmor;
                _mats[vIdx] = domMat;
            }
        }
    }

    if (vCount === 0) {
        return { vCount: 0, iCount: 0 };
    }

    const sMinX = minCX > 2 ? minCX : 2;
    const sMaxX = maxCX + 1 < endX ? maxCX + 1 : endX;
    const sMinY = minCY > 2 ? minCY : 2;
    const sMaxY = maxCY + 1 < endY ? maxCY + 1 : endY;
    const sMinZ = minCZ > 2 ? minCZ : 2;
    const sMaxZ = maxCZ + 1 < endZ ? maxCZ + 1 : endZ;

    // Step 2: Emit quads across [sMin .. sMax] interior & boundary-sealing edges
    for (let pz = sMinZ; pz <= sMaxZ; pz++) {
        const zBase = pz * pRes2;
        const cZBase = pz * cellCount2;
        const cZPrev = cZBase - cellCount2;
        for (let py = sMinY; py <= sMaxY; py++) {
            const yzBase = zBase + py * pRes;
            const cYZBase = cZBase + py * cellCount;
            const cYPrevZ = cYZBase - cellCount;
            const cYZPrev = cZPrev + py * cellCount;
            const cYPrevZPrev = cYZPrev - cellCount;
            for (let px = sMinX; px <= sMaxX; px++) {
                const dIdx = yzBase + px;
                const d0Neg = voxelData[dIdx] < 0.0;

                // X-axis edge
                if (d0Neg !== (voxelData[dIdx + 1] < 0.0)) {
                    const v0 = cellVertMap[px + cYPrevZPrev];
                    const v1 = cellVertMap[px + cYZPrev];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[px + cYPrevZ];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v1, v2, iCount, false);
                        iCount = pushTriAligned(v0, v2, v3, iCount, false);
                    }
                }

                // Y-axis edge
                if (d0Neg !== (voxelData[dIdx + pRes] < 0.0)) {
                    const v0 = cellVertMap[(px - 1) + cYZPrev];
                    const v1 = cellVertMap[px + cYZPrev];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[(px - 1) + cYZBase];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v2, v1, iCount, false);
                        iCount = pushTriAligned(v0, v3, v2, iCount, false);
                    }
                }

                // Z-axis edge
                if (d0Neg !== (voxelData[dIdx + pRes2] < 0.0)) {
                    const v0 = cellVertMap[(px - 1) + cYPrevZ];
                    const v1 = cellVertMap[px + cYPrevZ];
                    const v2 = cellVertMap[px + cYZBase];
                    const v3 = cellVertMap[(px - 1) + cYZBase];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        iCount = pushTriAligned(v0, v1, v2, iCount, false);
                        iCount = pushTriAligned(v0, v2, v3, iCount, false);
                    }
                }
            }
        }
    }

    return { vCount, iCount };
}

self.onmessage = function(e) {
    const data = e.data;
    const { requestId, chunkId, mode = 'surface_nets', voxelData } = data;

    if (!voxelData || voxelData.length === 0) {
        const emptyF = new Float32Array(0);
        const emptyN = new Float32Array(0);
        const emptyC = new Float32Array(0);
        const emptyW = new Float32Array(0);
        const emptyM = new Uint8Array(0);
        const emptyI = new Uint32Array(0);
        self.postMessage({
            requestId,
            chunkId,
            success: true,
            positions: emptyF,
            normals: emptyN,
            colors: emptyC,
            matWeights: emptyW,
            materials: emptyM,
            indices: emptyI
        }, [emptyF.buffer, emptyN.buffer, emptyC.buffer, emptyW.buffer, emptyM.buffer, emptyI.buffer]);
        return;
    }

    const { vCount, iCount } = mode === 'dual_contour'
        ? runDualContour(data)
        : runSurfaceNets(data);

    const posArray = _verts.slice(0, vCount * 3);
    const normArray = _norms.slice(0, vCount * 3);
    const colArray = _cols.slice(0, vCount * 3);
    const matWeightArray = _matWeights.slice(0, vCount * 3);
    const matArray = _mats.slice(0, vCount);
    const idxArray = _indices.slice(0, iCount);

    self.postMessage({
        requestId,
        chunkId,
        success: true,
        positions: posArray,
        normals: normArray,
        colors: colArray,
        matWeights: matWeightArray,
        materials: matArray,
        indices: idxArray
    }, [posArray.buffer, normArray.buffer, colArray.buffer, matWeightArray.buffer, matArray.buffer, idxArray.buffer]);
};
