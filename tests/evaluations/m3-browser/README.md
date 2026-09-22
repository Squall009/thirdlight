# Packet 38 browser verification runner

Real-browser probes for the M3 baseline, used again by packets 52–62. There is
**no browser installed by this repository**: the runner uses a Chrome binary and
an extracted system-library tree that already exist locally, plus two no-op
avahi stubs compiled at runtime into the system temp directory. Nothing is
installed, no root is used, no system file is modified.

## Run

```sh
node tests/evaluations/m3-browser/run.mjs                 # writes docs/acceptance/evidence-m3/38/raw
TL_M3_EVIDENCE_DIR=/tmp/m3-38 node tests/evaluations/m3-browser/run.mjs
TL_CHROME_PATH=/path/to/chrome TL_BROWSER_LIBS=/path/to/libs node tests/evaluations/m3-browser/run.mjs
```

`npm test` never runs this: it is an explicitly invoked evaluation that writes
only under `TL_M3_EVIDENCE_DIR`, so committed evidence is rewritten only on
purpose.

## Layout

| Path | Purpose |
|---|---|
| `lib/stublibs.mjs` | resolves the Chrome binary and library tree (env-overridable) and compiles the two avahi stubs |
| `lib/browser.mjs` | launch + CDP client (navigate, evaluate, real key/mouse events, screenshot, in-page canvas PNG, console/log/network capture) |
| `probes/capability.ts` | WebGL 2, three renderer, shadows, audio, gamepad, iframe permissions policy, visibility, storage/crypto capabilities |
| `probes/engine.ts` | pinned production `physics-rapier` (real WASM), `three-adapter/gltf-loader`, three `AnimationMixer` crossfade, `input` mapping — under three CSP variants |
| `build-probes.mjs` | esbuild bundling (pinned esbuild, no new dependency) and the static pages |
| `run.mjs` | static server with the production preview CSP + orchestration + evidence |

## What this proves and what it cannot

Proves: real browser, real WebGL 2 (software), real pixels, real DOM/console/
network, real WASM/GLB decoding, real key events, real hidden-tab transitions,
CSP behaviour.

Cannot prove: physical keyboard/gamepad, audible output, hardware-GPU behaviour,
real display compositing of the WebGL canvas, or anything requiring an owner
walkthrough. Those stay UNVERIFIED and are listed in
`docs/planning/m3-contracts/baseline.md` §3 and `docs/planning/m3-acceptance.md`
§5.
