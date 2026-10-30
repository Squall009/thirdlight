/**
 * three's Draco and Basis decoder files, shipped with an export only when a
 * shipped KTX2 texture or a
 * shipped GLB declares KHR_draco_mesh_compression / KHR_texture_basisu (read
 * from the GLB's own extensionsUsed, i.e. the bytes the game will load). The
 * export bootstrap's loader port looks for them at `./decoders/`. Meshopt
 * needs no files (its decoder is inside the bundle). Pure: bytes in, list out.
 */

import { isKtx2, readGlb } from '@thirdlight/shared';

/** Export path → path inside the pinned `three` package. */
const DECODERS: Readonly<Record<'draco' | 'basis', readonly (readonly [string, string])[]>> = {
  draco: [
    ['decoders/draco/draco_wasm_wrapper.js', 'examples/jsm/libs/draco/draco_wasm_wrapper.js'],
    ['decoders/draco/draco_decoder.wasm', 'examples/jsm/libs/draco/draco_decoder.wasm'],
  ],
  basis: [
    ['decoders/basis/basis_transcoder.js', 'examples/jsm/libs/basis/basis_transcoder.js'],
    ['decoders/basis/basis_transcoder.wasm', 'examples/jsm/libs/basis/basis_transcoder.wasm'],
  ],
};

/** The license row for each decoder (both are Apache-2.0, vendored by three). */
export const DECODER_LICENSES: Readonly<Record<'draco' | 'basis', { id: string; license: string }>> = {
  draco: { id: 'draco-decoder (three/examples/jsm/libs/draco)', license: 'Apache-2.0' },
  basis: { id: 'basis-transcoder (three/examples/jsm/libs/basis)', license: 'Apache-2.0' },
};

/** `extensionsUsed` of one GLB, or [] when the header/JSON is unreadable. */
function glbExtensionsUsed(bytes: Uint8Array): string[] {
  const glb = readGlb(bytes);
  if (typeof glb === 'string') return [];
  const used = glb.json['extensionsUsed'];
  return Array.isArray(used) ? used.filter((e): e is string => typeof e === 'string') : [];
}

/** Which decoders the shipped models (and KTX2 textures) need. */
export function decodersNeeded(assets: readonly { bytes: Uint8Array; contentType: string }[]): ('draco' | 'basis')[] {
  const need = new Set<'draco' | 'basis'>();
  for (const a of assets) {
    // A KTX2 texture asset needs the Basis transcoder too.
    if (a.contentType === 'image/x-texture' && isKtx2(a.bytes)) need.add('basis');
    if (a.contentType !== 'model/gltf-binary') continue;
    const used = glbExtensionsUsed(a.bytes);
    if (used.includes('KHR_draco_mesh_compression')) need.add('draco');
    if (used.includes('KHR_texture_basisu')) need.add('basis');
  }
  return [...need].sort();
}

/** The files to ship for `needed`, read from the pinned three package directory. */
export function decoderFiles(needed: readonly ('draco' | 'basis')[], threeDir: string, read: (path: string) => Uint8Array, join: (...p: string[]) => string): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (const d of needed) for (const [path, rel] of DECODERS[d]) out.push({ path, bytes: read(join(threeDir, ...rel.split('/'))) });
  return out;
}
