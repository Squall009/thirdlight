# Packet 38 evidence index

Executed 2026-09-19 by packet 38. Raw artifacts in this directory.

## Reproduce

```sh
node tests/evaluations/m3-browser/run.mjs
```

## Environment (from summary.json)

- `browserVersion`: `Chrome/151.0.7922.34`
- `protocolVersion`: `1.3`
- `userAgent`: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36`
- `chromePath`: `/home/dadmin/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
- `libraryPath`: `/home/dadmin/projects/visionary/.browser-libs/root/usr/lib/x86_64-linux-gnu`
- `stubPath`: `/tmp/tl-m3-browser-stubs`
- `origin`: `http://127.0.0.1:8793`
- `csp`: `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
- `cspWithWasm`: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
- `display`: `None`
- `note`: `software rasteriser (ANGLE/SwiftShader); no display; physical gamepad and audio device absent`

## Row results

| Row | Status | Detail |
|---|---|---|
| browser-launch | PASS | `{"browserVersion": "Chrome/151.0.7922.34"}` |
| webgl2 | PASS | `{"evidence": "capability.json"}` |
| three-render | PASS | `{"evidence": "capability-canvas.png"}` |
| keyboard-events | PASS | `{"keys": "[\"Enter\",\"up:Enter\",\"Space\",\"up:Space\"]"}` |
| hidden-tab | PASS | `{"visibilityState": "hidden", "seen": "[\"hidden\"]"}` |
| engine-engine | FAIL | `{"physicsOk": false, "physicsError": {"code": "physics_init_failed", "reason": "wasm_unavailable", "message": "Rapier WASM initialization failed: WebAssembly.instantiate(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because 'unsafe-eval' is` |
| engine-engine-nocsp | PASS | `{"physicsOk": true, "physicsError": null, "wasmCompile": "ok", "glbLoaded": true, "glbError": null, "clipCount": 1, "evidence": "engine-nocsp.json"}` |
| engine-engine-csp-wasm | PASS | `{"physicsOk": true, "physicsError": null, "wasmCompile": "ok", "glbLoaded": true, "glbError": null, "clipCount": 1, "evidence": "engine-csp-wasm.json"}` |

## Artifacts (sha256)

```text
e4eea4a4b5aaf2f574f08db615f92cb132b0f2e731b95c052c4569503f2ded4b  capability-canvas.png
18f113cfbc15903bc56464f1d3a8363015e241f4ea4af53e643a7ab0b6358f71  capability-console-network.json
344f9ef9d43845839d036316d06b1199ac75fa3e19dfffecbfac65ac0eac18f1  capability-page.png
7e01f259664d2639cf19839e69e2d1240abc2a87aafb2b0e52db2eee49882f00  capability.json
107ad0bf60340234ba59407417c4773eff86a47a3d92e5ea6c6862c251ee173d  engine-console-network.json
b3085c67b26235ce0f5d66129631367e3a36c5d3b6db71d7b64dcbd3988f849a  engine-csp-wasm-console-network.json
c078353f115c3b23e471f963212847b51b9ac82f6d8a864622e7eaca9841c724  engine-csp-wasm.json
41cda633f8713245029d9a79d6d3b7ac842b0e0c42253fe413de4e72e0cbb1c3  engine-nocsp-console-network.json
c078353f115c3b23e471f963212847b51b9ac82f6d8a864622e7eaca9841c724  engine-nocsp.json
33e7cbab924781efc35f963a0d2e0e006030d11a637890aadc7eb5d3feb310a8  engine-page.png
a6b467f07789cd6b258fe93dd8ca355c62c31da0b4d94788685622547168ec5c  engine.json
f2245d8cc9a6901623de2c11578fdc5f256b29598e275d1ad5d58abbfc379fbb  summary.json
```
