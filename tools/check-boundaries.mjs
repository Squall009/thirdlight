#!/usr/bin/env node
/**
 * Thirdlight boundary check 1 — static import graph (dependencies.md §5 check 1).
 *
 * Scans the .ts/.tsx sources of every implemented workspace package
 * (packages/<name>/package.json) and checks every
 * `import` / `export … from` / dynamic `import()` specifier against the
 * normative edge rules:
 *
 *   dependencies.md §4.1   node-side allowed import edges (exact table),
 *                          including the types-only edge qualifiers: a
 *                          value import, value re-export, or dynamic
 *                          `import()` of a types-only target fails
 *                          (`types-only-edge`). The qualifiers per the
 *                          table text: editor → project-model/commands
 *                          ("(types)"), backend → project-model
 *                          ("(types only — the snapshot document)"),
 *                          exporter → project-model/protocol/workspace
 *                          ("(types only — the service instance is
 *                          injected)"), protocol → project-model/commands
 *                          ("(types; pure code, no I/O)").
 *   dependencies.md §4.3   forbidden edges (any plane) — `runtime → three`,
 *                          `runtime → Node builtins`, `editor → workspace |
 *                          backend`, `backend → editor`, `mcp-adapter → backend`
 *                          (the `/services` subpath only), `mcp-adapter →
 *                          workspace | editor`, `exporter → backend | editor`,
 *                          relative imports into another package's internals
 *   dependencies.md §3     the public surface is the package.json `exports`
 *                          map only — a specifier reaching a non-exported
 *                          subpath fails
 *   dependencies.md §2     units are created only when implemented — importing
 *                          a not-yet-implemented `@thirdlight/*` unit fails
 *   dependencies.md §5.6   a package must not declare a dependency on a
 *                          not-yet-implemented workspace package (checked for
 *                          every package manifest AND the root manifest)
 *   dependencies.md §7     React is scoped to `editor` only — checked for
 *                          source imports AND declared dependencies (incl. the
 *                          React type packages, in every manifest including
 *                          the root)
 *   m1-acceptance.md §2.4  the forbidden web-framework list applies to imports
 *                          and to declared dependencies
 *   dependencies.md §4.3   no hidden global services — `globalThis`
 *                          assignments are flagged for review
 *
 * Test-file policy (narrow; the dependencies.md §5.1 contract
 * clarification permitting the approved test runner in designated package
 * test files is pending review — see handoff 04 repair record): designated
 * package test files (`.test.ts(x)` / `.spec.ts(x)`) may import the
 * approved test runner `vitest` (any subpath); every other rule applies to
 * test files unchanged, and a production file importing `vitest` fails
 * (`forbidden-external`). Tests are NOT exempt from boundary checking.
 *
 * Plain Node, no new dependency. Any violation ⇒ non-zero exit, each listed
 * as `file:line: [rule] message`.
 *
 * Specifier extraction (repaired per 04-review R2): the source is first
 * SCRUBBED — a small state machine blanks comments and string/template
 * literal contents (template `${…}` interpolations are treated as code)
 * while preserving delimiters, offsets, and line numbers 1:1 — and the
 * normative forms are matched against the scrubbed view:
 *   - every static import clause form: default, named (incl. multi-line),
 *     namespace, default+named, default+namespace, `import type …`
 *     variants, per-binding `type` modifiers, and comments between any
 *     tokens (an import with a comment between `import` and its clause)
 *   - side-effect `import 'spec'`
 *   - `export … from 'spec'` (incl. `export type …`)
 *   - dynamic `import('spec')` with or without an options argument
 *     (`import('spec', { … })`, multi-line options) — the call's parentheses
 *     are balanced in the scrubbed view
 * The specifier text is read from the raw source at the matched quote, so
 * file/line output stays accurate.
 *
 * Type-only classification (for the §4.1 types-only edges): an
 * `import type` / `export type` statement, or an import clause whose named
 * bindings are all `type`-prefixed, counts as type-only. A default or
 * namespace binding, any plain named binding, a side-effect import, and
 * any dynamic `import()` count as value (executable) imports. Statically,
 * a plain `import { T } from …` of a types-only target fails even if T
 * happens to be a type — the conservative direction (fix: `import type`).
 *
 * Static-scan bounds (remaining limitations, recorded in handoff 04):
 * `require()` and `import = require()` are not scanned (the documented
 * exclusion); regex literals can mislead the comment/string scrubber (a
 * false positive is possible, not a false negative for the normative import
 * forms); `exports` subpath pattern syntax (`./x/*`) is not matched (M1
 * exports maps are flat tables — dependencies.md §3); the `globalThis`
 * assignment scan runs on the raw source (a commented-out assignment is
 * flagged for review — the conservative direction for this review rule).
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const WORKSPACE_SCOPE = '@thirdlight/';

/** The unit list (dependencies.md §2). */
export const UNITS = [
  'project-model',
  'commands',
  'workspace',
  'runtime',
  'three-adapter',
  'protocol',
  'backend',
  'editor',
  'mcp-adapter',
  'exporter',
];

/**
 * Node-side allowed import edges (dependencies.md §4.1, exact).
 * `packages`: allowed `@thirdlight/*` targets. `external`: allowed
 * non-workspace packages. `node`: allowed Node builtins. `subpaths`:
 * per-target subpath restriction (mcp-adapter → backend: `services` only —
 * dependencies.md §3/§4.3). `typesOnly`: allowed targets whose edge the
 * §4.1 table qualifies as types only — a value import of such a target
 * fails (`types-only-edge`).
 */
export const NODE_SIDE_ALLOWED = {
  'project-model': { packages: [], external: [], node: [] },
  commands: { packages: ['project-model'], external: [], node: [] },
  workspace: {
    packages: ['project-model', 'commands'],
    external: [],
    node: ['fs', 'path', 'crypto', 'os'],
  },
  runtime: { packages: ['project-model'], external: [], node: [] },
  'three-adapter': {
    packages: ['runtime'],
    external: ['three', '@types/three'],
    node: [],
  },
  // §4.1 row: "project-model, commands (types; pure code, no I/O)".
  protocol: {
    packages: ['project-model', 'commands'],
    external: [],
    node: [],
    typesOnly: { 'project-model': true, commands: true },
  },
  // §4.1 row: "… project-model (types only — the snapshot document,
  // sessions.md §10.1)".
  backend: {
    packages: ['protocol', 'workspace', 'exporter', 'project-model'],
    external: ['ws'],
    node: ['http', 'fs', 'path', 'crypto'],
    typesOnly: { 'project-model': true },
  },
  // §4.1 row: "project-model, protocol, workspace (types only — the
  // service instance is injected, never constructed)".
  exporter: {
    packages: ['project-model', 'protocol', 'workspace'],
    external: ['esbuild'],
    node: [],
    typesOnly: { 'project-model': true, protocol: true, workspace: true },
  },
  'mcp-adapter': {
    packages: ['protocol', 'backend'],
    external: ['@modelcontextprotocol/sdk'],
    node: [],
    subpaths: { backend: ['services'] },
  },
  // §4.1 row: "… project-model (types), commands (types) …".
  editor: {
    packages: ['protocol', 'runtime', 'three-adapter', 'project-model', 'commands'],
    external: [
      'three',
      'react',
      'react-dom',
      '@types/react',
      '@types/react-dom',
      '@types/three',
    ],
    node: [],
    typesOnly: { 'project-model': true, commands: true },
  },
};

/**
 * Forbidden web frameworks (m1-acceptance.md §2.4, the recorded list;
 * dependencies.md §7: no web framework anywhere — node:http only).
 */
export const FORBIDDEN_WEB_FRAMEWORKS = new Set([
  'express',
  'fastify',
  'koa',
  'hapi',
  'next',
  'nuxt',
  'vue',
  'svelte',
  'preact',
  'angular',
]);

/** React is scoped to `editor` only (dependencies.md §7 React scope rules). */
const REACT_EDITOR_ONLY = new Set(['react', 'react-dom']);

/** React declaration scope (dependencies.md §7): only `editor` may declare these. */
const REACT_DECLARABLE = new Set(['react', 'react-dom', '@types/react', '@types/react-dom']);

/** Node builtins (bare and `node:`-prefixed forms), Node 22. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/**
 * Designated package test files (the narrow test-tooling policy — the
 * §5.1 contract clarification is pending review): only these may import the
 * approved test runner `vitest`.
 */
const RE_TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/;

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

// --- comment/string scrub ---------------------------------------------------

/**
 * Blank comments and string/template literal contents (spaces; delimiters,
 * newlines, and `${…}` interpolation code are kept) to build a code-only
 * view of the same length as `src`. Every offset and line number in the
 * result maps 1:1 to `src`. Regex literals are NOT recognized and can
 * mislead the scrubber (recorded limitation — false-positive direction).
 */
export function scrubCommentsAndStrings(src) {
  const out = Array.from(src);
  const n = out.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Frames: { mode: 'code' | 'str' | 'tpl', quote?, depth?, interp? }.
  // A 'code' frame with interp=true is a template `${…}` interpolation; a
  // brace at depth 0 there returns to the enclosing template.
  const stack = [{ mode: 'code', depth: 0, interp: false }];
  let i = 0;
  while (i < n) {
    const c = out[i];
    const f = stack[stack.length - 1];
    if (f.mode === 'code') {
      if (c === '/' && out[i + 1] === '/') {
        let j = i + 2;
        while (j < n && out[j] !== '\n') j++;
        blank(i, j); // delimiters included: leftovers would break clause matching
        i = j;
      } else if (c === '/' && out[i + 1] === '*') {
        let j = i + 2;
        while (j < n && !(out[j] === '*' && out[j + 1] === '/')) j++;
        const end = j < n ? j + 2 : n;
        blank(i, end); // delimiters included
        i = end;
      } else if (c === "'" || c === '"') {
        stack.push({ mode: 'str', quote: c });
        i++;
      } else if (c === '`') {
        stack.push({ mode: 'tpl' });
        i++;
      } else if (c === '{') {
        f.depth += 1;
        i++;
      } else if (c === '}') {
        if (f.depth > 0) f.depth -= 1;
        else if (f.interp) stack.pop();
        i++;
      } else {
        i++;
      }
    } else if (f.mode === 'str') {
      if (c === '\\') {
        blank(i + 1, Math.min(i + 2, n));
        i += 2;
      } else if (c === f.quote || c === '\n') {
        stack.pop(); // unterminated at EOL: recover, don't poison the rest
        i++;
      } else {
        blank(i, i + 1);
        i++;
      }
    } else {
      // template literal
      if (c === '\\') {
        blank(i + 1, Math.min(i + 2, n));
        i += 2;
      } else if (c === '$' && out[i + 1] === '{') {
        stack.push({ mode: 'code', depth: 0, interp: true });
        i += 2;
      } else if (c === '`') {
        stack.pop();
        i++;
      } else {
        blank(i, i + 1);
        i++;
      }
    }
  }
  return out.join('');
}

// --- specifier extraction ----------------------------------------------------

const QUOTE = "(['\"])";
// A static import clause: default, named (multi-line ok), namespace,
// default+named, default+namespace. Per-binding `type` modifiers stay
// inside the braces.
const CLAUSE =
  '(?:[\\w$]+|\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+)(?:\\s*,\\s*(?:\\*\\s+as\\s+[\\w$]+|\\{[^}]*\\}))?';
const RE_IMPORT_FROM = new RegExp(
  String.raw`\bimport\s+(type\s+)?(${CLAUSE})\s+from\s*${QUOTE}`,
  'g',
);
const RE_SIDE_EFFECT = new RegExp(String.raw`\bimport\s*${QUOTE}`, 'g');
const RE_EXPORT_FROM = new RegExp(
  String.raw`\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*${QUOTE}`,
  'g',
);
const RE_DYNAMIC_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*${QUOTE}`, 'g');

/** `globalThis.x = …` / `globalThis['x'] = …` (plain `=`; `===`, `!=`, … excluded). */
const RE_GLOBALTHIS =
  /globalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)|globalThis\s*\[\s*(['"])[A-Za-z_$][\w$.-]*\1\s*\]\s*=(?!=)/g;

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Balanced-close search for the opener at `openIndex` in a scrubbed view. */
function matchingParen(code, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True if the import clause imports no runtime values (type-only usage):
 * no default or namespace binding, and every named binding `type`-prefixed
 * (a binding literally named `type` counts as a value binding — the
 * contextual-keyword reading). An empty named clause (`import {} from`)
 * still executes the module: not type-only.
 */
function importClauseIsTypeOnly(typeKw, clause) {
  if (typeKw) return true;
  if (clause.includes('*')) return false; // namespace import: a runtime value
  if (!clause.startsWith('{')) return false; // a default binding (alone or +…): a runtime value
  const inner = clause.slice(1, -1);
  const bindings = inner.split(',').map((b) => b.trim()).filter((b) => b.length > 0);
  if (bindings.length === 0) return false;
  return bindings.every((b) => /^type\s+[\w$]/.test(b));
}

/**
 * Extract all import/export-from/dynamic-import specifiers with line
 * numbers and type-only classification.
 */
export function extractSpecifiers(src) {
  const code = scrubCommentsAndStrings(src);
  const found = [];
  const readStr = (quotePos) => {
    const q = src[quotePos];
    let j = quotePos + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') {
      if (src[j] === '\\') j += 1;
      j += 1;
    }
    return j < src.length && src[j] === q ? src.slice(quotePos + 1, j) : null;
  };

  // import … from 'spec' (all clause forms; comments between tokens ok —
  // the scrubbed view).
  RE_IMPORT_FROM.lastIndex = 0;
  let m;
  while ((m = RE_IMPORT_FROM.exec(code)) !== null) {
    const quotePos = m.index + m[0].length - 1;
    const spec = readStr(quotePos);
    if (spec === null) continue;
    found.push({
      spec,
      kind: 'import',
      line: lineOf(src, m.index),
      typeOnly: importClauseIsTypeOnly(Boolean(m[1]), m[2] ?? ''),
      index: m.index,
    });
  }

  // side-effect import 'spec'.
  RE_SIDE_EFFECT.lastIndex = 0;
  while ((m = RE_SIDE_EFFECT.exec(code)) !== null) {
    const quotePos = m.index + m[0].length - 1;
    const spec = readStr(quotePos);
    if (spec === null) continue;
    found.push({ spec, kind: 'import', line: lineOf(src, m.index), typeOnly: false, index: m.index });
  }

  // export … from 'spec' (export type … is type-only).
  RE_EXPORT_FROM.lastIndex = 0;
  while ((m = RE_EXPORT_FROM.exec(code)) !== null) {
    const quotePos = m.index + m[0].length - 1;
    const spec = readStr(quotePos);
    if (spec === null) continue;
    found.push({
      spec,
      kind: 'export-from',
      line: lineOf(src, m.index),
      typeOnly: Boolean(m[1]),
      index: m.index,
    });
  }

  // dynamic import('spec') — with or without an options argument.
  RE_DYNAMIC_IMPORT.lastIndex = 0;
  while ((m = RE_DYNAMIC_IMPORT.exec(code)) !== null) {
    const quotePos = m.index + m[0].length - 1;
    const spec = readStr(quotePos);
    if (spec === null) continue;
    const open = code.lastIndexOf('(', quotePos - 1);
    if (open === -1 || matchingParen(code, open) === -1) continue; // malformed call
    found.push({ spec, kind: 'dynamic-import', line: lineOf(src, m.index), typeOnly: false, index: m.index });
  }

  found.sort((a, b) => a.index - b.index);
  for (const f of found) delete f.index;
  return found;
}

// --- workspace discovery ----------------------------------------------------

function implementedPackages(root) {
  const dir = join(root, 'packages');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { pkgs: [], stray: [] };
  }
  const pkgs = [];
  const stray = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const pkgDir = join(dir, e.name);
    const pkgJsonPath = join(pkgDir, 'package.json');
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      stray.push(e.name);
      continue;
    }
    pkgs.push({ name: e.name, pkgDir, pkgJson });
  }
  return { pkgs, stray };
}

function tsFiles(pkgDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(pkgDir);
  return out.sort();
}

function splitPackageSpec(spec) {
  const i1 = spec.indexOf('/');
  if (spec.startsWith('@')) {
    // scoped: '@scope/name' — the package name spans through the second '/'
    if (i1 === -1) return { pkgName: spec, subpath: '' };
    const i2 = spec.indexOf('/', i1 + 1);
    if (i2 === -1) return { pkgName: spec, subpath: '' };
    return { pkgName: spec.slice(0, i2), subpath: spec.slice(i2 + 1) };
  }
  if (i1 === -1) return { pkgName: spec, subpath: '' };
  return { pkgName: spec.slice(0, i1), subpath: spec.slice(i1 + 1) };
}

function subpathExported(pkgJson, subpath) {
  const exports = pkgJson.exports;
  if (exports === undefined) return false;
  const key = subpath === '' ? '.' : `./${subpath}`;
  if (typeof exports === 'string') return subpath === '';
  return Object.prototype.hasOwnProperty.call(exports, key);
}

function isInside(p, dir) {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * Declared-dependency rules for one manifest (a package, or the workspace
 * root): unknown units, premature wiring (§2/§5.6), the React declaration
 * scope (§7 — only `editor` may declare react/react-dom + their @types/*),
 * and forbidden web frameworks.
 */
function checkDeclaredManifest(relFile, unitName, pkgJson, pkgsByName, addV) {
  for (const section of DEP_SECTIONS) {
    const deps = pkgJson[section] ?? {};
    for (const name of Object.keys(deps)) {
      if (name.startsWith(WORKSPACE_SCOPE)) {
        const unit = name.slice(WORKSPACE_SCOPE.length);
        if (!UNITS.includes(unit)) {
          addV(
            relFile,
            0,
            'unknown-unit',
            `${section} entry '${name}' is not a dependencies.md §2 unit`,
          );
        } else if (!pkgsByName.has(unit)) {
          addV(
            relFile,
            0,
            'premature-wiring',
            `${section} entry '${name}' references a workspace package that is ` +
              'not implemented yet (dependencies.md §2/§5.6: the lockfile cannot ' +
              'reference a non-existent workspace package)',
          );
        }
      } else if (REACT_DECLARABLE.has(name) && unitName !== 'editor') {
        addV(
          relFile,
          0,
          'react-declared-outside-editor',
          `${section} entry '${name}' — react/react-dom (and their @types/*) may ` +
            'be declared by the editor package only (dependencies.md §7 React ' +
            'scope rules; m1-acceptance.md §2.4)',
        );
      } else if (FORBIDDEN_WEB_FRAMEWORKS.has(splitPackageSpec(name).pkgName)) {
        addV(
          relFile,
          0,
          'forbidden-framework',
          `${section} entry '${name}' — web frameworks are forbidden ` +
            '(dependencies.md §7: node:http only; m1-acceptance.md §2.4)',
        );
      }
    }
  }
}

// --- the check ---------------------------------------------------------------

/**
 * Run the boundary check over one workspace root.
 * Returns { packages, filesScanned, specifiersChecked, violations }.
 * Each violation: { file (root-relative), line, rule, message }.
 */
export function checkWorkspace(root) {
  const violations = [];
  const addV = (file, line, rule, message) =>
    violations.push({ file, line, rule, message });

  const { pkgs, stray } = implementedPackages(root);
  const pkgsByName = new Map(pkgs.map((p) => [p.name, p]));

  for (const s of stray) {
    addV(
      join('packages', s),
      0,
      'stray-packages-dir',
      `directory packages/${s}/ has no package.json — units are created only ` +
        'when implemented with a package.json (dependencies.md §2)',
    );
  }

  // Root manifest declarations (workspace root package.json) — the same
  // declaration rules as the package manifests. The root is never the
  // `editor` package, so any React declaration there fails.
  let rootManifest = null;
  try {
    rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // no root manifest — npm itself cannot operate here; not a boundary
    // violation to report.
  }
  if (rootManifest) {
    const rootName = typeof rootManifest.name === 'string' ? rootManifest.name : '(root)';
    checkDeclaredManifest('package.json', rootName, rootManifest, pkgsByName, addV);
  }

  let filesScanned = 0;
  let specifiersChecked = 0;

  for (const pkg of pkgs) {
    const relPkgJson = join('packages', pkg.name, 'package.json');
    const allowed = NODE_SIDE_ALLOWED[pkg.name];
    if (!allowed) {
      addV(
        relPkgJson,
        0,
        'unknown-unit',
        `unit '${pkg.name}' is not in the dependencies.md §2 unit list`,
      );
      continue;
    }

    // declared dependencies: no premature wiring (§2/§5.6), React scope (§7),
    // no web frameworks.
    checkDeclaredManifest(relPkgJson, pkg.name, pkg.pkgJson, pkgsByName, addV);

    // sources.
    for (const file of tsFiles(pkg.pkgDir)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      const isTestFile = RE_TEST_FILE.test(file);
      filesScanned += 1;

      for (const { spec, kind, line, typeOnly } of extractSpecifiers(src)) {
        specifiersChecked += 1;

        // relative / absolute file imports.
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const abs = resolve(dirname(file), spec);
          if (!isInside(abs, pkg.pkgDir)) {
            addV(
              rel,
              line,
              'cross-package-internal',
              `${kind} '${spec}' escapes '${pkg.name}' — another package's internal ` +
                'files are unreachable; import the target via its exports subpath ' +
                '(dependencies.md §3/§4.3)',
            );
          }
          continue;
        }

        // Node builtins.
        if (spec.startsWith('node:')) {
          const b = spec.slice(5);
          if (!allowed.node.includes(b)) {
            addV(
              rel,
              line,
              'node-builtin-forbidden',
              `'${spec}' — Node builtins are not in '${pkg.name}'s allowed edges ` +
                '(dependencies.md §4.1; runtime is three-free and I/O-free, §4.3)',
            );
          }
          continue;
        }

        const { pkgName, subpath } = splitPackageSpec(spec);
        if (NODE_BUILTINS.has(pkgName)) {
          if (!allowed.node.includes(pkgName)) {
            addV(
              rel,
              line,
              'node-builtin-forbidden',
              `'${spec}' — Node builtins are not in '${pkg.name}'s allowed edges ` +
                '(dependencies.md §4.1; runtime is three-free and I/O-free, §4.3)',
            );
          }
          continue;
        }

        // workspace packages.
        if (pkgName.startsWith(WORKSPACE_SCOPE)) {
          const unit = pkgName.slice(WORKSPACE_SCOPE.length);
          if (!UNITS.includes(unit)) {
            addV(
              rel,
              line,
              'unknown-unit',
              `'${spec}' — '${pkgName}' is not in the dependencies.md §2 unit list`,
            );
            continue;
          }
          const target = pkgsByName.get(unit);
          if (!target) {
            addV(
              rel,
              line,
              'unimplemented-unit',
              `'${spec}' — '${pkgName}' is not implemented yet (dependencies.md §2: ` +
                'units are created only when implemented)',
            );
            continue;
          }
          if (target.pkgJson.exports === undefined) {
            addV(
              rel,
              line,
              'no-exports-map',
              `'${spec}' — '${pkgName}' has no exports map (dependencies.md §3: the ` +
                'public surface is the exports map only)',
            );
            continue;
          }
          if (!subpathExported(target.pkgJson, subpath)) {
            addV(
              rel,
              line,
              'non-exported-subpath',
              `'${spec}' — subpath '${subpath === '' ? '.' : `./${subpath}`}' is not in ` +
                `${pkgName}'s exports map (dependencies.md §3: internal files are ` +
                'unreachable by package name)',
            );
            continue;
          }
          if (unit === pkg.name) continue; // self-reference through own public subpath: internal
          if (!allowed.packages.includes(unit)) {
            addV(
              rel,
              line,
              'forbidden-edge',
              `'${spec}' — '${pkg.name} → ${unit}' is not in the dependencies.md §4.1 ` +
                'allowed node-side edges (forbidden-edge table: §4.3)',
            );
            continue;
          }
          const sub = allowed.subpaths?.[unit];
          if (sub && !sub.includes(subpath)) {
            addV(
              rel,
              line,
              'backend-services-only',
              `'${spec}' — '${pkg.name} may import only the /services subpath of ` +
                '@thirdlight/backend (dependencies.md §3/§4.3)',
            );
          }
          // §4.1 types-only qualifiers: a value import of these edges is an
          // executable import (for editor → commands/project-model this is the
          // second mutation path §4.3 forbids).
          if (allowed.typesOnly?.[unit] && !typeOnly) {
            addV(
              rel,
              line,
              'types-only-edge',
              `'${spec}' — '${pkg.name} → ${unit}' is a types-only edge ` +
                '(dependencies.md §4.1: "types only"); value imports, value ' +
                're-exports, and dynamic import() of it are executable imports ' +
                '— use `import type` / `export type` for the type-only forms ' +
                '(the no-second-mutation-path rule, §4.3)',
            );
          }
          continue;
        }

        // external (non-workspace) packages.
        // Narrow test-tooling policy: the approved test runner in designated
        // test files only (production files fail as forbidden-external below).
        if (isTestFile && pkgName === 'vitest') continue;
        if (FORBIDDEN_WEB_FRAMEWORKS.has(pkgName)) {
          addV(
            rel,
            line,
            'forbidden-framework',
            `'${spec}' — web frameworks are forbidden (dependencies.md §7: ` +
              'node:http only; m1-acceptance.md §2.4)',
          );
          continue;
        }
        if (REACT_EDITOR_ONLY.has(pkgName) && pkg.name !== 'editor') {
          addV(
            rel,
            line,
            'react-outside-editor',
            `'${spec}' — react/react-dom are scoped to the editor package only ` +
              '(dependencies.md §7 React scope rules)',
          );
          continue;
        }
        if (!allowed.external.includes(pkgName)) {
          addV(
            rel,
            line,
            'forbidden-external',
            `'${spec}' — '${pkgName}' is not in '${pkg.name}'s dependencies.md §4.1 ` +
              'allowed edges',
          );
        }
      }

      // no hidden global services (dependencies.md §4.3; m1-acceptance §2.4).
      // Runs on the raw source (a commented-out assignment is flagged for
      // review — the conservative direction for this review rule).
      RE_GLOBALTHIS.lastIndex = 0;
      let gm;
      while ((gm = RE_GLOBALTHIS.exec(src)) !== null) {
        addV(
          rel,
          lineOf(src, gm.index),
          'globalthis-assignment',
          'assignment to globalThis — no hidden global services (dependencies.md ' +
            '§4.3); cross-package state sharing is by injection only — review required',
        );
      }
    }
  }

  return {
    packages: pkgs.map((p) => p.name),
    filesScanned,
    specifiersChecked,
    violations,
  };
}

// --- CLI ---------------------------------------------------------------------

function main() {
  const root = process.cwd();
  const result = checkWorkspace(root);
  if (result.violations.length > 0) {
    console.error(
      `check-boundaries: FAIL — ${result.violations.length} violation(s):`,
    );
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line}: [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }
  if (result.packages.length === 0) {
    console.log(
      'check-boundaries: OK — no implemented packages yet (units appear in ' +
        'packets 05–12, dependencies.md §2); nothing to check.',
    );
  } else {
    console.log(
      `check-boundaries: OK — ${result.packages.length} package(s) [${result.packages.join(', ')}], ` +
        `${result.filesScanned} source file(s), ${result.specifiersChecked} specifier(s) checked; ` +
        'no boundary violations.',
    );
  }
}

// CLI guard — realpath-based, so it also works when the tool is invoked
// through a symlinked or relative path. (The naive
// `pathToFileURL(argv[1]) === import.meta.url` comparison silently skips
// main() for symlinked tool paths — a silent no-op check, the exact
// failure mode dependencies.md §9 forbids.)
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}