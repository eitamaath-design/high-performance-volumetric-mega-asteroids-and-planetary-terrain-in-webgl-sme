/**
 * Surface Nets Isosurface Extraction Worker
 * True Dual-Grid Surface Nets with 1-Voxel Halo Seam Stitching & Multi-Material Support
 * 
 * Generates watertight 2-manifold mesh from density + material voxel data.
 */

self.onmessage = function(e) {
    const { chunkId, res, voxelData, materialData, minBounds, cellSize } = e.data;
    // voxelData is Float32Array of dimension (res + 3)^3
    // Padded coordinate: px in [0 .. res + 2]
    const pRes = res + 3;
    const pRes2 = pRes * pRes;

    function getIndex(px, py, pz) {
        return px + py * pRes + pz * pRes2;
    }

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

    // Map cell (cx, cy, cz) to dual vertex index
    // Using a flat Int32Array for cells [0..res+1]
    const cellCount = res + 2;
    const cellCount2 = cellCount * cellCount;
    const cellVertexIndex = new Int32Array(cellCount * cellCount * cellCount).fill(-1);

    function getCellKey(cx, cy, cz) {
        return cx + cy * cellCount + cz * cellCount2;
    }

    // Step 1: For each cell [0 .. res+1], check 8 corners and generate dual vertex if sign changes
    for (let cz = 0; cz < cellCount; cz++) {
        for (let cy = 0; cy < cellCount; cy++) {
            for (let cx = 0; cx < cellCount; cx++) {
                // Corner densities
                let mask = 0;
                let cVals = new Float32Array(8);
                let matCounts = { 1: 0, 2: 0, 3: 0 }; // rock, ore, titanium

                for (let c = 0; c < 8; c++) {
                    const px = cx + corners[c][0];
                    const py = cy + corners[c][1];
                    const pz = cz + corners[c][2];
                    const val = getDensity(px, py, pz);
                    cVals[c] = val;
                    if (val < 0.0) {
                        mask |= (1 << c);
                        const m = getMaterial(px, py, pz);
                        if (matCounts[m] !== undefined) matCounts[m]++;
                    }
                }

                if (mask === 0 || mask === 255) continue; // Completely solid or empty

                // Calculate edge intersections & dual vertex via relaxation
                let vx = 0, vy = 0, vz = 0;
                let edgeCount = 0;

                for (let e = 0; e < 12; e++) {
                    const c1 = cubeEdges[e][0];
                    const c2 = cubeEdges[e][1];
                    const v1 = cVals[c1];
                    const v2 = cVals[c2];

                    if ((v1 < 0.0) !== (v2 < 0.0)) {
                        // Linear interpolation factor t where density = 0
                        const t = v1 / (v1 - v2);
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

                // Map to world coordinates. Note: cell (1, 1, 1) starts at chunk minBounds
                const wx = minBounds[0] + (vx - 1) * cellSize;
                const wy = minBounds[1] + (vy - 1) * cellSize;
                const wz = minBounds[2] + (vz - 1) * cellSize;

                // Compute normal via central differences on density grid
                const ipx = Math.round(vx);
                const ipy = Math.round(vy);
                const ipz = Math.round(vz);
                const nx = getDensity(ipx + 1, ipy, ipz) - getDensity(ipx - 1, ipy, ipz);
                const ny = getDensity(ipx, ipy + 1, ipz) - getDensity(ipx, ipy - 1, ipz);
                const nz = getDensity(ipx, ipy, ipz + 1) - getDensity(ipx, ipy, ipz - 1);
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;

                // Determine dominant material
                let domMat = 1; // Default Rock
                if (matCounts[2] > matCounts[1] && matCounts[2] >= matCounts[3]) domMat = 2; // Ore
                if (matCounts[3] > 0) domMat = 3; // Reinforced Titanium takes precedence

                // Vertex color based on material
                let rCol, gCol, bCol;
                if (domMat === 3) {
                    // Reinforced Titanium Bulkhead: Glowing metallic cyan/slate armor
                    rCol = 0.12; gCol = 0.90; bCol = 0.98;
                } else if (domMat === 2) {
                    // Mineral Ore Vein: Gold/amber glow
                    rCol = 0.95; gCol = 0.70; bCol = 0.15;
                } else {
                    // Regolith / Basalt Rock
                    const strata = 0.5 + 0.5 * Math.sin(wy * 0.02 + wx * 0.01);
                    rCol = 0.42 + 0.10 * strata;
                    gCol = 0.44 + 0.08 * strata;
                    bCol = 0.48 + 0.12 * strata;
                }

                const vIdx = vertices.length / 3;
                cellVertexIndex[getCellKey(cx, cy, cz)] = vIdx;

                vertices.push(wx, wy, wz);
                normals.push(nx / len, ny / len, nz / len);
                colors.push(rCol, gCol, bCol);
                materials.push(domMat);
            }
        }
    }

    // Step 2: Emit quads (2 triangles) across sign-changing interior grid edges
    // Edges exist between integer grid points in range [1 .. res+1]
    for (let pz = 1; pz <= res; pz++) {
        for (let py = 1; py <= res; py++) {
            for (let px = 1; px <= res; px++) {
                const d0 = getDensity(px, py, pz);

                // Edge 1: Along X-axis: (px, py, pz) -> (px+1, py, pz)
                const dX = getDensity(px + 1, py, pz);
                if ((d0 < 0.0) !== (dX < 0.0)) {
                    // Shared by 4 cells:
                    // c0: (px, py-1, pz-1), c1: (px, py, pz-1), c2: (px, py, pz), c3: (px, py-1, pz)
                    const v0 = cellVertexIndex[getCellKey(px, py - 1, pz - 1)];
                    const v1 = cellVertexIndex[getCellKey(px, py, pz - 1)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px, py - 1, pz)];

                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        if (d0 < 0.0) {
                            indices.push(v0, v1, v2);
                            indices.push(v0, v2, v3);
                        } else {
                            indices.push(v0, v2, v1);
                            indices.push(v0, v3, v2);
                        }
                    }
                }

                // Edge 2: Along Y-axis: (px, py, pz) -> (px, py+1, pz)
                const dY = getDensity(px, py + 1, pz);
                if ((d0 < 0.0) !== (dY < 0.0)) {
                    // Shared by 4 cells:
                    // c0: (px-1, py, pz-1), c1: (px, py, pz-1), c2: (px, py, pz), c3: (px-1, py, pz)
                    const v0 = cellVertexIndex[getCellKey(px - 1, py, pz - 1)];
                    const v1 = cellVertexIndex[getCellKey(px, py, pz - 1)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px - 1, py, pz)];

                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        if (d0 < 0.0) {
                            indices.push(v0, v2, v1);
                            indices.push(v0, v3, v2);
                        } else {
                            indices.push(v0, v1, v2);
                            indices.push(v0, v2, v3);
                        }
                    }
                }

                // Edge 3: Along Z-axis: (px, py, pz) -> (px, py, pz+1)
                const dZ = getDensity(px, py, pz + 1);
                if ((d0 < 0.0) !== (dZ < 0.0)) {
                    // Shared by 4 cells:
                    // c0: (px-1, py-1, pz), c1: (px, py-1, pz), c2: (px, py, pz), c3: (px-1, py, pz)
                    const v0 = cellVertexIndex[getCellKey(px - 1, py - 1, pz)];
                    const v1 = cellVertexIndex[getCellKey(px, py - 1, pz)];
                    const v2 = cellVertexIndex[getCellKey(px, py, pz)];
                    const v3 = cellVertexIndex[getCellKey(px - 1, py, pz)];

                    if (v0 !== -1 && v1 !== -1 && v2 !== -1 && v3 !== -1) {
                        if (d0 < 0.0) {
                            indices.push(v0, v1, v2);
                            indices.push(v0, v2, v3);
                        } else {
                            indices.push(v0, v2, v1);
                            indices.push(v0, v3, v2);
                        }
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
        chunkId,
        success: true,
        positions: posArray,
        normals: normArray,
        colors: colArray,
        materials: matArray,
        indices: idxArray
    }, [posArray.buffer, normArray.buffer, colArray.buffer, matArray.buffer, idxArray.buffer]);
};
