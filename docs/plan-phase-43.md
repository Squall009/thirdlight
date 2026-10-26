# Phase 43 — Clustered forward lighting

Status: planned 2026-10-26 (owner), after phase 42 is merged.

Goal: any number of local lights reach every pixel that needs them, with
shadows, on both renderers. Phase 42 lights static surfaces from the surface
cache. This phase covers what the cache does not: lights reaching moving
objects, local-light shadows on moving objects, and per-pixel highlights. It
lifts the 16 local lights drawn per pixel (`MAX_LOCAL_LIGHTS`,
`project-model/src/local-lights.ts`; D204). Read `docs/roadmap.md`
(principles 1, 5 and 7) and `docs/plan-phase-42.md` first.

## 1. Owner decisions (2026-10-26)

- **Our own clustered lighting.** Per-cluster light lists built by the
  engine, not three's r186 `ClusteredLighting` addon. The addon is WebGPU
  only and leaves out spot and shadowed lights. That is a limit of its code,
  not of the technique.
- **Light kinds in the lists:** point and spot lights (a cone test per
  cluster) and `area` lights (rect and line, a box test).
- **Shadowed local lights use a shadow atlas.**
  - One depth texture. Each light's matrices and its rect in the atlas sit in
    the light buffer, so the light loop samples shadows by index.
  - Point lights take 6 faces.
  - The atlas size is a per-tier budget. Lights are ranked by screen size and
    distance; a light that gets no space draws unshadowed. That is a quality
    budget, not a count cap.
- **Hooking three's lighting nodes is private API.** Each hook goes in
  `docs/three-upgrade-checklist.md`.
- **Performance** is measured at the 60 Hz cap on the Iris Xe: village,
  landscape and the interior class.

Owner to decide (default used if the phase starts without an answer):

- **WebGL 2.** Light lists can live in data textures read with `texelFetch`.
  - Default: WebGL 2 gets the same clustered lists through data textures, so
    one light path serves both renderers. The shadow atlas is shared.
  - Alternative: WebGL 2 keeps today's 16-light path.

## 2. Items (outline; the phase's first item turns them into a full plan)

| Item | What |
|---|---|
| 43.0 | Release check (three.js) and a baseline: village, landscape, interior at the cap on both renderers, local lights per scene, GPU ms per pass. |
| 43.1 | Cluster grid and light lists: a froxel grid at the render scale; point, spot (cone) and area (box) tests; lists packed for both renderers. |
| 43.2 | The light loop: every lit material kind reads its cluster's list; area-light highlights with the same maths as 42.7b; cache-lit static surfaces keep only highlights. |
| 43.3 | Shadow atlas: one depth texture, ranking by screen size and distance, per-tier budget, point lights as 6 faces, unshadowed fallback. |
| 43.4 | `MAX_LOCAL_LIGHTS` retired as a per-pixel cap (D204); the build's Problems line goes. |
| 43.5 | Performance to target and the manual. |
| 43.6 | Acceptance, full gate, review, review fixes. |

## 3. Progress

| Item | Status |
|---|---|
| — | Not started. |

## 4. Decision log

- 2026-10-26 (owner, relayed from session thirdlight-45): clustered lighting
  becomes its own phase after 42. The 2026-10-22 decision had made it "its
  own item inside 42", but no 42.x item was ever added.
