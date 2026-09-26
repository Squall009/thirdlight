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
  kind: 'dynamic' | 'specifier';
  reason?: string;
  typeOnly?: boolean;
  spec?: string;
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
    for (const m of text.matchAll(re)) hits.push({ index: m.index ?? 0, kind: 'dynamic', reason });
  }
  const declaration = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(declaration)) {
    hits.push({ index: m.index ?? 0, kind: 'specifier', typeOnly: Boolean(m[1]), spec: m[3] as string });
  }
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(sideEffect)) {
    hits.push({ index: m.index ?? 0, kind: 'specifier', typeOnly: false, spec: m[1] as string });
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
  const edges: [string, string][] = [];
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
    for (const h of hits) {
      if (h.kind === 'dynamic') {
        return containerFailure('behavior_dynamic_code', h.reason as string, {
          path: f.path,
          detail: h.reason,
          message: `file "${f.path}" contains a ${h.reason} construct (dynamic code is forbidden)`,
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
          return containerFailure('behavior_import_unpinned', h.spec as string, {
            path: f.path,
            detail: h.spec,
            message: `type-only import "${h.spec}" is not declared in requiredModules`,
          });
        }
        typeOnlyImports += 1;
        continue;
      }
      if (cls.kind === 'relative') {
        acceptedImports += 1;
        edges.push([f.path, h.spec as string]);
        continue;
      }
      return containerFailure('behavior_import_forbidden', cls.reason, {
        path: f.path,
        detail: cls.specifier,
        message: `file "${f.path}" imports "${cls.specifier}" (${cls.reason})`,
      });
    }
  }
  // Step 10: relative resolution against `files`.
  const relEdges: [string, string][] = [];
  for (const [from, spec] of edges) {
    const target = resolveRelativeTarget(from, spec);
    if (target === '..' || target.startsWith('../')) {
      return containerFailure('behavior_source_escape', target, {
        path: from,
        detail: target,
        message: `import "${spec}" in "${from}" resolves above the graph root`,
      });
    }
    if (!paths.includes(target)) {
      return containerFailure('behavior_source_missing', target, {
        path: from,
        detail: target,
        message: `import "${spec}" in "${from}" resolves to "${target}", which is not in files`,
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
