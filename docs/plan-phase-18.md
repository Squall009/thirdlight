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

- 2026-09-25 (18.0): data — `content.materials[]` gains optional `graph` (a generic `GraphData`: nodes, edges, groups, comments; graph kind `material`) and `parameters` (the exposed parameters), both appended after the 9.4 fields in the canonical form, so every shader material keeps its exact bytes. The plan's "`outputs`" are the output nodes of the graph (PBR / Unlit / Vertex offset) with the render flags as their fields — not a separate key (one place for them, edited like any node). Why: the generic graph format stays the one every graph kind uses.
- 2026-09-25 (18.0): the exposed parameters are `material.parameters` (`{key, type: float|vec2|vec3|vec4|color|texture, default, min?, max?, visibility?, label?, group?, tooltip?}`, ≤ 64, list order kept), not `params`: `params` stays the shader's overrides, which the renderer reads and which a graph material keeps as its fallback. Visibility follows 15.4 (public omitted from the canonical form). Parameters without a graph are allowed (inert) so a graph can be removed and brought back.
- 2026-09-25 (18.0): a graph material keeps `shader`/`params`/`textures`. Until the graph compiler (18.3) the runtime closure strips `graph` and `parameters` (`materialsForRuntime`, like `animatorsForRuntime`) and the editor's Scene-view material library gets the shader part only, so the renderer draws the shader fallback (and a graph edit never rebuilds viewport materials); 18.3 carries graphs into the manifest. No renderer code was touched (17.1 is in flight).
- 2026-09-25 (18.0): commands — owner kind `material` in `GRAPH_OWNERS` (owner id = materialId; a material without a graph has none — `setMaterial` adds one): `graphEdit` changes are recorded as the ops (a move in a 512-node graph stays a small record) and undone with the inverse ops; the editor's client advances `materials[i].graph` from them (full resync when they do not fit). The adapter also applies the material rule (a Parameter node names a declared parameter) so a refusal names it. New graph materials, conversions and parameter edits are one `setMaterial` each.
- 2026-09-25 (18.0): validation — catalogue types/fields, port types (a value never feeds a texture input), no cycles, ≤ 512 nodes, at most one surface output (`exclusive` tag) and one vertex offset, Parameter nodes name declared parameters, texture fields and texture parameters name texture assets (content-level, generic over any node field with `asset: 'texture'`). "Every output connected or defaulted" holds by construction: every non-texture input of every material node has a `default` (a constant or a built-in source: uv0/uv1, positions, normals, view directions, screen UV, time — checked by the catalogue test); a texture input falls back to its node's texture field. Missing a surface output is a diagnostic (the PBR output is `required`; the Unlit output satisfies it through the tag), not a refusal, so a graph can be rebuilt step by step.
- 2026-09-25 (18.0): per-object overrides = a new component `materialParams` `{ <materialId>: { <key>: value } }` next to the `materials` mapping (scene entities and prefabs, requires a model/box/instances), not a changed mapping value: every mapping consumer (three-adapter, viewport, bake, preview) reads mapping values as material ids and must not change during 17.x. The project rule (only public parameters of graph materials, values fitting the declaration) runs in `composeV4`, i.e. after every command in the workspace; the command checks the shape. The Inspector's Materials section lists the public parameters of the graph materials the object uses (own mapping or its model's default mapping). Descriptors: the component, `parameters` and `graph` (json, read-only: edited with graph edits).
- 2026-09-25 (18.1): catalogue — two graph kinds as data in `project-model/src/material-graph-kinds.ts`: `material` (owner `material`) and `material-function`; port types float/vec2/vec3/vec4/texture; every value width converts to every other implicitly (splat, truncate, pad 0 / w = 1 — Shader Graph's rules), texture never. Maths nodes carry a `type` field (`auto` default | a width). Node ids: the plan's list, plus Colour ramp beside Gradient (the plan's "gradients": a UV gradient shape and a two-colour ramp); "instance index/ID" is one Instance index node. Why: generic, any genre; the TSL compile of each node is 18.3.
- 2026-09-25 (18.1): framework — data-dependent ports, generic and data-only, in project-model `graph.ts` and the editor's copy (`editor/src/graph/model.ts`, parity in `tests/material-graph-parity.test.ts`): `GraphPortDef.typeFrom {field, lookup? | map? | byLength?}` (a type from node data: an external declaration through the validation context such as a material parameter, a value map, a string's length such as a swizzle mask, or `auto` = the widest wire in by the field's option order), `GraphNodeDef.portsFrom {field, kind}` (a sub-graph call's ports = the interface of the standalone graph the field names), `GraphKindDef.interface` (which nodes are a callable graph's inputs/outputs; port id = the interface node's id so renaming keeps wires; ordered by position), `GraphNodeDef.exclusive`, field type `color`, string `pattern`, string `asset`, port `default`, and a `GraphContext {graph(kind, id), lookup(name, value)}` passed to validation and to the editor (`GraphEditor`/`GraphInspector` prop `portContext`). Every geometry/connection helper takes an optional `PortsOf`. This is the 16.1-deferred "ports that depend on node data".
- 2026-09-25 (18.1): sub-graphs are standalone graph documents of kind `material-function` in `content.graphs[]` (16.1's generic records: `setGraph`/`deleteGraph`/`graphEdit {owner: {kind: "graph"}}`, the Graphs list, the `graph` document tab), not a new `content.materialFunctions[]`. Why: no second record type, op set or tab for what is a graph of a kind; visual-script functions (19) can do the same. Rules: calls between graph documents may not form a cycle (checked across `content.graphs`); a function edit or delete that breaks a caller (a wired port gone, a call to a deleted function) is refused naming the caller (the graph adapter re-validates the callers; the resulting-state check would refuse it too). Functions are not exported yet (18.3 with the graphs).
- 2026-09-25 (18.2 prep, logged here): the Material tab = name bar, a note (17.4 has not landed: "Preview arrives with the WebGPU renderer (phase 17.4) and the graph compiler (phase 18.3)…"), the exposed-parameter list on the left, the GraphEditor; the right dock shows GraphInspector for the selection. "Convert to graph" (editor, pure, `editor/src/session/material-graph.ts`) rebuilds standard and unlit materials (colour × map, roughness/metalness × ORM g/b, AO = lerp(1, ORM r, intensity), normal map × scale, emissive × intensity × map, tiling/offset UV, opacity × map alpha when not opaque, alpha clip, double-sided/transparent flags — as three.js's standard material does; unit-tested to validate in the backend); on a model a shader material also inherits the file's own textures, which a graph does not contain. Foliage/kit/water are disabled with the reason: they become 18.2's built-in templates with pixel tests. Pixel equivalence is unverified until 18.3 renders graphs.
- 2026-09-25 (run): 18.0/18.1 (data and catalogue) were built and merged while phase 17.2–17.5 were still in progress; they touch no renderer code (graph materials render with their shader fallback until 18.3).
