#!/usr/bin/env node
/**
 * Thirdlight boundary check 1 — static import graph (dependencies.md §5 check 1).
 *
 * Scans the .ts/.tsx sources of every implemented workspace package
 * (packages/<name>/package.json) and checks every
 * `import` / `export … from` / dynamic `import()` specifier against the
 * normative edge rules:
 *
 *   dependencies.md §4.1   node-side allowed import edges (exact table)
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
 *                          not-yet-implemented workspace package
 *   dependencies.md §7     React is scoped to `editor` only; the forbidden
 *                          web-framework list (m1-acceptance.md §2.4) applies
 *                          to imports and to declared dependencies
 *   dependencies.md §4.3   no hidden global services — `globalThis`
 *                          assignments are flagged for review
 *                          (m1-acceptance.md §2.4)
 *
 * Plain Node, no new dependency. Any violation ⇒ non-zero exit, each listed
 * as `file:line: [rule] message`.
 *
 * Static-scan bounds (recorded in handoff 04): specifiers are extracted by
 * pattern from `import` / `export … from` / dynamic `import()` — `require()`
 * and `import = require()` are NOT scanned; import-like text inside comments
 * or string literals may be reported (false positive, not false negative for
 * the three normative forms); `exports` subpath pattern syntax (`./x/*`) is
 * not matched (M1 exports maps are flat tables — dependencies.md §3).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * dependencies.md §3/§4.3).
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
  protocol: { packages: ['project-model', 'commands'], external: [], node: [] },
  backend: {
    packages: ['protocol', 'workspace', 'exporter', 'project-model'],
    external: ['ws'],
    node: ['http', 'fs', 'path', 'crypto'],
  },
  exporter: {
    packages: ['project-model', 'protocol', 'workspace'],
    external: ['esbuild'],
    node: [],
  },
  'mcp-adapter': {
    packages: ['protocol', 'backend'],
    external: ['@modelcontextprotocol/sdk'],
    node: [],
    subpaths: { backend: ['services'] },
  },
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

// --- specifier extraction -------------------------------------------------

// import … from 'spec' (default/named/namespace, `import type`, multi-line)
const MIDDLE =
  '(?:\\{[^}]*\\}|[\\w$]+\\s*,\\s*(?:type\\s+)?\\{[^}]*\\}|(?:type\\s+)?[\\w$]+|\\*\\s+as\\s+[\\w$]+)?';
const RE_IMPORT_FROM = new RegExp(
  String.raw`\bimport\s+(?:type\s+)?${MIDDLE}\s*from\s*(['"])([^'"\n]+)\1`,
  'g',
);
const RE_SIDE_EFFECT = /\bimport\s*(['"])([^'"\n]+)\1/g;
const RE_EXPORT_FROM =
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*(['"])([^'"\n]+)\1/g;
const RE_DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/** `globalThis.x = …` / `globalThis['x'] = …` (plain `=`; `===`, `!=`, … excluded). */
const RE_GLOBALTHIS =
  /globalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)|globalThis\s*\[\s*(['"])[A-Za-z_$][\w$.-]*\1\s*\]\s*=(?!=)/g;

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Extract all import/export-from/dynamic-import specifiers with line numbers. */
export function extractSpecifiers(src) {
  const found = [];
  const add = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({ spec: m[2], kind, line: lineOf(src, m.index), index: m.index });
    }
  };
  add(RE_IMPORT_FROM, 'import');
  add(RE_SIDE_EFFECT, 'import');
  add(RE_EXPORT_FROM, 'export-from');
  add(RE_DYNAMIC_IMPORT, 'dynamic-import');
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

    // declared dependencies: no premature wiring (§2/§5.6), no web frameworks.
    const depSections = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ];
    for (const section of depSections) {
      const deps = pkg.pkgJson[section] ?? {};
      for (const name of Object.keys(deps)) {
        if (name.startsWith(WORKSPACE_SCOPE)) {
          const unit = name.slice(WORKSPACE_SCOPE.length);
          if (!UNITS.includes(unit)) {
            addV(
              relPkgJson,
              0,
              'unknown-unit',
              `${section} entry '${name}' is not a dependencies.md §2 unit`,
            );
          } else if (!pkgsByName.has(unit)) {
            addV(
              relPkgJson,
              0,
              'premature-wiring',
              `${section} entry '${name}' references a workspace package that is ` +
                'not implemented yet (dependencies.md §2/§5.6: the lockfile cannot ' +
                'reference a non-existent workspace package)',
            );
          }
        } else if (FORBIDDEN_WEB_FRAMEWORKS.has(splitPackageSpec(name).pkgName)) {
          addV(
            relPkgJson,
            0,
            'forbidden-framework',
            `${section} entry '${name}' — web frameworks are forbidden ` +
              '(dependencies.md §7: node:http only; m1-acceptance.md §2.4)',
          );
        }
      }
    }

    // sources.
    for (const file of tsFiles(pkg.pkgDir)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      filesScanned += 1;

      for (const { spec, kind, line } of extractSpecifiers(src)) {
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
          continue;
        }

        // external (non-workspace) packages.
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}