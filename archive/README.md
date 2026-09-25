# Archive

`packet-workflow/` holds the process record of the original packet/gate
workflow (packets 00–69, gates A–Q, 2026-09-16 → 2026-09-22): handoffs,
acceptance evidence, planning packs, contracts, reviews, and the old STATUS.

It is kept for reference only. It is **not** authoritative: the gate
"acceptances" were self-reviews by the implementing model, and the audit of
2026-09-22 (`docs/audit-2026-09-22.md`) found many claims that do not hold in
a real browser. The code, its tests, and `docs/STATUS.md` are the source of
truth now.

The exact pre-cleanup tree is also tagged `archive/pre-audit-2026-09-22`.

Nothing under `archive/` is built, type-checked, or tested.

`webgl-renderer-17/` holds the three.js `WebGLRenderer` path as it stood when
phase 17.4 switched every view to `WebGPURenderer` (2026-09-25): the
three-adapter renderer factory with its `legacy` backend, the
`onBeforeCompile` project shaders and lightmap hook, the EffectComposer post
stack with the WebGL sky/PMREM/fog-volume passes, the WebGL lightmap baker,
and the shader-parity reference capture script. The shader and environment
parity reference images it drew stay in `tests/e2e/*-parity/refs/` as the
contract the TSL shading is compared with.
