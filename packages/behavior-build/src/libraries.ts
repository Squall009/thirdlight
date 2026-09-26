/**
 * Phase 23.7: script libraries in the compiler.
 *
 * A behavior (or another library) imports a project script library with
 * `@lib/<libraryId>`, which names that library's `src/index.ts`. The
 * libraries are supplied with the compile input as canonical source-graph
 * containers (the behavior container format and bounds). This module:
 *
 * - parses and statically checks each reachable library once (the same
 *   container rules, import scan and relative resolution as a behavior; a
 *   library may type-import any pinned engine module without listing it),
 * - resolves the `@lib/` graph from the behavior's imports: a missing
 *   library and a cycle between libraries are compile failures naming the
 *   chain, and the chain is bounded by the import-depth limit,
 * - transpiles each library file once (the pinned esbuild `transform`) and
 *   keeps the result in a cache keyed by the library digest, so a build that
 *   compiles several behaviors importing the same library compiles the
 *   library once; each behavior's bundle links the transpiled modules in.
 *
 * Nothing is evaluated: parse, scan and transpile only.
 */

import { transform as esbuildTransform } from 'esbuild';

import { sha256Hex } from './canonical';
import { containerFailure, parseSourceGraphContainer } from './container';
import { analyzeSourceGraph } from './scan';
import type {
  BehaviorCompileFailure,
  BehaviorCompilerLimits,
  CompileDiagnostic,
  LibraryCache,
  LibraryPin,
  PinnedModuleRef,
  ScriptLibraryInput,
} from './types';

/** One parsed, checked and transpiled library. */
export interface CompiledLibrary {
  libraryId: string;
  sourceDigest: string;
  /** Stored path → module text as the bundler loads it (`.ts` transpiled to JS, `.json` as is). */
  modules: Map<string, { contents: string; loader: 'js' | 'json' }>;
  /** Its own `@lib/` imports (ascending). */
  imports: string[];
}

export type LibraryResolution =
  | { ok: true; libraries: Map<string, CompiledLibrary>; pins: LibraryPin[] }
  | { ok: false; failure: BehaviorCompileFailure };

/** A bounded compiled-library cache (share one per compiler instance). */
export function createLibraryCache(max = 64): LibraryCache {
  return { entries: new Map<string, unknown>(), max };
}

function tagLibrary(failure: BehaviorCompileFailure, libraryId: string): BehaviorCompileFailure {
  return {
    ...failure,
    diagnostics: failure.diagnostics.map((d) => ({ ...d, library: libraryId, message: `@lib/${libraryId}: ${d.message}`.slice(0, 256) })),
  };
}

const transformTs = async (text: string, sourcefile: string): Promise<string> => {
  const out = await esbuildTransform(text, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile, logLevel: 'silent' });
  return out.code;
};

/** Parse, check and transpile one library (or take it from the cache). */
async function compileLibrary(
  input: ScriptLibraryInput,
  pinnedModules: readonly PinnedModuleRef[],
  limits: BehaviorCompilerLimits,
  cache: LibraryCache | undefined,
): Promise<{ ok: true; library: CompiledLibrary } | { ok: false; failure: BehaviorCompileFailure }> {
  const sourceDigest = sha256Hex(input.containerBytes);
  const key = `${input.libraryId}:${sourceDigest}:${pinnedModules.map((p) => `${p.id}@${p.version}`).join(',')}:${limits.files}/${limits.fileBytes}/${limits.graphBytes}/${limits.importsPerFile}/${limits.importDepth}`;
  const cached = cache?.entries.get(key) as CompiledLibrary | undefined;
  if (cached !== undefined) return { ok: true, library: cached };
  const parsed = parseSourceGraphContainer(input.containerBytes, limits);
  if (!parsed.ok) return { ok: false, failure: tagLibrary(parsed.failure, input.libraryId) };
  const analyzed = analyzeSourceGraph(parsed.container, pinnedModules, limits, { library: true });
  if (!analyzed.ok) return { ok: false, failure: tagLibrary(analyzed.failure, input.libraryId) };
  const modules = new Map<string, { contents: string; loader: 'js' | 'json' }>();
  for (const f of parsed.container.files) {
    if (f.path.endsWith('.json')) {
      modules.set(f.path, { contents: f.text, loader: 'json' });
      continue;
    }
    try {
      modules.set(f.path, { contents: await transformTs(f.text, f.path), loader: 'js' });
    } catch (e) {
      return { ok: false, failure: transformFailure(e, input.libraryId, f.path, limits) };
    }
  }
  const library: CompiledLibrary = { libraryId: input.libraryId, sourceDigest, modules, imports: analyzed.analysis.libraryImports ?? [] };
  if (cache !== undefined) {
    if (cache.entries.size >= cache.max) {
      const oldest = cache.entries.keys().next().value;
      if (oldest !== undefined) cache.entries.delete(oldest);
    }
    cache.entries.set(key, library);
  }
  return { ok: true, library };
}

/** A transpile error of a library file as located diagnostics (esbuild lines 1-based, columns 0-based). */
function transformFailure(e: unknown, libraryId: string, path: string, limits: BehaviorCompilerLimits): BehaviorCompileFailure {
  const errors = (e as { errors?: { text?: string; location?: { line?: number; column?: number } | null }[] }).errors;
  const diagnostics: CompileDiagnostic[] = [];
  if (Array.isArray(errors)) {
    for (const er of errors) {
      if (diagnostics.length >= limits.diagnostics) break;
      const d: CompileDiagnostic = { code: 'behavior_source_invalid', reason: 'syntax', path, library: libraryId, message: `@lib/${libraryId}: ${er.text ?? 'compiler error'}`.slice(0, 256) };
      if (typeof er.location?.line === 'number') d.line = er.location.line;
      if (typeof er.location?.column === 'number') d.column = er.location.column + 1;
      diagnostics.push(d);
    }
  }
  if (diagnostics.length === 0) {
    diagnostics.push({ code: 'behavior_source_invalid', reason: 'syntax', path, library: libraryId, message: `@lib/${libraryId}: the pinned compiler rejected ${path}` });
  }
  return { ok: false, code: 'behavior_source_invalid', reason: 'syntax', detail: `@lib/${libraryId}/${path}`, diagnostics };
}

/**
 * Resolve the libraries reachable from `imports` (the importing source's own
 * `@lib/` ids). `from` names the importer in messages (a behavior's
 * `src/index.ts` graph or `@lib/<id>` for a library check).
 */
export async function resolveLibraries(
  imports: readonly string[],
  from: string,
  inputs: readonly ScriptLibraryInput[],
  pinnedModules: readonly PinnedModuleRef[],
  limits: BehaviorCompilerLimits,
  cache: LibraryCache | undefined,
): Promise<LibraryResolution> {
  const byId = new Map(inputs.map((l) => [l.libraryId, l] as const));
  const compiled = new Map<string, CompiledLibrary>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = async (id: string, importer: string): Promise<BehaviorCompileFailure | null> => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) {
      const chain = [...stack.slice(stack.indexOf(id)), id].map((x) => `@lib/${x}`).join(' -> ');
      return containerFailure('behavior_library_cycle', chain, { detail: chain, message: `the script libraries import each other in a cycle: ${chain}` }).failure;
    }
    const input = byId.get(id);
    if (input === undefined) {
      return containerFailure('behavior_library_missing', id, {
        detail: `@lib/${id}`,
        message: `${importer} imports "@lib/${id}", which is not a script library of this project`,
      }).failure;
    }
    if (stack.length + 1 > limits.importDepth) {
      return containerFailure('behavior_source_limits_exceeded', 'import_depth', {
        limit: 'import_depth',
        current: stack.length + 1,
        max: limits.importDepth,
        message: 'the chain of script library imports exceeds the depth bound',
      }).failure;
    }
    state.set(id, 1);
    stack.push(id);
    const r = await compileLibrary(input, pinnedModules, limits, cache);
    if (!r.ok) return r.failure;
    compiled.set(id, r.library);
    for (const next of r.library.imports) {
      const f = await visit(next, `@lib/${id}`);
      if (f !== null) return f;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of imports) {
    const f = await visit(id, from);
    if (f !== null) return { ok: false, failure: f };
  }
  const pins = [...compiled.values()].map((l) => ({ libraryId: l.libraryId, sourceDigest: l.sourceDigest })).sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0));
  return { ok: true, libraries: compiled, pins };
}
