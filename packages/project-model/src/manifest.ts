import { canonicalJsonText, sha256Hex, sha256HexOfText } from '@thirdlight/shared';
import { MODULE_IDS } from './modules';
/**
 * The runtime-content manifest's shared pieces: its discriminator, the content
 * file size caps, the build-options record, the engine pins and module table
 * the manifest rows name, a behavior row's input, the recipe digest and the
 * export closure's digest. The manifest itself is captured by `manifest-v5.ts`
 * (and read in its older version by `manifest-v2.ts`).
 *
 * This module is in the zero-dependency `project-model` leaf because the
 * canonical JSON text and the SHA-256 helpers (`./sha256`) already live here.
 */

/**
 * The toolchain the engine builds scripts and games with and records in their
 * manifests: the bundler, the script type checker and the renderer. They are
 * the repository's installed pins; tools/check-deps.mjs fails the build when
 * they disagree.
 */
export const TOOLCHAIN_PINS = Object.freeze({ esbuild: '0.28.2', typescript: '5.9.3', three: '0.186.1' } as const);

/** The engine version a new project's manifest and an export's record name. */
export const ENGINE_VERSION = '0.1.0';

/** The manifest discriminator. */
export const RUNTIME_CONTENT_TYPE = 'thirdlight-runtime-content' as const;

/**
 * The most bytes one content file of a Play build or an export may hold; the
 * play content store takes it as its single-artifact cap.
 */
export const MANIFEST_CONTENT_FILE_MAX_BYTES = 33_554_432;

/**
 * The manifest document cap: the manifest is one file like the content files
 * it lists, so it has their per-file cap. Asset rows, rigs and prefabs are
 * still inline and grow with the game; a fixed cap below a file's would bound
 * how many assets a game ships.
 */
export const RUNTIME_CONTENT_MANIFEST_MAX_BYTES = MANIFEST_CONTENT_FILE_MAX_BYTES;

/** The exact canonical option-set record. */
export const BUILD_OPTIONS_RECORD = Object.freeze({
  bundler: `esbuild@${TOOLCHAIN_PINS.esbuild}`,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  target: 'es2022',
  loaders: ['ts', 'tsx'],
});

/** `JSON.stringify(record, null, 2) + "\n"` — the bytes `buildOptionsDigest` covers. */
export function buildOptionsRecordBytes(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(BUILD_OPTIONS_RECORD, null, 2)}\n`);
}

/**
 * The pinned engine table recorded in `enginePins`, ascending by `id`. A
 * version change is an owner-approved decision change.
 */
export const M2_ENGINE_PINS: ReadonlyArray<{ id: string; version: string; apiVersion: number }> = Object.freeze([
  Object.freeze({ id: '@thirdlight/input', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/physics-rapier', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/three', version: '0.186.0', apiVersion: 0 }),
  Object.freeze({ id: '@thirdlight/three-adapter', version: '0.1.0', apiVersion: 1 }),
]);

/** The package a known module id belongs to (the manifest `modules` rows). */
export const M2_MODULE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  [MODULE_IDS.keyboardGamepad]: '@thirdlight/input',
  [MODULE_IDS.gltfLoader]: '@thirdlight/three-adapter',
});

/** One reachable source-bearing behavior. */
export interface ManifestBehaviorInput {
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  apiVersion: number;
  declaration: unknown;
  ownedTransforms: readonly string[];
  requiredModules: readonly string[];
}

/** `recipeDigest` for one import recipe. */
export function recipeDigestOf(importRecipe: unknown): string {
  return sha256HexOfText(canonicalJsonText(importRecipe));
}

/** One emitted artifact of the export closure (path relative to the output root). */
export interface EmittedArtifactDigest {
  path: string;
  digest: string;
  byteLength: number;
}

/**
 * `meta.json.outputDigest`: the SHA-256 record of the emitted
 * closure. Deterministic over the emitted artifact listing (sorted by path,
 * excluding `meta.json` itself — it carries `exportedAt` and this value):
 *
 *   sha256( for each artifact: `${path}\n${digest}\n${byteLength}\n` )
 *
 * The algorithm is not fixed by the accepted contract text (a contract-change
 * request C36-3 records the proposed definition).
 */
export function digestEmittedClosure(artifacts: readonly EmittedArtifactDigest[]): string {
  const rows = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let text = '';
  for (const a of rows) text += `${a.path}\n${a.digest}\n${a.byteLength}\n`;
  return sha256HexOfText(text);
}

/** SHA-256 (lowercase hex) of one byte string — re-exported for closure digests. */
export const digestBytes = sha256Hex;
