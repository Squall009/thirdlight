# Phase 18 — Material node graph

Goal: materials can be authored as node graphs in a centre tab (phase 16
framework), compiled to TSL (phase 17), rendering the same in the Scene view,
Play and exports on WebGPU and WebGL2. The shader-type materials of 9.4
stay and become built-in graph templates. (Planned earlier as phase 13;
moved after the renderer phase by the owner, 2026-09-24.) Read
`docs/roadmap.md` (principles) first.

## 1. Decisions

- A material is either a shader-type material (9.4) or a graph material;
  "Convert to graph" turns a shader-type material into an equivalent graph.
- Graphs compile to TSL in the browser (editor and runtime) from data; no
  generated code is stored; the exported game carries the graph data.

## 2. Work items

### 18.0 Data

- `content.materials[]` gains `graph?: { nodes, edges, groups, comments,
  outputs }` (a material with a graph ignores `shader`/`params`), exposed
  parameters (`params` with type, default, range, visibility public/private
  like 15.4) that objects and per-object material mappings may override,
  texture references as asset refs. Validation: node kinds from the
  catalogue, port types, no cycles, bounded size (≤ 512 nodes), every
  output connected or defaulted. Commands: node/edge/group edits as
  commands with undo (the framework's command set, generic over graph
  kinds).

### 18.1 Node catalogue (generic, not demo-shaped)

- Inputs: constants (float, vec2–4, colour), exposed parameters, time,
  UV0/UV1, vertex colour, position/normal (object, world, view), view
  direction, camera distance, screen UV, instance index/ID, global wind.
- Maths: add/sub/mul/div, dot/cross, normalize, length, lerp, clamp,
  saturate, smoothstep, step, min/max, abs, floor/fract, sin/cos, pow,
  remap, split/combine, swizzle, one-minus.
- Textures: sample 2D (with UV and sampler settings), normal map, triplanar,
  flipbook; noise (value, gradient, Voronoi), gradients.
- Utility: fresnel, rim, posterize, dither, world-aligned UV, parallax
  (simple), vertex displacement (vertex stage output), alpha clip.
- Outputs: PBR (base colour, metalness, roughness, normal, emissive, AO,
  opacity/alpha clip), unlit, vertex offset; flags (double-sided,
  transparent, shadow casting).
- Sub-graphs (reusable node groups stored as their own content records).

### 18.2 Editor

- The Material tab: the graph, a live preview sphere/plane/model pane with
  the environment, exposed-parameter list; the Inspector shows the selected
  node; the Materials tab lists materials and opens tabs; errors per node.
- Built-in templates generated from the 9.4 shader types (standard,
  foliage wind, world-aligned kit, unlit, water) — a converted material
  looks the same as before (pixel test).

### 18.3 Runtime and export

- The material library compiles graphs to TSL node materials with a cache
  keyed by the graph's canonical digest; the export carries graphs in the
  manifest; per-object overrides of exposed parameters.

### 18.4 Tests and wrap-up

- Unit: compile each node kind; graph validation. e2e: build a graph
  (texture × tint + fresnel emissive), assign it, see it in the Scene view,
  Play and the export (pixel checks); convert a shader-type material and
  compare pixels. Docs and STATUS row 18 (and row 13 points here).

## 3. Progress

| Item | Status | Commits |
|---|---|---|
| 18.0 data | todo | |
| 18.1 node catalogue | todo | |
| 18.2 editor | todo | |
| 18.3 runtime and export | todo | |
| 18.4 tests and wrap-up | todo | |

## 4. Decision log
