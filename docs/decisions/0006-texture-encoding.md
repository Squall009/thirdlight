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
- `@jsquash/webp` at exactly **`1.5.0`** (Apache-2.0; one dependency,
  `wasm-feature-detect` ^1.2.11, Apache-2.0): libwebp's decoder as WASM
  (Squoosh's build). Decodes WebP sources (a WebP texture, a model's WebP
  image on "extract textures") to RGBA for the encoder, since 2026-10-03
  (phase 28.11, Skyforge E78). Its WASM is read from the package in
  node_modules and instantiated in the encoder's thread. Integrity
  `sha512-KggLoj2MnRSfIqTeKe1EmbljTX2vuV7mh79k89PCL1pyqiDULcPM1L47twxXt0hkb68F70bXiL31MxsuoZtKFw==`.
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

12 Mpix per source (the encoder's own cap), PNG, JPEG and (since 28.11)
WebP sources, no "data" (linear, uncompressed-channel) mode: the
wrapper exposes no linear-mip preset. Changing either pin changes encoded
bytes: a new pin is a new decision.

## 4. Addendum (phase 25.21): data encoding, packing, texture arrays

No new pin: the same `ktx2-encoder` 0.6.0 and its Basis Universal build.

- `ktx2: "data"` → UASTC LDR 4×4 with Zstandard, linear, no normal-map
  preset, not perceptual: channels stay apart (ETC1S would mix them), so
  masks, heights and packed occlusion/roughness/metalness keep their values.
  This closes §3's "no data mode".
- **Packing** (`POST …/content/textures/pack`, MCP `tl_content_upload
  {pack}`): the backend reads the named PNG/JPEG texture assets' current
  versions, decodes them (the same decoders), builds each layer's RGBA from
  per-channel sources (a channel of a source, or a constant), and encodes all
  layers as one KTX2 — a Basis 2D array (`cBASISTexType2DArray`) when there
  are several, a 2D texture for one. The wrapper's own encode entry always
  sets a 2D type, so the packer drives the wrapper's Basis module directly
  (through the package's exported `NodeBasisEncoder` loader, with the same
  settings the colour/normal imports use). The version records `packedFrom`
  (each channel's asset id, the source version's digest and channel, or the
  constant; the encoder and version; the encoding) instead of `convertedFrom`.
- Limits: all sources one size; at most 12 Mpix across the layers (the
  encoder's cap: four 1024² layers, two 2048²); at most 256 layers (the
  guaranteed array depth of WebGL 2 and WebGPU). A KTX2 or WebP source is
  refused (it cannot be unpacked on the server).
