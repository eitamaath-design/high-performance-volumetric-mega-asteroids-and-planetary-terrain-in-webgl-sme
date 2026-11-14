# Technical Report: Option 3 — Hybrid Planetary Clipmap Crust + Entrance Portals + Cavern Manifolds

## 1. Executive Summary & Rockets Mega-Scale Problem
In *Rockets Managed by Anti-Gravity*, planetary bodies span massive dimensions ($R = 2800\text{u}\text{--}8000\text{u}+$, hosting 20–50+ simultaneous pilots). A uniform volumetric grid across an $8000\text{u}$ radius requires trillions of voxels, causing catastrophic memory exhaustion. Option 3 solves this via a **Hybrid Macro Shell + Dynamic Subterranean Cavern Manifold**:
- The intact exterior macro body is rendered via a geodetic clipmap shell.
- When a starfighter strikes the crust with a mining laser, the engine dynamically stamps an entrance portal aperture and spawns a high-resolution subterranean voxel chunk volume ($cell = 2\text{u}\text{--}4\text{u}$) seamlessly anchored to the portal collar.
- Over $99.5\%$ of the planetary core consumes zero memory, enabling unlimited planetary scaling.

---

## 2. Dynamic Entrance Portals & Cavern Stitching

### 2.1 Entrance Collar Aperture
When the mining beam makes contact with the macro shell at $\mathbf{p}_{\text{hit}}$:
1. Shell vertices within brush radius $R_{\text{brush}} \times 1.6$ are displaced inward along the surface normal $\mathbf{n}$, opening a clean entrance collar.
2. The dynamic entrance portal registers an analytical aperture mask $\text{Portal} = \langle \mathbf{p}_{\text{hit}}, R_{\text{portal}} \rangle$.

### 2.2 On-Demand Cavern Voxel Allocation
As the pilot carves into the planetoid, local high-density voxel chunks ($16^3$ cells, $CHUNK\_SIZE \approx 350\text{u}$, $CELL\_SIZE \approx 21\text{u}\text{ down to }4\text{u}$) allocate dynamically along the tunnel vector. Voxel densities evaluate procedurally with inverted distance fields, stitching seamlessly to the portal collar.

---

## 3. Flight Mechanics & Cavern Navigation
- Starfighters fly at high velocity through orbital space, approach exterior orbital crystal nodes, dive into the entrance portal, and maneuver through carved underground caverns.
- Real-time swept-sphere collision checks evaluate against the combined geometry (macro shell + cavern mesh), providing continuous slide-collision along tunnel walls with **$0.00\text{u}$** visual-physics deviation.

---

## 4. Multi-Material Cavern Base Infrastructure
- Underground caverns house base machinery (`Weapons Research Lab`, `Shield Generator Dome`, `Engine Foundry`, `Ore Refinery`) snapped to the cave floor along surface normals.
- Perimeter cavern rock is fortified with nanite titanium armor (`materialId = 3`), presenting glowing cyan metallic bulkheads that block raiders from mining into player bases.
