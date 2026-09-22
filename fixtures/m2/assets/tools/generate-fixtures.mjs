#!/usr/bin/env node
/**
 * Packet 24 fixture generator — self-generated, redistribution-safe GLB files
 * under `fixtures/m2/assets/`.
 *
 * Nothing here is downloaded: every byte is produced by this script from
 * scratch (raw buffers, a hand-built GLB container, hand-built PNG chunks with
 * real CRCs and a real zlib IDAT stream for the 1x1 images). The generator
 * writes:
 *
 *   fixtures/m2/assets/*.glb              the committed fixture bytes
 *   fixtures/m2/assets/bytes.base64.json  base64 sidecars for the *tests*
 *
 * The base64 sidecars exist because `packages/asset-pipeline` is a pure leaf
 * (no Node built-ins, no I/O — dependencies.md §4.1) and therefore cannot read
 * files: its tests load the exact committed bytes through the Vite
 * `import.meta.glob(..., '?raw')` transform plus a base64 decode, and assert
 * `sha256(bytes) === expected.json.entries[].sha256`, which is the digest of
 * the committed `.glb` file. `expected.json` also records that digest, and the
 * packet-24 evidence manifest records `sha256sum` over the committed files.
 *
 * Usage: node fixtures/m2/assets/tools/generate-fixtures.mjs
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// --- GLB container -----------------------------------------------------------

function glbFromRawJson(jsonText, bin) {
  const jsonBytes = Buffer.from(jsonText, 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const c0 = Buffer.alloc(8);
  c0.writeUInt32LE(jsonChunk.length, 0);
  c0.writeUInt32LE(CHUNK_JSON, 4);
  const c1 = Buffer.alloc(8);
  c1.writeUInt32LE(binChunk.length, 0);
  c1.writeUInt32LE(CHUNK_BIN, 4);
  return Buffer.concat([header, c0, jsonChunk, c1, binChunk]);
}

function glb(json, bin) {
  return glbFromRawJson(JSON.stringify(json), bin);
}

const f32 = (values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
};
const u16 = (values) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b;
};
const pad4 = (b) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]));

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([body, data])), 0);
  return Buffer.concat([length, body, data, crc]);
}

/** A structurally valid PNG: real signature/IHDR/IDAT(zlib)/IEND + CRCs. */
function png(width, height, pixelRowBytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = pixelRowBytes ?? Buffer.alloc(1 + width * 4, 0); // filter byte + RGBA row
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ONE_PIXEL_PNG = png(1, 1);
// Header-valid PNG whose declared dimensions are far beyond the decoded cap.
// M2 has no image decoder: the profile bounds decoded pixel bytes from the
// header, which is exactly the resource the cap protects (see README.md).
const HUGE_PNG = png(20000, 20000, Buffer.alloc(5, 0));

// --- the tiny models ---------------------------------------------------------

const BASE_BUFFER_VIEWS = [
  { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
  { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
  { buffer: 0, byteOffset: 72, byteLength: 6, target: 34963 },
  { buffer: 0, byteOffset: 80, byteLength: 12 },
  { buffer: 0, byteOffset: 92, byteLength: 48 },
];

const BASE_BIN = pad4(
  Buffer.concat([
    f32([0, 0, 0, 1, 0, 0, 0, 1, 0]), // POSITION
    f32([0, 0, 1, 0, 0, 1, 0, 0, 1]), // NORMAL
    u16([0, 1, 2]), // indices
    Buffer.alloc(2), // pad to the 4-byte boundary
    f32([0, 0.5, 1]), // animation input times
    f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), // rotation quaternions
  ]),
);

const BASE_ACCESSORS = [
  { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
  { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
  { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
  { bufferView: 3, componentType: 5126, count: 3, type: 'SCALAR' },
  { bufferView: 4, componentType: 5126, count: 3, type: 'VEC4' },
];

const BASE_MATERIALS = [
  {
    name: 'MatA',
    pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 },
  },
  {
    name: 'MatB',
    alphaMode: 'MASK',
    alphaCutoff: 0.5,
    doubleSided: true,
    pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.9, 1] },
  },
];

/** tiny-v1: one triangle, two materials, one rotation clip. */
function tinyV1() {
  const json = {
    asset: { version: '2.0', generator: 'thirdlight packet-24 fixture (self-generated)' },
    scene: 0,
    scenes: [{ name: 'Main', nodes: [0] }],
    nodes: [{ name: 'Root', children: [1] }, { name: 'Tri', mesh: 0 }],
    meshes: [
      {
        name: 'TriMesh',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }],
      },
    ],
    materials: BASE_MATERIALS,
    animations: [
      {
        name: 'Spin',
        samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
      },
    ],
    buffers: [{ byteLength: BASE_BIN.length }],
    bufferViews: BASE_BUFFER_VIEWS,
    accessors: BASE_ACCESSORS,
  };
  return glb(json, BASE_BIN);
}

/** tiny-v2: quad geometry, reordered materials, two-clip channels, node swap. */
function tinyV2() {
  const bin = pad4(
    Buffer.concat([
      f32([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), // POSITION (quad)
      f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), // NORMAL
      u16([0, 1, 2, 0, 2, 3]), // indices (two triangles)
      f32([0, 0.5, 1, 2]), // times
      f32([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), // translation
      f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), // rotation
    ]),
  );
  const json = {
    asset: { version: '2.0', generator: 'thirdlight packet-24 fixture (self-generated)' },
    scene: 0,
    scenes: [{ name: 'Main', nodes: [1] }],
    nodes: [{ name: 'Tri', mesh: 0 }, { name: 'Root', children: [0] }],
    meshes: [
      {
        name: 'TriMesh2',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: 'MatB',
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.9, 1] },
      },
      {
        name: 'MatA',
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 },
      },
    ],
    animations: [
      {
        name: 'Spin2',
        samplers: [
          { input: 3, output: 5, interpolation: 'LINEAR' },
          { input: 3, output: 4, interpolation: 'LINEAR' },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: 'rotation' } },
          { sampler: 1, target: { node: 0, path: 'translation' } },
        ],
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 12, target: 34963 },
      { buffer: 0, byteOffset: 108, byteLength: 16 },
      { buffer: 0, byteOffset: 124, byteLength: 48 },
      { buffer: 0, byteOffset: 172, byteLength: 64 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 4, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 5, componentType: 5126, count: 4, type: 'VEC4' },
    ],
  };
  return glb(json, bin);
}

/** A copy of tiny-v1's JSON with `mutate` applied, over the same BIN. */
function basedOnTinyV1(mutate, binExtra = Buffer.alloc(0), extraViews = []) {
  const bytes = tinyV1();
  const jsonLength = bytes.readUInt32LE(12);
  const jsonStart = 20;
  const base = JSON.parse(bytes.subarray(jsonStart, jsonStart + jsonLength).toString('utf8'));
  const bin = Buffer.concat([BASE_BIN, binExtra]);
  base.buffers = [{ byteLength: bin.length }];
  base.bufferViews = [...BASE_BUFFER_VIEWS, ...extraViews];
  mutate(base);
  return glb(base, bin);
}

// --- the fixture set ---------------------------------------------------------

const fixtures = {};

fixtures['tiny-v1.glb'] = tinyV1();
fixtures['tiny-v2.glb'] = tinyV2();

// 3 — truncation: the header still declares the full container length.
{
  const full = tinyV1();
  fixtures['truncated.glb'] = full.subarray(0, full.length - 20);
}

// 4 — bad chunk framing: the second chunk is not BIN.
{
  const bytes = Buffer.from(tinyV1());
  const jsonLength = bytes.readUInt32LE(12);
  bytes.writeUInt32LE(0x12345678, 12 + 8 + jsonLength + 4);
  fixtures['bad-chunk.glb'] = bytes;
}

// 5 — duplicate JSON member name.
fixtures['bad-json.glb'] = glbFromRawJson(
  '{"asset":{"version":"2.0","version":"2.0"},"buffers":[{"byteLength":0}],"bufferViews":[]}',
  Buffer.alloc(0),
);

// 6 — JSON chunk BOM (the container length stays consistent).
fixtures['bom-json.glb'] = glbFromRawJson(`\ufeff${JSON.stringify({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 0 }],
  bufferViews: [],
})}`, Buffer.alloc(0));

// 7 — accessor overflow: count far beyond its bufferView.
fixtures['accessor-overflow.glb'] = basedOnTinyV1((json) => {
  json.accessors[0].count = 1000000;
});

// 8 — external/remote buffer URI.
fixtures['external-uri-buffer.glb'] = basedOnTinyV1((json) => {
  json.buffers = [{ uri: 'https://example.invalid/model.bin', byteLength: BASE_BIN.length }];
});

// 9 — external `data:` image URI.
fixtures['external-uri-image.glb'] = basedOnTinyV1((json) => {
  json.images = [{ uri: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }];
});

// 10 — unsupported required extension.
fixtures['required-extension.glb'] = basedOnTinyV1((json) => {
  json.extensionsUsed = ['KHR_materials_unlit'];
  json.extensionsRequired = ['KHR_materials_unlit'];
});

// 11 — compression extension.
fixtures['compression.glb'] = basedOnTinyV1((json) => {
  json.extensionsUsed = ['KHR_draco_mesh_compression'];
  json.extensionsRequired = ['KHR_draco_mesh_compression'];
});

// 12 — decoded image byte cap (header-declared 20000x20000 = 1.6 GB pixels).
{
  const offset = BASE_BIN.length;
  fixtures['decoded-limit.glb'] = basedOnTinyV1(
    (json) => {
      json.images = [{ name: 'huge', bufferView: 5, mimeType: 'image/png' }];
    },
    HUGE_PNG,
    [{ buffer: 0, byteOffset: offset, byteLength: HUGE_PNG.length }],
  );
}

// 13 — image count cap (65 one-pixel images).
{
  const explicit4 = pad4(ONE_PIXEL_PNG);
  const bin = Buffer.concat([BASE_BIN, ...Array.from({ length: 65 }, () => explicit4)]);
  const json = {
    asset: { version: '2.0', generator: 'thirdlight packet-24 fixture (self-generated)' },
    scene: 0,
    scenes: [{ name: 'Main', nodes: [0] }],
    nodes: [{ name: 'Root', children: [1] }, { name: 'Tri', mesh: 0 }],
    meshes: [
      {
        name: 'TriMesh',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }],
      },
    ],
    materials: BASE_MATERIALS,
    images: Array.from({ length: 65 }, (_, i) => ({
      name: `img${String(i).padStart(2, '0')}`,
      bufferView: 5 + i,
      mimeType: 'image/png',
    })),
    animations: [
      {
        name: 'Spin',
        samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      ...BASE_BUFFER_VIEWS,
      ...Array.from({ length: 65 }, (_, i) => ({
        buffer: 0,
        byteOffset: BASE_BIN.length + i * explicit4.length,
        byteLength: ONE_PIXEL_PNG.length,
      })),
    ],
    accessors: BASE_ACCESSORS,
  };
  fixtures['image-count-limit.glb'] = glb(json, bin);
}

// 14 — node count cap (4097 nodes).
fixtures['count-limit.glb'] = basedOnTinyV1((json) => {
  const extra = Array.from({ length: 4095 }, (_, i) => ({ name: `n${i}` }));
  json.nodes = [...json.nodes, ...extra];
});

// 15 — malformed clip: input times are not strictly increasing.
fixtures['malformed-clip.glb'] = (() => {
  const bin = pad4(
    Buffer.concat([
      Buffer.from(BASE_BIN.subarray(0, 80)),
      f32([0, 0.5, 0.5]),
      Buffer.from(BASE_BIN.subarray(92)),
    ]),
  );
  const bytes = tinyV1();
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  json.buffers = [{ byteLength: bin.length }];
  return glb(json, bin);
})();

// 16 — empty model: a mesh with no primitives.
fixtures['empty-model.glb'] = basedOnTinyV1((json) => {
  json.meshes = [{ name: 'Empty', primitives: [] }];
});

// 17 — image magic bytes do not match the declared mimeType.
{
  const offset = BASE_BIN.length;
  fixtures['mime-mismatch.glb'] = basedOnTinyV1(
    (json) => {
      json.images = [{ name: 'png-as-jpeg', bufferView: 5, mimeType: 'image/jpeg' }];
    },
    ONE_PIXEL_PNG,
    [{ buffer: 0, byteOffset: offset, byteLength: ONE_PIXEL_PNG.length }],
  );
}

// --- write -------------------------------------------------------------------

mkdirSync(ROOT, { recursive: true });
const base64 = {};
const report = [];
for (const name of Object.keys(fixtures).sort()) {
  const bytes = fixtures[name];
  writeFileSync(join(ROOT, name), bytes);
  base64[name] = bytes.toString('base64');
  report.push({ name, byteLength: bytes.length, sha256: sha256(bytes) });
}

const base64Text =
  JSON.stringify(
    {
      note: 'Generated by tools/generate-fixtures.mjs — base64 of the committed *.glb fixtures, used by the pure (no-I/O) package tests. Do not edit by hand.',
      files: base64,
    },
    null,
    2,
  ) + '\n';
writeFileSync(join(ROOT, 'bytes.base64.json'), base64Text);

let expectedText = '';
try {
  expectedText = readFileSync(join(ROOT, 'expected.json'), 'utf8');
} catch {
  expectedText = '';
}
for (const entry of report) {
  const re = new RegExp(`("file": "${entry.name.replace('.', '\\.')}"[\\s\\S]*?"sha256": ")[0-9a-f]{64}`);
  if (!re.test(expectedText)) {
    console.log(`${entry.name}: no expected.json entry (sha256 ${entry.sha256}, ${entry.byteLength} B)`);
  }
}
console.log(`generate-fixtures: wrote ${report.length} GLB fixture(s) + bytes.base64.json`);
for (const entry of report) {
  console.log(`  ${entry.name.padEnd(26)} ${String(entry.byteLength).padStart(7)} B  ${entry.sha256}`);
}
