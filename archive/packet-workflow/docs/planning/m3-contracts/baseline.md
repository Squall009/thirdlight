# Packet 38 — M3 browser baseline

**Executed 2026-09-19. Raw evidence: `acceptance/evidence-m3/38/`.** This is a
feasibility baseline, not acceptance evidence: it exercises the *existing* pinned
production stack and records what a real browser does here. It does not close any
M2 row and it does not start M3 implementation.

## 1. What was run, and what is real

| Probe | Real artefact | Result |
|---|---|---|
| Local Chrome launch | Chrome for Testing **151.0.7922.34** (`headless=new`), launched from a pre-existing local Playwright cache with a pre-existing extracted library tree plus two locally compiled no-op avahi stubs. **No root, no apt, no system package installed or modified.** | PASS |
| WebGL 2 | `WebGL 2.0 (OpenGL ES 3.0 Chromium)`; unmasked renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` | PASS (software) |
| three.js render | pinned `three@0.186.0` `WebGLRenderer`, WebGL 2, shadow map allocated 512×512, 3 draw calls / 36 triangles, `glGetError()` 0, real `readPixels` = scene background, in-page `canvas.toDataURL()` PNG | PASS |
| DOM + console + network | probe page served over real HTTP with the production preview CSP; per-page console/log/network records stored | PASS |
| Keyboard | real CDP key events reached the page (`Enter`, `Space` down/up) | PASS |
| Hidden tab | opening a second target really hid the first (`visibilityState` `visible` → `hidden`, `visibilitychange` fired) | PASS |
| Rapier in browser | pinned `@thirdlight/physics-rapier` (real `rapier2d-compat@0.20.0` WASM): 12-step settle then 48 motion steps, grounded, 61 steps, 2 static colliders, snap steps 2, penetration corrections 49 | PASS without CSP; **FAIL under the production preview CSP** (§2) |
| GLB loading | pinned `@thirdlight/three-adapter/gltf-loader` loading the committed `fixtures/m2/assets/tiny-v2.glb` (1864 bytes, digest `826e99bd…` re-verified in-browser via `crypto.subtle`); clips/ownership reported; disposed | PASS under the production CSP |
| Rigid animation | `AnimationMixer` crossfade between two probe clips on independent instances: weights 1→0.5→0 in, 1→0.5→1 out, a second mixer unaffected | PASS |
| Input mapping | pinned `@thirdlight/input`: `KeyD`→`moveX 1`, `Space`→`jump: pressed`, **`Enter`→ unbound**, standard pad button 0→`pressed`, axis 0.9→0.875, non-standard mapping ignored | PASS |
| Audio | `AudioContext` present; PCM decode of a generated 48 kHz mono 16-bit WAV succeeds (0.49998 s, resampled 44100); after a real gesture the context reaches `running`; an `AnalyserNode` downstream of the gain measured peak **0.0488** = the exact expected amplitude (8000/32768 × 0.2) | decode/graph PASS; **audibility UNVERIFIED** |
| Physical gamepad | `navigator.getGamepads()` → 0 devices; no `/dev/input` | UNVERIFIED |
| Gamepad in an iframe | `allow="gamepad 'none'"` makes `getGamepads()` throw a `SecurityError` (permissions policy) | PASS (behaviour recorded) |
| Display / hardware GPU | `DISPLAY` unset, no Xvfb; SwiftShader only | UNVERIFIED |
| Page screenshot vs canvas | the composited page screenshot carries DOM text; WebGL canvas content is **not** composited under SwiftShader, while the in-page canvas PNG is correct | recorded limitation |

Reproduce: `node tests/evaluations/m3-browser/run.mjs` (see
`tests/evaluations/m3-browser/README.md`). Evidence is written only under
`TL_M3_EVIDENCE_DIR`; `npm test` never runs it.

## 2. P1 finding — the accepted preview CSP blocks Rapier WASM

With the **production preview-origin CSP** (`sessions.md` §17.4, reproduced
verbatim in `run.mjs`) the real browser refuses to compile any WebAssembly:

```text
wasm_unavailable: WebAssembly.instantiate(): Compiling or instantiating
WebAssembly module violates the following Content Security policy directive
because 'unsafe-eval' is not an allowed source of script in the following
Content Security Policy directive: "script-src 'self'"
```

The pinned physics adapter is `@dimforge/rapier2d-compat@0.20.0`, which embeds
WASM and instantiates it at runtime, so **`physics_init_failed`/
`wasm_unavailable` is the only possible outcome for editor Play under the accepted
CSP**. This is a real-browser fact, not a theoretical one: an M2 Play/preview
session could never have initialized physics on a CSP-compliant preview origin —
M2's browser half was UNVERIFIED, and that is exactly the gap it hid.

- `engine.json` (production CSP): `physicsOk:false`, `wasmCompile:"blocked…"`.
- `engine-nocsp.json` (no CSP): `physicsOk:true`, full course trace.
- `engine-csp-wasm.json` (production CSP **+ `'wasm-unsafe-eval'`**): `physicsOk:true`.

**Proposed contract diff (owned by packet 42; not applied here).** In
`sessions.md` §17.4 add exactly one source to `script-src`:

```diff
-  default-src 'none'; script-src 'self'; connect-src 'self';
+  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
```

Consequences to record with the diff: `'wasm-unsafe-eval'` permits WebAssembly
compilation only (it does not permit `eval`); the exported standalone page has no
CSP header from the export writer today, so export/static serving must state its
policy explicitly and use the same token (packet 60); the preview iframe must
carry `allow="gamepad"` or the gamepad API is unavailable inside it (measured
above; `sessions.md` §13 framing text).

Until Gate K accepts and promotes the diff, M3 packets may not silently change the
CSP; they may cite this finding.

## 3. M3 verification path for this container

Use the local Chrome runner for: DOM/HUD, canvas pixels, console/network,
resize, loading/lifecycle/ownership, WAV decode and inspection, preview/export
loading, CDP key events, hidden-tab transitions and CSP behaviour. Label every
pixel/GL statement **software rasteriser (SwiftShader)**.

Keep UNVERIFIED, with the manual procedures required by `m3-acceptance.md` §5:
physical keyboard and gamepad (a CDP key event is not a physical device),
audible output (no audio device; counters are not audibility), hardware-GPU
behaviour and real display compositing, OS-level window/iframe focus behaviour,
and any claim that needs a second machine or an owner-observed walkthrough.

## 4. M2 disposition (not rewritten)

M2 remains accepted-with-bounded-follow-ups with its 16 UNVERIFIED browser/
hardware rows. Nothing here re-labels them. Where M2 could not run a browser, M3
now can; that produces **fresh M3 evidence only**. The §2 finding is new
information about an accepted contract and is handed to Gate K.

## 5. Limits of this packet

- Only the pinned engine packages and the built editor bundle were exercised; a
  complete Play session (backend + preview bridge + locator) and a standalone
  export tree in the browser are packet 59/60 work.
- No benchmark, frame-rate or GPU-memory claim is made.
- The library tree and Chrome binary live outside this repository and belong to
  other local projects; if they move, `TL_CHROME_PATH`/`TL_BROWSER_LIBS` must be
  set or the probe reports UNVERIFIED.
