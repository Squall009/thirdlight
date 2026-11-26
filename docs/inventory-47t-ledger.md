# Ledger of 47T.3: browser tests to unit tests, then archived

Item 47T.3 of `docs/plan-phase-47t.md`; the plan for each file is its row in `docs/inventory-47t.md`. One row a
browser file archived to `archive/tests-e2e/`. "Covered by" names a unit test whose body was read and asserts the
same thing; "new" is a unit test written in this item; "dropped" is what nothing checks any more (browser-only,
accepted by the owner: found later in the pictures or by hand). "Archived in" is the tag in the commit's message
(`git log --grep '<tag>'`). Paths are shortened as in the inventory (`pm/` packages/project-model/src, `ti/`
tests/integration, …).

## Browser files

| File | Logic checks found | Covered by (file: title) | New unit tests (file: title) | Dropped browser-only (unchecked) | Archived in |
|---|---|---|---|---|---|
| block-editor | retire: block editor | — | — | the block editor (retires in 48) | 47T.3a-1 |
| block-layers | retire: block layers | — | — | block maps in Scene/Play/export (retires) | 47T.3a-1 |
| block-lightmaps | retire: block-layer bake, WebGL 2 | — | — | retires | 47T.3a-1 |
| block-lod | retire: block-layer LOD | — | — | retires | 47T.3a-1 |
| block-world-uv | retire: block looks | — | — | retires | 47T.3a-1 |
| ktx2-rgba-thumbnails | retire: WebGL 2 RGBA transcode | — | — | the RGBA thumbnail path (WebGL 2) | 47T.3a-1 |
| layered-material | retire: painted terrain, trim rows | — | — | retires | 47T.3a-1 |
| level-acceptance | retire: blocks, terrain, splines, architecture | — | — | retires | 47T.3a-1 |
| lightmaps | retire: phase-42 bakers, saved probes | — | — | retires | 47T.3a-1 |
| painted-terrain | retire: painted block layer | — | — | retires | 47T.3a-1 |
| smooth-tops | retire: block-layer tops | — | — | retires | 47T.3a-1 |
| terrain | retire: block terrain | — | — | retires | 47T.3a-1 |
| terrain-brushes | retire: block terrain brushes | — | — | retires | 47T.3a-1 |
| terrain-cdlod | retire: heightfield terrain | — | — | retires | 47T.3a-1 |
| terrain-paint | retire: terrain paint | — | — | retires | 47T.3a-1 |
| editor-chrome | looks; no logic part (header, toolbar pictures, empty state's button) | — | — | the item editors' chrome: picture E1/E7 | 47T.3a-1 |
| environment | looks; no logic part | — | — | vignette and the fog volume drawn (in no picture) | 47T.3a-1 |
| gizmos | looks; no logic part | — | — | icons and the Gizmos menu toggles: picture E1 | 47T.3a-1 |
| lights | looks; the Inspector's light-mask/light-layer checkboxes and localLights select are UI wiring (the rule is `ta/light-layers`) | — | — | light tint, spot cookie, atlas shadows drawn; those Inspector fields' wiring | 47T.3a-1 |
| placeholders | looks; no logic part | — | — | clickable placeholder icons: picture E1 | 47T.3a-1 |
| camera-depth | dropped: depth modes, decal z-fighting | — | — | far plane / depth-buffer modes and decal z-fighting drawn | 47T.3a-1 |
| effects-gpu (+ `effects-gpu/`) | dropped: WebGPU particle kernel vs CPU | — | — | the WebGPU compute particles against the CPU reference | 47T.3a-1 |
| material-custom-lit | dropped: custom-lit shading on the GPU | — | — | custom-lit shading drawn | 47T.3a-1 |
| material-graph-render (+ `material-graph-render/`) | dropped: node kinds' drawn values; the texture-limit fallback's compile rule is `ta/texture-unit-guard` | — | — | drawn node values, specular, custom-lit on WebGPU | 47T.3a-1 |
| memory | dropped: leak tests (skipped in every gate) | — | — | page heap and GPU counts back to baseline | 47T.3a-1 |
| play-memory | dropped: GPU resources held in Play | — | — | the play preview's fixed GPU resource set (a perf-report row at most) | 47T.3a-1 |
| sky-texture | dropped: a texture sky upright | — | — | texture skies' orientation | 47T.3a-1 |
| webgpu-reference (+ `webgpu-reference/`) | dropped: 40 reference images | — | — | dof, fxaa, smaa, lut, grading, fog and sky kinds, node-material pixels | 47T.3a-1 |
| mcp-headless | boot: replaced by boot test 5 | `tests/e2e/boot.e2e.ts`: an MCP play with no editor open | — | — | 47T.3a-1 |
| play-export | boot: replaced by boot tests 3–4 | `tests/e2e/boot.e2e.ts`: Play, the export with the backend stopped | — | the preview filling the centre view without scrolling | 47T.3a-1 |

## Unit files of retiring systems (archived to `archive/tests-unit-retired/`, same paths)

| File | System | Seconds (whole-suite run) |
|---|---|---|
| packages/three-adapter/src/surface-probes.test.ts | old probe lighting (phase-42 surface probes) | 18 |
| packages/three-adapter/src/surface-bake.test.ts | phase-42 surface cache bake (block layers, generated buildings) | 18 |
| packages/three-adapter/src/block-mesh-worker.test.ts | block layers (mesh workers) | 13 |
| tests/integration/m42-bake/bake-lighting.test.ts | phase-42 lighting bake through MCP, backend, export | 12 |
