# Packet 53 — M3 animation-roles browser verification (manual, the packet-32/37 procedure)

**Status in this container: UNVERIFIED.** There is no browser, no WebGL
context and no GPU here. Nothing in this directory was executed; every
rendered statement of packet 53 (rendered poses, the 0.2 s crossfade in
pixels, the independent mixers on screen) is **UNVERIFIED** until the owner
runs this procedure. The verified halves are:

- the real-loader + real-fixture `setRoles` evidence over the committed
  `courier-roles.glb` / `courier-reordered.glb` and the committed
  real-roles rows (`tests/m3-animation/roles-real-loader.test.ts`);
- the controller behavior over the real `three@0.186.0` animation stack
  (real GLB clips; rule 3 selection, the rule 4 0.2 s weight law, the rule 7
  stage 3 / 5–6 re-check + stale-load refusal, rule 2 bounded host-driven
  update, rule 5 independent mixers, rule 6 no transform writes, rule 8
  disposal while blending — `packages/three-adapter/src/animation.test.ts`);
- the committed real-roles fixture re-derivation (media checker `roles`
  group: every verdict re-derived with the same stage 3/5–6 function as the
  profile cases; the digest-pinned bytes).

`m3-animation.browser.ts` is a **temporary test host**, not a production
bootstrap and not a shipped bundle. It is named `.browser.ts` so vitest never
collects it. The host composes the REAL packages (the three-adapter root +
the pinned GLTFLoader port) over the REAL committed fixture bytes (fetched
from the served repository root and SHA-256-verified against the media
`index.json` before use). It never claims skeletal isolation (the profile is
rigid; §41.10 non-goal).

## What it exercises (the packet 53 / B14 evidence lines)

| # | Check | Recorded |
|---|---|---|
| A1 | **Named B14 checklist**: the committed real-rows install — stored-order v1 on `courier-roles.glb`, reordered v2 on `courier-reordered.glb` (the §41.3.4 rule 5 mapping) — and the stale stored-order row against the reordered bytes is refused (hard, rule 7: code + bounded message); the contract constants (`RUN_SPEED_EPS`, `ANIMATION_CROSSFADE_SECONDS`) and the pure selector table | `checklist.rolesAccepted` |
| A2 | **The 0.2 s weight law in the realized mixer**: the idle→run fade sampled at three points against `crossfadeIncomingWeight(elapsed)` (the rule 4 law `t/0.2` / `1 − t/0.2`), with the max absolute error recorded | `checklist.weightLaw` |
| A3 | **The blending flag**: `true` mid-fade, `false` after the 0.2 s fade completes | `checklist.blending` |
| A4 | **Independent pose/mixer per copy**: instance B stays idle (`{idle: 1}` weights, role `idle`) across A's full run→airborne timeline on the SAME prepared resource; the committed step index A reports | `checklist.independence`, `checklist.stepIndex` |
| A5 | **Rendered poses**: the animated node's quaternion of A (airborne) vs B (idle) at the rendered frame — the two mixers in different roles at the same time | `checklist.poseIndependence` |
| A6 | **No transform writes (rule 6)**: A's holder pose (the entity-level Group) is byte-identical before and after the full role timeline — the controller writes only mixer time and action weights | `checklist.noTransformWrites` |
| A7 | **Disposal while blending (rule 8)**: C fades idle→run and is disposed mid-blend — `dispose` ok, second call `alreadyDisposed`, and A/B keep running on the shared resource afterwards | `checklist.disposalWhileBlending` |
| A8 | **Real screenshots**: `m3-animation-roles-a-airborne.png`, `m3-animation-roles-b-idle.png` (the two instances of one resource in different roles) and `m3-animation-roles-reordered.png` (the new mapping on the reordered bytes) | the three downloaded PNGs |
| A9 | **Fixture integrity in the browser**: the fetched GLB bytes' SHA-256 against the media `index.json` (the evidence runs on the committed bytes, not a local copy) | `fixtureDigests` |

The host owns the frame loop (scripted `update(delta)` steps with the host's
frame delta + real `WebGLRenderer` frames for the screenshots); the
controllers install no `requestAnimationFrame`, no timer and no mixer
listener (rule 2). The host renders with its own minimal camera/renderer rig
(the scene adapter's canvas path is the m3-render host's evidence); the
evidence is the rendered poses, the named-checklist values and the recorded
errors — never a GPU-memory claim.

## Procedure

Prerequisites: the owner's desktop, a modern Chromium/Firefox with WebGL 2
(SwiftShader counts — label the renderer string as recorded), and Node 22.

1. From the repository root, build the host with the pinned esbuild:
   `npx esbuild tests/browser/m3-animation/m3-animation.browser.ts --bundle --platform=browser --format=iife --outfile=dist/m3-animation-test/harness.js`
2. Write a page next to it that loads `./harness.js`, then serve the
   repository root over HTTP so `/fixtures/m3/media/**` resolves, e.g.
   `npx http-server -p 8142 .` (any static server; do not open `file://`).
3. Open `http://127.0.0.1:8142/dist/m3-animation-test/` in the browser.
4. Record the environment (OS + browser + version, the `isWebGL2` +
   renderer string from the console/evidence).
5. Confirm in the console/evidence: `fixtureDigests` all `match: true`;
   `rolesAccepted.storedOrderV1.ok=true`, `reorderedV2.ok=true`,
   `staleRow.code="animation_role_unresolved"` (the message names the
   stage-5 clipName disagreement); `weightLaw.maxAbsError` ≤ 0.05 (the
   realized mixer against the contract law); `blending.midFade=true` and
   `blending.afterFade=false`; `independence.bIdleThroughout=true`;
   `poseIndependence.differ=true`; `noTransformWrites.unchanged=true`;
   `disposalWhileBlending = {"midBlend":true,"disposeOk":true,
   "secondCall":"alreadyDisposed","sharedSurvives":true}`; `errors: []`.
6. The host downloads three PNGs (`m3-animation-roles-a-airborne.png`,
   `m3-animation-roles-b-idle.png`, `m3-animation-roles-reordered.png`).
   Record their SHA-256 and dimensions; visually confirm A's pose differs
   from B's (different roles on one shared resource) and the reordered
   instance renders.
7. Save the evidence JSON from `window.__m3Animation.evidence`.

Record the run (environment, console lines, screenshot digests, the evidence
JSON) under `docs/acceptance/evidence-m3/53/` when it is executed; until then
the browser rows of B14 stay UNVERIFIED.