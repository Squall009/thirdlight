#!/usr/bin/env node
/**
 * The gate's e2e areas (tools/gate-areas.json): which e2e files a change runs.
 *
 *   node tools/check-gate-areas.mjs                 the check (npm run build): every e2e file sits in an area,
 *                                                   every file an area names exists, `core` is there, and every
 *                                                   package source file reaches an area or `everyArea`
 *   node tools/check-gate-areas.mjs --for <files…>  the areas the changed files reach, one a line (every area for
 *                                                   a file in `everyArea`, or a package source in no area)
 *   node tools/check-gate-areas.mjs --e2e <areas…>  the e2e files of those areas, one a line (an unknown area fails)
 *   node tools/check-gate-areas.mjs --sources       every package source file and the areas it reaches
 *   node tools/check-gate-areas.mjs --names         every area's name
 *   node tools/check-gate-areas.mjs --times <log> [areas…]  test time by area from a Playwright list log (a
 *                                                   file in two areas counts in both; only the areas named, if any)
 *
 * The map is checked so it cannot rot: an e2e file in no area would never run outside a full gate, and a source
 * file in no area would change the product with only the core smoke watching (a project-model setting once turned
 * a renderer feature on for every scene that way and no area's test ran).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E = 'tests/e2e';
const { areas, everyArea = [] } = JSON.parse(readFileSync(join(ROOT, 'tools/gate-areas.json'), 'utf8'));

/** A source glob as a regular expression: `**` crosses folders, `*` stays inside one. */
function areaGlobRegExp(glob) {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

const e2ePath = (name) => `${E2E}/${name}.e2e.ts`;
const everyAreaRes = everyArea.map(areaGlobRegExp);
const areaRes = Object.entries(areas).map(([name, area]) => ({
  name,
  inc: (area.sources ?? []).map(areaGlobRegExp),
  exc: (area.exclude ?? []).map(areaGlobRegExp),
}));
const inArea = (a, f) => a.inc.some((r) => r.test(f)) && !a.exc.some((r) => r.test(f));
/** A package's own source: what the product is built from (its tests run by `vitest related` instead). */
const isPackageSource = (f) => /^packages\/[^/]+\/src\//.test(f) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const reachesEveryArea = (f) => everyAreaRes.some((r) => r.test(f));
const unmapped = (f) => isPackageSource(f) && !reachesEveryArea(f) && !areaRes.some((a) => inArea(a, f));

function areasFor(files) {
  // A file every part reads, or a source the map missed (the build check fails it, but a gate never runs narrower
  // than the change): every area.
  if (files.some((f) => reachesEveryArea(f) || unmapped(f))) return Object.keys(areas);
  return areaRes.filter((a) => files.some((f) => inArea(a, f))).map((a) => a.name);
}

/** Every file under a folder, as a path from the repository root. */
function walk(dir, out = []) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); } else out.push(p);
  }
  return out;
}
const packageSources = () =>
  readdirSync(join(ROOT, 'packages')).filter((p) => existsSync(join(ROOT, 'packages', p, 'src'))).flatMap((p) => walk(`packages/${p}/src`)).filter(isPackageSource);

function e2eOf(names) {
  const out = new Set();
  for (const n of names) {
    if (areas[n] === undefined) {
      console.error(`gate areas: no area '${n}' (areas: ${Object.keys(areas).join(', ')})`);
      process.exit(2);
    }
    for (const f of areas[n].e2e) out.add(e2ePath(f));
  }
  return [...out];
}

function check() {
  const problems = [];
  if (areas.core === undefined) problems.push('no `core` area (the smoke every fast gate runs)');
  const placed = new Set();
  for (const [name, area] of Object.entries(areas)) {
    for (const f of area.e2e) {
      if (!existsSync(join(ROOT, e2ePath(f)))) problems.push(`${name}: ${e2ePath(f)} does not exist`);
      placed.add(f);
    }
  }
  const files = readdirSync(join(ROOT, E2E)).filter((f) => f.endsWith('.e2e.ts')).map((f) => f.slice(0, -'.e2e.ts'.length));
  for (const f of files) if (!placed.has(f)) problems.push(`${e2ePath(f)} is in no area of tools/gate-areas.json`);
  const sources = packageSources();
  for (const f of sources) if (unmapped(f)) problems.push(`${f} reaches no area of tools/gate-areas.json (add it to an area's sources, or to everyArea)`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`gate areas: ${p}`);
    process.exit(1);
  }
  console.log(`gate areas: ${files.length} e2e files in ${Object.keys(areas).length} areas, ${sources.length} package sources mapped`);
}

/** Seconds of a Playwright list reporter's duration: `(850ms)`, `(14.4s)`, `(1.2m)`. */
const durationS = (n, unit) => Number(n) * (unit === 'ms' ? 0.001 : unit === 'm' ? 60 : 1);

function times(log, only) {
  const perFile = new Map();
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const m = /› tests\/e2e\/([^/:]+)\.e2e\.ts:\d+:\d+ › .*\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/.exec(line);
    if (m !== null) perFile.set(m[1], (perFile.get(m[1]) ?? 0) + durationS(m[2], m[3]));
  }
  const out = [];
  for (const [name, area] of Object.entries(areas)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const s = area.e2e.reduce((t, f) => t + (perFile.get(f) ?? 0), 0);
    if (s > 0) out.push(`${name} ${Math.round(s)} s`);
  }
  console.log(out.join(', '));
}

const [flag, ...rest] = process.argv.slice(2);
if (flag === undefined) check();
else if (flag === '--for') for (const a of areasFor(rest)) console.log(a);
else if (flag === '--e2e') for (const f of e2eOf(rest)) console.log(f);
else if (flag === '--sources') for (const f of packageSources()) console.log(`${f}\t${reachesEveryArea(f) ? 'every area' : areasFor([f]).join(' ')}`);
else if (flag === '--names') for (const n of Object.keys(areas)) console.log(n);
else if (flag === '--times' && rest[0] !== undefined) times(rest[0], rest.slice(1));
else {
  console.error('usage: node tools/check-gate-areas.mjs [--for <files…> | --sources | --e2e <areas…> | --names | --times <log> [areas…]]');
  process.exit(2);
}
