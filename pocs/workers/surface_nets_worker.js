// Surface Nets Isosurface Extraction Worker
// Computes dual-grid surface extraction with 1-voxel padding and transfers buffers back via Transferables.

self.onmessage = function(e) {
    const { chunkId, res, voxelData, minBounds, maxBounds, cellSize } = e.data;
    
    // voxelData is a Float32Array containing density values for (res + 2)^3 due to 1-voxel border padding
    const paddedRes = res + 2;
    const vertices = [];
    const normals = [];
    const colors = [];
    const indices = [];

    // Surface Nets dual grid polygonization across inner cells [0..res-1]
    // Each cell (x, y, z) has 8 corners in the padded grid.
    const cubeEdges = [
        [0,1,0], [1,1,0], [1,0,0], [0,0,0],
        [0,1,1], [1,1,1], [1,0,1], [0,0,1]
    ];

    // Helper to get density at local padded coordinates (x, y, z)
    function getDensity(x, y, z) {
        return voxelData[x + paddedRes * (y + paddedRes * z)];
    }

    // Edge table & dual vertex generation
    const cellVertices = new Map();

    for (let z = 0; z < res; z++) {
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                // Padded indices start at x+1, y+1, z+1
                const px = x + 1;
                const py = y + 1;
                const pz = z + 1;

                // Check 8 corners
                let mask = 0;
                let dSum = 0;
                const cornerVals = new Array(8);
                let edgeIntersections = 0;

                for (let c = 0; c < 8; c++) {
                    const cx = px + cubeEdges[c][0];
                    const cy = py + cubeEdges[c][1];
                    const cz = pz + cubeEdges[c][2];
                    const val = getDensity(cx, cy, cz);
                    cornerVals[c] = val;
                    if (val < 0.0) mask |= (1 << c);
                    dSum += val;
                }

                if (mask === 0 || mask === 255) continue; // Completely inside or outside

                // Compute dual vertex position via edge crossing average / relaxation
                let vx = 0, vy = 0, vz = 0;
                let edgeCount = 0;

                // Standard 12 cube edges check for surface crossing
                const edges = [
                    [0,1], [1,2], [2,3], [3,0],
                    [4,5], [5,6], [6,7], [7,4],
                    [0,4], [1,5], [2,6], [3,7]
                ];

                for (let e = 0; e < 12; e++) {
                    const c1 = edges[e][0];
                    const c2 = edges[e][1];
                    const v1 = cornerVals[c1];
                    const v2 = cornerVals[c2];

                    if ((v1 < 0.0) !== (v2 < 0.0)) {
                        const t = v1 / (v1 - v2);
                        const e1 = cubeEdges[c1];
                        const e2 = cubeEdges[c2];
                        const ex = px + e1[0] + t * (e2[0] - e1[0]);
                        const ey = py + e1[1] + t * (e2[1] - e1[1]);
                        const ez = pz + e1[2] + t * (e2[2] - e1[2]);

                        vx += ex - 1; // offset back to local chunk coords [0..res]
                        vy += ey - 1;
                        vz += ez - 1;
                        edgeCount++;
                    }
                }

                if (edgeCount > 0) {
                    vx /= edgeCount;
                    vy /= edgeCount;
                    vz /= edgeCount;

                    // Map to world coordinates
                    const wx = minBounds[0] + vx * cellSize;
                    const wy = minBounds[1] + vy * cellSize;
                    const wz = minBounds[2] + vz * cellSize;

                    // Approximate normal via central differences on padded grid
                    const eps = 1.0;
                    const nx = getDensity(px + 1, py, pz) - getDensity(px - 1, py, pz);
                    const ny = getDensity(px, py + 1, pz) - getDensity(px, py - 1, pz);
                    const nz = getDensity(px, py, pz + 1) - getDensity(px, py, pz - 1);
                    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) + 0.00001;
                    const normX = nx / len;
                    const normY = ny / len;
                    const normZ = nz / len;

                    // Color based on height / depth strata
                    const distFromCenter = Math.sqrt(wx * wx + wy * wy + wz * wz);
                    const rCol = 0.45 + 0.15 * Math.sin(wx * 0.01);
                    const gCol = 0.42 + 0.12 * Math.cos(wy * 0.01);
                    const bCol = 0.48 + 0.18 * Math.sin(wz * 0.01);

                    const vIndex = vertices.length / 3;
                    cellVertices.set(`${x},${y},${z}`, vIndex);

                    vertices.push(wx, wy, wz);
                    normals.push(normX, normY, normZ);
                    colors.push(rCol, gCol, bCol);
                }
            }
        }
    }

    // Generate quad/triangle faces between adjacent dual vertices in cells sharing an edge
    for (let z = 0; z < res - 1; z++) {
        for (let y = 0; y < res - 1; y++) {
            for (let x = 0; x < res - 1; x++) {
                // Check edges along x, y, z axes between adjacent cells
                // For simplicity in Surface Nets, connect cell (x,y,z) with neighbors (x+1,y,z), (x,y+1,z), (x,y,z+1)
                const v0 = cellVertices.get(`${x},${y},${z}`);
                if (v0 === undefined) continue;

                const v1 = cellVertices.get(`${x+1},${y},${z}`);
                const v2 = cellVertices.get(`${x},${y+1},${z}`);
                const v3 = cellVertices.get(`${x},${y},${z+1}`);

                if (v1 !== undefined && v2 !== undefined) {
                    indices.push(v0, v1, v2);
                }
                if (v1 !== undefined && v3 !== undefined) {
                    indices.push(v0, v3, v1);
                }
                if (v2 !== undefined && v3 !== undefined) {
                    indices.push(v0, v2, v3);
                }
            }
        }
    }

    const posArray = new Float32Array(vertices);
    const normArray = new Float32Array(normals);
    const colArray = new Float32Array(colors);
    const idxArray = new Uint32Array(indices);

    self.postMessage({
        chunkId,
        success: true,
        positions: posArray,
        normals: normArray,
        colors: colArray,
        indices: idxArray
    }, [posArray.buffer, normArray.buffer, colArray.buffer, idxArray.buffer]);
};
