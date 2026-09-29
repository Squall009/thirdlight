# Decision 0006 — KTX2 texture encoding on import (phase 25.19)

Status: **ACCEPTED — phase 25 autonomous run (owner, 2026-09-28: "no
approval stops; take the most generic sound option and log it"); owner
review pending.** Binding for the backend's KTX2 encoding.

## 1. The pins

- `ktx2-encoder` at exactly **`0.6.0`** (MIT; one dependency, `ktx-parse`
  ^1.1.0, MIT). It bundles a precompiled, non-threaded WASM build of the
  **Basis Universal** encoder (Apache-2.0; upstream commit `1b33fd50…`,
  2026-07-05, Emscripten 4.0.15, `KTX2_ZSTANDARD=ON`; its
  `THIRD_PARTY_NOTICES.md` carries the attribution) — the npm-packaged
  encoder, no system binary. Integrity
  `sha512-gEWkw2YUlhKO4hXhqVLQQWJ+fGJObsXIwz0pGjJMclnQ4MQU3SAtN1MzutjFxO3ejWvxHyvFk5kr8+RtLmHiTA==`.
- `jpeg-js` at exactly **`0.4.4`** (BSD-3-Clause, no dependencies): decodes
  JPEG sources to RGBA for the encoder. PNG sources are decoded in-house
  (`packages/backend/src/png-decode.ts`, node:zlib).
- Declared by `packages/backend` only; pinned in `tools/check-deps.mjs`,
  allowed for the backend in `tools/check-boundaries.mjs` (with the
  `worker_threads` and `zlib` builtins); installed with
  `npm install --save-exact`. Both stay external to the backend bundle
  (the encoder loads its WASM next to its own file) and are never in a
  browser bundle or an export: the game only loads the encoded KTX2, which
  three's own transcoder (already vendored by the pinned three) reads.

## 2. What it does

`ktx2: "color"` → ETC1S (quality 128), sRGB transfer function, perceptual,
mipmaps; `"normal"` → UASTC LDR 4×4 with Zstandard supercompression, linear,
the encoder's normal-map preset (renormalized mips). The KTX2 is the asset
version's bytes; `convertedFrom` records the original, the encoder and its
version (the output depends on them), and the encoding. One encode at a time
in a worker thread of the backend (`dist/backend/ktx2-worker.mjs`).

## 3. Limits

12 Mpix per source (the encoder's own cap), PNG and JPEG only (WebP is
refused with the reason), no "data" (linear, uncompressed-channel) mode: the
wrapper exposes no linear-mip preset. Changing either pin changes encoded
bytes: a new pin is a new decision.
