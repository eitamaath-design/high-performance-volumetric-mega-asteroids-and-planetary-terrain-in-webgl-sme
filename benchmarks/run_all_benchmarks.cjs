const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = 8089;
const ROOT_DIR = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT_DIR, req.url === '/' ? 'pocs/poc1_chunked_octree_surface_nets.html' : req.url);
    if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found: ' + req.url);
        return;
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500);
            res.end('Server error');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

async function runBenchmark(pocName, urlPath) {
    return new Promise(async (resolve, reject) => {
        server.listen(PORT, async () => {
            console.log(`Test server running for ${pocName} at http://localhost:${PORT}/${urlPath}`);
            try {
                const browser = await chromium.launch({
                    headless: true,
                    args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader']
                });
                const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
                const page = await context.newPage();
                
                page.on('console', msg => {
                    const text = msg.text();
                    if (text.includes('BENCHMARK_COMPLETE')) {
                        console.log(`[Browser Console (${pocName})]`, text);
                    }
                });

                await page.goto(`http://localhost:${PORT}/${urlPath}`, { waitUntil: 'networkidle' });
                
                console.log(`Waiting for window.__BENCHMARK_RESULTS__ for ${pocName}...`);
                await page.waitForFunction(() => window.__BENCHMARK_RESULTS__, { timeout: 60000 });
                const data = await page.evaluate(() => window.__BENCHMARK_RESULTS__);

                const outPath = path.join(ROOT_DIR, 'benchmarks', `${pocName}_results.json`);
                fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
                console.log(`Benchmark results successfully written to ${outPath}`);

                await browser.close();
                server.close(() => resolve(data));
            } catch (err) {
                server.close(() => reject(err));
            }
        });
    });
}

async function main() {
    try {
        console.log('=== Running PoC 1 Benchmark ===');
        await runBenchmark('poc1_surface_nets', 'pocs/poc1_chunked_octree_surface_nets.html');

        console.log('=== Running PoC 2 Benchmark ===');
        await runBenchmark('poc2_svo', 'pocs/poc2_sparse_voxel_octree_mesh_patching.html');

        console.log('=== Running PoC 3 Benchmark ===');
        await runBenchmark('poc3_clipmaps', 'pocs/poc3_hierarchical_lod_clipmaps.html');

        console.log('=== Running PoC 4 Benchmark ===');
        await runBenchmark('poc4_sdf_raymarching', 'pocs/poc4_gpu_sdf_raymarching_hybrid.html');

        console.log('All PoC benchmarks executed successfully!');
    } catch (err) {
        console.error('Benchmark runner failed:', err);
        process.exit(1);
    }
}

main();
