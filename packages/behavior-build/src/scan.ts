/**
 * Static source analysis — project-model.md §22.3 / §22.3.3 steps 8–12:
 * the `requiredModules ⊆ pinnedModules` check, the bounded textual import /
 * dynamic-code scanner in file order then text position, the relative
 * resolution, cycle detection and the import-depth bound.
 *
 * Textual and structural only: no source bytes are parsed as code, imported,
 * required or evaluated anywhere. A specifier assembled at runtime from string
 * concatenation is deliberately not detected (a documented limitation).
 */

import type {
  BehaviorCompileFailure,
  BehaviorCompilerLimits,
  PinnedModuleRef,
  SourceGraphAnalysis,
  SourceGraphContainer,
} from './types';
import type { BehaviorCompilerLimits as Limits } from './types';
import { containerFailure } from './container';

/** Node builtins (Node 22; bare and `node:`-prefixed forms). */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/** POSIX-normalize a relative specifier against the importing file. */
export function posixResolve(fromPath: string, spec: string): string {
  const parts = fromPath.split('/').slice(0, -1);
  let up = 0;
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      else up += 1;
    } else parts.push(seg);
  }
  return '../'.repeat(up) + parts.join('/');
}

interface ScanHit {
  index: number;
  /** Phase 25.6: where the hit is judged (a declaration's `from`; else `index`). */
  at: number;
  kind: 'dynamic' | 'specifier';
  reason?: string;
  typeOnly?: boolean;
  spec?: string;
}

/** Phase 25.6: what a text position is part of. */
export type TextRegion = 'code' | 'comment' | 'string' | 'regex';

/**
 * Phase 25.6: a lexical map of TypeScript text — every position is code, a
 * comment, a string (quotes and template text; a template's `${…}` is code)
 * or a regular expression literal. Used only to say where a scan hit sits;
 * the scan itself stays textual. A `/` starts a regex after an operator,
 * an opening bracket, a comma or semicolon, or a keyword such as `return`.
 */
export function textRegions(text: string): Uint8Array {
  // 0 code, 1 comment, 2 string, 3 regex
  const out = new Uint8Array(text.length);
  const templates: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let i = 0;
  let prev = ''; // the last significant code token's last character, or a keyword
  const regexAfter = /[(,=:[!&|?{};+\-*%<>~^]/;
  const mark = (from: number, to: number, v: number): void => {
    out.fill(v, from, Math.min(to, text.length));
  };
  const template = (start: number): number => {
    // from the character after ` (or after the } closing a `${`), to the closing ` or an opening ${
    let j = start;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        mark(start, j + 1, 2);
        return j + 1;
      } else if (c === '$' && text[j + 1] === '{') {
        mark(start, j + 2, 2);
        templates.push(depth);
        depth += 1;
        return j + 2;
      } else j += 1;
    }
    mark(start, j, 2);
    return j;
  };
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      mark(i, stop, 1);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      mark(i, stop, 1);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      mark(i, j + 1, 2);
      i = j + 1;
      prev = 'x';
    } else if (c === '`') {
      out[i] = 2;
      i = template(i + 1);
      prev = 'x';
    } else if (c === '/' && (prev === '' || regexAfter.test(prev) || prev === 'kw')) {
      let j = i + 1;
      let cls = false;
      while (j < text.length && text[j] !== '\n') {
        const d = text[j];
        if (d === '\\') j += 2;
        else {
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          j += 1;
        }
      }
      j += 1;
      while (j < text.length && /[a-z]/i.test(text[j]!)) j += 1;
      mark(i, j, 3);
      i = j;
      prev = 'x';
    } else if (c === '{') {
      depth += 1;
      prev = c;
      i += 1;
    } else if (c === '}') {
      depth -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        out[i] = 2;
        i = template(i + 1);
        prev = 'x';
      } else {
        prev = c;
        i += 1;
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j]!)) j += 1;
      const word = text.slice(i, j);
      prev = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word) ? 'kw' : 'x';
      i = j;
    } else {
      if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? 'x' : c;
      i += 1;
    }
  }
  return out;
}

const REGION_NAMES: readonly TextRegion[] = ['code', 'comment', 'string', 'regex'];

/** Phase 25.6: a scan hit's 1-based line and column, and the region it sits in. */
function locate(text: string, regions: Uint8Array, at: number): { line: number; column: number; region: TextRegion } {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < at && k < text.length; k++) {
    if (text[k] === '\n') {
      line += 1;
      lineStart = k + 1;
    }
  }
  return { line, column: at - lineStart + 1, region: REGION_NAMES[regions[at] ?? 0] ?? 'code' };
}

/** Phase 25.6: the words a hit's message ends with when it is not in code (the scan is textual). */
function regionNote(region: TextRegion): string {
  if (region === 'code') return '';
  const where = region === 'comment' ? 'a comment' : region === 'string' ? 'a string' : 'a regular expression';
  return ` It is inside ${where}: the scan is textual, so reword it.`;
}

/**
 * Extract the import-ish constructs in text order (the exact contract
 * constructs; comments/strings are not stripped — the scan is textual by
 * specification).
 */
function scanText(text: string): ScanHit[] {
  const hits: ScanHit[] = [];
  const dynamic: [RegExp, string][] = [
    [/\bimport\s*\(/g, 'dynamic_import'],
    [/\beval\s*\(/g, 'eval'],
    [/\bnew\s+Function\s*\(/g, 'function_constructor'],
    [/\bFunction\s*\(/g, 'function_constructor'],
    [/\brequire\s*\(/g, 'require'],
  ];
  for (const [re, reason] of dynamic) {
    for (const m of text.matchAll(re)) hits.push({ index: m.index ?? 0, at: m.index ?? 0, kind: 'dynamic', reason });
  }
  const declaration = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(declaration)) {
    // Judged at its `from` (a declaration's match may start in code and end in a comment).
    const tail = /from\s*['"][^'"]+['"]$/.exec(m[0]);
    const at = (m.index ?? 0) + (tail?.index ?? 0);
    hits.push({ index: m.index ?? 0, at, kind: 'specifier', typeOnly: Boolean(m[1]), spec: m[3] as string });
  }
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(sideEffect)) {
    hits.push({ index: m.index ?? 0, at: m.index ?? 0, kind: 'specifier', typeOnly: false, spec: m[1] as string });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

type Classified =
  | { kind: 'relative' }
  | { kind: 'type_only_engine' }
  | { kind: 'library'; libraryId: string }
  | { kind: 'forbidden'; reason: string; specifier: string };

/** Phase 23.7: `@lib/<libraryId>` names a project script library's `src/index.ts`. */
export const LIBRARY_SPECIFIER_RE = /^@lib\/([a-z0-9][a-z0-9_-]{0,63})$/;

/** Phase 23.7: a relative specifier's stored path (`.json` kept; otherwise `.ts` appended when missing). */
export function resolveRelativeTarget(from: string, spec: string): string {
  const target = posixResolve(from, spec);
  return target.endsWith('.ts') || target.endsWith('.json') ? target : `${target}.ts`;
}

function classify(spec: string, typeOnly: boolean, pinned: readonly string[]): Classified {
  const lib = LIBRARY_SPECIFIER_RE.exec(spec);
  if (lib !== null) return { kind: 'library', libraryId: lib[1] as string };
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    if (spec.startsWith('node:')) return { kind: 'forbidden', reason: 'node_builtin', specifier: spec };
    return { kind: 'forbidden', reason: 'network', specifier: spec };
  }
  if (spec.startsWith('/')) return { kind: 'forbidden', reason: 'absolute', specifier: spec };
  if (spec.startsWith('./') || spec.startsWith('../')) return { kind: 'relative' };
  if (spec.startsWith('#')) return { kind: 'forbidden', reason: 'absolute', specifier: spec };
  const first = spec.split('/')[0] as string;
  if (NODE_BUILTINS.has(first)) return { kind: 'forbidden', reason: 'node_builtin', specifier: spec };
  if (pinned.includes(spec)) {
    if (typeOnly) return { kind: 'type_only_engine' };
    return { kind: 'forbidden', reason: 'engine_value_import', specifier: spec };
  }
  return { kind: 'forbidden', reason: 'bare', specifier: spec };
}

export type AnalyzeResult = { ok: true; analysis: SourceGraphAnalysis } | { ok: false; failure: BehaviorCompileFailure };

/**
 * Steps 8–12 over an accepted container. `limits` may override the defaults.
 */
export function analyzeSourceGraph(
  container: SourceGraphContainer,
  pinnedModules: readonly PinnedModuleRef[],
  limits: Limits,
  options: { library?: boolean } = {},
): AnalyzeResult {
  const pinnedIds = pinnedModules.map((p) => p.id);
  const paths = container.files.map((f) => f.path);
  // Step 8: `requiredModules ⊆ pinnedModules`.
  for (const mod of container.requiredModules) {
    if (!pinnedIds.includes(mod)) {
      return containerFailure('behavior_import_unpinned', mod, {
        detail: mod,
        message: `requiredModules entry "${mod}" is not in the pinned module set`,
      });
    }
  }
  // Step 9: the ordered import scan (file order, then text position).
  const edges: [string, string, { line: number; column: number; region: TextRegion }][] = [];
  let typeOnlyImports = 0;
  let acceptedImports = 0;
  const libraryImports = new Set<string>();
  for (const f of container.files) {
    // Phase 23.7: a `.json` file is data — it has no imports; it must parse.
    if (f.path.endsWith('.json')) {
      try {
        JSON.parse(f.text);
      } catch (e) {
        return containerFailure('behavior_source_invalid', 'json', {
          path: f.path,
          detail: f.path,
          message: `file "${f.path}" is not valid JSON: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
        });
      }
      continue;
    }
    const hits = scanText(f.text);
    const importCount = hits.filter((h) => h.kind === 'specifier').length;
    if (importCount > limits.importsPerFile) {
      return containerFailure('behavior_source_limits_exceeded', 'imports', {
        limit: 'imports',
        current: importCount,
        max: limits.importsPerFile,
        path: f.path,
        message: `file "${f.path}" has too many import declarations`,
      });
    }
    let regions: Uint8Array | null = null;
    const where = (h: ScanHit): { line: number; column: number; region: TextRegion } => locate(f.text, (regions ??= textRegions(f.text)), h.at);
    for (const h of hits) {
      if (h.kind === 'dynamic') {
        const w = where(h);
        return containerFailure('behavior_dynamic_code', h.reason as string, {
          path: f.path,
          line: w.line,
          column: w.column,
          detail: h.reason,
          message: `file "${f.path}" line ${w.line} contains a ${h.reason} construct (dynamic code is forbidden).${regionNote(w.region)}`,
        });
      }
      const cls = classify(h.spec as string, h.typeOnly === true, pinnedIds);
      if (cls.kind === 'library') {
        acceptedImports += 1;
        libraryImports.add(cls.libraryId);
        continue;
      }
      if (cls.kind === 'type_only_engine') {
        // §22.3.1 rule 3: a type-only engine import must name a module from
        // `requiredModules` (it is erased and contributes no output bytes).
        // Phase 23.7: a script library lists none (any pinned module's types).
        if (options.library !== true && !container.requiredModules.includes(h.spec as string)) {
          const w = where(h);
          return containerFailure('behavior_import_unpinned', h.spec as string, {
            path: f.path,
            line: w.line,
            column: w.column,
            detail: h.spec,
            message: `line ${w.line}: type-only import "${h.spec}" is not declared in requiredModules.${regionNote(w.region)}`,
          });
        }
        typeOnlyImports += 1;
        continue;
      }
      if (cls.kind === 'relative') {
        acceptedImports += 1;
        edges.push([f.path, h.spec as string, where(h)]);
        continue;
      }
      const w = where(h);
      return containerFailure('behavior_import_forbidden', cls.reason, {
        path: f.path,
        line: w.line,
        column: w.column,
        detail: cls.specifier,
        message: `file "${f.path}" line ${w.line} imports "${cls.specifier}" (${cls.reason}).${regionNote(w.region)}`,
      });
    }
  }
  // Step 10: relative resolution against `files`.
  const relEdges: [string, string][] = [];
  for (const [from, spec, w] of edges) {
    const target = resolveRelativeTarget(from, spec);
    if (target === '..' || target.startsWith('../')) {
      return containerFailure('behavior_source_escape', target, {
        path: from,
        line: w.line,
        column: w.column,
        detail: target,
        message: `import "${spec}" in "${from}" line ${w.line} resolves above the graph root.${regionNote(w.region)}`,
      });
    }
    if (!paths.includes(target)) {
      return containerFailure('behavior_source_missing', target, {
        path: from,
        line: w.line,
        column: w.column,
        detail: target,
        message: `import "${spec}" in "${from}" line ${w.line} resolves to "${target}", which is not in files.${regionNote(w.region)}`,
      });
    }
    relEdges.push([from, target]);
  }
  // Step 11: cycle detection over the resolved relative graph.
  const adj = new Map<string, string[]>();
  for (const [a, b] of relEdges) adj.set(a, [...(adj.get(a) ?? []), b]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (node: string): void => {
    if (cycle !== null) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (cycle !== null) break;
      if (state.get(next) === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
        break;
      }
      if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  visit(container.entryPath);
  if (cycle !== null) {
    const list = cycle as string[];
    return containerFailure('behavior_source_cycle', list.join(' -> '), {
      detail: list.join(' -> '),
      message: `the resolved import graph contains a cycle: ${list.join(' -> ')}`,
    });
  }
  // Step 12: import depth (longest chain from the entry).
  const depthMemo = new Map<string, number>();
  const depthOf = (node: string): number => {
    const memo = depthMemo.get(node);
    if (memo !== undefined) return memo;
    let best = 0;
    for (const next of adj.get(node) ?? []) best = Math.max(best, 1 + depthOf(next));
    depthMemo.set(node, best);
    return best;
  };
  const importDepth = depthOf(container.entryPath);
  if (importDepth > limits.importDepth) {
    return containerFailure('behavior_source_limits_exceeded', 'import_depth', {
      limit: 'import_depth',
      current: importDepth,
      max: limits.importDepth,
      message: 'the longest relative import chain exceeds the depth bound',
    });
  }
  return {
    ok: true,
    analysis: {
      entryPath: container.entryPath,
      fileCount: container.files.length,
      fileByteLengths: container.files.map((f) => ({ path: f.path, byteLength: new TextEncoder().encode(f.text).length })),
      requiredModules: [...container.requiredModules],
      ownedTransforms: [...container.ownedTransforms],
      relativeEdges: relEdges,
      importDepth,
      typeOnlyImports,
      acceptedImports,
      ...(libraryImports.size > 0 ? { libraryImports: [...libraryImports].sort() } : {}),
    },
  };
}

/** Bound override helper shared by the analysis/compile entry points. */
export function withLimits(base: BehaviorCompilerLimits, overrides?: Partial<BehaviorCompilerLimits>): BehaviorCompilerLimits {
  return overrides === undefined ? { ...base } : { ...base, ...overrides };
}
