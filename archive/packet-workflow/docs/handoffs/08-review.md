# Packet 08 review — accepted (round 1; single-session review pass)

Date: 2026-09-18. Reviewed implementation commit `83e0250` + record commit
`357f2e6` against packet 08 (implementation-prompts §08),
`docs/contracts/runtime.md` (v0.1), `docs/contracts/dependencies.md`
(§3/§4.1/§6/§7), and m1-acceptance §2.1 (all packet-08 rows). Per the
owner's 2026-09-18 single-session decision (RESUME-2026-09-18.md), the
review pass was executed by the takeover session working strictly from the
tree, the contract text, and fresh probes (not implementation memory);
method and evidence below. One repair round used (max 3).

## Verdict

**Accepted — packet 08 complete.** Two P2 findings (F1, F2) were found in
the review round and fixed in the same round with regression tests
(commit below the verdict section). No P1 findings: every m1-acceptance §2.1
packet-08 check is satisfied or explicitly carried (browser visual —
UNVERIFIED, environmental, recorded with evidence). Toolchain green after
the round: 630/630 ×2, check-deps, check-boundaries, strict build exit 0.

## Contract conformance re-verification (tree + contract text)

| Contract item | Verified by |
|---|---|
| §3.1 strict config (unknown field ⇒ `config_invalid`; `modules` default `["thirdlight.demo:box-motion"]`; `fixedStepHz` ∈ [1,1000] integer; driver kinds + raf-requires-rAF; `onFrame`) | `runtime.ts` `parseConfig` (line-by-line) + review probe P1 (unknown field, hz 0/1001/2.5, driver `bogus`, `raf`-in-Node all ⇒ `config_invalid`; `modules: []` ⇒ box static; default selection ⇒ box moves) |
| §3.2/§3.3/§3.4 lifecycle (states; `runtime_already_started`/`runtime_not_running`/`runtime_disposed`; start/stop/start single rAF; restart retains state; dispose idempotent `alreadyDisposed`; post-dispose codes; `getDiagnostics` works disposed) | `runtime.ts` `start/stop/tick/dispose` (line-by-line) + suite `lifecycle.test.ts` + probe P4 (rAF listener count 1 after start, 0 after stop/dispose) |
| §3.5 `tick` manual-only ⇒ `tick_not_allowed`; `tick` not running ⇒ `runtime_not_running` | `runtime.ts` `tick` + probe P4 (before start and while running) |
| §2 snapshot (strict wrapper; reasons `shape`/`scene_validation`/`revision_mismatch`/`id_mismatch`; ≤10 model errors + total; deep-freeze on success; `≤1024` entities via re-validation) | `snapshot.ts` (line-by-line) + suite `snapshot.test.ts` + probe P3 (all four reasons, `path` given, `errors ≤ 10` + `errorTotal`) |
| §4 mutable state (prev/curr deep copies; `simTime = stepIndex/hz` single division; no aliasing) | `runtime.ts` init + `stepOnce` + suite + probe P7 |
| §5 fixed steps (anchor first frame; `rawN = floor(...)`; `n = min(rawN, 8)`; drop-and-resync + `droppedSteps`; zero-step frames; non-monotonic ⇒ 0 steps + `clockWarningCount` +1) | `runtime.ts` `runFrame` (line-by-line) + suite `fixed-step.test.ts` (incl. the 100 ms stall 12-raw ⇒ 8/4 case) + review probe C |
| §5.1 module isolation (backup/restore; no `stepIndex`/`simTime` advance; `module_error`; failed module not re-created; no-op until dispose) | `runtime.ts` `stepOnce` + suite `registry.test.ts` (33 recorded failures ⇒ ring 32 / count 33) |
| §6 interpolation (exact `alpha` field in the state; lerp formula; slerp sign-align + `dot > 1−1e-9` nlerp shortcut + standard slerp; `alpha==0`/`prev==curr` ⇒ `curr` exactly; fresh derived values; document order; `getCamera {id,fovY,near,far}`) | `interp.ts` + `runtime.ts` `getInterpolatedState` (line-by-line) + suite `interp.test.ts` + probe P6 (exact field sets, order, camera/group static) |
| §7.1 demo (A=0.5, T=4.0, `x0 + A·sin(2π(stepIndex+1)/(SIM_HZ·T))`; non-box entities static; bounded ±0.5) | `demo.ts` + suite `demo.test.ts` (exact points 119/239/359/479) + probe D |
| §8 diagnostics (exact 14-field shape; ring 32; cumulative `errorCount`; `frameCount` incl. zero-step frames; `clock: "injected"`/`"performance"`; messages ≤ 256) | `runtime.ts` `buildDiagnostics` + suite `diagnostics.test.ts` + probe P5 (exact key-set equality) |
| dependencies.md §3 surface rows (runtime: `instantiateRuntime`, `createSimulationRegistry`, `registerSimulationModule`, `BUILTIN_MODULES`, types, `ERROR_CODES`; three-adapter: `createSceneAdapter`, `ERROR_CODES`; exports-map-only `"."`) | `index.ts` of both packages + `package.json` exports (line-by-line) — see F1 for the one deviation found |
| dependencies.md §4.1 edges (runtime → project-model only; three-adapter → runtime + three; no Node builtins) | `check-boundaries` + negative probes (`three`/`node:fs` in runtime ⇒ FAIL exit 1) |
| dependencies.md §6 registry (name syntax; exactly one M1 module; duplicate registration/selection ⇒ `config_invalid`; no string-to-code resolution) | `registry.ts` + suite `registry.test.ts` (`BUILTIN_MODULES.length === 1`) + probe P2 |
| §9 three-free / I/O-free / no hidden globals | boundary tools + bundle scan below + code review (module-level state is constants only) |
| m1-acceptance §2.1 no-user-scripts (08 share: runtime bundle contains no `eval`, dynamic `import()`, input listeners) | fresh esbuild CJS bundle scan (below) |
| m1-acceptance §2.4 stack pins (three 0.186.0 / @types/three 0.186.0 installed exact) | `check-deps` output |

## Bundle content scan (fresh; m1-acceptance §2.1 "no user scripts" row)

esbuild CJS bundle of `packages/runtime/src/index.ts` into /tmp, fixed-string
counts over the emitted bytes:

| Pattern | Runtime bundle |
|---|---|
| `eval(` / `new Function(` / `import(` | 0 / 0 / 0 |
| `addEventListener` / `WebSocket` / `XMLHttpRequest` / `fetch(` | 0 / 0 / 0 / 0 |
| `process.` / `require(` / `document.` / `window.` | 0 / 0 / 0 / 0 |

The runtime core references `globalThis.performance` /
`globalThis.requestAnimationFrame` only (the §9-guarded DOM surface) — the
zero `window.`/`document.` hits confirm it does not reach for other DOM.
**Recorded for the packet 10 scan:** the three-adapter bundle (three.js
included) contains 26 `addEventListener` and 3 `XMLHttpRequest` substring
hits from three.js's own source (its event/WebXR plumbing), 0
`eval(`/`new Function(`/`import(`/`WebSocket`. The packet 08 row scopes the
scan to the runtime bundle (clean); packet 10's forbidden-content scan
should expect three.js internals as a known source and key on the
forbidden-content patterns (origins, credentials), not raw
`addEventListener` presence.

## Findings (review round 1 — both fixed in-round, regression-tested)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| F1 | P2 | `adapterError` was a **value export** of `@thirdlight/three-adapter` beyond the dependencies.md §3 surface row (`createSceneAdapter`, `ERROR_CODES`, + the types the row's signature requires). | Fixed: removed from `src/index.ts` (kept internal; `adapter.ts` imports it from `./errors`). |
| F2 | P2 | `captureScreenshot(maxWidth)` did not validate its argument: a non-positive or non-integer `maxWidth` reached the downscale path (a real browser would downscale to a degenerate 0-width canvas; Node masked it behind `render_unsupported`). | Fixed: fail-fast validation **before** the render attempt (no side effects on a bad argument) ⇒ structured `screenshot_failed` ("maxWidth must be a positive integer"); new Node-observable regression test (`adapter.test.ts`). |

Both are contract-conformance/robustness items, not behavior the
acceptance checks pinned; neither changed any pinned value.

## Review notes (non-gating)

- **N1 — `STEP_COUNT_EPS = 1e-9` floor guard** (runtime.ts): the normative
  `rawN = floor((targetSim − simTime)/dt)` can undercount exact multiples in
  double precision (e.g. 11.999999999999998 → 11), which would break the
  pinned "12 raw" stall case. The guard is a fixed constant inside the
  computation ⇒ determinism is preserved (§7.3: same inputs ⇒ same floats);
  it cannot run a step early by more than ~1e-9 of a step (~8e-12 s).
  Accepted as an implementation detail making the normative check
  executable; recorded here for the gate C reviewer.
- **N2 — adapter scene-graph construction is eager, renderer is lazy:**
  `createSceneAdapter` builds geometries/materials/camera/lights at call
  time (pure three.js JS — verified non-throwing in Node via probe E);
  only `WebGLRenderer` creation is deferred to the first `renderFrame`.
  Matches "never throws" + "the renderer is the owned GPU lifetime".
- **N3 — browser visual remains UNVERIFIED** (no root in this container:
  `libnspr4`/`libnss3` missing; `evidence-08/browser-attempt.txt`).
  Carried to the Gate C / M1 gate review box: the ready fixture at
  `/tmp/p08-browser/` (rAF driver + real WebGL + screenshot) is the exact
  re-verification vehicle. The playwright §7 pin contract-change request
  stands (handoff 08).

## Interpretation decisions — re-verified (handoff 08 §"Interpretation decisions")

1. **Step ordinal (1-based).** Re-derived from the contract text: §7.1
   defines `x(stepIndex) = x0 + A·sin(2π(stepIndex+1)/(SIM_HZ·T))` as "the
   value the module sets at each step", and m1-acceptance pins "stepIndex
   119 (x = x0 + A) … under the §7.1 `(stepIndex + 1)` offset". The pin is
   satisfiable under two readings (module-argument vs state-at-read-time);
   the implementation makes **state `stepIndex` at read time N ⇒ box at
   x(N)** (the module receives the 1-based ordinal of the step being
   completed). All four pinned points then hold exactly (119 ⇒ x0+A bit
   exact; 239/479 ⇒ x0 within 1.3e-16; 359 ⇒ x0−A bit exact), and the
   determinism row's "the demo position at fixed stepIndexes equals the
   §7.1 formula" reads naturally against the observable
   `diagnostics.stepIndex`. No pinned value is broken by the alternative
   reading either (it shifts the same exact points to state 120/240/360/
   480) — recorded as an interpretation, not a contract change; a reviewed
   contract diff could pin the reading explicitly (see contract-change
   requests).
2. **One `module_error` per failed step attempt.** The m1-acceptance ring
   check ("33 errors → 32 kept", singular "a throwing module (injected)")
   is executable only if the failed stateless module is stepped (and
   throws) repeatedly; "the module is failed, not retried" is read as
   "`create` is never retried". Under the alternative (module skipped
   after the first throw) a single thrower yields 1 error and the pinned
   check cannot run. Re-verified: implementation matches the recorded
   reading.
3. **Capped frame ⇒ `alpha = 0`** — matches §6 ("after a catch-up resync,
   `targetSim == simTime` ⇒ `alpha = 0`") ✓.
4. **`renderBackend: null`** as the non-browser absent value — the §8
   adapter block lists `"webgl2"` as the reported value when selected; the
   contract does not pin an absent value, `null` is the unambiguous
   JSON-absent marker, and diagnostics must remain callable in Node
   (probe E). Recorded; no contract change.

## Toolchain (post-round, real tree)

| Command | Result |
|---|---|
| `npm test` (×2 after the round) | 50 files / **630/630 passed** (629 at impl + 1 new maxWidth regression test) |
| `npm run check-deps` | exit 0 — 6 pending pins (all future-packet consumers) |
| `npm run check-boundaries` | exit 0 — 5 packages, 91 source files, 357 specifiers |
| `npm run build` (strict tsc ×5) | exit 0 |
| Review probes (fresh set, esbuild-bundled public entries) | P1–P8 PASS (strict config; duplicate/unknown module selection; all four snapshot reasons; rAF `tick_not_allowed` + listener accounting + rAF-driven demo motion; exact §8 diagnostics field set; interpolated-state shape/order/static camera+group; determinism via public API; `maxWidth` validation fail-fast) |

## Record

Review round commit: see STATUS row 08 / orchestration log. Nothing pushed.
Verdict: **ACCEPTED** — packet 08 complete; next packet 09 (backend API and
live session transport) may start.