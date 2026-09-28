/**
 * Phase 25.9: script libraries as shared runtime modules.
 *
 * Each script library a build reaches is compiled once, on its own, into one
 * ES module (`libraries/<outputDigest>.js`): bundled from its own files,
 * tree-shaken (code no export reaches is dropped; every export is kept, so the
 * module does not depend on which scripts use it) and minified. A behavior
 * (or another library) does not bundle a library's code: its `@lib/<id>`
 * import is linked through a small stub that re-exports the library's export
 * names from the module's digest-named file, so
 *
 * - an import of a name the library does not export fails the compile, as
 *   it did when the code was bundled (esbuild checks the stub's names);
 * - the output imports the library by its output digest (`../libraries/<d>.js`
 *   from a behavior, `./<d>.js` from a library): the importer's own output
 *   digest covers the exact library bytes it runs with, so the determinism
 *   pins (the recorded output digests and the manifest's buildId) cover the
 *   linked output;
 * - the browser loads each library module once per realm (the page, the
 *   simulation worker), however many scripts import it.
 *
 * Nothing is evaluated: parse, scan and build over in-memory bytes only.
 */

import { build as esbuildBuild, type BuildOptions, type Plugin } from 'esbuild';

import { sha256Hex } from './canonical';
import { ENTRY_PATH } from './limits';
import { LIBRARY_SPECIFIER_RE, resolveRelativeTarget } from './scan';
import type { CompiledLibrary } from './libraries';
import type { BehaviorCompileFailure, BehaviorCompilerLimits, CompileDiagnostic, LibraryCache, PinnedModuleRef, SharedLibraryModule } from './types';

/** Where shared library modules live, next to `behaviors/` (manifest paths, the export's layout, Play's routes). */
export const SHARED_LIBRARY_DIR = 'libraries';

/** A shared library module's artifact path. */
export function sharedLibraryPath(outputDigest: string): string {
  return `${SHARED_LIBRARY_DIR}/${outputDigest}.js`;
}

/** The namespace of a library's own files while it is built as a shared module. */
const OWN_NAMESPACE = 'tl-lib-own';
/** The namespace of the link stubs (`@lib/<id>` → the re-exporting stub). */
export const LINK_NAMESPACE = 'tl-lib-link';

/**
 * The pinned build options of a shared library module (part of every
 * importer's recipe through its output digest). `outfile` only names the
 * output for the external source map (nothing is written).
 */
export const SHARED_LIBRARY_OPTIONS = Object.freeze({
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  treeShaking: true,
  minify: true,
  legalComments: 'none',
  sourcemap: 'external',
  sourcesContent: false,
  outfile: '/out.js',
  metafile: true,
  logLevel: 'silent',
  write: false,
  absWorkingDir: '/',
} as const);

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The link stub for one library as seen from a behavior (`behavior`) or from
 * another library (`library`): its export names re-exported from the
 * module's digest-named file (a library without exports is imported for its
 * effects).
 */
export function linkStubText(module: Pick<SharedLibraryModule, 'exports' | 'outputDigest'>, from: 'behavior' | 'library'): string {
  const target = JSON.stringify(from === 'behavior' ? `../${sharedLibraryPath(module.outputDigest)}` : `./${module.outputDigest}.js`);
  if (module.exports.length === 0) return `import ${target};\n`;
  const names = module.exports.map((n) => (IDENTIFIER_RE.test(n) || n === 'default' ? n : JSON.stringify(n)));
  return `export { ${names.join(', ')} } from ${target};\n`;
}

/** A stub-namespace name in a compiler message as the import the author wrote. */
export function linkNamesInText(text: string): string {
  return text.replace(new RegExp(`${LINK_NAMESPACE}:([a-z0-9_-]+)`, 'g'), '@lib/$1').replace(new RegExp(`${OWN_NAMESPACE}:`, 'g'), '');
}

/** One esbuild output file (the injected test builds may leave the path out). */
type OutFile = { path?: string; contents: Uint8Array; text?: string };

function sharedPlugin(lib: CompiledLibrary, links: ReadonlyMap<string, SharedLibraryModule>, overDeadline: () => boolean): Plugin {
  return {
    name: 'thirdlight-shared-library',
    setup(api) {
      api.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        // A stub's import of the linked module stays an import (the browser loads it by digest).
        if (args.namespace === LINK_NAMESPACE) return { path: args.path, external: true };
        const from = args.namespace === OWN_NAMESPACE ? args.importer : ENTRY_PATH;
        const target = resolveRelativeTarget(from, args.path);
        if (!lib.sources.has(target)) {
          return { errors: [{ text: `unresolved relative import "${args.path}" from "@lib/${lib.libraryId}/${from}"` }] };
        }
        return { path: target, namespace: OWN_NAMESPACE };
      });
      api.onResolve({ filter: /^@lib\// }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const id = LIBRARY_SPECIFIER_RE.exec(args.path)?.[1];
        if (id === undefined || !links.has(id)) return { errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }] };
        return { path: id, namespace: LINK_NAMESPACE };
      });
      api.onLoad({ filter: /.*/, namespace: LINK_NAMESPACE }, (args) => ({ contents: linkStubText(links.get(args.path) as SharedLibraryModule, 'library'), loader: 'js' }));
      api.onLoad({ filter: /.*/, namespace: OWN_NAMESPACE }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        return { contents: lib.sources.get(args.path) as string, loader: args.path.endsWith('.json') ? 'json' : 'ts' };
      });
      api.onResolve({ filter: /.*/ }, (args) => ({ errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }] }));
    },
  };
}

/** The shared-module compile's failure for one library (located diagnostics, tagged with the library). */
function buildFailure(e: unknown, libraryId: string, limits: BehaviorCompilerLimits): BehaviorCompileFailure {
  const errors = (e as { errors?: { text?: string; location?: { file?: string; line?: number; column?: number } | null }[] }).errors;
  const diagnostics: CompileDiagnostic[] = [];
  if (Array.isArray(errors)) {
    for (const er of errors) {
      if (diagnostics.length >= limits.diagnostics) break;
      const text = linkNamesInText(er.text ?? 'compiler error');
      const d: CompileDiagnostic = { code: 'behavior_source_invalid', reason: 'syntax', library: libraryId, message: `@lib/${libraryId}: ${text}`.slice(0, 256) };
      const file = er.location?.file;
      if (typeof file === 'string') {
        const path = file.replace(/^[a-z-]+:/, '');
        if (/^[a-z0-9][a-z0-9._/-]*\.(ts|json)$/.test(path)) d.path = path;
      }
      if (typeof er.location?.line === 'number') d.line = er.location.line;
      if (typeof er.location?.column === 'number') d.column = er.location.column + 1;
      diagnostics.push(d);
    }
  }
  const first = diagnostics[0];
  if (first === undefined) {
    const message = e instanceof Error ? e.message.replace(/\/[^\s:]*\//g, '').slice(0, 200) : 'the pinned compiler failed';
    return { ok: false, code: 'behavior_compile_failed', reason: 'internal', detail: `@lib/${libraryId}`, diagnostics: [{ code: 'behavior_compile_failed', reason: 'internal', library: libraryId, message: `@lib/${libraryId}: ${message}`.slice(0, 256) }] };
  }
  const link = first.message.includes('No matching export') || first.message.includes('unresolved relative import');
  return { ok: false, code: link ? 'behavior_compile_failed' : 'behavior_source_invalid', reason: link ? 'link' : 'syntax', detail: `@lib/${libraryId}${first.path !== undefined ? `/${first.path}` : ''}`, diagnostics };
}

export interface SharedLibraryCompileOptions {
  readonly pinnedModules: readonly PinnedModuleRef[];
  readonly limits: BehaviorCompilerLimits;
  readonly forbiddenStrings: readonly string[];
  readonly cache: LibraryCache | undefined;
  readonly overDeadline: () => boolean;
  /** The output content scan (`scanOutput`), passed in so this module does not import the compiler. */
  readonly scan: (bytes: Uint8Array, pinned: readonly PinnedModuleRef[], forbidden: readonly string[]) => { letter: string; letters: string[] } | null;
  /** A test seam: the build implementation (defaults to the pinned esbuild). */
  readonly build?: (options: unknown) => Promise<{ outputFiles?: OutFile[]; metafile?: unknown }>;
}

/** Build one library as a shared module against its already-built dependencies. */
async function buildShared(
  lib: CompiledLibrary,
  links: ReadonlyMap<string, SharedLibraryModule>,
  opts: SharedLibraryCompileOptions,
): Promise<{ ok: true; module: SharedLibraryModule } | { ok: false; failure: BehaviorCompileFailure }> {
  const entry = lib.sources.get(ENTRY_PATH);
  if (entry === undefined) {
    return { ok: false, failure: { ok: false, code: 'behavior_source_invalid', reason: 'entry', detail: `@lib/${lib.libraryId}`, diagnostics: [{ code: 'behavior_source_invalid', reason: 'entry', library: lib.libraryId, message: `@lib/${lib.libraryId}: the library has no ${ENTRY_PATH}` }] } };
  }
  const buildImpl = opts.build ?? ((o: unknown) => esbuildBuild(o as BuildOptions) as unknown as Promise<{ outputFiles?: OutFile[]; metafile?: unknown }>);
  let result: { outputFiles?: OutFile[]; metafile?: unknown };
  try {
    result = await buildImpl({
      stdin: { contents: entry, resolveDir: '/', sourcefile: ENTRY_PATH, loader: 'ts' },
      ...SHARED_LIBRARY_OPTIONS,
      plugins: [sharedPlugin(lib, links, opts.overDeadline)],
    });
  } catch (e) {
    if (opts.overDeadline() || (e instanceof Error && e.message.includes('__thirdlight_compile_timeout__'))) {
      return { ok: false, failure: { ok: false, code: 'behavior_compile_timeout', reason: 'timeout', diagnostics: [{ code: 'behavior_compile_timeout', reason: 'timeout', library: lib.libraryId, message: 'the compile wall-clock bound is exceeded' }] } };
    }
    return { ok: false, failure: buildFailure(e, lib.libraryId, opts.limits) };
  }
  const files = result.outputFiles ?? [];
  const js = files.find((f) => f.path !== undefined && f.path.endsWith('.js')) ?? files.find((f) => f.path === undefined || !f.path.endsWith('.map'));
  const map = files.find((f) => f.path !== undefined && f.path.endsWith('.js.map'));
  if (js === undefined) return { ok: false, failure: buildFailure(new Error('the pinned compiler produced no output'), lib.libraryId, opts.limits) };
  const out = js.contents;
  if (out.length > opts.limits.outputBytes) {
    return {
      ok: false,
      failure: { ok: false, code: 'behavior_output_limits_exceeded', reason: 'output_bytes', limit: 'output_bytes', current: out.length, max: opts.limits.outputBytes, detail: `@lib/${lib.libraryId}`, diagnostics: [{ code: 'behavior_output_limits_exceeded', reason: 'output_bytes', library: lib.libraryId, message: `@lib/${lib.libraryId}: the compiled library exceeds the output byte bound (${out.length} > ${opts.limits.outputBytes})` }] },
    };
  }
  const hit = opts.scan(out, opts.pinnedModules, opts.forbiddenStrings);
  if (hit !== null) {
    return {
      ok: false,
      failure: { ok: false, code: 'behavior_output_forbidden_content', reason: hit.letter, detail: hit.letters.join(','), diagnostics: [{ code: 'behavior_output_forbidden_content', reason: hit.letter, library: lib.libraryId, message: `@lib/${lib.libraryId}: the compiled library contains a forbidden pattern (${hit.letters.join(', ')})` }] },
    };
  }
  const meta = result.metafile as { outputs?: Record<string, { exports?: string[] }> } | undefined;
  const exports = [...(meta?.outputs?.['out.js']?.exports ?? [])].sort();
  return {
    ok: true,
    module: {
      libraryId: lib.libraryId,
      sourceDigest: lib.sourceDigest,
      outputBytes: out,
      outputDigest: sha256Hex(out),
      exports,
      imports: [...lib.imports],
      sourceMap: map !== undefined ? new TextDecoder().decode(map.contents) : '',
    },
  };
}

/**
 * Compile every library of a resolution as a shared module, dependencies
 * first (the resolution has no cycles). Each module is kept in the cache by
 * its source digest, its dependencies' output digests and the options, so a
 * build that links N scripts to a library compiles the library once.
 */
export async function compileSharedLibraries(
  resolved: ReadonlyMap<string, CompiledLibrary>,
  opts: SharedLibraryCompileOptions,
): Promise<{ ok: true; modules: Map<string, SharedLibraryModule> } | { ok: false; failure: BehaviorCompileFailure }> {
  const modules = new Map<string, SharedLibraryModule>();
  const visit = async (id: string): Promise<BehaviorCompileFailure | null> => {
    if (modules.has(id)) return null;
    const lib = resolved.get(id);
    if (lib === undefined) return null;
    for (const dep of lib.imports) {
      const f = await visit(dep);
      if (f !== null) return f;
    }
    const links = new Map<string, SharedLibraryModule>();
    for (const dep of lib.imports) {
      const m = modules.get(dep);
      if (m !== undefined) links.set(dep, m);
    }
    const key = [
      'shared',
      id,
      lib.sourceDigest,
      [...links.values()].map((m) => `${m.libraryId}@${m.outputDigest}`).join(','),
      opts.pinnedModules.map((p) => `${p.id}@${p.version}`).join(','),
      opts.limits.outputBytes,
      JSON.stringify(opts.forbiddenStrings),
    ].join(':');
    const cached = opts.build === undefined ? (opts.cache?.entries.get(key) as SharedLibraryModule | undefined) : undefined;
    if (cached !== undefined) {
      modules.set(id, cached);
      return null;
    }
    const built = await buildShared(lib, links, opts);
    if (!built.ok) return built.failure;
    modules.set(id, built.module);
    if (opts.cache !== undefined && opts.build === undefined) {
      if (opts.cache.entries.size >= opts.cache.max) {
        const oldest = opts.cache.entries.keys().next().value;
        if (oldest !== undefined) opts.cache.entries.delete(oldest);
      }
      opts.cache.entries.set(key, built.module);
    }
    return null;
  };
  for (const id of [...resolved.keys()].sort()) {
    const f = await visit(id);
    if (f !== null) return { ok: false, failure: f };
  }
  return { ok: true, modules };
}
