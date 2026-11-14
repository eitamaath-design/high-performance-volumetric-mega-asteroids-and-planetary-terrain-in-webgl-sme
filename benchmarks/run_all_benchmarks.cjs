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

async function runBenchmark(browser, pocName, urlPath) {
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
    await page.waitForFunction(() => window.__BENCHMARK_RESULTS__, { timeout: 60000 });
    const data = await page.evaluate(() => window.__BENCHMARK_RESULTS__);

    if (pageError) {
        throw new Error(`Page error encountered during benchmark of ${pocName}: ${pageError.message}`);
    }

    const outPath = path.join(ROOT_DIR, 'benchmarks', `${pocName}_results.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[OK] Results written to ${outPath}`);
    console.log(JSON.stringify(data, null, 2));

    await context.close();
    return data;
}

async function main() {
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

            // 1. Rockets Baseline
            await runBenchmark(browser, 'baseline', 'benchmarks/rockets_baseline.html?benchmark=true');

            // 2. PoC 1: Chunked Surface Nets
            await runBenchmark(browser, 'poc1_surface_nets', 'pocs/poc1_chunked_octree_surface_nets.html?benchmark=true');

            // 3. PoC 2: SVO Dual Contouring
            await runBenchmark(browser, 'poc2_svo', 'pocs/poc2_sparse_voxel_octree_mesh_patching.html?benchmark=true');

            // 4. PoC 3: Clipmap Shell & Cavern Portals
            await runBenchmark(browser, 'poc3_clipmaps', 'pocs/poc3_hierarchical_lod_clipmaps.html?benchmark=true');

            // 5. PoC 4: 3D GPU SDF Raymarcher
            await runBenchmark(browser, 'poc4_sdf_raymarching', 'pocs/poc4_gpu_sdf_raymarching_hybrid.html?benchmark=true');

            console.log('\n[SUCCESS] All 5 benchmarks executed cleanly with zero errors!');
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
