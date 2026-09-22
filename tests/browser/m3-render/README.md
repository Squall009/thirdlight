# Packet 52 — M3 light/shadow/surface browser verification (manual, packet-32/37 procedure)

**Status in this container: UNVERIFIED.** There is no browser, no WebGL
context and no GPU here. Nothing in this directory was executed; every
visual/WebGL statement of packet 52 (real screenshots, the realized light
nodes, the WebGL-2 gate, the first-render probe) is **UNVERIFIED** until the
owner runs this procedure. The verified halves are: the pure §41.1.3/§41.1.4/
§41.2 math + the fixture `shadowCases` replay
(`packages/three-adapter/src/lighting.test.ts`), the adapter construction/
decision/diagnostics (`packages/three-adapter/src/adapter-m3.test.ts`), and
the promoted fixture re-derivation (media checker, the `presets`/`constants`/
`lights`/`shadow`/`preset-independence` groups).

`m3-render.browser.ts` is a **temporary test host**, not a production
bootstrap and not a shipped bundle. It is named `.browser.ts` so vitest never
collects it.

## What it exercises (the packet 52 evidence lines)

| # | Check | Recorded |
|---|---|---|
| R1 | **Named B11 checklist** (Gate K): the authored key/fill light values against the fixture rows (`key-ok`/`fill-ok`), the derived key-light position/target + shadow camera (the pure §41.1.3 math — the exact values the adapter realizes from the same functions), the three preset rows adapter-vs-fixture bit-equal, the seven shadow constants adapter-vs-fixture bit-equal | `checklist.*` in the evidence JSON |
| R2 | **Real screenshots** of the shadow-on scene at 16:9 (1280×720) and 4:3 (1024×768 — the resize path: the shadow camera is level-derived and unchanged by the resize) and of the shadow-off-by-author scene | the three downloaded PNGs + their SHA-256 |
| R3 | **Diagnostics** (`shadows`/`shadowReason`): shadow-on scene ⇒ `shadows: "on"` (the real first-render probe passed and the shadow map was allocated at 512²/PCFShadowMap); shadow-off-by-author scene ⇒ `off` / `cast_shadow_false` | `checklist.diagnosticsShadowOn/Off` |
| R4 | **Synthetic context loss/recovery** (the accepted packet-26 behavior): the host fires the real `webglcontextlost`/`webglcontextrestored` canvas events; `renderFrame` must report `render_context_lost` while lost and resume after restoration; nothing is disposed on loss | `contextLoss` |
| R5 | **Repeated create/dispose** (five cycles): idempotent disposal, diagnostics coherent after dispose | `repeatedDispose` |
| R6 | **Material independence (value-level, §41.2.3)**: entity A edited from `hazard` to `beacon` in a second realization — only A's committed values change; B keeps its own `matte-ground` row (the adapter realizes the committed `surface` values literally; the per-placement material instance is by construction) | `materialIndependence` |

The **unsupported-shadows fallback** (probe failure ⇒ `off` /
`shadow_unsupported`) is a soft-degradation path that cannot be forced in a
healthy browser (the probe runs against the real GL context); it is pinned by
the promoted fixture case `shadow-degraded-capability` and the pure decision
tests. The **WebGL-1 ⇒ `render_unsupported`** hard gate (M3 target is WebGL 2)
likewise only fires on a WebGL-1-only browser; the `isWebGL2` environment
probe is recorded so the run's capability is on the record. No GPU-memory
claim from JS object counts (packet 52 evidence rule).

## Procedure

Prerequisites: the owner's desktop, a modern Chromium/Firefox with WebGL 2
(SwiftShader counts — label the renderer string as recorded), and Node 22.

1. From the repository root, build the host with the pinned esbuild:
   `npx esbuild tests/browser/m3-render/m3-render.browser.ts --bundle --platform=browser --format=iife --outfile=dist/m3-render-test/harness.js`
2. Write a page next to it that loads `./harness.js`, then serve the
   repository root over HTTP so `/fixtures/m3/media/render/light-surface-cases.json`
   resolves, e.g. `npx http-server -p 8141 .` (any static server; do not open
   `file://`).
3. Open `http://127.0.0.1:8141/dist/m3-render-test/` in the browser.
4. Record the environment (OS + browser + version, the HUD's `isWebGL2` +
   renderer string — name it **SwiftShader** if software-rendered).
5. Confirm in the HUD/console: `checklist: presetRows.match=true
   shadowConstants.match=true`, `diagnostics: shadowOn` carries
   `shadows: "on"`, `shadowOff` carries `off` / `cast_shadow_false`,
   `contextLoss: {"lostReported":true,"recoveredReported":true}`,
   `repeatedDispose: {"cycles":5,"allIdempotent":true}`,
   `materialIndependence: true`.
6. The host downloads three PNGs (`m3-render-shadow-on-169.png`,
   `m3-render-shadow-on-43.png`, `m3-render-shadow-off-169.png`). Record their
   SHA-256 and dimensions; visually confirm the named checklist on the
   pixels: the key light direction/hazard contrast in the shadow-on scene,
   the shadowed boxes, the hazard row's emissive tint, and the shadow-off
   scene rendering with the key light only.
7. `await window.__m3Render.collectEvidence()` → save the JSON. Save the
   console output. These artefacts (JSON + 3 PNGs + console) are the packet
   52 browser evidence; file them with the handoff record.