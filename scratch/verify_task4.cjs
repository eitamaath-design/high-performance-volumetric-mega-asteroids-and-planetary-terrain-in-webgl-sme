const fs = require('fs');
const path = require('path');
const root = 'd:/Projects/high-performance-volumetric-mega-asteroids-and-planetary-terrain-in-webgl-sme';

console.log('=== TASK 4 VERIFICATION & AUDIT ===');

const filesToCheck = [
  'KNOWLEDGE_BASE.md',
  'pocs/index.html',
  'reports/alt_1_chunked-octree-surface-nets-with-async-web-workers.md',
  'reports/alt_2_sparse-voxel-octree-with-dirty-aabb-mesh-patching.md',
  'reports/alt_3_hierarchical-lod-clipmaps-for-volumetric-asteroids.md',
  'reports/alt_4_gpu-sdf-raymarching-and-hybrid-polygon-core.md',
  'reports/COMPARATIVE_SYNTHESIS_AND_RECOMMENDATIONS.md'
];

let allValid = true;
for (const f of filesToCheck) {
  const fullPath = path.join(root, f);
  if (!fs.existsSync(fullPath)) {
    console.error(`[FAIL] Missing file: ${f}`);
    allValid = false;
  } else {
    const stats = fs.statSync(fullPath);
    console.log(`[PASS] ${f} (${stats.size} bytes)`);
  }
}

// Check index.html links
const indexHtmlPath = path.join(root, 'pocs/index.html');
const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
const linksMatch = indexHtmlContent.match(/href="([^"]+)"/g) || [];
console.log(`\nChecked pocs/index.html: found ${linksMatch.length} href links.`);
for (const link of linksMatch) {
  console.log(`  -> ${link}`);
}

// Check KNOWLEDGE_BASE.md content
const kbPath = path.join(root, 'KNOWLEDGE_BASE.md');
const kbContent = fs.readFileSync(kbPath, 'utf8');
console.log(`\nKNOWLEDGE_BASE.md check:`);
console.log(`- Contains Task 4 / Synthesis / Gallery: ${kbContent.includes('Task 4') || kbContent.includes('Gallery') || kbContent.includes('Synthesis') ? 'YES' : 'NO'}`);
console.log(`- Contains Reports references: ${kbContent.includes('reports/') ? 'YES' : 'NO'}`);

console.log('\nVerification complete.');
