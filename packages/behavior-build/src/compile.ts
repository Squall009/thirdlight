/**
 * `compileBehavior` — the shared, pure behavior compiler (behaviors.md §5,
 * project-model.md §22.3.3 steps 13–15, §22.4).
 *
 * It parses and statically analyzes the supplied canonical container bytes,
 * then hands the *in-memory* file map to the pinned `esbuild@0.28.2` as a
 * bundler over an in-memory resolver (`stdin` + a plugin; `write: false`) with
 * the closed option set of behaviors.md §5.4. It never imports, requires,
 * evaluates or otherwise runs project source, never reads a filesystem path,
 * and never spawns a shell/process/plugin/hook.
 *
 * Determinism: identical input (including `limits`, `pinnedModules` and
 * `forbiddenStrings`) yields byte-identical `outputBytes`, `manifestBytes`,
 * `manifestDigest` and `outputDigest`; a failure yields `ok: false` and no
 * bytes.
 */

import { build as esbuildBuild, type BuildOptions, type Plugin } from 'esbuild';
import type { DeclaredProperty } from '@thirdlight/project-model';

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
import { containerFailure, parseSourceGraphContainer } from './container';
import { analyzeSourceGraph, posixResolve, withLimits } from './scan';
import { readCodeDeclaration, rewriteCodeDeclaration } from './declare';
import type {
  BehaviorCompileFailure,
  BehaviorCompileInput,
  BehaviorCompileOptions,
  BehaviorCompileResult,
  BehaviorCompiler,
  BehaviorCompilerLimits,
  BehaviorManifest,
  CompileDiagnostic,
  PinnedModuleRef,
} from './types';

/** The canonical manifest bytes: 2-space JSON in the §5.2 field order + `\n`. */
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
  };
}

/** Digest of the compile recipe (the derived-cache key half). */
export function compileRecipeDigest(
  declaration: { properties: readonly DeclaredProperty[] },
  pinnedModules: readonly PinnedModuleRef[],
  limits: BehaviorCompilerLimits,
): string {
  return sha256HexOfText(canonicalJsonText(compileRecipe(declaration, pinnedModules, limits)));
}

function diag(d: CompileDiagnostic, limits: BehaviorCompilerLimits): CompileDiagnostic[] {
  const out = [d];
  while (out.length > limits.diagnostics) out.pop();
  return out;
}

/**
 * The output content scan (behaviors.md §5.5): textual, explicitly not a
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

/** The in-memory resolver over the accepted container's file map. */
function memoryPlugin(
  files: ReadonlyMap<string, string>,
  overDeadline: () => boolean,
): Plugin {
  return {
    name: 'thirdlight-behavior-graph',
    setup(api) {
      api.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const importer = args.importer.replace(/^\//, '');
        const from = files.has(importer) ? importer : ENTRY_PATH;
        let target = posixResolve(from, args.path);
        if (!target.endsWith('.ts')) target += '.ts';
        if (!files.has(target)) {
          return { errors: [{ text: `unresolved relative import "${args.path}" from "${from}"` }] };
        }
        return { path: target, namespace: 'tl-behavior-memory' };
      });
      // No other specifier form can reach the bundler: the static scan
      // rejected every non-relative, non-type-only specifier before this call.
      api.onResolve({ filter: /.*/ }, (args) => ({
        errors: [{ text: `internal: esbuild resolved a forbidden specifier "${args.path}"` }],
      }));
      const load = (args: { path: string }): { contents: string; loader: 'ts' } => {
        if (overDeadline()) throw new Error('__thirdlight_compile_timeout__');
        const key = args.path.replace(/^\//, '');
        const text = files.get(key) ?? files.get(ENTRY_PATH);
        return { contents: text as string, loader: 'ts' };
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
 * bundle is never executed. The `Promise` signature is the contract note
 * C33-1 (behaviors.md §5.1 states a synchronous signature while §5.4 mandates
 * the in-memory plugin mechanism).
 */
const defaultBuild = (options: unknown): Promise<{ outputFiles?: { contents: Uint8Array }[] }> =>
  esbuildBuild(options as BuildOptions) as unknown as Promise<{ outputFiles?: { contents: Uint8Array }[] }>;

/**
 * Compile one behavior graph (behaviors.md §5.1). Pure and total: every
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

  // The pinned parser must be the pinned version (dependencies.md §7): a drift
  // changes the output bytes and therefore every published digest.
  if (!esbuildPinMatches()) {
    return fail('behavior_compile_failed', 'toolchain', {
      detail: `esbuild ${ESBUILD_PIN}`,
      message: `the installed esbuild is not the pinned ${ESBUILD_PIN}`,
    });
  }
  // Phase 15.4: properties declared in code (`export const properties` in
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
    // Phase 16.3: the position as fields too (the script editor marks it inline).
    return { ...failed, diagnostics: failed.diagnostics.map((d) => ({ ...d, line: code.line, column: code.column })) };
  }
  const declaredInCode = code.found && code.ok;
  // Declaration bounds (project-model.md §22.4: re-checked here).
  const declaration = declaredInCode ? { properties: code.properties } : input.declaration;
  const properties = declaration.properties;
  if (!Array.isArray(properties) || properties.length < 1) {
    return fail('behavior_source_limits_exceeded', 'properties', {
      limit: 'properties',
      current: Array.isArray(properties) ? properties.length : 0,
      max: limits.properties,
      message: 'a behavior declaration must declare 1..32 properties',
    });
  }
  if (properties.length > limits.properties) {
    return fail('behavior_source_limits_exceeded', 'properties', {
      limit: 'properties',
      current: properties.length,
      max: limits.properties,
      message: 'the declaration exceeds the property count bound',
    });
  }
  const declarationBytes = utf8Encode(canonicalJsonText(declaration)).length;
  if (declarationBytes > limits.declarationBytes) {
    return fail('behavior_source_limits_exceeded', 'declaration_bytes', {
      limit: 'declaration_bytes',
      current: declarationBytes,
      max: limits.declarationBytes,
      message: 'the canonical declaration exceeds the byte bound',
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
  let buildError: unknown = null;
  try {
    const result = await buildImpl({
      stdin: { contents: entryFile, resolveDir: '/', sourcefile: container.entryPath, loader: 'ts' },
      ...COMPILER_OPTIONS,
      plugins: [memoryPlugin(files, overDeadline)],
    });
    const out = result.outputFiles?.[0]?.contents;
    if (out === undefined) throw new Error('the pinned compiler produced no output');
    outputBytes = out;
  } catch (e) {
    buildError = e;
  }
  // The synchronous esbuild call cannot be preempted mid-call (behaviors.md
  // §6): the bound is cooperative and measured around/inside the call.
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
    // Phase 16.3: every located compiler error as its own diagnostic (path,
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
    // Phase 15.4: present only when the declaration was derived from the code.
    ...(declaredInCode ? { declaredInCode: true as const } : {}),
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
    recipeDigest: compileRecipeDigest(declaration, input.pinnedModules, limits),
    declarationDigest: declarationDigestOf(declaration),
    diagnostics: [],
  };
}

/**
 * Phase 16.3: esbuild's structured errors as located diagnostics. Files load
 * from the in-memory namespace (`tl-behavior-memory:src/a.ts`), the entry
 * from stdin (`src/index.ts`); esbuild columns are 0-based.
 */
function syntaxDiagnostics(errors: unknown[], limits: BehaviorCompilerLimits): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const raw of errors) {
    if (out.length >= limits.diagnostics) break;
    const e = raw as { text?: unknown; location?: { file?: unknown; line?: unknown; column?: unknown } | null };
    const text = typeof e.text === 'string' ? e.text : 'compiler error';
    const d: CompileDiagnostic = { code: 'behavior_source_invalid', reason: 'syntax', message: text.slice(0, 256) };
    const loc = e.location;
    if (loc !== null && loc !== undefined) {
      if (typeof loc.file === 'string') {
        const path = loc.file.replace(/^[a-z-]+:/, '');
        if (/^[a-z0-9][a-z0-9._/-]*\.ts$/.test(path)) d.path = path;
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
    return `${where}${first.text ?? 'compiler error'}`.slice(0, 256);
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
  } = {},
): BehaviorCompiler {
  const pinnedModules = options.pinnedModules ?? M2_PINNED_MODULES;
  const compileOptions: BehaviorCompileOptions = {};
  if (options.now !== undefined) compileOptions.now = options.now;
  if (options.build !== undefined) compileOptions.build = options.build;
  return {
    pinnedModules,
    compile(input: BehaviorCompileInput): Promise<BehaviorCompileResult> {
      return compileBehavior({ ...input, pinnedModules }, compileOptions);
    },
  };
}
