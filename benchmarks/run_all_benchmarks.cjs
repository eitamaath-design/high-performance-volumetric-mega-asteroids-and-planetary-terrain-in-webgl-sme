const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = 8089;
const ROOT_DIR = path.resolve(__dirname, '..');

// Static HTTP Server with Query String Stripping and MIME support
const server = http.createServer((req, res) => {
    const cleanUrl = req.url.split('?')[0];
    const relPath = cleanUrl === '/' ? 'pocs/index.html' : cleanUrl.replace(/^\//, '');
    const filePath = path.join(ROOT_DIR, relPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found: ' + req.url);
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Server error: ' + err.message);
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

async function runBenchmark(browser, pocName, urlPath, writeFile = true) {
    console.log(`\n=== Running Benchmark: ${pocName} ===`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    let pageError = null;
    page.on('pageerror', err => {
        console.error(`[Page Error (${pocName})]`, err.message);
        pageError = err;
    });

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('BENCHMARK_COMPLETE')) {
            console.log(`[Browser Console (${pocName})]`, text);
        }
    });

    console.log(`Navigating to http://localhost:${PORT}/${urlPath}...`);
    await page.goto(`http://localhost:${PORT}/${urlPath}`, { waitUntil: 'networkidle' });

    console.log(`Waiting for window.__BENCHMARK_RESULTS__ for ${pocName}...`);
    await page.waitForFunction(() => window.__BENCHMARK_RESULTS__, { timeout: 90000 });
    const data = await page.evaluate(() => window.__BENCHMARK_RESULTS__);

    if (pageError) {
        throw new Error(`Page error encountered during benchmark of ${pocName}: ${pageError.message}`);
    }

    if (writeFile) {
        const outPath = path.join(ROOT_DIR, 'benchmarks', `${pocName}_results.json`);
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
        console.log(`[OK] Results written to ${outPath}`);
    }
    console.log(JSON.stringify(data, null, 2));

    await context.close();
    return data;
}

function normalizeResult(key, raw) {
    if (key === 'baseline' || raw.poc === 'rockets_baseline') {
        const carveMs = raw.avgCarveDurationMs ?? raw.avgCarveLatency ?? 0;
        return {
            poc: 'baseline',
            scale: raw.scale || '10p',
            quality: raw.quality || 'legacy-48^3',
            brushRadius: raw.brushRadius ?? 140,
            cellSize: raw.cellSize || '~109.4u (48³)',
            avgFps: raw.avgFps ?? 0,
            avgFrameTime: raw.avgFrameTimeMs ?? raw.avgFrameTime ?? 0,
            p99FrameTime: raw.p99FrameTimeMs ?? raw.p99FrameTime ?? 0,
            avgMainThreadWorkMs: raw.avgMainThreadWorkMs ?? null,
            p99MainThreadWorkMs: raw.p99MainThreadWorkMs ?? null,
            avgCarveLatency: carveMs,
            avgMainThreadCarveMs: raw.avgMainThreadCarveMs ?? carveMs,
            sampledFrames: raw.totalFrames ?? raw.sampledFrames ?? 450,
            triangles: raw.trianglesCount ?? raw.triangles ?? 0,
            drawCalls: raw.drawCalls ?? 0,
            heapMemoryMB: raw.heapMemoryMb ?? raw.heapMemoryMB ?? 0,
            visualCollisionError: raw.visualCollisionError || '> 30.00u',
            visualCollisionErrorNumeric: typeof raw.visualCollisionErrorNumeric === 'number' ? raw.visualCollisionErrorNumeric : null
        };
    }

    return {
        poc: raw.poc || key,
        scale: raw.scale || '10p',
        quality: raw.quality || 'medium',
        brushRadius: raw.brushRadius ?? 140,
        cellSize: raw.cellSize || '--',
        avgFps: raw.avgFps ?? 0,
        avgFrameTime: raw.avgFrameTime ?? 0,
        p99FrameTime: raw.p99FrameTime ?? 0,
        avgMainThreadWorkMs: raw.avgMainThreadWorkMs ?? null,
        p99MainThreadWorkMs: raw.p99MainThreadWorkMs ?? null,
        avgCarveLatency: raw.avgCarveLatency ?? 0,
        avgMainThreadCarveMs: raw.avgMainThreadCarveMs ?? raw.avgCarveLatency ?? 0,
        sampledFrames: raw.sampledFrames ?? 0,
        triangles: raw.triangles ?? 0,
        drawCalls: raw.drawCalls ?? 0,
        heapMemoryMB: raw.heapMemoryMB ?? 0,
        visualCollisionError: raw.visualCollisionError || '0.00u',
        visualCollisionErrorNumeric: typeof raw.visualCollisionErrorNumeric === 'number' ? raw.visualCollisionErrorNumeric : 0
    };
}

function parseCliArgs(argv) {
    const args = argv.slice(2);
    const matrixMode = args.includes('--matrix');
    const framesArg = args.find(a => a.startsWith('--frames='));
    let frames = 450;
    let hasFramesFlag = false;
    if (framesArg) {
        const parsed = parseInt(framesArg.split('=')[1], 10);
        if (Number.isFinite(parsed) && parsed >= 30) {
            frames = parsed;
            hasFramesFlag = true;
        }
    }
    const qualityArg = args.find(a => a.startsWith('--quality='));
    const quality = qualityArg ? qualityArg.split('=')[1] : null;
    return { matrixMode, frames, hasFramesFlag, quality };
}

function buildQueryParams({ scale = null, frames = 450, hasFramesFlag = false, quality = null }) {
    const qs = ['benchmark=true'];
    if (scale) qs.push(`scale=${encodeURIComponent(scale)}`);
    if (hasFramesFlag) qs.push(`frames=${frames}`);
    if (quality) qs.push(`quality=${encodeURIComponent(quality)}`);
    return qs.join('&');
}

async function main() {
    const cli = parseCliArgs(process.argv);

    server.listen(PORT, async () => {
        console.log(`Benchmark HTTP server running on http://localhost:${PORT}`);
        let browser;

        try {
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--use-gl=angle',
                    '--enable-webgl',
                    '--ignore-gpu-blocklist',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--enable-unsafe-swiftshader'
                ]
            });

            const environment = {
                renderer: 'Playwright Chromium Headless SwiftShader',
                node: process.version,
                platform: process.platform
            };

            if (cli.matrixMode) {
                const scales = ['10p', '30p', '50p'];
                const pocTargets = [
                    { key: 'poc1', path: 'pocs/poc1_chunked_octree_surface_nets.html' },
                    { key: 'poc2', path: 'pocs/poc2_sparse_voxel_octree_mesh_patching.html' },
                    { key: 'poc3', path: 'pocs/poc3_hierarchical_lod_clipmaps.html' },
                    { key: 'poc4', path: 'pocs/poc4_gpu_sdf_raymarching_hybrid.html' }
                ];
                const matrix = {};
                const results = [];

                for (const scale of scales) {
                    matrix[scale] = {};
                    for (const target of pocTargets) {
                        const qs = buildQueryParams({
                            scale,
                            frames: cli.frames,
                            hasFramesFlag: cli.hasFramesFlag,
                            quality: cli.quality
                        });
                        const raw = await runBenchmark(
                            browser,
                            `${target.key}_${scale}`,
                            `${target.path}?${qs}`,
                            false
                        );
                        const normalized = normalizeResult(target.key, raw);
                        matrix[scale][target.key] = normalized;
                        results.push(normalized);
                    }
                }

                const matrixOut = {
                    generatedAt: new Date().toISOString(),
                    environment,
                    scales,
                    frames: cli.frames,
                    quality: cli.quality || 'default',
                    baselineNote: 'Legacy monolithic 64³/48³ baseline is fixed at R=2800u (10p) and unscalable to 30p/50p',
                    matrix,
                    results
                };
                const matrixPath = path.join(ROOT_DIR, 'benchmarks', 'matrix_results.json');
                fs.writeFileSync(matrixPath, JSON.stringify(matrixOut, null, 2));
                console.log(`\n[SUCCESS] Matrix benchmark complete! Results written to ${matrixPath}`);
            } else {
                const pocQs = buildQueryParams({
                    frames: cli.frames,
                    hasFramesFlag: cli.hasFramesFlag,
                    quality: cli.quality
                });
                const standardTargets = [
                    { key: 'baseline', fileName: 'baseline', path: 'benchmarks/rockets_baseline.html?benchmark=true' },
                    { key: 'poc1', fileName: 'poc1_surface_nets', path: `pocs/poc1_chunked_octree_surface_nets.html?${pocQs}` },
                    { key: 'poc2', fileName: 'poc2_svo', path: `pocs/poc2_sparse_voxel_octree_mesh_patching.html?${pocQs}` },
                    { key: 'poc3', fileName: 'poc3_clipmaps', path: `pocs/poc3_hierarchical_lod_clipmaps.html?${pocQs}` },
                    { key: 'poc4', fileName: 'poc4_sdf_raymarching', path: `pocs/poc4_gpu_sdf_raymarching_hybrid.html?${pocQs}` }
                ];

                const targets = {};
                const results = [];
                for (const target of standardTargets) {
                    const raw = await runBenchmark(browser, target.fileName, target.path, true);
                    const normalized = normalizeResult(target.key, raw);
                    targets[target.key] = normalized;
                    results.push(normalized);
                }

                const summaryOut = {
                    generatedAt: new Date().toISOString(),
                    environment,
                    frames: cli.frames,
                    targets,
                    results
                };
                const summaryPath = path.join(ROOT_DIR, 'benchmarks', 'summary_results.json');
                fs.writeFileSync(summaryPath, JSON.stringify(summaryOut, null, 2));
                console.log(`\n[SUCCESS] All 5 benchmarks executed cleanly and summary written to ${summaryPath}!`);
            }

            await browser.close();
            server.close(() => process.exit(0));
        } catch (err) {
            console.error('\n[FATAL] Benchmark suite failed:', err);
            if (browser) await browser.close();
            server.close(() => process.exit(1));
        }
    });
}

main();
