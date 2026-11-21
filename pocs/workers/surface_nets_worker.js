/**
 * Surface Nets Isosurface Extraction Worker
 * True Dual-Grid Surface Nets with 1-Voxel Halo Seam Stitching & Multi-Material Support
 * 
 * Generates watertight 2-manifold mesh from density + material voxel data.
 */

self.onmessage = function(e) {
    const {
        requestId,
        chunkId,
        res,
        voxelData,
        materialData,
        minBounds,
        cellSize,
        extendPosX = false,
        extendPosY = false,
        extendPosZ = false
    } = e.data;
    // voxelData is Float32Array of dimension (res + 5)^3 (2-voxel halo on each side)
    // Sample index px=2 corresponds to minBounds; px=res+2 corresponds to maxBounds.
    const pRes = res + 5;
    const pRes2 = pRes * pRes;

    function getDensity(px, py, pz) {
        return voxelData[px + py * pRes + pz * pRes2];
    }

    function getMaterial(px, py, pz) {
        return materialData ? materialData[px + py * pRes + pz * pRes2] : 1;
    }

    // Corner offsets of cell (0..1, 0..1, 0..1)
    const corners = [
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
        [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]
    ];

    // Standard 12 cube edges
    const cubeEdges = [
        [0, 1], [2, 3], [4, 5], [6, 7], // parallel to X
        [0, 2], [1, 3], [4, 6], [5, 7], // parallel to Y
        [0, 4], [1, 5], [2, 6], [3, 7]  // parallel to Z
    ];

    const vertices = [];
    const normals = [];
    const colors = [];
    const materials = [];
    const indices = [];

    // Cells in [1 .. res + 2] mapped into flat array of size (res + 4)^3
    const cellCount = res + 4;
    const cellCount2 = cellCount * cellCount;
    const cellVertexIndex = new Int32Array(cellCount * cellCount * cellCount).fill(-1);

    const endX = extendPosX ? res + 2 : res + 1;
    const endY = extendPosY ? res + 2 : res + 1;
    const endZ = extendPosZ ? res + 2 : res + 1;

    function getCellKey(cx, cy, cz) {
        return cx + cy * cellCount + cz * cellCount2;
    }

    const cVals = new Float32Array(8);

    // Step 1: For each cell [1 .. end], check 8 corners and generate dual vertex if sign changes
    for (let cz = 1; cz <= endZ; cz++) {
        for (let cy = 1; cy <= endY; cy++) {
            for (let cx = 1; cx <= endX; cx++) {
                let mask = 0;
                let rockCount = 0;
                let oreCount = 0;
                let armorCount = 0;

                for (let c = 0; c < 8; c++) {
                    const px = cx + corners[c][0];
                    const py = cy + corners[c][1];
                    const pz = cz + corners[c][2];
                    const val = getDensity(px, py, pz);
                    cVals[c] = val;
                    if (val < 0.0) {
                        mask |= (1 << c);
                        const m = getMaterial(px, py, pz);
                        if (m === 3) armorCount++;
                        else if (m === 2) oreCount++;
                        else rockCount++;
                    }
                }

                if (mask === 0 || mask === 255) continue;

                let vx = 0, vy = 0, vz = 0;
                let edgeCount = 0;

                for (let e = 0; e < 12; e++) {
                    const c1 = cubeEdges[e][0];
                    const c2 = cubeEdges[e][1];
                    const v1 = cVals[c1];
                    const v2 = cVals[c2];

                    if ((v1 < 0.0) !== (v2 < 0.0)) {
                        const denom = v1 - v2;
                        const t = Math.abs(denom) > 1e-6 ? v1 / denom : 0.5;
                        const p1 = corners[c1];
                        const p2 = corners[c2];
                        vx += cx + p1[0] + t * (p2[0] - p1[0]);
                        vy += cy + p1[1] + t * (p2[1] - p1[1]);
                        vz += cz + p1[2] + t * (p2[2] - p1[2]);
                        edgeCount++;
                    }
                }

                if (edgeCount === 0) continue;

                vx /= edgeCount;
                vy /= edgeCount;
                vz /= edgeCount;

                // Map to world coordinates. Sample index (2, 2, 2) starts at chunk minBounds
                const wx = minBounds[0] + (vx - 2) * cellSize;
                const wy = minBounds[1] + (vy - 2) * cellSize;
                const wz = minBounds[2] + (vz - 2) * cellSize;

                // Central differences strictly inside [1 .. pRes - 2] for exact seam consistency
                const ipx = Math.max(1, Math.min(pRes - 2, Math.round(vx)));
                const ipy = Math.max(1, Math.min(pRes - 2, Math.round(vy)));
                const ipz = Math.max(1, Math.min(pRes - 2, Math.round(vz)));
                const nx = getDensity(ipx + 1, ipy, ipz) - getDensity(ipx - 1, ipy, ipz);
                const ny = getDensity(ipx, ipy + 1, ipz) - getDensity(ipx, ipy - 1, ipz);
                const nz = getDensity(ipx, ipy, ipz + 1) - getDensity(ipx, ipy, ipz - 1);
                let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                let unx = 0.0, uny = 1.0, unz = 0.0;
                if (len > 1e-6) {
                    unx = nx / len;
                    uny = ny / len;
                    unz = nz / len;
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
                    const strata = 0.5 + 0.5 * Math.sin(wy * 0.02 + wx * 0.01);
                    rCol = 0.42 + 0.08 * strata;
                    gCol = 0.44 + 0.07 * strata;
                    bCol = 0.48 + 0.09 * strata;
                }

                const vIdx = vertices.length / 3;
                cellVertexIndex[getCellKey(cx, cy, cz)] = vIdx;

                vertices.push(wx, wy, wz);
                normals.push(unx, uny, unz);
                colors.push(rCol, gCol, bCol);
                materials.push(domMat);
            }
        }
    }

    function pushTriAligned(i0, i1, i2) {
        const ax = vertices[i0 * 3], ay = vertices[i0 * 3 + 1], az = vertices[i0 * 3 + 2];
        const bx = vertices[i1 * 3], by = vertices[i1 * 3 + 1], bz = vertices[i1 * 3 + 2];
        const cx = vertices[i2 * 3], cy = vertices[i2 * 3 + 1], cz = vertices[i2 * 3 + 2];
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const gx = e1y * e2z - e1z * e2y;
        const gy = e1z * e2x - e1x * e2z;
        const gz = e1x * e2y - e1y * e2x;
        const nx = normals[i0 * 3], ny = normals[i0 * 3 + 1], nz = normals[i0 * 3 + 2];
        if (gx * nx + gy * ny + gz * nz >= 0.0) {
            indices.push(i0, i1, i2);
        } else {
            indices.push(i0, i2, i1);
        }
    }

    // Step 2: Emit quads across interior & boundary edges [2 .. end]
    for (let pz = 2; pz <= endZ; pz++) {
        for (let py = 2; py <= endY; py++) {
            for (let px = 2; px <= endX; px++) {
                const d0 = getDensity(px, py, pz);

                // Edge 1: Along X-axis: (px, py, pz) -> (px+1, py, pz)
                const dX = getDensity(px + 1, py, pz);
                if ((d0 < 0.0) !== (dX < 0.0)) {
                    const v0 = cellVertexIndex[getCellKey(px, py - 1, pz - 1)];
                    const v1 = cellVertexIndex[getCellKey(px, py, pz - 1)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px, py - 1, pz)];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        pushTriAligned(v0, v1, v2);
                        pushTriAligned(v0, v2, v3);
                    }
                }

                // Edge 2: Along Y-axis: (px, py, pz) -> (px, py+1, pz)
                const dY = getDensity(px, py + 1, pz);
                if ((d0 < 0.0) !== (dY < 0.0)) {
                    const v0 = cellVertexIndex[getCellKey(px - 1, py, pz - 1)];
                    const v1 = cellVertexIndex[getCellKey(px, py, pz - 1)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px - 1, py, pz)];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        pushTriAligned(v0, v2, v1);
                        pushTriAligned(v0, v3, v2);
                    }
                }

                // Edge 3: Along Z-axis: (px, py, pz) -> (px, py, pz+1)
                const dZ = getDensity(px, py, pz + 1);
                if ((d0 < 0.0) !== (dZ < 0.0)) {
                    const v0 = cellVertexIndex[getCellKey(px - 1, py - 1, pz)];
                    const v1 = cellVertexIndex[getCellKey(px, py - 1, pz)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px - 1, py, pz)];
                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        pushTriAligned(v0, v1, v2);
                        pushTriAligned(v0, v2, v3);
                    }
                }
            }
        }
    }

    const posArray = new Float32Array(vertices);
    const normArray = new Float32Array(normals);
    const colArray = new Float32Array(colors);
    const matArray = new Uint8Array(materials);
    const idxArray = new Uint32Array(indices);

    self.postMessage({
        requestId,
        chunkId,
        success: true,
        positions: posArray,
        normals: normArray,
        colors: colArray,
        materials: matArray,
        indices: idxArray
    }, [posArray.buffer, normArray.buffer, colArray.buffer, matArray.buffer, idxArray.buffer]);
};
