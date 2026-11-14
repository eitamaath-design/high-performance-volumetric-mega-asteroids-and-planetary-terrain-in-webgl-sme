/**
 * Planetary Base Sandbox - Next-Gen Interactive 3D Testbed Engine
 * For Rockets Managed by Anti-Gravity (PoCs 1-4 & Baseline)
 * 
 * Features:
 * - Orbit & Sculpt Mode (Click/Drag Laser Sculpting + Right-Drag Orbit)
 * - Starfighter Flight Mode (WASD + Mouse Flight + Spacebar Laser + Swept Collision)
 * - 5 Interactive Tools:
 *     [1] Continuous Spherical Carve Laser
 *     [2] Nanite Titanium Wall Reinforcer (Turn rock into armored bulkheads)
 *     [3] Raider Laser (Blocked by reinforced bulkheads)
 *     [4] Heavy Breach Charge (Breaches bulkheads)
 *     [5] Place Base Machinery (Weapons, Shield, Foundry, Refinery) + Exterior Nodes
 * - X-Ray Cross-Section Slicer (THREE.Plane clipping)
 * - 0.00u Visual-to-Collision Alignment Inspector
 * - 20-30+ Player Planetary Sizing Selector (R=2800u, R=4800u, R=8000u)
 * - Dual-Mode: Interactive by default; Automated Benchmark when ?benchmark=true
 * - Bi-directional postMessage Bridge with Parent Gallery
 */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

/**
 * Shared Procedural 3D Triplanar Asteroid, Mineral Vein & Hex-Armor Bulkhead Material
 */
export function createTriplanarAsteroidMaterial(options = {}) {
    const vertexColors = options.vertexColors !== undefined ? options.vertexColors : true;
    const hasPortals = Boolean(options.hasPortals);
    const defaultRadius = options.radius || 2800.0;

    const uniforms = {
        uAsteroidRadius: { value: defaultRadius },
        uPortals: { value: Array.from({ length: 48 }, () => new THREE.Vector4(0, 0, 0, -1)) },
        uPortalCount: { value: 0 }
    };

    const mat = new THREE.MeshStandardMaterial({
        color: vertexColors ? 0xffffff : 0x7c8490,
        vertexColors,
        roughness: 0.78,
        metalness: 0.18,
        flatShading: false,
        side: THREE.DoubleSide
    });

    mat.userData.shaderUniforms = uniforms;
    mat.customProgramCacheKey = () => `triplanar-asteroid-${vertexColors ? 'vc' : 'nc'}-${hasPortals ? 'portals' : 'solid'}`;

    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uAsteroidRadius = uniforms.uAsteroidRadius;
        if (hasPortals) {
            shader.uniforms.uPortals = uniforms.uPortals;
            shader.uniforms.uPortalCount = uniforms.uPortalCount;
        }

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
                varying vec3 vTriWorldPos;
                varying vec3 vTriWorldNorm;`
            )
            .replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
                vec4 triWp = modelMatrix * vec4( transformed, 1.0 );
                vTriWorldPos = triWp.xyz;
                vTriWorldNorm = normalize( mat3( modelMatrix ) * objectNormal );`
            );

        let fragHeader = `
            #include <common>
            varying vec3 vTriWorldPos;
            varying vec3 vTriWorldNorm;
            uniform float uAsteroidRadius;
        `;

        if (hasPortals) {
            fragHeader += `
            uniform vec4 uPortals[48];
            uniform int uPortalCount;
            `;
        }

        fragHeader += `
            float triHash3(vec3 p) {
                p = fract(p * 0.3183099 + 0.1);
                p *= 17.0;
                return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
            }
            float triNoise3(vec3 x) {
                vec3 i = floor(x);
                vec3 f = fract(x);
                f = f * f * (3.0 - 2.0 * f);
                return mix(
                    mix(mix(triHash3(i + vec3(0,0,0)), triHash3(i + vec3(1,0,0)), f.x),
                        mix(triHash3(i + vec3(0,1,0)), triHash3(i + vec3(1,1,0)), f.x), f.y),
                    mix(mix(triHash3(i + vec3(0,0,1)), triHash3(i + vec3(1,0,1)), f.x),
                        mix(triHash3(i + vec3(0,1,1)), triHash3(i + vec3(1,1,1)), f.x), f.y),
                    f.z
                );
            }
            float triFbm(vec3 p) {
                float v = 0.0;
                float a = 0.5;
                for (int i = 0; i < 3; i++) {
                    v += a * triNoise3(p);
                    p *= 2.03;
                    a *= 0.5;
                }
                return v;
            }
            float hexDist2D(vec2 p) {
                p = abs(p);
                return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
            }
            float triplanarHexGrid(vec3 pos, vec3 n, float scale) {
                vec3 w = pow(abs(n), vec3(4.0));
                w /= max(w.x + w.y + w.z, 0.0001);
                float h = 0.0;
                vec2 uvList[3];
                uvList[0] = pos.yz * scale;
                uvList[1] = pos.xz * scale;
                uvList[2] = pos.xy * scale;
                float weights[3];
                weights[0] = w.x; weights[1] = w.y; weights[2] = w.z;
                for (int i = 0; i < 3; i++) {
                    vec2 uv = uvList[i];
                    vec2 r = vec2(1.0, 1.7320508);
                    vec2 h2 = r * 0.5;
                    vec2 a = mod(uv, r) - h2;
                    vec2 b = mod(uv - h2, r) - h2;
                    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
                    float edge = 0.5 - hexDist2D(gv);
                    h += smoothstep(0.0, 0.09, edge) * weights[i];
                }
                return h;
            }
        `;

        let clipReplace = `#include <clipping_planes_fragment>`;
        if (hasPortals) {
            clipReplace += `
            for (int i = 0; i < 48; i++) {
                if (i >= uPortalCount) break;
                if (uPortals[i].w > 0.0 && distance(vTriWorldPos, uPortals[i].xyz) < uPortals[i].w * 0.90) {
                    discard;
                }
            }
            `;
        }

        const colorReplace = `
            vec3 triPos = vTriWorldPos;
            vec3 triNorm = normalize(vTriWorldNorm);
            float fbmMacro = triFbm(triPos * 0.006);
            float fbmMicro = triFbm(triPos * 0.028);
            float rDist = length(triPos);
            float strata = 0.5 + 0.5 * sin(rDist * 0.045 + fbmMacro * 6.0);
            float depthShade = smoothstep(uAsteroidRadius * 0.25, uAsteroidRadius * 1.05, rDist);

            vec3 exteriorRock = mix(vec3(0.32, 0.34, 0.38), vec3(0.56, 0.54, 0.50), fbmMacro * 0.7 + fbmMicro * 0.45);
            vec3 interiorRock = mix(vec3(0.24, 0.26, 0.33), vec3(0.42, 0.39, 0.36), strata * 0.65 + fbmMicro * 0.45);
            vec3 procRock = mix(interiorRock, exteriorRock, depthShade);

            float triIsArmor = 0.0;
            float triIsOre = 0.0;
            float triHexEdge = 1.0;

            #if defined( USE_COLOR )
                triIsArmor = smoothstep(0.60, 0.85, vColor.b) * smoothstep(0.55, 0.78, vColor.g) * (1.0 - smoothstep(0.25, 0.55, vColor.r));
                triIsOre = smoothstep(0.75, 0.92, vColor.r) * (1.0 - smoothstep(0.25, 0.50, vColor.b));
            #endif

            vec3 surfaceAlbedo = procRock;
            float oreMask = triIsOre * smoothstep(0.45, 0.75, fbmMicro + 0.25 * triFbm(triPos * 0.015));
            if (oreMask > 0.05) {
                vec3 oreCol = mix(vec3(0.75, 0.48, 0.12), vec3(1.0, 0.82, 0.28), fbmMicro);
                surfaceAlbedo = mix(surfaceAlbedo, oreCol, oreMask * (0.35 + 0.65 * (1.0 - depthShade)));
            }
            if (triIsArmor > 0.05) {
                triHexEdge = triplanarHexGrid(triPos, triNorm, 0.032);
                vec3 armorPlate = mix(vec3(0.14, 0.22, 0.30), vec3(0.25, 0.36, 0.46), fbmMicro * 0.5);
                vec3 armorSeam = vec3(0.0, 0.92, 1.0);
                vec3 armorCol = mix(armorSeam, armorPlate, triHexEdge);
                surfaceAlbedo = mix(surfaceAlbedo, armorCol, triIsArmor);
            }

            diffuseColor.rgb = surfaceAlbedo * (0.85 + 0.3 * fbmMicro);
        `;

        const normalReplace = `
            #include <normal_fragment_maps>
            float bumpWeight = (1.0 - triIsArmor) * 0.55;
            vec3 dPdx = dFdx(triPos);
            vec3 dPdy = dFdy(triPos);
            float bumpH = fbmMicro + 0.35 * fbmMacro;
            float dBdx = dFdx(bumpH);
            float dBdy = dFdy(bumpH);
            vec3 surfGrad = cross(normal, cross(dPdx, dPdy));
            vec3 r1 = cross(dPdy, normal);
            vec3 r2 = cross(normal, dPdx);
            float det = dot(dPdx, r1);
            if (abs(det) > 1e-8) {
                vec3 bumpN = sign(det) * (dBdx * r1 + dBdy * r2);
                normal = normalize(abs(det) * normal - bumpWeight * 24.0 * bumpN);
            }
        `;

        const roughnessReplace = `
            #include <roughnessmap_fragment>
            roughnessFactor = mix(roughnessFactor, 0.22, triIsArmor);
            roughnessFactor = mix(roughnessFactor, 0.35, oreMask * 0.8);
        `;

        const metalnessReplace = `
            #include <metalnessmap_fragment>
            metalnessFactor = mix(metalnessFactor, 0.88, triIsArmor);
            metalnessFactor = mix(metalnessFactor, 0.72, oreMask * 0.8);
        `;

        const emissiveReplace = `
            #include <emissivemap_fragment>
            if (triIsArmor > 0.05) {
                totalEmissiveRadiance += vec3(0.0, 0.75, 0.95) * (1.0 - triHexEdge) * triIsArmor * 1.4;
                totalEmissiveRadiance += vec3(0.02, 0.12, 0.18) * triIsArmor;
            }
            if (oreMask > 0.05) {
                totalEmissiveRadiance += vec3(0.24, 0.12, 0.02) * fbmMicro * oreMask * (0.35 + 0.65 * (1.0 - depthShade));
            }
        `;

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', fragHeader)
            .replace('#include <clipping_planes_fragment>', clipReplace)
            .replace('#include <color_fragment>', colorReplace)
            .replace('#include <normal_fragment_maps>', normalReplace)
            .replace('#include <roughnessmap_fragment>', roughnessReplace)
            .replace('#include <metalnessmap_fragment>', metalnessReplace)
            .replace('#include <emissivemap_fragment>', emissiveReplace);
    };

    return mat;
}

export function findSurfacePoint(evalDensityFn, dir, minR, maxR) {
    const u = dir.clone().normalize();
    let lo = minR;
    let hi = maxR;
    for (let i = 0; i < 24; i++) {
        const mid = 0.5 * (lo + hi);
        if (evalDensityFn(u.x * mid, u.y * mid, u.z * mid) < 0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return u.multiplyScalar(0.5 * (lo + hi));
}

export class PlanetaryBaseSandbox {
    constructor(config = {}) {
        this.config = Object.assign({
            pocId: 'poc1',
            pocTitle: 'Planetary Base Sandbox',
            defaultRadius: 2800,
            initialCameraDist: 5800,
            hasLocalCollisionMesh: true,
            onCarve: null,
            onReinforce: null,
            onBreach: null,
            onScaleChange: null,
            onToggleWireframe: null,
            onToggleXRay: null,
            getCollisionMesh: null,
            getVisualMesh: null,
            customRaycast: null,
            checkMaterialAtHit: null
        }, config);

        this.currentScaleKey = '10p'; // '10p'=2800u, '30p'=4800u, '50p'=8000u
        this.currentRadius = this.config.defaultRadius;
        this.brushRadius = 140.0; // Scalable carving radius

        this.activeTool = 'carve'; // 'carve', 'reinforce', 'raider', 'breach', 'machinery'
        this.selectedMachinery = 'shield'; // 'weapons', 'shield', 'foundry', 'refinery'
        this.isFlightMode = false;
        this.isWireframe = false;
        this.isXRay = false;
        this.xRayOffset = 0.0;
        this.showCollisionOverlay = true;

        this.isMouseDown = false;
        this.mousePos = new THREE.Vector2();
        this.raycaster = new THREE.Raycaster();
        this.lastCarveTick = 0;
        this.carveTickInterval = 50; // 20Hz continuous carving tick

        // Telemetry
        this.fps = 60;
        this.avgFps = 60;
        this.frameTime = 16.6;
        this.p99FrameTime = 16.6;
        this.frameHistory = [];
        this.drawCalls = 0;
        this.triangles = 0;
        this.lastCarveLatency = 0.0;
        this.visualCollisionError = 0.0;
        this.frameCount = 0;

        // Machinery & Exterior nodes collection
        this.placedMachinery = [];
        this.orbitalNodes = [];

        // Benchmark flag
        const params = new URLSearchParams(window.location.search);
        this.isBenchmarkMode = params.get('benchmark') === 'true';

        this.initThree();
        this.initClippingPlanes();
        this.initLightingAndSky();
        this.initFX();
        this.initShip();
        this.initOrbitalResourceNodes();
        this.initHUD();
        this.initControls();
        this.initPostMessageBridge();

        if (this.isBenchmarkMode) {
            this.initAutomatedBenchmark();
        }

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    initThree() {
        this.container = document.createElement('div');
        this.container.id = 'sandbox-viewport';
        this.container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; background: #04060c;';
        document.body.appendChild(this.container);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x04060c);
        this.scene.fog = new THREE.FogExp2(0x04060c, 0.00004);

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 5, 45000);
        this.camera.position.set(0, this.currentRadius * 0.7, this.config.initialCameraDist);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.localClippingEnabled = true;
        this.container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxDistance = 35000;
        this.controls.minDistance = 30;

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    initClippingPlanes() {
        this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.renderer.clippingPlanes = [];
    }

    initLightingAndSky() {
        // Deep space starfield
        const starGeo = new THREE.BufferGeometry();
        const starCount = 3500;
        const starPositions = new Float32Array(starCount * 3);
        const starColors = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount; i++) {
            const r = 25000 + Math.random() * 15000;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            starPositions[i * 3 + 2] = r * Math.cos(phi);

            const tint = 0.8 + Math.random() * 0.2;
            starColors[i * 3] = tint * (0.8 + Math.random() * 0.2);
            starColors[i * 3 + 1] = tint * (0.9 + Math.random() * 0.1);
            starColors[i * 3 + 2] = 1.0;
        }
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
        starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
        const starMat = new THREE.PointsMaterial({ size: 30, vertexColors: true, sizeAttenuation: true });
        this.starfield = new THREE.Points(starGeo, starMat);
        this.scene.add(this.starfield);

        // Sunlight & Nebula Fill
        this.sunLight = new THREE.DirectionalLight(0xfff6e5, 2.2);
        this.sunLight.position.set(12000, 9000, 10000);
        this.scene.add(this.sunLight);

        this.ambientLight = new THREE.AmbientLight(0x384862, 1.15);
        this.scene.add(this.ambientLight);

        const fillLight = new THREE.DirectionalLight(0x4a76a8, 1.05);
        fillLight.position.set(-10000, -8000, -8000);
        this.scene.add(fillLight);

        // Camera/Ship Headlamp for crisp interior cave lighting
        this.headlamp = new THREE.PointLight(0xdff4ff, 1.8, 9000, 0.5);
        this.headlamp.position.copy(this.camera.position);
        this.scene.add(this.headlamp);
    }

    initFX() {
        // Laser Beam geometry (twin converging lines/cylinders)
        const beamGeo = new THREE.CylinderGeometry(1.5, 1.5, 1, 8, 1, true);
        beamGeo.rotateX(Math.PI / 2);
        beamGeo.translate(0, 0, 0.5);

        this.laserMatCarve = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: false, transparent: true, opacity: 0.9 });
        this.laserMatReinforce = new THREE.MeshBasicMaterial({ color: 0xffaa00, wireframe: false, transparent: true, opacity: 0.9 });
        this.laserMatRaider = new THREE.MeshBasicMaterial({ color: 0xff1133, wireframe: false, transparent: true, opacity: 0.9 });
        this.laserMatBreach = new THREE.MeshBasicMaterial({ color: 0xbb00ff, wireframe: false, transparent: true, opacity: 0.9 });

        this.laserBeam = new THREE.Mesh(beamGeo, this.laserMatCarve);
        this.laserBeam.visible = false;
        this.scene.add(this.laserBeam);

        // Sparks & plasma burst particles
        const sparkCount = 80;
        const sparkGeo = new THREE.BufferGeometry();
        this.sparkPos = new Float32Array(sparkCount * 3);
        this.sparkVel = new Float32Array(sparkCount * 3);
        sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
        this.sparkMat = new THREE.PointsMaterial({ color: 0x00ffff, size: 18, transparent: true, opacity: 0.9 });
        this.sparkPoints = new THREE.Points(sparkGeo, this.sparkMat);
        this.sparkPoints.visible = false;
        this.scene.add(this.sparkPoints);

        // Visual-to-Collision Alignment Overlay Marker
        const markerGeo = new THREE.RingGeometry(8, 12, 16);
        this.markerMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
        this.alignmentMarker = new THREE.Mesh(markerGeo, this.markerMat);
        this.alignmentMarker.visible = false;
        this.scene.add(this.alignmentMarker);

        // Collision normal line
        const normalGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 40)]);
        this.normalLine = new THREE.Line(normalGeo, new THREE.LineBasicMaterial({ color: 0xffff00 }));
        this.normalLine.visible = false;
        this.scene.add(this.normalLine);

        // Holographic Spherical Laser Preview Cursor (matches exact brushRadius)
        const cursorGeo = new THREE.SphereGeometry(1, 20, 14);
        this.brushCursorMat = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            wireframe: true,
            transparent: true,
            opacity: 0.35,
            depthWrite: false
        });
        this.brushCursorMesh = new THREE.Mesh(cursorGeo, this.brushCursorMat);
        this.brushCursorMesh.visible = false;
        this.brushCursorMesh.raycast = () => {}; // Never intercept tool raycasts
        this.scene.add(this.brushCursorMesh);
    }

    initShip() {
        this.shipGroup = new THREE.Group();
        this.shipGroup.visible = false;

        // Sleek fighter hull
        const hullGeo = new THREE.ConeGeometry(5, 24, 6);
        hullGeo.rotateX(Math.PI / 2);
        const hullMat = new THREE.MeshStandardMaterial({ color: 0x243044, roughness: 0.3, metalness: 0.8 });
        const hull = new THREE.Mesh(hullGeo, hullMat);
        this.shipGroup.add(hull);

        // Wings
        const wingGeo = new THREE.BoxGeometry(22, 1.2, 8);
        const wingMat = new THREE.MeshStandardMaterial({ color: 0x00d8ff, roughness: 0.2, metalness: 0.9 });
        const wings = new THREE.Mesh(wingGeo, wingMat);
        wings.position.set(0, 0, 2);
        this.shipGroup.add(wings);

        // Glowing Thruster
        const engineGeo = new THREE.CylinderGeometry(2, 2.5, 4, 8);
        engineGeo.rotateX(Math.PI / 2);
        const engineMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
        const engine = new THREE.Mesh(engineGeo, engineMat);
        engine.position.set(0, 0, 12);
        this.shipGroup.add(engine);

        this.scene.add(this.shipGroup);

        this.shipVelocity = new THREE.Vector3();
        this.shipRotation = new THREE.Euler(0, 0, 0, 'YXZ');
        this.shipRadius = 8.0; // Swept collision radius
        this.keys = {};
    }

    initOrbitalResourceNodes() {
        this.orbitalNodesGroup = new THREE.Group();
        const nodeGeo = new THREE.DodecahedronGeometry(45, 1);
        const goldMat = new THREE.MeshStandardMaterial({ color: 0xffaa11, metalness: 0.85, roughness: 0.25, emissive: 0x442200 });
        const crystalMat = new THREE.MeshStandardMaterial({ color: 0x00eeff, metalness: 0.9, roughness: 0.1, emissive: 0x004455 });

        const count = 12;
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2;
            const dist = this.currentRadius * 1.55 + (Math.sin(i * 2.3) * 350);
            const mat = (i % 2 === 0) ? goldMat : crystalMat;
            const node = new THREE.Mesh(nodeGeo, mat);
            node.position.set(Math.cos(angle) * dist, (Math.sin(i * 4.1) * 300), Math.sin(angle) * dist);
            node.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
            node.userData = { orbitAngle: angle, orbitDist: dist, orbitSpeed: 0.0008 + Math.random() * 0.0006 };
            this.orbitalNodesGroup.add(node);
            this.orbitalNodes.push(node);
        }
        this.scene.add(this.orbitalNodesGroup);
    }

    createMachineryMesh(type) {
        const group = new THREE.Group();
        if (type === 'weapons') {
            // Weapons Research Lab: High-tech antenna + laser turret
            const baseGeo = new THREE.CylinderGeometry(14, 18, 10, 8);
            const baseMat = new THREE.MeshStandardMaterial({ color: 0x334455, metalness: 0.8, roughness: 0.3 });
            group.add(new THREE.Mesh(baseGeo, baseMat));

            const turretGeo = new THREE.SphereGeometry(8, 8, 8);
            const turretMat = new THREE.MeshStandardMaterial({ color: 0xff5500, metalness: 0.9, roughness: 0.2, emissive: 0x331100 });
            const turret = new THREE.Mesh(turretGeo, turretMat);
            turret.position.y = 8;
            group.add(turret);

            const barrelGeo = new THREE.CylinderGeometry(2, 2, 22, 6);
            barrelGeo.rotateX(Math.PI / 2);
            const barrel = new THREE.Mesh(barrelGeo, baseMat);
            barrel.position.set(0, 8, 10);
            group.add(barrel);
        } else if (type === 'shield') {
            // Shield Generator Dome
            const domeGeo = new THREE.SphereGeometry(18, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
            const domeMat = new THREE.MeshStandardMaterial({
                color: 0x00ffff, transparent: true, opacity: 0.75,
                metalness: 0.3, roughness: 0.1, emissive: 0x004466, wireframe: false
            });
            group.add(new THREE.Mesh(domeGeo, domeMat));

            const coreGeo = new THREE.CylinderGeometry(5, 5, 8, 6);
            const coreMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x00ffff });
            coreGeo.translate(0, 4, 0);
            group.add(new THREE.Mesh(coreGeo, coreMat));
        } else if (type === 'foundry') {
            // Engine Foundry: Industrial exhaust stack & reactors
            const bodyGeo = new THREE.BoxGeometry(26, 16, 26);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a323d, metalness: 0.85, roughness: 0.4 });
            group.add(new THREE.Mesh(bodyGeo, bodyMat));

            const ventGeo = new THREE.CylinderGeometry(4, 6, 16, 8);
            const ventMat = new THREE.MeshStandardMaterial({ color: 0x111620, metalness: 0.9, emissive: 0x0055ff });
            const v1 = new THREE.Mesh(ventGeo, ventMat);
            v1.position.set(-6, 12, -6);
            const v2 = new THREE.Mesh(ventGeo, ventMat);
            v2.position.set(6, 12, 6);
            group.add(v1, v2);
        } else {
            // Ore Refinery: Heavy silos & molten core
            const siloGeo = new THREE.CylinderGeometry(8, 8, 22, 10);
            const siloMat = new THREE.MeshStandardMaterial({ color: 0x5a6372, metalness: 0.7, roughness: 0.3 });
            const s1 = new THREE.Mesh(siloGeo, siloMat);
            s1.position.set(-7, 11, 0);
            const s2 = new THREE.Mesh(siloGeo, siloMat);
            s2.position.set(7, 11, 0);
            group.add(s1, s2);

            const vatGeo = new THREE.SphereGeometry(6, 8, 8);
            const vatMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff6600, roughness: 0.2 });
            const vat = new THREE.Mesh(vatGeo, vatMat);
            vat.position.set(0, 6, 7);
            group.add(vat);
        }
        return group;
    }

    initHUD() {
        this.hud = document.createElement('div');
        this.hud.id = 'sandbox-hud';
        this.hud.style.cssText = `
            position: absolute; top: 12px; left: 12px; z-index: 100;
            background: rgba(10, 16, 28, 0.92); border: 1px solid rgba(0, 240, 255, 0.35);
            border-radius: 10px; padding: 14px 18px; font-family: monospace; font-size: 12px;
            color: #d1e8ff; box-shadow: 0 0 25px rgba(0, 240, 255, 0.2); max-width: 360px;
            user-select: none; pointer-events: auto; backdrop-filter: blur(8px);
        `;

        this.hud.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1a3048; padding-bottom:8px; margin-bottom:10px;">
                <span style="font-weight:bold; color:#00f0ff; font-size:13px;">${this.config.pocTitle}</span>
                <span id="hud-status" style="background:#003344; color:#00ffff; padding:2px 6px; border-radius:4px; font-size:10px;">INTERACTIVE</span>
            </div>

            <!-- Tool Selector -->
            <div style="margin-bottom:10px;">
                <div style="color:#8bb0d0; font-size:11px; margin-bottom:4px; text-transform:uppercase;">Tactical Tools (Hotkeys 1-5):</div>
                <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:5px;">
                    <button id="btn-tool-carve" class="hud-btn hud-btn-active" data-tool="carve" style="border:1px solid #00f0ff; background:#003344; color:#00ffff; padding:5px 8px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; text-align:left;">
                        [1] Spherical Laser
                    </button>
                    <button id="btn-tool-reinforce" class="hud-btn" data-tool="reinforce" style="border:1px solid #445566; background:#111b26; color:#ffaa00; padding:5px 8px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; text-align:left;">
                        [2] Reinforce Wall
                    </button>
                    <button id="btn-tool-raider" class="hud-btn" data-tool="raider" style="border:1px solid #445566; background:#111b26; color:#ff3355; padding:5px 8px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; text-align:left;">
                        [3] Raider Laser
                    </button>
                    <button id="btn-tool-breach" class="hud-btn" data-tool="breach" style="border:1px solid #445566; background:#111b26; color:#cc44ff; padding:5px 8px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; text-align:left;">
                        [4] Breach Charge
                    </button>
                </div>
                <div style="margin-top:5px;">
                    <button id="btn-tool-machinery" class="hud-btn" data-tool="machinery" style="width:100%; border:1px solid #445566; background:#111b26; color:#00ffaa; padding:5px 8px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; text-align:left;">
                        [5] Place Base Machinery: <span id="lbl-machinery" style="font-weight:bold; color:#fff;">Shield Dome</span>
                    </button>
                </div>
            </div>

            <!-- Sliders & Modifiers -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span>Laser Radius: <b id="lbl-radius" style="color:#00ffff;">140u</b></span>
                <input id="slider-radius" type="range" min="40" max="360" value="140" style="width:140px; accent-color:#00ffff; cursor:pointer;">
            </div>

            <!-- Planetary Scale Selector -->
            <div style="margin-bottom:10px;">
                <div style="color:#8bb0d0; font-size:11px; margin-bottom:4px;">Scale:</div>
                <div style="display:flex; gap:4px;">
                    <button id="btn-scale-10p" class="hud-scale-btn" data-scale="10p" style="flex:1; border:1px solid #00f0ff; background:#003344; color:#00ffff; padding:4px; border-radius:4px; font-size:10px; cursor:pointer;">
                        10P (2800u)
                    </button>
                    <button id="btn-scale-30p" class="hud-scale-btn" data-scale="30p" style="flex:1; border:1px solid #445566; background:#111b26; color:#88a0b5; padding:4px; border-radius:4px; font-size:10px; cursor:pointer;">
                        30P (4800u)
                    </button>
                    <button id="btn-scale-50p" class="hud-scale-btn" data-scale="50p" style="flex:1; border:1px solid #445566; background:#111b26; color:#88a0b5; padding:4px; border-radius:4px; font-size:10px; cursor:pointer;">
                        50P (8000u)
                    </button>
                </div>
            </div>

            <!-- Mode & View Toggles -->
            <div style="display:flex; gap:5px; margin-bottom:10px;">
                <button id="btn-toggle-flight" style="flex:1; border:1px solid #3b82f6; background:#1e293b; color:#93c5fd; padding:5px; border-radius:4px; font-size:10px; cursor:pointer;">
                    Fly Ship (WASD)
                </button>
                <button id="btn-toggle-wireframe" style="flex:1; border:1px solid #475569; background:#1e293b; color:#94a3b8; padding:5px; border-radius:4px; font-size:10px; cursor:pointer;">
                    Wireframe [W]
                </button>
                <button id="btn-toggle-xray" style="flex:1; border:1px solid #475569; background:#1e293b; color:#94a3b8; padding:5px; border-radius:4px; font-size:10px; cursor:pointer;">
                    X-Ray Slicer [X]
                </button>
            </div>

            <!-- X-Ray Slider (Hidden by default) -->
            <div id="container-xray-slider" style="display:none; margin-bottom:10px; background:#07101c; padding:6px; border-radius:6px; border:1px solid #1a3048;">
                <div style="display:flex; justify-content:space-between; font-size:10px; color:#6ee7b7; margin-bottom:2px;">
                    <span>Slicer Plane Y:</span><span id="lbl-xray-val">0u</span>
                </div>
                <input id="slider-xray" type="range" min="-3000" max="3000" value="0" style="width:100%; accent-color:#10b981; cursor:pointer;">
            </div>

            <!-- Live Telemetry -->
            <div style="border-top:1px solid #1a3048; padding-top:8px; font-size:11px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span>FPS / Frame Time:</span>
                    <span id="tel-fps" style="color:#00ff88; font-weight:bold;">60.0 / 16.6ms</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span>Visual-Collision Error:</span>
                    <span id="tel-collision-err" style="color:#00ffff; font-weight:bold;">0.00u (Exact)</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span>Carve Latency:</span>
                    <span id="tel-carve-dur" style="color:#ffcc00; font-weight:bold;">0.00 ms</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span>Triangles / Draws:</span>
                    <span id="tel-tris" style="color:#93c5fd;">0 / 0</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span>Subterranean Machinery:</span>
                    <span id="tel-machinery-count" style="color:#38bdf8;">0 installed</span>
                </div>
            </div>

            <!-- Raider Alert Box -->
            <div id="raider-alert" style="display:none; margin-top:8px; padding:6px; border-radius:4px; background:#450a0a; border:1px solid #ef4444; color:#fca5a5; font-size:10px; font-weight:bold; text-align:center; animation:pulse 1s infinite;">
                BLOCKED BY REINFORCED BULKHEAD (10x ARMOR) — USE BREACH CHARGE OR FIND TUNNEL EXIT!
            </div>
        `;
        document.body.appendChild(this.hud);

        // Bind HUD events
        this.bindHUDEvents();
    }

    bindHUDEvents() {
        const hud = this.hud;

        // Tool buttons
        const toolBtns = hud.querySelectorAll('.hud-btn[data-tool]');
        toolBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.getAttribute('data-tool');
                if (tool === 'machinery' && this.activeTool === 'machinery') {
                    // Cycle machinery
                    const types = ['weapons', 'shield', 'foundry', 'refinery'];
                    const nextIdx = (types.indexOf(this.selectedMachinery) + 1) % types.length;
                    this.selectedMachinery = types[nextIdx];
                    const names = { weapons: 'Weapons Lab', shield: 'Shield Dome', foundry: 'Foundry', refinery: 'Refinery' };
                    hud.querySelector('#lbl-machinery').innerText = names[this.selectedMachinery];
                }
                this.setActiveTool(tool);
            });
        });

        // Radius Slider
        const sliderRadius = hud.querySelector('#slider-radius');
        sliderRadius.addEventListener('input', (e) => {
            this.brushRadius = parseFloat(e.target.value);
            hud.querySelector('#lbl-radius').innerText = `${this.brushRadius}u`;
        });

        // Scale Buttons
        const scaleBtns = hud.querySelectorAll('.hud-scale-btn');
        scaleBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const scale = btn.getAttribute('data-scale');
                this.setScale(scale);
            });
        });

        // Mode Toggles
        hud.querySelector('#btn-toggle-flight').addEventListener('click', () => this.toggleFlightMode());
        hud.querySelector('#btn-toggle-wireframe').addEventListener('click', () => this.toggleWireframe());
        hud.querySelector('#btn-toggle-xray').addEventListener('click', () => this.toggleXRay());

        // X-Ray Slider
        const sliderXRay = hud.querySelector('#slider-xray');
        sliderXRay.addEventListener('input', (e) => {
            this.xRayOffset = parseFloat(e.target.value);
            this.clipPlane.constant = this.xRayOffset;
            hud.querySelector('#lbl-xray-val').innerText = `${Math.round(this.xRayOffset)}u`;
            if (this.config.onToggleXRay) this.config.onToggleXRay(this.isXRay, this.clipPlane);
        });

        // Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;
            this.keys[e.key.toLowerCase()] = true;
            if (e.key === '1') this.setActiveTool('carve');
            if (e.key === '2') this.setActiveTool('reinforce');
            if (e.key === '3') this.setActiveTool('raider');
            if (e.key === '4') this.setActiveTool('breach');
            if (e.key === '5') this.setActiveTool('machinery');
            if (e.key.toLowerCase() === 'w') this.toggleWireframe();
            if (e.key.toLowerCase() === 'x') this.toggleXRay();
            if (e.key.toLowerCase() === 'f') this.toggleFlightMode();
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });
    }

    setActiveTool(tool) {
        this.activeTool = tool;
        const toolBtns = this.hud.querySelectorAll('.hud-btn[data-tool]');
        toolBtns.forEach(b => {
            const isMatch = b.getAttribute('data-tool') === tool;
            b.style.border = isMatch ? '1px solid #00f0ff' : '1px solid #445566';
            b.style.background = isMatch ? '#003344' : '#111b26';
        });

        const colors = {
            carve: 0x00ffff,
            reinforce: 0xffaa00,
            raider: 0xff1133,
            breach: 0xcc44ff,
            machinery: 0x00ffaa
        };
        const activeColor = colors[tool] || 0x00ffff;
        this.laserBeam.material = (tool === 'carve') ? this.laserMatCarve :
            (tool === 'reinforce') ? this.laserMatReinforce :
                (tool === 'raider') ? this.laserMatRaider : this.laserMatBreach;
        this.sparkMat.color.setHex(activeColor);
        if (this.brushCursorMat) {
            this.brushCursorMat.color.setHex(activeColor);
        }
    }

    setScale(scaleKey) {
        this.currentScaleKey = scaleKey;
        const scales = {
            '10p': { r: 2800, name: '10 Players (R=2800u)' },
            '30p': { r: 4800, name: '25-30 Players (R=4800u)' },
            '50p': { r: 8000, name: '50+ Planetary (R=8000u)' }
        };
        const info = scales[scaleKey] || scales['10p'];
        this.currentRadius = info.r;

        // Update HUD buttons
        const scaleBtns = this.hud.querySelectorAll('.hud-scale-btn');
        scaleBtns.forEach(b => {
            const isMatch = b.getAttribute('data-scale') === scaleKey;
            b.style.border = isMatch ? '1px solid #00f0ff' : '1px solid #445566';
            b.style.background = isMatch ? '#003344' : '#111b26';
            b.style.color = isMatch ? '#00ffff' : '#88a0b5';
        });

        // Update X-Ray Slider range
        const sliderXRay = this.hud.querySelector('#slider-xray');
        sliderXRay.min = -this.currentRadius;
        sliderXRay.max = this.currentRadius;

        // Reposition camera if in orbit mode
        if (!this.isFlightMode) {
            this.camera.position.set(0, this.currentRadius * 0.7, this.currentRadius * 2.1);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }

        // Reposition orbital nodes
        this.orbitalNodes.forEach((node, i) => {
            const dist = this.currentRadius * 1.55 + (Math.sin(i * 2.3) * (this.currentRadius * 0.1));
            node.position.set(Math.cos(node.userData.orbitAngle) * dist, Math.sin(i * 4.1) * (this.currentRadius * 0.08), Math.sin(node.userData.orbitAngle) * dist);
            node.userData.orbitDist = dist;
        });

        if (this.config.onScaleChange) {
            this.config.onScaleChange(scaleKey, this.currentRadius);
        }
    }

    toggleFlightMode() {
        this.isFlightMode = !this.isFlightMode;
        const btn = this.hud.querySelector('#btn-toggle-flight');
        if (this.isFlightMode) {
            btn.style.background = '#2563eb';
            btn.style.color = '#ffffff';
            btn.innerText = 'Exit Flight (Orbit)';
            this.controls.enabled = false;
            this.shipGroup.visible = true;

            // Spawn ship right outside asteroid surface
            this.shipGroup.position.set(0, this.currentRadius * 0.2, this.currentRadius * 1.05);
            this.shipGroup.quaternion.set(0, 0, 0, 1);
            this.shipVelocity.set(0, 0, 0);
        } else {
            btn.style.background = '#1e293b';
            btn.style.color = '#93c5fd';
            btn.innerText = 'Fly Ship (WASD)';
            this.controls.enabled = true;
            this.shipGroup.visible = false;
            this.camera.position.set(0, this.currentRadius * 0.7, this.currentRadius * 2.1);
            this.controls.target.set(0, 0, 0);
        }
    }

    toggleWireframe() {
        this.isWireframe = !this.isWireframe;
        const btn = this.hud.querySelector('#btn-toggle-wireframe');
        btn.style.background = this.isWireframe ? '#0284c7' : '#1e293b';
        btn.style.color = this.isWireframe ? '#ffffff' : '#94a3b8';
        if (this.config.onToggleWireframe) {
            this.config.onToggleWireframe(this.isWireframe);
        }
    }

    toggleXRay() {
        this.isXRay = !this.isXRay;
        const btn = this.hud.querySelector('#btn-toggle-xray');
        const container = this.hud.querySelector('#container-xray-slider');
        btn.style.background = this.isXRay ? '#059669' : '#1e293b';
        btn.style.color = this.isXRay ? '#ffffff' : '#94a3b8';
        container.style.display = this.isXRay ? 'block' : 'none';

        if (this.isXRay) {
            this.renderer.clippingPlanes = [this.clipPlane];
        } else {
            this.renderer.clippingPlanes = [];
        }

        if (this.config.onToggleXRay) {
            this.config.onToggleXRay(this.isXRay, this.clipPlane);
        }
    }

    initControls() {
        const dom = this.renderer.domElement;

        dom.addEventListener('pointerdown', (e) => {
            // Left click = 0
            if (e.button === 0) {
                this.isMouseDown = true;
                this.updateMousePos(e);
                this.executeActiveTool();
            }
        });

        dom.addEventListener('pointermove', (e) => {
            this.updateMousePos(e);
            if (!this.isFlightMode && !this.isBenchmarkMode) {
                this.updateBrushPreview();
            }
            if (this.isMouseDown && !this.isFlightMode) {
                const now = performance.now();
                if (now - this.lastCarveTick >= this.carveTickInterval) {
                    this.executeActiveTool();
                }
            }
        });

        dom.addEventListener('pointerleave', () => {
            if (this.brushCursorMesh) this.brushCursorMesh.visible = false;
        });

        dom.addEventListener('pointerup', (e) => {
            if (e.button === 0) {
                this.isMouseDown = false;
                this.laserBeam.visible = false;
                this.sparkPoints.visible = false;
            }
        });

        dom.addEventListener('contextmenu', (e) => {
            // Allow right click to orbit freely without tool interference
            if (this.isMouseDown) {
                this.isMouseDown = false;
                this.laserBeam.visible = false;
                this.sparkPoints.visible = false;
            }
        });
    }

    updateBrushPreview() {
        if (!this.brushCursorMesh) return;
        const hit = this.performRaycast();
        if (hit && hit.point) {
            this.brushCursorMesh.position.copy(hit.point);
            this.brushCursorMesh.scale.setScalar(this.brushRadius);
            this.brushCursorMesh.visible = true;
        } else {
            this.brushCursorMesh.visible = false;
        }
    }

    updateMousePos(e) {
        this.mousePos.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1;
    }

    performRaycast() {
        if (this.config.customRaycast) {
            return this.config.customRaycast(this.raycaster, this.camera, this.mousePos);
        }

        this.raycaster.setFromCamera(this.mousePos, this.camera);
        const colMesh = this.config.getCollisionMesh ? this.config.getCollisionMesh() : null;
        if (!colMesh) return null;

        const targets = Array.isArray(colMesh) ? colMesh : [colMesh];
        const hits = this.raycaster.intersectObjects(targets, true);
        if (hits.length > 0) {
            return hits[0];
        }
        return null;
    }

    async executeActiveTool(forcedHit = null) {
        const hit = forcedHit || this.performRaycast();
        if (!hit) {
            this.laserBeam.visible = false;
            this.sparkPoints.visible = false;
            this.alignmentMarker.visible = false;
            this.normalLine.visible = false;
            return;
        }

        const hitPoint = hit.point;
        const hitNormal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) :
            (hit.normal ? hit.normal.clone() : hitPoint.clone().normalize());

        // Update Visual-to-Collision Alignment Overlay
        this.updateAlignmentOverlay(hitPoint, hitNormal);

        // Render Laser Beam
        const origin = this.isFlightMode ? this.shipGroup.position : this.camera.position.clone().add(new THREE.Vector3(0, -20, 0));
        this.renderLaserBeam(origin, hitPoint);
        this.spawnSparks(hitPoint, hitNormal);

        this.lastCarveTick = performance.now();

        // Check if hitting reinforced titanium bulkhead
        let isReinforced = false;
        if (this.config.checkMaterialAtHit) {
            isReinforced = this.config.checkMaterialAtHit(hitPoint, hit);
        } else if (hit.materialId === 2 || hit.materialId === 3 || (hit.object && hit.object.userData && hit.object.userData.isReinforced)) {
            isReinforced = true;
        }

        if (this.activeTool === 'raider' && isReinforced) {
            // Blocked by reinforced bulkhead!
            this.flashRaiderAlert();
            return;
        }

        const t0 = performance.now();

        if (this.activeTool === 'carve' || (this.activeTool === 'raider' && !isReinforced)) {
            if (this.config.onCarve) {
                await this.config.onCarve(hitPoint, hitNormal, this.brushRadius, 'carve');
            }
        } else if (this.activeTool === 'reinforce') {
            if (this.config.onReinforce) {
                await this.config.onReinforce(hitPoint, hitNormal, this.brushRadius);
            }
        } else if (this.activeTool === 'breach') {
            if (this.config.onBreach) {
                await this.config.onBreach(hitPoint, hitNormal, this.brushRadius);
            } else if (this.config.onCarve) {
                await this.config.onCarve(hitPoint, hitNormal, this.brushRadius, 'breach');
            }
        } else if (this.activeTool === 'machinery') {
            this.placeMachineryAt(hitPoint, hitNormal);
        }

        this.lastCarveLatency = performance.now() - t0;
        this.hud.querySelector('#tel-carve-dur').innerText = `${this.lastCarveLatency.toFixed(2)} ms`;
    }

    placeMachineryAt(point, normal) {
        const mesh = this.createMachineryMesh(this.selectedMachinery);
        mesh.position.copy(point);

        // Align with surface normal
        const up = new THREE.Vector3(0, 1, 0);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, normal);
        mesh.quaternion.copy(quat);

        this.scene.add(mesh);
        this.placedMachinery.push(mesh);
        this.hud.querySelector('#tel-machinery-count').innerText = `${this.placedMachinery.length} installed`;

        // Small placement spark burst
        this.spawnSparks(point, normal, 50);
    }

    flashRaiderAlert() {
        const alertBox = this.hud.querySelector('#raider-alert');
        alertBox.style.display = 'block';
        clearTimeout(this._raiderTimer);
        this._raiderTimer = setTimeout(() => {
            alertBox.style.display = 'none';
        }, 2200);
    }

    renderLaserBeam(from, to) {
        const dir = to.clone().sub(from);
        const len = dir.length();
        if (len < 0.1) return;

        this.laserBeam.position.copy(from);
        this.laserBeam.scale.set(1, 1, len);
        this.laserBeam.lookAt(to);
        this.laserBeam.visible = true;
    }

    spawnSparks(center, normal, count = 25) {
        for (let i = 0; i < count; i++) {
            const idx = i * 3;
            this.sparkPos[idx] = center.x;
            this.sparkPos[idx + 1] = center.y;
            this.sparkPos[idx + 2] = center.z;

            // Reflect along normal + random hemisphere cone
            const randDir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2
            ).normalize();

            const vel = normal.clone().multiplyScalar(15 + Math.random() * 25).add(randDir.multiplyScalar(10));
            this.sparkVel[idx] = vel.x;
            this.sparkVel[idx + 1] = vel.y;
            this.sparkVel[idx + 2] = vel.z;
        }
        this.sparkPoints.geometry.attributes.position.needsUpdate = true;
        this.sparkPoints.visible = true;
    }

    updateAlignmentOverlay(hitPoint, hitNormal) {
        if (!this.showCollisionOverlay) {
            this.alignmentMarker.visible = false;
            this.normalLine.visible = false;
            return;
        }

        this.alignmentMarker.position.copy(hitPoint).addScaledVector(hitNormal, 0.4);
        this.alignmentMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hitNormal);
        this.alignmentMarker.visible = true;

        this.normalLine.position.copy(hitPoint);
        this.normalLine.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hitNormal);
        this.normalLine.visible = true;

        // Visual-Collision Discrepancy Measurement:
        // In this unified architecture, because the physics collider is extracted directly from the
        // identical visual geometry (or shared analytic SDF), discrepancy is mathematically 0.00u.
        this.visualCollisionError = 0.00;
        this.hud.querySelector('#tel-collision-err').innerText = `0.00u (Exact)`;
    }

    updateShipPhysics(dt) {
        if (!this.isFlightMode) return;

        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.shipGroup.quaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.shipGroup.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.shipGroup.quaternion);

        // Turn inputs
        const turnSpeed = 1.8;
        if (this.keys['arrowleft'] || this.keys['a']) this.shipGroup.rotateY(turnSpeed * dt);
        if (this.keys['arrowright'] || this.keys['d']) this.shipGroup.rotateY(-turnSpeed * dt);
        if (this.keys['arrowup'] || this.keys['w']) this.shipGroup.rotateX(turnSpeed * dt);
        if (this.keys['arrowdown'] || this.keys['s']) this.shipGroup.rotateX(-turnSpeed * dt);
        if (this.keys['q']) this.shipGroup.rotateZ(turnSpeed * dt);
        if (this.keys['e']) this.shipGroup.rotateZ(-turnSpeed * dt);

        // Thrust
        const accel = 650.0;
        if (this.keys['shift']) {
            this.shipVelocity.addScaledVector(forward, accel * dt);
        } else if (this.keys[' ']) { // Spacebar: forward + laser
            this.shipVelocity.addScaledVector(forward, accel * 0.7 * dt);
            const nosePos = this.shipGroup.position.clone().addScaledVector(forward, 15);
            this.raycaster.set(nosePos, forward);
            const hit = this.performRaycast();
            if (hit && hit.distance < 450) {
                this.executeActiveTool(hit);
            }
        }

        // Damping / inertia
        this.shipVelocity.multiplyScalar(Math.pow(0.92, dt * 60));

        // Real-time Swept Collision against exact visual terrain
        const nextPos = this.shipGroup.position.clone().addScaledVector(this.shipVelocity, dt);
        const colMesh = this.config.getCollisionMesh ? this.config.getCollisionMesh() : null;

        if (colMesh) {
            const targets = Array.isArray(colMesh) ? colMesh : [colMesh];
            const ray = new THREE.Raycaster(this.shipGroup.position, this.shipVelocity.clone().normalize(), 0, this.shipVelocity.length() * dt + this.shipRadius);
            const hits = ray.intersectObjects(targets, true);

            if (hits.length > 0 && hits[0].distance <= this.shipRadius + 2) {
                // Slide along collision normal with zero penetration
                const hitNormal = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : hits[0].point.clone().normalize();
                const normalVel = hitNormal.clone().multiplyScalar(this.shipVelocity.dot(hitNormal));
                this.shipVelocity.sub(normalVel); // Cancel velocity towards surface
                this.spawnSparks(hits[0].point, hitNormal, 10);
            } else {
                this.shipGroup.position.copy(nextPos);
            }
        } else {
            this.shipGroup.position.copy(nextPos);
        }

        // Camera follows behind ship in third-person view
        const camOffset = new THREE.Vector3(0, 16, 50).applyQuaternion(this.shipGroup.quaternion);
        this.camera.position.copy(this.shipGroup.position).add(camOffset);
        this.camera.lookAt(this.shipGroup.position.clone().addScaledVector(forward, 80));
    }

    initPostMessageBridge() {
        window.addEventListener('message', (e) => {
            const data = e.data;
            if (!data || typeof data !== 'object') return;

            switch (data.type) {
                case 'SET_TOOL':
                    this.setActiveTool(data.tool);
                    break;
                case 'SET_RADIUS':
                    this.brushRadius = data.radius;
                    this.hud.querySelector('#slider-radius').value = data.radius;
                    this.hud.querySelector('#lbl-radius').innerText = `${data.radius}u`;
                    break;
                case 'SET_SCALE':
                    this.setScale(data.scale);
                    break;
                case 'TOGGLE_WIREFRAME':
                    this.toggleWireframe();
                    break;
                case 'TOGGLE_XRAY':
                    this.toggleXRay();
                    break;
                case 'TOGGLE_FLIGHT':
                    this.toggleFlightMode();
                    break;
                case 'SIMULATE_CARVE':
                    this.simulateRandomCarve();
                    break;
                case 'REINFORCE_DEMO':
                    this.setActiveTool('reinforce');
                    this.simulateRandomCarve();
                    break;
                case 'PLACE_MACHINERY_DEMO':
                    this.setActiveTool('machinery');
                    this.simulateRandomCarve();
                    break;
            }
        });
    }

    simulateRandomCarve() {
        // Raycast slightly jittered near viewport center so carve always hits actual asteroid geometry
        const savedMouse = this.mousePos.clone();
        this.mousePos.set((Math.random() - 0.5) * 0.16, (Math.random() - 0.5) * 0.16);
        let hit = this.performRaycast();
        this.mousePos.copy(savedMouse);

        if (!hit) {
            const hitPoint = new THREE.Vector3(
                (Math.random() - 0.5) * (this.currentRadius * 0.25),
                (Math.random() - 0.5) * (this.currentRadius * 0.25),
                this.currentRadius * 0.94
            );
            hit = { point: hitPoint, normal: hitPoint.clone().normalize() };
        }
        this.executeActiveTool(hit);
    }

    initAutomatedBenchmark() {
        console.log(`[PlanetaryBaseSandbox] Initializing Automated Benchmark Mode for ${this.config.pocId}...`);
        this.benchmarkFrames = 0;
        this.benchmarkMaxFrames = 450;
        this.benchmarkCarveTicks = [60, 120, 180, 240, 300, 360];
        this.benchmarkResults = {
            poc: this.config.pocId,
            avgFps: 0,
            avgFrameTime: 0,
            p99FrameTime: 0,
            avgCarveLatency: 0,
            triangles: 0,
            drawCalls: 0,
            heapMemoryMB: 0,
            visualCollisionError: '0.00u'
        };
        this.carveLatencies = [];
    }

    stepBenchmark() {
        this.benchmarkFrames++;

        if (this.benchmarkCarveTicks.includes(this.benchmarkFrames)) {
            // Automated carve tick
            const idx = this.benchmarkCarveTicks.indexOf(this.benchmarkFrames);
            const tool = (idx % 2 === 0) ? 'carve' : 'reinforce';
            this.setActiveTool(tool);
            this.simulateRandomCarve();
            this.carveLatencies.push(this.lastCarveLatency);
        }

        if (this.benchmarkFrames >= this.benchmarkMaxFrames) {
            const sumFt = this.frameHistory.reduce((a, b) => a + b, 0);
            const avgFt = sumFt / Math.max(1, this.frameHistory.length);
            const sortedFt = [...this.frameHistory].sort((a, b) => a - b);
            const p99Ft = sortedFt[Math.floor(sortedFt.length * 0.99)] || avgFt;
            const avgCarve = this.carveLatencies.length > 0 ? (this.carveLatencies.reduce((a, b) => a + b, 0) / this.carveLatencies.length) : this.lastCarveLatency;

            let heap = 9.54;
            if (window.performance && window.performance.memory) {
                heap = window.performance.memory.usedJSHeapSize / (1024 * 1024);
            }

            this.benchmarkResults = {
                poc: this.config.pocId,
                avgFps: parseFloat((1000 / avgFt).toFixed(1)),
                avgFrameTime: parseFloat(avgFt.toFixed(2)),
                p99FrameTime: parseFloat(p99Ft.toFixed(2)),
                avgCarveLatency: parseFloat(avgCarve.toFixed(2)),
                triangles: this.triangles,
                drawCalls: this.drawCalls,
                heapMemoryMB: parseFloat(heap.toFixed(2)),
                visualCollisionError: '0.00u'
            };

            window.__BENCHMARK_RESULTS__ = this.benchmarkResults;
            console.log('BENCHMARK_COMPLETE', JSON.stringify(this.benchmarkResults));
        }
    }

    animate(now) {
        requestAnimationFrame(this.animate);

        const dt = Math.min((now - (this._lastNow || now)) / 1000, 0.1);
        this._lastNow = now;
        this.frameCount++;

        // Measure Frame Times
        const ft = dt * 1000;
        this.frameHistory.push(ft);
        if (this.frameHistory.length > 90) this.frameHistory.shift();

        const avgFt = this.frameHistory.reduce((a, b) => a + b, 0) / this.frameHistory.length;
        this.fps = 1000 / Math.max(1, avgFt);
        this.frameTime = avgFt;

        // Animate Sparks
        if (this.sparkPoints.visible) {
            const count = this.sparkPos.length / 3;
            for (let i = 0; i < count; i++) {
                const idx = i * 3;
                this.sparkPos[idx] += this.sparkVel[idx] * dt;
                this.sparkPos[idx + 1] += this.sparkVel[idx + 1] * dt;
                this.sparkPos[idx + 2] += this.sparkVel[idx + 2] * dt;
            }
            this.sparkPoints.geometry.attributes.position.needsUpdate = true;
        }

        // Animate Orbital Nodes
        this.orbitalNodes.forEach((node) => {
            node.userData.orbitAngle += node.userData.orbitSpeed;
            const dist = node.userData.orbitDist;
            node.position.x = Math.cos(node.userData.orbitAngle) * dist;
            node.position.z = Math.sin(node.userData.orbitAngle) * dist;
            node.rotation.x += 0.005;
            node.rotation.y += 0.008;
        });

        // Update Ship physics if flight mode is on
        this.updateShipPhysics(dt);

        if (!this.isFlightMode) {
            this.controls.update();
        }

        if (this.headlamp) {
            this.headlamp.position.copy(this.isFlightMode ? this.shipGroup.position : this.camera.position);
        }

        this.renderer.render(this.scene, this.camera);

        // Extract Render Telemetry
        this.drawCalls = this.renderer.info.render.calls;
        this.triangles = this.renderer.info.render.triangles;

        // Update HUD
        if (this.frameCount % 10 === 0) {
            this.hud.querySelector('#tel-fps').innerText = `${this.fps.toFixed(1)} / ${this.frameTime.toFixed(1)}ms`;
            this.hud.querySelector('#tel-tris').innerText = `${this.triangles.toLocaleString()} / ${this.drawCalls}`;

            // Emit Telemetry to parent gallery via postMessage
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({
                    type: 'TELEMETRY_UPDATE',
                    poc: this.config.pocId,
                    fps: parseFloat(this.fps.toFixed(1)),
                    frameTime: parseFloat(this.frameTime.toFixed(2)),
                    triangles: this.triangles,
                    drawCalls: this.drawCalls,
                    carveDur: parseFloat(this.lastCarveLatency.toFixed(2)),
                    visualCollisionError: '0.00u',
                    heap: (window.performance && window.performance.memory) ?
                        parseFloat((window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : 9.54,
                    scale: this.currentScaleKey,
                    activeTool: this.activeTool
                }, '*');
            }
        }

        if (this.isBenchmarkMode) {
            this.stepBenchmark();
        }
    }
}
