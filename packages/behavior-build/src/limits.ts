/**
 * Compiler constants, the pinned module table and the pinned build option set.
 *
 * `COMPILER_LIMITS` is the closed resource-bound table; the pinned esbuild
 * option set is a contract constant — changing any of it is a reviewed
 * contract change.
 */

import { version as esbuildVersion } from 'esbuild';
import {
  BEHAVIOR_ENTRY_PATH,
  MAX_BEHAVIOR_DIAGNOSTICS,
  MAX_BEHAVIOR_FILES,
  MAX_BEHAVIOR_FILE_BYTES,
  MAX_BEHAVIOR_OUTPUT_BYTES,
  MAX_BEHAVIOR_SOURCE_BYTES,
  MAX_DECLARATION_BYTES,
  MAX_OWNED_TRANSFORMS,
} from '@thirdlight/project-model';
import type { BehaviorCompilerLimits, PinnedModuleRef } from './types';

/** The stable compiler identity (`COMPILER_ID` string). */
export const COMPILER_ID = 'thirdlight.behavior-compiler' as const;

/** The compiler implementation version (the manifest's `compiler.version`). */
export const COMPILER_VERSION = '1' as const;

/** The pinned toolchain. */
export const ESBUILD_PIN = '0.28.2' as const;
export const TYPESCRIPT_PIN = '5.9.3' as const;

/** The behavior API version. */
export const BEHAVIOR_API_VERSION = 1 as const;

/** The fixed entry path (exactly `src/index.ts`). */
export const ENTRY_PATH = BEHAVIOR_ENTRY_PATH;

/**
 * The defaults. The contract lists the first nine keys; `ownedTransforms`
 * and `declarationBytes` are project-model bounds the preparer re-checks here.
 */
export const COMPILER_LIMITS: Readonly<BehaviorCompilerLimits> = Object.freeze({
  files: MAX_BEHAVIOR_FILES,
  fileBytes: MAX_BEHAVIOR_FILE_BYTES,
  graphBytes: MAX_BEHAVIOR_SOURCE_BYTES,
  importDepth: 8,
  importsPerFile: 16,
  ownedTransforms: MAX_OWNED_TRANSFORMS,
  diagnostics: MAX_BEHAVIOR_DIAGNOSTICS,
  timeoutMs: 2_000,
  outputBytes: MAX_BEHAVIOR_OUTPUT_BYTES,
  declarationBytes: MAX_DECLARATION_BYTES,
} as const);

/**
 * The pinned build option set for the intermediate output.
 * `absWorkingDir: '/'` is a determinism pin: esbuild's emitted module-path
 * comments are relative to the working directory, so without it the same
 * input bytes would produce cwd-dependent output. It is part of the compile
 * recipe digest.
 */
export const COMPILER_OPTIONS = Object.freeze({
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  logLevel: 'silent',
  write: false,
  absWorkingDir: '/',
} as const);

/**
 * The host's pinned engine module table (behaviors.md), at its locked
 * versions. There is no `@thirdlight/behaviors` package: the browser-safe
 * behavior types live in `runtime`. The character controller is not pinned —
 * every build and every script sees only the generic engine packages; a genre
 * module is never implied.
 */
export const M2_PINNED_MODULES: readonly PinnedModuleRef[] = Object.freeze([
  Object.freeze({ id: '@thirdlight/physics-rapier', version: '0.1.0', apiVersion: BEHAVIOR_API_VERSION }),
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: BEHAVIOR_API_VERSION }),
]);

/**
 * The output content scan (the letter table of behaviors.md and export.md).
 * Letters follow export.md where a pattern is shared (`d` = `fetch(`,
 * `e` = `node:`, `f` = `__dirname`/`process.`, `g` = `/mcp`,
 * `h` = URL literals, `j` = `XMLHttpRequest`/`WebSocket`); the behavior-only
 * patterns take the next free letters (`k`–`o`) and `p` is a surviving pinned
 * engine module id. The first hit's letter is reported.
 */
export const OUTPUT_SCAN_PATTERNS: readonly { letter: string; pattern: string }[] = Object.freeze([
  Object.freeze({ letter: 'c', pattern: '/api/v1/' }),
  Object.freeze({ letter: 'd', pattern: 'fetch(' }),
  Object.freeze({ letter: 'e', pattern: 'node:' }),
  Object.freeze({ letter: 'f', pattern: '__dirname' }),
  Object.freeze({ letter: 'f', pattern: 'process.' }),
  Object.freeze({ letter: 'g', pattern: '/mcp' }),
  Object.freeze({ letter: 'h', pattern: 'http://' }),
  Object.freeze({ letter: 'h', pattern: 'https://' }),
  Object.freeze({ letter: 'h', pattern: 'file://' }),
  Object.freeze({ letter: 'j', pattern: 'XMLHttpRequest' }),
  Object.freeze({ letter: 'j', pattern: 'WebSocket' }),
  Object.freeze({ letter: 'k', pattern: 'import(' }),
  Object.freeze({ letter: 'l', pattern: 'eval(' }),
  Object.freeze({ letter: 'm', pattern: 'new Function' }),
  Object.freeze({ letter: 'n', pattern: 'Function(' }),
  Object.freeze({ letter: 'o', pattern: 'require(' }),
]);

/** Letter assigned to a surviving pinned engine module id. */
export const OUTPUT_SCAN_ENGINE_LETTER = 'p' as const;

/** Letters assigned to host-supplied origin/token strings (export.md a/b/i). */
export const OUTPUT_SCAN_HOST_LETTERS = ['a', 'b', 'i'] as const;

/** The compiler's toolchain block recorded in every manifest. */
export function compilerToolchain(): { id: typeof COMPILER_ID; version: typeof COMPILER_VERSION; esbuild: string; typescript: typeof TYPESCRIPT_PIN } {
  return { id: COMPILER_ID, version: COMPILER_VERSION, esbuild: esbuildVersion, typescript: TYPESCRIPT_PIN };
}

/** True when the installed esbuild is the pinned parser version. */
export function esbuildPinMatches(): boolean {
  return esbuildVersion === ESBUILD_PIN;
}
