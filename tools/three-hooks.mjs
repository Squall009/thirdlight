#!/usr/bin/env node
/**
 * Every place the engine reaches into three.js's private or undocumented
 * members, and the upgrade checklist row that covers it.
 *
 * A three upgrade is only safe if each such hook is checked against the new
 * release, and the checklist is what an upgrade reads. Hooks are found by
 * shape, not by a list kept by hand, so a new one shows up here (and fails
 * tools/three-hooks.test.mjs) until docs/three-upgrade-checklist.md names its
 * file and the member it uses in one table row:
 * - a patched prototype method (`proto.setupObserver = …`, `X.prototype.y = …`);
 * - an instance method replaced on a three object (`renderer.renderObject =`,
 *   `node.updateBefore =`, `node.setSize =`) or `setRenderObjectFunction`;
 * - `renderer.library.addLight` (three's light-node registry);
 * - an `_`-prefixed member (three's private fields; the engine's own markers
 *   start with `_tl`);
 * - a node builder's members (`builder.context`, `builder.geometry`, …),
 *   which TSL leaves undocumented.
 *
 * `node tools/three-hooks.mjs` prints every site with its file:line and
 * whether the checklist covers it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const CHECKLIST = join(ROOT, 'docs', 'three-upgrade-checklist.md');

/** [pattern, the member it names]. Every pattern is global; one line can hold several sites. */
const RULES = [
  [/(?:\bproto|\.prototype)\.(\w+)\s*=(?!=)/g, (m) => m[1]],
  [/\b(setupObserver|setRenderObjectFunction)\b/g, (m) => m[1]],
  [/\.(renderObject|updateBefore|setSize)\s*=(?!=)/g, (m) => m[1]],
  [/\blibrary\.addLight\b/g, () => 'library.addLight'],
  [/\?*\.(_[a-zA-Z]\w*)/g, (m) => m[1]],
  [/['"](_[a-zA-Z]\w*)['"]|\b(_listeners)\s*:/g, (m) => m[1] ?? m[2]],
  [/(?<![.\w])builder\??\.(\w+)/g, (m) => `builder.${m[1]}`],
  [/\(builder as [^\n]*?[}\w]\s*\)\??\.(\w+)/g, (m) => `builder.${m[1]}`],
];

/** The engine's own `_` markers, not three's. */
const OWN = /^_tl/;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The renderer package, and any other package source that imports three. */
function scannedFiles() {
  const packages = join(ROOT, 'packages');
  return readdirSync(packages).flatMap((pkg) => {
    const src = join(packages, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) return [];
    } catch {
      return [];
    }
    const files = sourceFiles(src);
    return pkg === 'three-adapter' ? files : files.filter((f) => /from 'three[/']/.test(readFileSync(f, 'utf8')));
  });
}

/** Every hook site: `{ file, line, member }` (file relative to the repo root). */
export function hookSites() {
  const sites = [];
  for (const path of scannedFiles()) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const seen = new Set();
    lines.forEach((text, i) => {
      const t = text.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      const code = text.replace(/\s\/\/ .*$/, '');
      for (const [re, name] of RULES) {
        for (const m of code.matchAll(re)) {
          const member = name(m);
          if (member === undefined || OWN.test(member)) continue;
          const key = `${i}:${member}`;
          if (seen.has(key)) continue;
          seen.add(key);
          sites.push({ file: relative(ROOT, path), line: i + 1, member });
        }
      }
    });
  }
  return sites;
}

/** The checklist's table rows. */
export function checklistRows(text = readFileSync(CHECKLIST, 'utf8')) {
  return text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Hook') && !l.startsWith('|---'));
}

/** Whether one row names the site's file and its member. */
export function covers(row, site) {
  return row.includes(basename(site.file)) && row.includes(site.member);
}

/** The sites no checklist row covers. */
export function uncovered(sites = hookSites(), rows = checklistRows()) {
  return sites.filter((s) => !rows.some((r) => covers(r, s)));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = checklistRows();
  const sites = hookSites();
  for (const s of sites) console.log(`${rows.some((r) => covers(r, s)) ? 'ok     ' : 'MISSING'} ${s.file}:${s.line} ${s.member}`);
  const missing = uncovered(sites, rows).length;
  console.log(`${sites.length} hook sites, ${missing} not in ${relative(ROOT, CHECKLIST)}`);
  process.exitCode = missing === 0 ? 0 : 1;
}
