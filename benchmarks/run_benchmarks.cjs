const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = 8085;
const ROOT_DIR = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT_DIR, req.url === '/' ? 'benchmarks/rockets_baseline.html' : req.url);
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

server.listen(PORT, async () => {
    console.log(`Test server running at http://localhost:${PORT}/`);

    try {
        const browser = await chromium.launch({
            headless: true,
            args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader']
        });

        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();

        page.on('console', msg => {
            console.log(`[Browser Console] ${msg.text()}`);
        });

        console.log('Navigating to benchmark page...');
        await page.goto(`http://localhost:${PORT}/benchmarks/rockets_baseline.html`, { waitUntil: 'networkidle' });

        console.log('Waiting for window.__BENCHMARK_RESULTS__ (timeout 60s)...');
        await page.waitForFunction(() => window.__BENCHMARK_RESULTS__, { timeout: 60000 });
        const benchmarkData = await page.evaluate(() => window.__BENCHMARK_RESULTS__);

        const outputPath = path.join(ROOT_DIR, 'benchmarks', 'baseline_results.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkData, null, 2));
        console.log(`Benchmark results successfully written to ${outputPath}`);
        console.log(JSON.stringify(benchmarkData, null, 2));

        await browser.close();
        server.close();
        process.exit(0);
    } catch (err) {
        console.error('Benchmark execution failed:', err);
        server.close();
        process.exit(1);
    }
});
