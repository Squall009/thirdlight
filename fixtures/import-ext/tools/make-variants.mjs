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
const load = (name) => import(pathToFileURL(req.resolve(name)).href);

const { NodeIO } = await load('@gltf-transform/core');
const ext = await load('@gltf-transform/extensions');
const { quantize } = await load('@gltf-transform/functions');

const io = new NodeIO().registerExtensions(ext.ALL_EXTENSIONS);
const base = () => io.readBinary(new Uint8Array(readFileSync(join(OUT, 'base-png.glb'))));

/** glTF JSON surgery on a GLB (for cases no writer would produce). */
function editJson(bytes, fn) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const rest = bytes.subarray(20 + jsonLen);
  fn(json);
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

const expected = {
  note: 'Generated by tools/make-base.py (Blender 5.2.2) and tools/make-variants.mjs (@gltf-transform 4.5.0). The inspector verdicts are asserted by packages/asset-pipeline/src/import-ext.test.ts.',
  files: {},
};
for (const name of ['base-png.glb', 'webp-cube.glb']) files[name] = new Uint8Array(readFileSync(join(OUT, name)));
const verdict = {
  'base-png.glb': { status: 'ok', extensions: [] },
  'webp-cube.glb': { status: 'ok', extensions: ['EXT_texture_webp', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_texture_transform'] },
  'materials-all.glb': { status: 'ok', extensions: ['KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_sheen', 'KHR_materials_transmission', 'KHR_materials_volume'] },
  'unlit-quantized.glb': { status: 'ok', extensions: ['KHR_materials_unlit', 'KHR_mesh_quantization'] },
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
