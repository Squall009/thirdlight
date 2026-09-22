/**
 * Compiler constants, the pinned module table and the pinned build option set
 * (project-model.md §22.4, behaviors.md §5.3/§5.4/§6, dependencies.md §7).
 *
 * `COMPILER_LIMITS` is the closed resource-bound table; the pinned esbuild
 * option set is a contract constant (export.md §5.3) — changing any of it is a
 * reviewed contract change, not a packet edit.
 */

import { version as esbuildVersion } from 'esbuild';
import type { BehaviorCompilerLimits, PinnedModuleRef } from './types';

/** The stable compiler identity (dependencies.md §2/§3: `COMPILER_ID` string). */
export const COMPILER_ID = 'thirdlight.behavior-compiler' as const;

/** The compiler implementation version (the manifest's `compiler.version`). */
export const COMPILER_VERSION = '1' as const;

/** The pinned toolchain (dependencies.md §7). */
export const ESBUILD_PIN = '0.28.2' as const;
export const TYPESCRIPT_PIN = '5.9.3' as const;

/** The behavior API version (runtime.md §12/§13; behaviors.md §11). */
export const BEHAVIOR_API_VERSION = 1 as const;

/** The fixed entry path (project-model.md §22.2: exactly `src/index.ts`). */
export const ENTRY_PATH = 'src/index.ts' as const;

/**
 * The M2 defaults (behaviors.md §6). The contract lists the first nine keys;
 * `ownedTransforms`, `properties` and `declarationBytes` are the §22.4/§20.7
 * bounds the preparer re-checks here.
 */
export const COMPILER_LIMITS: Readonly<BehaviorCompilerLimits> = Object.freeze({
  files: 16,
  fileBytes: 65_536,
  graphBytes: 262_144,
  importDepth: 8,
  importsPerFile: 16,
  ownedTransforms: 16,
  diagnostics: 32,
  timeoutMs: 2_000,
  outputBytes: 131_072,
  properties: 32,
  declarationBytes: 32_768,
} as const);

/**
 * The pinned build option set for the intermediate output (behaviors.md §5.4).
 * `absWorkingDir: '/'` is a packet-33 determinism pin: esbuild's emitted
 * module-path comments are relative to the working directory, so without it
 * the same input bytes would produce cwd-dependent output (contract note
 * C33-2). It is part of the compile recipe digest.
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
 * The host's pinned engine module table (behaviors.md §5.3; the M2 set at its
 * locked versions). `@thirdlight/behaviors` does not exist (dependencies.md §2
 * D19-A: the browser-safe behavior types live in `runtime`).
 */
export const M2_PINNED_MODULES: readonly PinnedModuleRef[] = Object.freeze([
  Object.freeze({ id: '@thirdlight/platformer', version: '0.1.0', apiVersion: BEHAVIOR_API_VERSION }),
  Object.freeze({ id: '@thirdlight/physics-rapier', version: '0.1.0', apiVersion: BEHAVIOR_API_VERSION }),
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: BEHAVIOR_API_VERSION }),
]);

/**
 * The output content scan (behaviors.md §5.5 / export.md §5.4 letter table).
 * Letters follow export.md §5.4 where a pattern is shared (`d` = `fetch(`,
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

/** Letter assigned to a surviving pinned engine module id (behaviors.md §5.5). */
export const OUTPUT_SCAN_ENGINE_LETTER = 'p' as const;

/** Letters assigned to host-supplied origin/token strings (export.md §5.4 a/b/i). */
export const OUTPUT_SCAN_HOST_LETTERS = ['a', 'b', 'i'] as const;

/** The compiler's toolchain block recorded in every manifest. */
export function compilerToolchain(): { id: typeof COMPILER_ID; version: typeof COMPILER_VERSION; esbuild: string; typescript: typeof TYPESCRIPT_PIN } {
  return { id: COMPILER_ID, version: COMPILER_VERSION, esbuild: esbuildVersion, typescript: TYPESCRIPT_PIN };
}

/** True when the installed esbuild is the pinned parser version. */
export function esbuildPinMatches(): boolean {
  return esbuildVersion === ESBUILD_PIN;
}
