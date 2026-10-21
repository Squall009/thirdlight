/**
 * The script type check: the pinned TypeScript compiler checks a script's
 * files (and the script libraries it imports) against the generated behavior
 * API typings, entirely in memory.
 *
 * esbuild only strips types, so a wrong option name (`{ blendTime }` where the
 * field is `time`) compiles and runs with the option ignored. This check is
 * what catches it. It runs on request (a script check), never on a Play or an
 * export build: a type error does not stop a project from opening or running.
 *
 * Nothing is written and no project path is read: the program sees a virtual
 * file map (the script under `/script/<behaviorId>/`, each library under
 * `/lib/<libraryId>/`, the typings under `/types/`). The only files read are
 * the pinned compiler's own standard-library typings, once per process.
 *
 * The entry's default export is checked as a `BehaviorSpec`, so `step(state,
 * ctx)` written without annotations still gets `ctx` typed as the context
 * (the documented way to write a script). `noImplicitAny` is off for the same
 * reason: an untyped helper parameter is plain JavaScript, not an error. So is
 * `strictNullChecks` (see the options): the check is for wrong names and
 * wrong types, the mistakes esbuild lets through.
 */

import type * as TS from 'typescript';

import { BEHAVIOR_API_DTS } from './behavior-api-typings.generated';
import { parseSourceGraphContainer } from './container';
import { GRAPH_SOURCE_BANNER } from './graph-banner';
import { COMPILER_LIMITS, ENTRY_PATH, TYPE_CHECK_TIMEOUT_MS, TYPESCRIPT_PIN } from './limits';
import { LIBRARY_SPECIFIER_RE, resolveRelativeTarget } from './scan';
import type { CompileDiagnostic, ScriptLibraryInput } from './types';

type Ts = typeof TS;

/** The diagnostic code of a type error (its `reason` is the TypeScript error number, `ts2353`). */
export const TYPE_ERROR_CODE = 'behavior_type_error' as const;

/**
 * The `property` helpers a code declaration calls (`export const properties
 * = { speed: property.number(3) }`). The compiler reads and replaces that
 * statement before the build, so the helpers exist only for the type check.
 */
export const SCRIPT_GLOBALS_DTS = `// The property helpers of a code declaration (src/index.ts \`export const properties\`).
interface ThirdlightPropertyOptions {
  label?: string; min?: number; max?: number; step?: number; maxLength?: number;
  values?: readonly string[]; bounds?: unknown; group?: string; header?: string; tooltip?: string;
}
interface ThirdlightPropertyHelpers {
  number(defaultValue: number, options?: ThirdlightPropertyOptions): unknown;
  boolean(defaultValue: boolean, options?: ThirdlightPropertyOptions): unknown;
  string(defaultValue: string, options?: ThirdlightPropertyOptions): unknown;
  enum(defaultValue: string, options?: ThirdlightPropertyOptions): unknown;
  vec3(defaultValue: readonly [number, number, number], options?: ThirdlightPropertyOptions): unknown;
  entityRef(defaultValue: string | null, options?: ThirdlightPropertyOptions): unknown;
  assetRef(defaultValue: string | null, options?: ThirdlightPropertyOptions): unknown;
}
declare const property: ThirdlightPropertyHelpers & { readonly public: ThirdlightPropertyHelpers; readonly private: ThirdlightPropertyHelpers };
`;

const TYPINGS_PATH = '/types/thirdlight-runtime.d.ts';
const GLOBALS_PATH = '/types/script-globals.d.ts';
/** What the entry's default export is checked as (state and prepared values stay the script's own). */
const SPEC_SUFFIX = ") satisfies import('@thirdlight/runtime').BehaviorSpec<any, any>";
/** A source file kept between checks (a re-check of the same script reparses only what changed). */
const MAX_CACHED_FILES = 512;
/** The known fields named after an excess-property error, at most. */
const MAX_FIELDS_NAMED = 16;

export interface ScriptTypeCheckInput {
  readonly behaviorId: string;
  readonly containerBytes: Uint8Array;
  /** The project's script libraries (`@lib/<id>` imports resolve to them). */
  readonly libraries?: readonly ScriptLibraryInput[];
}

export interface ScriptTypeCheckResult {
  /** The type errors (bounded by `maxDiagnostics`); empty when the script type-checks. */
  readonly diagnostics: CompileDiagnostic[];
  /** Why nothing was checked: a generated visual-script source, or a toolchain that is not the pin. */
  readonly skipped?: 'graph' | 'toolchain';
  /** The check stopped at its time bound; `diagnostics` holds what was found before. */
  readonly timedOut?: true;
}

export interface ScriptTypeChecker {
  check(input: ScriptTypeCheckInput): Promise<ScriptTypeCheckResult>;
}

let tsModule: Promise<Ts> | null = null;
/** The pinned compiler, loaded on the first check (a Play or a build never loads it). */
function loadTs(): Promise<Ts> {
  tsModule ??= import('typescript').then((m) => ((m as { default?: Ts }).default ?? m) as Ts);
  return tsModule;
}

/** The entry with its default export wrapped in `(…) satisfies BehaviorSpec`, and the map back. */
function wrapDefaultExport(ts: Ts, text: string): { text: string; original: TS.SourceFile; toOriginal: (pos: number) => number } {
  const sf = ts.createSourceFile(ENTRY_PATH, text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const stmt = sf.statements.find((s): s is TS.ExportAssignment => ts.isExportAssignment(s) && s.isExportEquals !== true);
  if (stmt === undefined) return { text, original: sf, toOriginal: (p) => p };
  const open = stmt.expression.getStart(sf);
  const close = stmt.expression.end;
  const wrapped = `${text.slice(0, open)}(${text.slice(open, close)}${SPEC_SUFFIX}${text.slice(close)}`;
  return {
    text: wrapped,
    original: sf,
    toOriginal: (p) => (p <= open ? p : p <= close + 1 ? p - 1 : p < close + 1 + SPEC_SUFFIX.length ? open : p - 1 - SPEC_SUFFIX.length),
  };
}

/** The deepest node at `pos` (for naming the fields an object literal may have). */
function nodeAt(ts: Ts, sf: TS.SourceFile, pos: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (n: TS.Node): void => {
    if (pos < n.getStart(sf) || pos >= n.end) return;
    found = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** ` (CameraBlendOptions has: time, ease)` after an excess-property error, so the right name is in the message. */
function knownFieldsNote(ts: Ts, checker: TS.TypeChecker, sf: TS.SourceFile, pos: number): string {
  let n = nodeAt(ts, sf, pos);
  while (n !== undefined && !ts.isObjectLiteralExpression(n)) n = n.parent;
  if (n === undefined) return '';
  const type = checker.getContextualType(n);
  if (type === undefined) return '';
  const names = checker.getPropertiesOfType(checker.getNonNullableType(type)).map((p) => p.getName());
  if (names.length === 0) return '';
  const shown = names.slice(0, MAX_FIELDS_NAMED).join(', ') + (names.length > MAX_FIELDS_NAMED ? ', …' : '');
  return ` (${checker.typeToString(type)} has: ${shown})`;
}

/**
 * A type checker that keeps the compiler's standard library and the API
 * typings parsed between checks, and each script and library file until its
 * text changes. `now` (a monotonic clock in ms) bounds the checking time; the
 * pure checker reads no clock without it.
 */
export function createScriptTypeChecker(options: { now?: () => number; maxDiagnostics?: number; timeoutMs?: number } = {}): ScriptTypeChecker {
  const maxDiagnostics = options.maxDiagnostics ?? COMPILER_LIMITS.diagnostics;
  const timeoutMs = options.timeoutMs ?? TYPE_CHECK_TIMEOUT_MS;
  const fixedFiles = new Map<string, TS.SourceFile>();
  const userFiles = new Map<string, { text: string; sf: TS.SourceFile }>();
  let lastProgram: TS.Program | undefined;
  let libDir = '';

  const compilerOptions = (ts: Ts): TS.CompilerOptions => ({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // The browser globals a script sees (the same libraries the typings are generated with).
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noImplicitAny: false,
    // Most context members are optional in the typings (a host may lack one)
    // while Play always has them; the manual writes `ctx.camera.activate(…)`.
    strictNullChecks: false,
    noEmit: true,
    types: [],
    skipLibCheck: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    noLib: false,
  });

  const sourceFile = (ts: Ts, name: string, text: string): TS.SourceFile => {
    const kept = userFiles.get(name);
    if (kept !== undefined && kept.text === text) {
      userFiles.delete(name);
      userFiles.set(name, kept);
      return kept.sf;
    }
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, name.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
    userFiles.set(name, { text, sf });
    if (userFiles.size > MAX_CACHED_FILES) userFiles.delete(userFiles.keys().next().value as string);
    return sf;
  };

  const fixedFile = (ts: Ts, name: string): TS.SourceFile | undefined => {
    const kept = fixedFiles.get(name);
    if (kept !== undefined) return kept;
    let text: string | undefined;
    if (name === TYPINGS_PATH) text = BEHAVIOR_API_DTS;
    else if (name === GLOBALS_PATH) text = SCRIPT_GLOBALS_DTS;
    else if (name.startsWith(`${libDir}/`)) text = ts.sys.readFile(name);
    if (text === undefined) return undefined;
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    fixedFiles.set(name, sf);
    return sf;
  };

  return {
    async check(input: ScriptTypeCheckInput): Promise<ScriptTypeCheckResult> {
      const ts = await loadTs();
      if (ts.version !== TYPESCRIPT_PIN) return { diagnostics: [], skipped: 'toolchain' };
      const opts = compilerOptions(ts);
      const libFile = ts.getDefaultLibFilePath(opts);
      libDir = libFile.slice(0, libFile.lastIndexOf('/'));
      const parsed = parseSourceGraphContainer(input.containerBytes);
      if (!parsed.ok) return { diagnostics: [] };
      const entry = parsed.container.files.find((f) => f.path === parsed.container.entryPath);
      // A visual script's source is generated by the engine: a type error there is the generator's bug.
      if (entry !== undefined && entry.text.startsWith(`${GRAPH_SOURCE_BANNER}\n`)) return { diagnostics: [], skipped: 'graph' };

      const scriptRoot = `/script/${input.behaviorId}/`;
      const files = new Map<string, string>();
      // Virtual path -> where a diagnostic there is reported.
      const origin = new Map<string, { path: string; library?: string; toOriginal?: (pos: number) => number; original?: TS.SourceFile }>();
      for (const f of parsed.container.files) {
        const name = scriptRoot + f.path;
        if (f.path === parsed.container.entryPath) {
          const w = wrapDefaultExport(ts, f.text);
          files.set(name, w.text);
          origin.set(name, { path: f.path, toOriginal: w.toOriginal, original: w.original });
        } else {
          files.set(name, f.text);
          origin.set(name, { path: f.path });
        }
      }
      for (const lib of input.libraries ?? []) {
        const p = parseSourceGraphContainer(lib.containerBytes);
        if (!p.ok) continue;
        for (const f of p.container.files) {
          const name = `/lib/${lib.libraryId}/${f.path}`;
          files.set(name, f.text);
          origin.set(name, { path: f.path, library: lib.libraryId });
        }
      }

      const resolve = (spec: string, containing: string): TS.ResolvedModuleFull | undefined => {
        const lib = LIBRARY_SPECIFIER_RE.exec(spec);
        let target: string | undefined;
        if (lib !== null) target = `/lib/${lib[1] as string}/${ENTRY_PATH}`;
        else if (spec.startsWith('./') || spec.startsWith('../')) {
          const root = containing.startsWith(scriptRoot) ? scriptRoot : containing.slice(0, containing.indexOf('/', '/lib/'.length) + 1);
          target = root + resolveRelativeTarget(containing.slice(root.length), spec);
        }
        // `@thirdlight/runtime` (and anything else) resolves to the ambient typings or stays unresolved.
        if (target === undefined || !files.has(target)) return undefined;
        return { resolvedFileName: target, extension: target.endsWith('.json') ? ts.Extension.Json : ts.Extension.Ts, isExternalLibraryImport: false };
      };

      const host: TS.CompilerHost = {
        getSourceFile: (name) => {
          const text = files.get(name);
          return text !== undefined ? sourceFile(ts, name, text) : fixedFile(ts, name);
        },
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        writeFile: () => undefined,
        getCurrentDirectory: () => '/',
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (f) => files.has(f) || fixedFile(ts, f) !== undefined,
        readFile: (f) => files.get(f) ?? fixedFile(ts, f)?.text,
        directoryExists: (d) => d === '/' || [...files.keys()].some((f) => f.startsWith(`${d}/`)),
        getDirectories: () => [],
        resolveModuleNameLiterals: (literals, containing) => literals.map((l) => ({ resolvedModule: resolve(l.text, containing) })),
      };
      const roots = [TYPINGS_PATH, GLOBALS_PATH, ...parsed.container.files.filter((f) => !f.path.endsWith('.json')).map((f) => scriptRoot + f.path)];
      const program = ts.createProgram({ rootNames: roots, options: opts, host, ...(lastProgram !== undefined ? { oldProgram: lastProgram } : {}) });
      lastProgram = program;

      const start = options.now?.();
      const token: TS.CancellationToken = {
        isCancellationRequested: () => start !== undefined && options.now !== undefined && options.now() - start > timeoutMs,
        throwIfCancellationRequested() {
          if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
        },
      };
      const found: TS.Diagnostic[] = [];
      let timedOut = false;
      try {
        found.push(...program.getGlobalDiagnostics(token));
        for (const name of files.keys()) {
          const sf = program.getSourceFile(name);
          if (sf === undefined || sf.isDeclarationFile) continue;
          found.push(...program.getSyntacticDiagnostics(sf, token), ...program.getSemanticDiagnostics(sf, token));
          if (found.length >= maxDiagnostics) break;
        }
      } catch (e) {
        if (!(e instanceof ts.OperationCanceledException)) throw e;
        timedOut = true;
      }

      const checker = program.getTypeChecker();
      const diagnostics: CompileDiagnostic[] = [];
      for (const d of found) {
        if (diagnostics.length >= maxDiagnostics) break;
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        let message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        const out: CompileDiagnostic = { code: TYPE_ERROR_CODE, reason: `ts${d.code}`, message: '' };
        const where = d.file !== undefined ? origin.get(d.file.fileName) : undefined;
        if (d.file !== undefined && where !== undefined && d.start !== undefined) {
          // Excess-property errors (TS2353) name the type, not its fields: name them.
          if (d.code === 2353) message += knownFieldsNote(ts, checker, d.file, d.start);
          const file = where.original ?? d.file;
          const pos = where.toOriginal !== undefined ? where.toOriginal(d.start) : d.start;
          const lc = ts.getLineAndCharacterOfPosition(file, Math.min(pos, file.text.length));
          out.path = where.path;
          if (where.library !== undefined) out.library = where.library;
          out.line = lc.line + 1;
          out.column = lc.character + 1;
        }
        out.message = (where?.library !== undefined ? `@lib/${where.library}: ${message}` : message).slice(0, 256);
        diagnostics.push(out);
      }
      return { diagnostics, ...(timedOut ? { timedOut: true as const } : {}) };
    },
  };
}
