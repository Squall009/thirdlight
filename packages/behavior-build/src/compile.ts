/**
 * `compileBehavior` — the shared, pure behavior compiler (behaviors.md;
 * project-model.md source rules steps 13–15).
 *
 * It parses and statically analyzes the supplied canonical container bytes,
 * then hands the *in-memory* file map to the pinned `esbuild@0.28.2` as a
 * bundler over an in-memory resolver (`stdin` + a plugin; `write: false`) with
 * the closed option set `COMPILER_OPTIONS`. It never imports, requires,
 * evaluates or otherwise runs project source, never reads a filesystem path,
 * and never spawns a shell/process/plugin/hook.
 *
 * Determinism: identical input (including `limits`, `pinnedModules` and
 * `forbiddenStrings`) yields byte-identical `outputBytes`, `manifestBytes`,
 * `manifestDigest` and `outputDigest`; a failure yields `ok: false` and no
 * bytes.
 */

import { build as esbuildBuild, type BuildOptions, type Plugin } from 'esbuild';
import { declarationBytes, type DeclaredProperty } from '@thirdlight/project-model';

import {
  BEHAVIOR_API_VERSION,
  COMPILER_ID,
  COMPILER_LIMITS,
  COMPILER_OPTIONS,
  ENTRY_PATH,
  ESBUILD_PIN,
  M2_PINNED_MODULES,
  OUTPUT_SCAN_ENGINE_LETTER,
  OUTPUT_SCAN_HOST_LETTERS,
  OUTPUT_SCAN_PATTERNS,
  compilerToolchain,
  esbuildPinMatches,
} from './limits';
import { canonicalJsonText, sha256Hex, sha256HexOfText, utf8Encode } from './canonical';
import { canonicalContainerText, containerFailure, parseSourceGraphContainer } from './container';
import { analyzeSourceGraph, LIBRARY_SPECIFIER_RE, resolveRelativeTarget, withLimits } from './scan';
import { createLibraryCache, resolveLibraries, type CompiledLibrary } from './libraries';
import { compileSharedLibraries, LINK_NAMESPACE, linkNamesInText, linkStubText } from './shared-libraries';
import { readCodeDeclaration, rewriteCodeDeclaration } from './declare';
import { GRAPH_SOURCE_BANNER } from './graph-banner';
import type {
  BehaviorCompileFailure,
  BehaviorCompileInput,
  BehaviorCompileOptions,
  BehaviorCompileResult,
  BehaviorCompileSuccess,
  BehaviorCompiler,
  BehaviorCompilerLimits,
  BehaviorManifest,
  CompileDiagnostic,
  LibraryPin,
  PinnedModuleRef,
  ScriptLibraryCheckInput,
  ScriptLibraryCheckResult,
  SharedLibraryModule,
} from './types';

/** The canonical manifest bytes: 2-space JSON in the manifest field order + `\n`. */
export function manifestBytesOf(manifest: BehaviorManifest): Uint8Array {
  return utf8Encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Digest of the canonical declaration bytes (compact canonical JSON). */
export function declarationDigestOf(declaration: { properties: readonly DeclaredProperty[] }): string {
  return sha256HexOfText(canonicalJsonText(declaration));
}

/** The compile recipe the prepared output is bound to (hashed into `recipeDigest`). */
export function compileRecipe(
  declaration: { properties: readonly DeclaredProperty[] },
  pinnedModules: readonly PinnedModuleRef[],
  limits: BehaviorCompilerLimits,
  libraries: readonly LibraryPin[] = [],
  linking: 'shared' | 'bundle' = 'bundle',
): Record<string, unknown> {
  return {
    compilerId: COMPILER_ID,
    compilerVersion: compilerToolchain().version,
    esbuild: ESBUILD_PIN,
    typescript: compilerToolchain().typescript,
    options: COMPILER_OPTIONS,
    limits,
    pinnedModules,
    declarationDigest: declarationDigestOf(declaration),
    // The linked library versions (only when there are any: older recipes keep their digest).
    ...(libraries.length > 0 ? { libraries } : {}),
    // Libraries linked as shared modules (absent for the bundled form and when there are none).
    ...(libraries.length > 0 && linking === 'shared' ? { libraryLinking: 'shared' } : {}),
  };
}

/** Digest of the compile recipe (the derived-cache key half). */
export function compileRecipeDigest(
  declaration: { properties: readonly DeclaredProperty[] },
  pinnedModules: readonly PinnedModuleRef[],
  limits: BehaviorCompilerLimits,
  libraries: readonly LibraryPin[] = [],
  linking: 'shared' | 'bundle' = 'bundle',
): string {
  return sha256HexOfText(canonicalJsonText(compileRecipe(declaration, pinnedModules, limits, libraries, linking)));
}

function diag(d: CompileDiagnostic, limits: BehaviorCompilerLimits): CompileDiagnostic[] {
  const out = [d];
  while (out.length > limits.diagnostics) out.pop();
  return out;
}

/**
 * The output content scan: textual, explicitly not a
 * sandbox. Returns the first hit's letter plus up to four hit letters.
 */
export function scanOutput(
  outputBytes: Uint8Array,
  pinnedModules: readonly PinnedModuleRef[],
  forbiddenStrings: readonly string[] = [],
): { letter: string; letters: string[] } | null {
  const text = new TextDecoder('latin1').decode(outputBytes);
  const hits: { index: number; letter: string }[] = [];
  for (const { letter, pattern } of OUTPUT_SCAN_PATTERNS) {
    const index = text.indexOf(pattern);
    if (index >= 0) hits.push({ index, letter });
  }
  for (const pin of pinnedModules) {
    const index = text.indexOf(pin.id);
    if (index >= 0) hits.push({ index, letter: OUTPUT_SCAN_ENGINE_LETTER });
  }
  forbiddenStrings.forEach((s, i) => {
    if (s.length === 0) return;
    const index = text.indexOf(s);
    if (index >= 0) hits.push({ index, letter: OUTPUT_SCAN_HOST_LETTERS[Math.min(i, 2)] as string });
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.index - b.index);
  const letters: string[] = [];
  for (const h of hits) if (!letters.includes(h.letter)) letters.push(h.letter);
  return { letter: hits[0]?.letter as string, letters: letters.slice(0, 4) };
}

/** The namespace library modules load from (`<libraryId>/<stored path>`). */
const LIBRARY_NAMESPACE = 'tl-lib';

/** The in-memory resolver over the accepted container's file map (and the linked libraries). */
function memoryPlugin(
  files: ReadonlyMap<string, string>,
  overDeadline: () => boolean,
  libraries: ReadonlyMap<string, CompiledLibrary> = new Map(),
  links: ReadonlyMap<string, SharedLibraryModule> | null = null,
): Plugin {
  return {
    name: 'thirdlight-behavior-graph',
    setup(api) {
      api.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        // A link stub's import of the shared module stays an import (loaded by digest at run time).
        if (args.namespace === LINK_NAMESPACE) return { path: args.path, external: true };
        // A relative import inside a library resolves in that library.
        if (args.namespace === LIBRARY_NAMESPACE) {
          const slash = args.importer.indexOf('/');
          const libraryId = args.importer.slice(0, slash);
          const lib = libraries.get(libraryId);
          const target = resolveRelativeTarget(args.importer.slice(slash + 1), args.path);
          if (lib === undefined || !lib.modules.has(target)) {
            return { errors: [{ text: `unresolved relative import "${args.path}" from "@lib/${args.importer}"` }] };
          }
          return { path: `${libraryId}/${target}`, namespace: LIBRARY_NAMESPACE };
        }
        const importer = args.importer.replace(/^\//, '');
        const from = files.has(importer) ? importer : ENTRY_PATH;
        const target = resolveRelativeTarget(from, args.path);
        if (!files.has(target)) {
          return { errors: [{ text: `unresolved relative import "${args.path}" from "${from}"` }] };
        }
        return { path: target, namespace: 'tl-behavior-memory' };
      });
      // `@lib/<id>` -> the library's entry module (resolved and checked before the build).
      api.onResolve({ filter: /^@lib\// }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const m = LIBRARY_SPECIFIER_RE.exec(args.path);
        const id = m?.[1];
        // Shared linking - the stub re-exporting the module's names.
        if (links !== null) {
          if (id === undefined || !links.has(id)) return { errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }] };
          return { path: id, namespace: LINK_NAMESPACE };
        }
        if (id === undefined || !libraries.has(id)) {
          return { errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }] };
        }
        return { path: `${id}/src/index.ts`, namespace: LIBRARY_NAMESPACE };
      });
      api.onLoad({ filter: /.*/, namespace: LIBRARY_NAMESPACE }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const slash = args.path.indexOf('/');
        const mod = libraries.get(args.path.slice(0, slash))?.modules.get(args.path.slice(slash + 1));
        if (mod === undefined) throw new Error(`internal: missing library module "${args.path}"`);
        return { contents: mod.contents, loader: mod.loader };
      });
      api.onLoad({ filter: /.*/, namespace: LINK_NAMESPACE }, (args) => {
        const mod = links?.get(args.path);
        if (mod === undefined) throw new Error(`internal: missing library module "${args.path}"`);
        return { contents: linkStubText(mod, 'behavior'), loader: 'js' };
      });
      // No other specifier form can reach the bundler: the static scan
      // rejected every non-relative, non-type-only specifier before this call.
      api.onResolve({ filter: /.*/ }, (args) => ({
        errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }],
      }));
      const load = (args: { path: string }): { contents: string; loader: 'ts' | 'json' } => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const key = args.path.replace(/^\//, '');
        const text = files.get(key) ?? files.get(ENTRY_PATH);
        // A `.json` file is a data module (its parsed value is the default export).
        return { contents: text as string, loader: key.endsWith('.json') && files.has(key) ? 'json' : 'ts' };
      };
      api.onLoad({ filter: /.*/, namespace: 'tl-behavior-memory' }, load);
    },
  };
}


/**
 * The default build implementation: the pinned esbuild **asynchronous** `build`
 * API, which is the only entry point that supports an in-memory resolver plugin
 * (0.28.2 rejects plugins in the synchronous API calls). It is invoked as a
 * parser/linker over supplied in-memory bytes with `write: false`; the returned
 * bundle is never executed. The `Promise` signature follows from that.
 */
const defaultBuild = (options: unknown): Promise<{ outputFiles?: { path?: string; contents: Uint8Array }[] }> =>
  esbuildBuild(options as BuildOptions) as unknown as Promise<{ outputFiles?: { path?: string; contents: Uint8Array }[] }>;

/**
 * The source map rides along the build (an external map names an
 * output file; nothing is written). The JavaScript bytes are the same as
 * without a map, so every recorded output digest stays valid.
 */
const SOURCE_MAP_OPTIONS = Object.freeze({ outfile: '/out.js', sourcemap: 'external', sourcesContent: false } as const);

/**
 * Compile one behavior graph. Pure and total: every
 * failure is a `{ ok: false }` result with ≤ `limits.diagnostics` diagnostics;
 * no bytes are produced on failure.
 */
export async function compileBehavior(
  input: BehaviorCompileInput,
  options: BehaviorCompileOptions = {},
): Promise<BehaviorCompileResult> {
  const limits = withLimits(COMPILER_LIMITS, input.limits);
  const buildImpl = options.build ?? defaultBuild;
  const start = options.now !== undefined ? options.now() : null;
  const overDeadline = (): boolean =>
    start !== null && options.now !== undefined && options.now() - start > limits.timeoutMs;
  const fail = (
    code: string,
    reason: string,
    extra: { limit?: string; current?: number; max?: number; detail?: string; path?: string; message?: string } = {},
  ): BehaviorCompileResult => {
    const res = containerFailure(code, reason, extra);
    return { ...res.failure, diagnostics: diag(res.failure.diagnostics[0] as CompileDiagnostic, limits) };
  };

  // The pinned parser must be the pinned version: a drift
  // changes the output bytes and therefore every published digest.
  if (!esbuildPinMatches()) {
    return fail('behavior_compile_failed', 'toolchain', {
      detail: `esbuild ${ESBUILD_PIN}`,
      message: `the installed esbuild is not the pinned ${ESBUILD_PIN}`,
    });
  }
  // Properties declared in code (`export const properties` in
  // src/index.ts) are the declaration; the supplied JSON declaration is then
  // ignored (code wins, so the two cannot drift).
  const early = parseSourceGraphContainer(input.containerBytes, limits);
  const entryText = early.ok ? early.container.files.find((f) => f.path === early.container.entryPath)?.text : undefined;
  const code = entryText !== undefined ? readCodeDeclaration(entryText) : ({ found: false } as const);
  if (code.found && !code.ok) {
    const failed = fail('behavior_source_invalid', 'properties', {
      detail: `src/index.ts:${code.line}:${code.column}`,
      path: ENTRY_PATH,
      message: code.message.slice(0, 256),
    }) as BehaviorCompileFailure;
    // The position as fields too (the script editor marks it inline).
    return { ...failed, diagnostics: failed.diagnostics.map((d) => ({ ...d, line: code.line, column: code.column })) };
  }
  const declaredInCode = code.found && code.ok;
  // Declaration bounds (re-checked here).
  const declaration = declaredInCode ? { properties: code.properties } : input.declaration;
  const properties = declaration.properties;
  // Any number of properties, none included: only the byte budget bounds them.
  if (!Array.isArray(properties)) {
    return fail('behavior_source_invalid', 'properties', {
      message: 'a behavior declaration is { properties: [...] }',
    });
  }
  const bytes = declarationBytes(declaration);
  if (bytes > limits.declarationBytes) {
    return fail('behavior_source_limits_exceeded', 'declaration_bytes', {
      limit: 'declaration_bytes',
      current: bytes,
      max: limits.declarationBytes,
      message: `the declaration is ${bytes} bytes, over the ${limits.declarationBytes}-byte budget (declare fewer or shorter properties)`,
    });
  }
  // Steps 1–7.
  const parsed = parseSourceGraphContainer(input.containerBytes, limits);
  if (!parsed.ok) {
    return { ...parsed.failure, diagnostics: diag(parsed.failure.diagnostics[0] as CompileDiagnostic, limits) };
  }
  const container = parsed.container;
  // Steps 8–12.
  const analyzed = analyzeSourceGraph(container, input.pinnedModules, limits);
  if (!analyzed.ok) {
    return { ...analyzed.failure, diagnostics: diag(analyzed.failure.diagnostics[0] as CompileDiagnostic, limits) };
  }
  // The script libraries the source reaches (checked, transpiled once, pinned).
  let linked: ReadonlyMap<string, CompiledLibrary> = new Map();
  let pins: LibraryPin[] = [];
  // Shared linking (the default) - each library its own module, compiled once.
  const linking = input.libraryLinking ?? 'shared';
  let links: Map<string, SharedLibraryModule> | null = null;
  const libraryImports = analyzed.analysis.libraryImports ?? [];
  if (libraryImports.length > 0) {
    const resolved = await resolveLibraries(libraryImports, `behavior ${input.behaviorId}`, input.libraries ?? [], input.pinnedModules, limits, options.libraryCache);
    if (!resolved.ok) {
      return { ...resolved.failure, diagnostics: resolved.failure.diagnostics.slice(0, limits.diagnostics) };
    }
    linked = resolved.libraries;
    pins = resolved.pins;
    if (linking === 'shared') {
      const shared = await compileSharedLibraries(resolved.libraries, {
        pinnedModules: input.pinnedModules,
        limits,
        forbiddenStrings: input.forbiddenStrings ?? [],
        cache: options.libraryCache,
        overDeadline,
        scan: scanOutput,
      });
      if (!shared.ok) return { ...shared.failure, diagnostics: shared.failure.diagnostics.slice(0, limits.diagnostics) };
      links = shared.modules;
    }
  }
  // Step 13: parse/transform by the pinned compiler.
  if (overDeadline()) {
    return fail('behavior_compile_timeout', 'timeout', { message: 'the compile wall-clock bound is exceeded before the build call' });
  }
  const files = new Map<string, string>(container.files.map((f) => [f.path, f.text] as const));
  if (declaredInCode && entryText !== undefined) {
    files.set(container.entryPath, rewriteCodeDeclaration(entryText, code.start, code.end, code.properties));
  }
  const entryFile = files.get(container.entryPath) as string;
  let outputBytes: Uint8Array | null = null;
  let sourceMap: string | undefined;
  let buildError: unknown = null;
  try {
    const result = await buildImpl({
      stdin: { contents: entryFile, resolveDir: '/', sourcefile: container.entryPath, loader: 'ts' },
      ...COMPILER_OPTIONS,
      ...SOURCE_MAP_OPTIONS,
      plugins: [memoryPlugin(files, overDeadline, linked, links)],
    });
    const outFiles = (result.outputFiles ?? []) as { path?: string; contents: Uint8Array }[];
    const out = (outFiles.find((f) => f.path !== undefined && f.path.endsWith('.js')) ?? outFiles.find((f) => f.path === undefined || !f.path.endsWith('.map')))?.contents;
    if (out === undefined) throw new Error('the pinned compiler produced no output');
    outputBytes = out;
    const map = outFiles.find((f) => f.path !== undefined && f.path.endsWith('.js.map'));
    if (map !== undefined) sourceMap = new TextDecoder().decode(map.contents);
  } catch (e) {
    buildError = e;
  }
  // The synchronous esbuild call cannot be preempted mid-call: the bound is
  // cooperative and measured around/inside the call.
  if (buildError !== null) {
    if (overDeadline()) {
      return fail('behavior_compile_timeout', 'timeout', { message: 'the compile wall-clock bound is exceeded' });
    }
    const message = boundedMessage(buildError);
    if (message.includes('__thirdlight_compile_timeout__')) {
      return fail('behavior_compile_timeout', 'timeout', { message: 'the compile wall-clock bound is exceeded' });
    }
    if (message.includes('forbidden specifier') || message.includes('unresolved relative import')) {
      return fail('behavior_compile_failed', 'link', {
        detail: message.slice(0, 128),
        message: `the pinned compiler could not link the accepted graph: ${message}`,
      });
    }
    const structured = (buildError as { errors?: unknown }).errors;
    if (!Array.isArray(structured) || structured.length === 0) {
      // The pinned tool (or an injected build) threw without a structured
      // diagnostic: a compiler failure, never a source-syntax verdict.
      return fail('behavior_compile_failed', 'internal', {
        detail: message.slice(0, 128),
        message: `the pinned compiler failed internally: ${message}`,
      });
    }
    const failed = fail('behavior_source_invalid', 'syntax', {
      detail: message.slice(0, 128),
      message: `the pinned compiler rejected the source: ${message}`,
    }) as BehaviorCompileFailure;
    // Every located compiler error as its own diagnostic (path,
    // 1-based line and column), bounded like any diagnostic list.
    const located = syntaxDiagnostics(structured, limits);
    return located.length > 0 ? { ...failed, diagnostics: located } : failed;
  }
  const out = outputBytes as Uint8Array;
  if (start !== null && options.now !== undefined && options.now() - start > limits.timeoutMs) {
    return fail('behavior_compile_timeout', 'timeout', { message: 'the compile wall-clock bound is exceeded' });
  }
  // Step 14: output bytes bound.
  if (out.length > limits.outputBytes) {
    return fail('behavior_output_limits_exceeded', 'output_bytes', {
      limit: 'output_bytes',
      current: out.length,
      max: limits.outputBytes,
      message: 'the compiled output exceeds the output byte bound',
    });
  }
  // Step 15: output content scan.
  const hit = scanOutput(out, input.pinnedModules, input.forbiddenStrings ?? []);
  if (hit !== null) {
    return fail('behavior_output_forbidden_content', hit.letter, {
      detail: hit.letters.join(','),
      message: `the compiled output contains a forbidden pattern (${hit.letters.join(', ')})`,
    });
  }
  // The canonical, digest-bound manifest.
  const sourceDigest = sha256Hex(input.containerBytes);
  const outputDigest = sha256Hex(out);
  const toolchain = compilerToolchain();
  const manifest: BehaviorManifest = {
    manifestVersion: 1,
    behaviorId: input.behaviorId,
    sourceDigest,
    sourceByteLength: input.containerBytes.length,
    entryPath: ENTRY_PATH,
    files: container.files.map((f) => ({
      path: f.path,
      digest: sha256HexOfText(f.text),
      byteLength: new TextEncoder().encode(f.text).length,
    })),
    requiredModules: [...container.requiredModules],
    ownedTransforms: [...container.ownedTransforms],
    enginePins: input.pinnedModules.map((p) => ({ id: p.id, version: p.version, apiVersion: p.apiVersion })),
    declaration: { properties: properties.map((p) => ({ ...p })) },
    // Present only when the declaration was derived from the code.
    ...(declaredInCode ? { declaredInCode: true as const } : {}),
    // Generated from a visual-script graph (the generator's first line).
    ...(entryText !== undefined && entryText.startsWith(`${GRAPH_SOURCE_BANNER}\n`) ? { sourceKind: 'graph' as const } : {}),
    // The linked script library versions (absent when none: older manifests stay byte-identical).
    ...(pins.length > 0 ? { libraries: pins.map((p) => ({ ...p })) } : {}),
    // The shared modules the output imports (their digests are in its import paths too).
    ...(links !== null && links.size > 0 ? { libraryModules: [...links.values()].map((m) => ({ libraryId: m.libraryId, outputDigest: m.outputDigest })).sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1)) } : {}),
    apiVersion: BEHAVIOR_API_VERSION,
    compiler: { id: toolchain.id, version: toolchain.version, esbuild: toolchain.esbuild, typescript: toolchain.typescript },
    outputDigest,
    outputByteLength: out.length,
  };
  const manifestBytes = manifestBytesOf(manifest);
  return {
    ok: true,
    manifest,
    manifestBytes,
    manifestDigest: sha256Hex(manifestBytes),
    outputBytes: out,
    outputDigest,
    recipeDigest: compileRecipeDigest(declaration, input.pinnedModules, limits, pins, linking),
    declarationDigest: declarationDigestOf(declaration),
    diagnostics: [],
    ...(sourceMap !== undefined ? { sourceMap } : {}),
    ...(links !== null && links.size > 0 ? { libraryModules: [...links.values()].sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1)) } : {}),
  };
}

/**
 * esbuild's structured errors as located diagnostics. Files load
 * from the in-memory namespace (`tl-behavior-memory:src/a.ts`), the entry
 * from stdin (`src/index.ts`); esbuild columns are 0-based.
 */
function syntaxDiagnostics(errors: unknown[], limits: BehaviorCompilerLimits): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const raw of errors) {
    if (out.length >= limits.diagnostics) break;
    const e = raw as { text?: unknown; location?: { file?: unknown; line?: unknown; column?: unknown } | null };
    const text = typeof e.text === 'string' ? linkNamesInText(e.text) : 'compiler error';
    const d: CompileDiagnostic = { code: 'behavior_source_invalid', reason: 'syntax', message: text.slice(0, 256) };
    const loc = e.location;
    if (loc !== null && loc !== undefined) {
      if (typeof loc.file === 'string' && loc.file.startsWith(`${LIBRARY_NAMESPACE}:`)) {
        // A library module (`tl-lib:<libraryId>/<path>`).
        const rest = loc.file.slice(LIBRARY_NAMESPACE.length + 1);
        const slash = rest.indexOf('/');
        if (slash > 0) {
          d.library = rest.slice(0, slash);
          d.path = rest.slice(slash + 1);
        }
      } else if (typeof loc.file === 'string') {
        const path = loc.file.replace(/^[a-z-]+:/, '');
        if (/^[a-z0-9][a-z0-9._/-]*\.(ts|json)$/.test(path)) d.path = path;
      }
      if (typeof loc.line === 'number') d.line = loc.line;
      if (typeof loc.column === 'number') d.column = loc.column + 1;
    }
    out.push(d);
  }
  return out;
}

/** Bounded, host-path-free error text for diagnostics (≤ 256 chars). */
function boundedMessage(e: unknown): string {
  const anyE = e as { errors?: { text?: string; location?: { file?: string; line?: number; column?: number } }[]; message?: string };
  const first = anyE.errors?.[0];
  if (first !== undefined) {
    const loc = first.location;
    const where = loc?.file !== undefined ? `${loc.file}:${loc.line ?? 0}:${loc.column ?? 0}: ` : '';
    return linkNamesInText(`${where}${first.text ?? 'compiler error'}`).slice(0, 256);
  }
  if (typeof anyE.message === 'string') return anyE.message.replace(/\/[^\s:]*\//g, '').slice(0, 256);
  return 'the pinned compiler failed';
}

/**
 * Build the injectable compiler instance the workspace's preparation layer
 * consumes. The pinned module table is a fact of the instance (the prepared
 * record copies it into every manifest).
 */
export function createBehaviorCompiler(
  options: {
    pinnedModules?: readonly PinnedModuleRef[];
    now?: () => number;
    build?: BehaviorCompileOptions['build'];
    /** Successful compiles kept (least recently used first out; default 256, 0: none). */
    cacheEntries?: number;
  } = {},
): BehaviorCompiler {
  const pinnedModules = options.pinnedModules ?? M2_PINNED_MODULES;
  // One compiled-library cache per instance (a library compiles once per build).
  const compileOptions: BehaviorCompileOptions = { libraryCache: createLibraryCache() };
  if (options.now !== undefined) compileOptions.now = options.now;
  if (options.build !== undefined) compileOptions.build = options.build;
  // A compile is a pure function of its input and this compiler (a custom `build` is not
  // cached), so a successful one is kept by the digest of what it compiled: the source container, the
  // declaration, the libraries it may link (their digests), the pinned modules, the limits and the
  // compiler's recipe. A Play of unchanged scripts then compiles nothing.
  const maxEntries = options.build !== undefined ? 0 : Math.max(0, options.cacheEntries ?? 256);
  const memo = new Map<string, BehaviorCompileSuccess>();
  const stats = { hits: 0, misses: 0 };
  const keyOf = (input: BehaviorCompileInput): string =>
    sha256HexOfText(
      canonicalJsonText({
        behaviorId: input.behaviorId,
        declaration: input.declaration,
        source: sha256Hex(input.containerBytes),
        libraries: (input.libraries ?? []).map((l) => ({ libraryId: l.libraryId, digest: sha256Hex(l.containerBytes) })),
        forbidden: input.forbiddenStrings ?? [],
        linking: input.libraryLinking ?? 'shared',
        recipe: compileRecipe({ properties: [] }, pinnedModules, withLimits(COMPILER_LIMITS, input.limits)),
      }),
    );
  return {
    pinnedModules,
    compile(input: BehaviorCompileInput): Promise<BehaviorCompileResult> {
      if (maxEntries === 0) return compileBehavior({ ...input, pinnedModules }, compileOptions);
      const key = keyOf(input);
      const hit = memo.get(key);
      if (hit !== undefined) {
        stats.hits += 1;
        memo.delete(key);
        memo.set(key, hit);
        return Promise.resolve(hit);
      }
      stats.misses += 1;
      return compileBehavior({ ...input, pinnedModules }, compileOptions).then((r) => {
        if (r.ok) {
          memo.set(key, r);
          if (memo.size > maxEntries) memo.delete(memo.keys().next().value as string);
        }
        return r;
      });
    },
    cacheStats: () => ({ hits: stats.hits, misses: stats.misses, entries: memo.size }),
    checkLibrary(input: ScriptLibraryCheckInput): Promise<ScriptLibraryCheckResult> {
      return checkScriptLibrary({ ...input, pinnedModules }, compileOptions);
    },
  };
}

/**
 * Check one script library on its own - its container rules,
 * imports (missing libraries, cycles), syntax and output bounds - by
 * compiling a one-line module that re-exports it (`export * from
 * '@lib/<id>'`) against the given library set. Nothing is kept; the result
 * carries the library's digest and the other libraries it reaches.
 */
export async function checkScriptLibrary(input: ScriptLibraryCheckInput, options: BehaviorCompileOptions = {}): Promise<ScriptLibraryCheckResult> {
  const pinnedModules = input.pinnedModules ?? M2_PINNED_MODULES;
  const own = input.libraries.find((l) => l.libraryId === input.libraryId);
  if (own === undefined) {
    return containerFailure('behavior_library_missing', input.libraryId, { detail: `@lib/${input.libraryId}`, message: `"@lib/${input.libraryId}" is not a script library of this project` }).failure;
  }
  const containerBytes = utf8Encode(
    canonicalContainerText({ graphVersion: 1, entryPath: ENTRY_PATH, requiredModules: [], ownedTransforms: [], files: [{ path: ENTRY_PATH, text: `export * from '@lib/${input.libraryId}';\n` }] }),
  );
  const result = await compileBehavior(
    { behaviorId: input.libraryId, declaration: { properties: [] }, containerBytes, pinnedModules, libraries: input.libraries, ...(input.limits !== undefined ? { limits: input.limits } : {}) },
    options,
  );
  if (!result.ok) return result;
  const pins = result.manifest.libraries ?? [];
  // The size of the library's own shared module (what it adds to a build).
  const module = result.libraryModules?.find((m) => m.libraryId === input.libraryId);
  return {
    ok: true,
    libraryId: input.libraryId,
    sourceDigest: sha256Hex(own.containerBytes),
    imports: pins.map((p) => p.libraryId).filter((id) => id !== input.libraryId),
    outputByteLength: module?.outputBytes.length ?? result.manifest.outputByteLength,
    diagnostics: [],
  };
}
