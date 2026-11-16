const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright-core');

const PORT = 8094;
const ROOT_DIR = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
    const cleanUrl = req.url.split('?')[0];
    const relPath = cleanUrl === '/' ? 'pocs/index.html' : cleanUrl.replace(/^\//, '');
    const filePath = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
});

async function launchBrowser() {
    return chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--enable-unsafe-swiftshader']
    });
}

(async () => {
    await new Promise(r => server.listen(PORT, r));
    const browser = await launchBrowser();
    const errors = [];

    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(`PAGEERROR: ${e.message}`));
        page.on('console', m => {
            if (m.type() === 'error') errors.push(`CONSOLE_ERR: ${m.text()}`);
            else console.log(`[BROWSER CONSOLE] ${m.text()}`);
        });

        console.log('--- Loading PoC 4 ---');
        await page.goto(`http://localhost:${PORT}/pocs/poc4_gpu_sdf_raymarching_hybrid.html`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // 1. Check basic raycast and hit
        const status1 = await page.evaluate(() => {
            const sb = window.__SANDBOX__;
            sb.mousePos.set(0, 0);
            const hit = sb.performRaycast();
            return {
                cellSize: sb.config.getCellSize(),
                hasHit: Boolean(hit),
                hitPoint: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
                hitDist: hit ? hit.distance : -1,
                matId: hit ? hit.materialId : -1
            };
        });
        console.log('Status 1 (Initial):', status1);
        assert(status1.hasHit, 'Expected center raycast hit');

        // Take a screenshot of the initial render
        const ARTIFACT_SCRATCH = 'C:/Users/eitama/.gemini/antigravity/brain/b62e5584-4397-4a6f-bda3-af7daff89e72/scratch';
        fs.mkdirSync(ARTIFACT_SCRATCH, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACT_SCRATCH, 'poc4_initial.png') });

        // 2. Test Carve operation
        console.log('--- Testing Carve Mode ---');
        await page.evaluate(async () => {
            const sb = window.__SANDBOX__;
            const hit = sb.performRaycast();
            if (hit) {
                await sb.config.onCarve(hit.point, hit.normal, 120, 'carve');
            }
        });
        await page.waitForTimeout(300);

        // 3. Test Reinforce operation
        console.log('--- Testing Reinforce Mode ---');
        const reinforceResult = await page.evaluate(async () => {
            const sb = window.__SANDBOX__;
            const hit = sb.performRaycast();
            if (hit) {
                await sb.config.onReinforce(hit.point, hit.normal, 150);
                const hitAfter = sb.performRaycast();
                const isArmor = sb.config.checkMaterialAtHit(hitAfter.point, hitAfter);
                return {
                    isArmor,
                    materialId: hitAfter ? hitAfter.materialId : null
                };
            }
            return null;
        });
        console.log('Reinforce Result:', reinforceResult);
        assert(reinforceResult && reinforceResult.isArmor, 'Expected hit point to be reinforced armor');

        // 4. Test Breach Charge mode
        console.log('--- Testing Heavy Breach Charge Mode ---');
        const breachResult = await page.evaluate(async () => {
            const sb = window.__SANDBOX__;
            const hit = sb.performRaycast();
            if (hit) {
                await sb.config.onCarve(hit.point, hit.normal, 180, 'breach');
                const hitAfter = sb.performRaycast();
                const isArmor = sb.config.checkMaterialAtHit(hitAfter.point, hitAfter);
                return {
                    isArmor,
                    materialId: hitAfter ? hitAfter.materialId : null
                };
            }
            return null;
        });
        console.log('Breach Result:', breachResult);
        assert(breachResult && !breachResult.isArmor, 'Expected armor to be stripped after breach charge');

        // 5. Test Quality & Scale switching
        console.log('--- Testing Quality & Scale Switching ---');
        await page.evaluate(() => {
            const sb = window.__SANDBOX__;
            sb.config.onQualityChange('medium');
            sb.config.onScaleChange('30p', 4800);
        });
        await page.waitForTimeout(1000);

        const statusScale = await page.evaluate(() => {
            const sb = window.__SANDBOX__;
            sb.mousePos.set(0, 0);
            const hit = sb.performRaycast();
            return {
                cellSize: sb.config.getCellSize(),
                hasHit: Boolean(hit),
                hitDist: hit ? hit.distance : -1
            };
        });
        console.log('Status after 30P scale change:', statusScale);
        assert(statusScale.hasHit, 'Expected hit after scale change');

        await page.screenshot({ path: path.join(ARTIFACT_SCRATCH, 'poc4_30p_medium.png') });

        assert(errors.length === 0, `Errors during execution: ${errors.join(', ')}`);
        console.log('\n[POC4 VERIFICATION PASSED PERFECTLY WITH ZERO ERRORS!]');
    } finally {
        await browser.close();
        server.close();
    }
})();
