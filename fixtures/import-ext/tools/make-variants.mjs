#!/usr/bin/env node
/**
 * gltf-transform half of the import-ext fixtures: reads base-png.glb (from
 * make-base.py) and writes the extension variants plus hand-edited negative
 * cases, then expected.json (digests + the expected inspector verdict).
 *
 * The encoders are NOT project dependencies. Install them once outside the
 * repository, at these exact versions, and point TL_FIXTURE_TOOLS at that dir:
 *
 *   mkdir -p ~/.cache/thirdlight-fixture-tools && cd ~/.cache/thirdlight-fixture-tools
 *   npm init -y && npm install --save-exact @gltf-transform/core@4.5.0 \
 *     @gltf-transform/extensions@4.5.0 @gltf-transform/functions@4.5.0 \
 *     meshoptimizer@1.2.0 draco3dgltf@1.5.7 ktx2-encoder@0.6.0
 *   TL_FIXTURE_TOOLS=~/.cache/thirdlight-fixture-tools node fixtures/import-ext/tools/make-variants.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');
const TOOLS = process.env.TL_FIXTURE_TOOLS ?? join(homedir(), '.cache', 'thirdlight-fixture-tools');
const req = createRequire(join(TOOLS, 'package.json'));
// ESM entry points, so every package shares one @gltf-transform/core instance.
const ESM = {
  '@gltf-transform/core': 'dist/index.js',
  '@gltf-transform/extensions': 'dist/index.js',
  '@gltf-transform/functions': 'dist/index.js',
  sharp: 'dist/index.mjs',
};
const load = (name) =>
  import(pathToFileURL(ESM[name] !== undefined ? join(TOOLS, 'node_modules', name, ESM[name]) : req.resolve(name)).href);

const { NodeIO } = await load('@gltf-transform/core');
const ext = await load('@gltf-transform/extensions');
const { quantize, reorder, meshopt, draco } = await load('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = await load('meshoptimizer');
const draco3d = (await load('draco3dgltf')).default;
const { ktx2 } = await import(pathToFileURL(join(TOOLS, 'node_modules/ktx2-encoder/dist/gltf-transform/index.js')).href);
const sharp = (await load('sharp')).default;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const base = () => io.readBinary(new Uint8Array(readFileSync(join(OUT, 'base-png.glb'))));

/** glTF JSON (and BIN) surgery on a GLB, for cases no writer would produce. */
function editJson(bytes, fn) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const rest = bytes.slice(20 + jsonLen);
  fn(json, rest.subarray(8));
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const j = new TextEncoder().encode(text);
  const out = new Uint8Array(20 + j.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, j.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  out.set(rest, 20 + j.length);
  return out;
}

const files = {};

// --- valid: every no-decoder material extension on one material -------------
{
  const doc = await base();
  const mat = doc.getRoot().listMaterials()[0];
  const tex = mat.getBaseColorTexture();
  const clearcoat = doc.createExtension(ext.KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(0.8).setClearcoatRoughnessFactor(0.2).setClearcoatTexture(tex);
  const sheen = doc.createExtension(ext.KHRMaterialsSheen).createSheen().setSheenColorFactor([0.2, 0.2, 0.8]).setSheenRoughnessFactor(0.5);
  const transmission = doc.createExtension(ext.KHRMaterialsTransmission).createTransmission().setTransmissionFactor(0.2);
  const volume = doc.createExtension(ext.KHRMaterialsVolume).createVolume().setThicknessFactor(0.1).setAttenuationColor([1, 0.9, 0.8]);
  const strength = doc.createExtension(ext.KHRMaterialsEmissiveStrength).createEmissiveStrength().setEmissiveStrength(2);
  mat.setEmissiveFactor([0.1, 0.02, 0.0]);
  mat.setExtension('KHR_materials_clearcoat', clearcoat);
  mat.setExtension('KHR_materials_sheen', sheen);
  mat.setExtension('KHR_materials_transmission', transmission);
  mat.setExtension('KHR_materials_volume', volume);
  mat.setExtension('KHR_materials_emissive_strength', strength);
  files['materials-all.glb'] = await io.writeBinary(doc);
}

// --- valid: unlit + quantized attributes (KHR_mesh_quantization) -------------
{
  const doc = await base();
  const mat = doc.getRoot().listMaterials()[0];
  mat.setExtension('KHR_materials_unlit', doc.createExtension(ext.KHRMaterialsUnlit).createUnlit());
  await doc.transform(quantize());
  files['unlit-quantized.glb'] = await io.writeBinary(doc);
}

// --- valid: meshopt-compressed geometry AND animation (a 2 s spin) ------------
{
  const doc = await base();
  const root = doc.getRoot();
  const node = root.listNodes()[0];
  const times = doc.createAccessor('spin_t').setType('SCALAR').setArray(new Float32Array([0, 1, 2]));
  const s = Math.SQRT1_2;
  const rots = doc.createAccessor('spin_r').setType('VEC4').setArray(new Float32Array([0, 0, 0, 1, 0, s, 0, s, 0, 1, 0, 0]));
  const sampler = doc.createAnimationSampler().setInput(times).setOutput(rots).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath('rotation').setSampler(sampler);
  doc.createAnimation('spin').addSampler(sampler).addChannel(channel);
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  files['meshopt-cube.glb'] = await io.writeBinary(doc);
}

// --- valid: Draco through gltf-transform (quantized + edgebreaker) ----------
{
  const doc = await base();
  await doc.transform(draco({ method: 'edgebreaker' }));
  files['draco-gt-cube.glb'] = await io.writeBinary(doc);
}

// --- valid: KTX2 / Basis Universal (ETC1S, mipmaps) texture -----------------
{
  const doc = await base();
  const imageDecoder = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  await doc.transform(ktx2({ isUASTC: false, generateMipmap: true, imageDecoder }));
  files['ktx2-cube.glb'] = await io.writeBinary(doc);
}

const webp = new Uint8Array(readFileSync(join(OUT, 'webp-cube.glb')));

// --- rejected: a WebP image as the core texture source ------------------------
files['bad-webp-core-source.glb'] = editJson(webp, (j) => {
  j.textures[0] = { source: 0, sampler: 0 };
  j.extensionsUsed = j.extensionsUsed.filter((e) => e !== 'EXT_texture_webp');
  j.extensionsRequired = j.extensionsRequired.filter((e) => e !== 'EXT_texture_webp');
});
// --- rejected: an allowlisted extension in a place it means nothing ----------
files['bad-ext-placement.glb'] = editJson(webp, (j) => {
  j.materials[0].extensions.KHR_texture_transform = { scale: [2, 2] };
});
// --- rejected: an extension object not declared in extensionsUsed ------------
files['bad-ext-undeclared.glb'] = editJson(webp, (j) => {
  j.extensionsUsed = j.extensionsUsed.filter((e) => e !== 'KHR_materials_ior');
});
// --- rejected: a material-extension texture that does not exist --------------
files['bad-ext-texture-ref.glb'] = editJson(files['materials-all.glb'], (j) => {
  j.materials[0].extensions.KHR_materials_clearcoat.clearcoatTexture = { index: 9 };
});

// --- meshopt codec test vectors: encoded by meshoptimizer's encoder, expected
// output from meshoptimizer's own decoder (the importer's TS port must match).
{
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const vectors = [];
  const add = (name, raw, count, stride, mode, filter = 'NONE') => {
    const encoded = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode, 0);
    const decoded = new Uint8Array(count * stride);
    MeshoptDecoder.decodeGltfBuffer(decoded, count, stride, encoded, mode, filter);
    vectors.push({ name, count, stride, mode, filter, encoded: Buffer.from(encoded).toString('base64'), decoded: Buffer.from(decoded).toString('base64') });
  };
  // smooth positions (float3), 1000 vertices: several 256-vertex blocks
  const pos = new Float32Array(1000 * 3);
  for (let i = 0; i < 1000; i++) pos.set([Math.sin(i / 30) * 4, i / 100, Math.cos(i / 17) + rand() * 0.01], i * 3);
  add('positions-f32x3', new Uint8Array(pos.buffer), 1000, 12, 'ATTRIBUTES');
  // noisy bytes, 37 vertices of stride 8 (a partial group)
  const noise = new Uint8Array(37 * 8);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(rand() * 256);
  add('noise-u8x8', noise, 37, 8, 'ATTRIBUTES');
  // normals through the OCTAHEDRAL filter (8-bit and 16-bit)
  const nrm = new Float32Array(300 * 4);
  for (let i = 0; i < 300; i++) {
    const a = rand() * Math.PI * 2, z = rand() * 2 - 1, r = Math.sqrt(1 - z * z);
    nrm.set([Math.cos(a) * r, Math.sin(a) * r, z, 0], i * 4);
  }
  add('normals-oct8', MeshoptEncoder.encodeFilterOct(nrm, 300, 4, 8), 300, 4, 'ATTRIBUTES', 'OCTAHEDRAL');
  add('normals-oct16', MeshoptEncoder.encodeFilterOct(nrm, 300, 8, 16), 300, 8, 'ATTRIBUTES', 'OCTAHEDRAL');
  // rotations through the QUATERNION filter
  const quat = new Float32Array(200 * 4);
  for (let i = 0; i < 200; i++) {
    const h = i / 40, s = Math.sin(h), c = Math.cos(h);
    quat.set([s * 0.6, s * 0.8, 0, c], i * 4);
  }
  add('rotations-quat', MeshoptEncoder.encodeFilterQuat(quat, 200, 8, 12), 200, 8, 'ATTRIBUTES', 'QUATERNION');
  // times/scales through the EXPONENTIAL filter
  const expv = new Float32Array(150 * 3);
  for (let i = 0; i < expv.length; i++) expv[i] = (rand() - 0.5) * 1000;
  add('values-exp', MeshoptEncoder.encodeFilterExp(expv, 150, 12, 15), 150, 12, 'ATTRIBUTES', 'EXPONENTIAL');
  // a 40x40 grid: 3042 triangles as TRIANGLES (16- and 32-bit) and as INDICES
  const idx = [];
  for (let y = 0; y < 39; y++) for (let x = 0; x < 39; x++) {
    const v = y * 40 + x;
    idx.push(v, v + 40, v + 1, v + 1, v + 40, v + 41);
  }
  const i32 = new Uint32Array(idx);
  const i16 = new Uint16Array(idx);
  add('grid-triangles-u16', new Uint8Array(i16.buffer), idx.length, 2, 'TRIANGLES');
  add('grid-triangles-u32', new Uint8Array(i32.buffer), idx.length, 4, 'TRIANGLES');
  add('grid-indices-u32', new Uint8Array(i32.buffer), idx.length, 4, 'INDICES');
  writeFileSync(join(OUT, 'meshopt-vectors.json'), `${JSON.stringify({ note: 'meshoptimizer 1.2.0 encodeGltfBuffer (version 0) + decodeGltfBuffer; see tools/make-variants.mjs', vectors }, null, 1)}\n`);
}

// --- rejected: a meshopt stream cut short ------------------------------------
files['bad-meshopt-truncated.glb'] = editJson(files['meshopt-cube.glb'], (j) => {
  const e = j.bufferViews.find((bv) => bv.extensions?.EXT_meshopt_compression?.mode === 'ATTRIBUTES').extensions.EXT_meshopt_compression;
  e.byteLength -= 8;
});
// --- rejected: a Draco attribute the primitive does not have ------------------
files['bad-draco-attribute.glb'] = editJson(files['draco-gt-cube.glb'], (j) => {
  j.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes.COLOR_0 = 7;
});
// --- rejected: a KTX2 image that is not Basis Universal (vkFormat != 0) -------
files['bad-ktx2-not-basis.glb'] = editJson(files['ktx2-cube.glb'], (j, bin) => {
  const bv = j.bufferViews[j.images[0].bufferView];
  new DataView(bin.buffer, bin.byteOffset).setUint32((bv.byteOffset ?? 0) + 12, 37, true); // VK_FORMAT_R8G8B8A8_UNORM
});

const expected = {
  note: 'Generated by tools/make-base.py (Blender 5.2.2) and tools/make-variants.mjs (@gltf-transform 4.5.0). The inspector verdicts are asserted by packages/asset-pipeline/src/import-ext.test.ts.',
  files: {},
};
for (const name of ['base-png.glb', 'webp-cube.glb', 'draco-cube.glb']) files[name] = new Uint8Array(readFileSync(join(OUT, name)));
const verdict = {
  'base-png.glb': { status: 'ok', extensions: [] },
  'webp-cube.glb': { status: 'ok', extensions: ['EXT_texture_webp', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_texture_transform'] },
  'materials-all.glb': { status: 'ok', extensions: ['KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_sheen', 'KHR_materials_transmission', 'KHR_materials_volume'] },
  'unlit-quantized.glb': { status: 'ok', extensions: ['KHR_materials_unlit', 'KHR_mesh_quantization'] },
  'draco-cube.glb': { status: 'ok', extensions: ['KHR_draco_mesh_compression'] },
  'draco-gt-cube.glb': { status: 'ok', extensions: ['KHR_draco_mesh_compression'] },
  'meshopt-cube.glb': { status: 'ok', extensions: ['EXT_meshopt_compression', 'KHR_mesh_quantization'] },
  'ktx2-cube.glb': { status: 'ok', extensions: ['KHR_texture_basisu'] },
  'bad-meshopt-truncated.glb': { status: 'rejected', codes: ['asset_buffer_invalid'] },
  'bad-draco-attribute.glb': { status: 'rejected', codes: ['asset_primitive_unsupported'] },
  'bad-ktx2-not-basis.glb': { status: 'rejected', codes: ['asset_image_invalid'] },
  'bad-webp-core-source.glb': { status: 'rejected', codes: ['asset_texture_invalid'] },
  'bad-ext-placement.glb': { status: 'rejected', codes: ['asset_extension_unsupported'] },
  'bad-ext-undeclared.glb': { status: 'rejected', codes: ['asset_extension_unsupported'] },
  'bad-ext-texture-ref.glb': { status: 'rejected', codes: ['asset_material_invalid'] },
};
const b64 = {};
for (const [name, bytes] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
  writeFileSync(join(OUT, name), bytes);
  b64[name] = Buffer.from(bytes).toString('base64');
  expected.files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, ...verdict[name] };
  console.log(`${name.padEnd(28)} ${String(bytes.length).padStart(7)} B  ${expected.files[name].sha256}`);
}
writeFileSync(join(OUT, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
writeFileSync(join(OUT, 'bytes.base64.json'), `${JSON.stringify(b64, null, 2)}\n`);
