#!/usr/bin/env node
/**
 * The gate's e2e areas (tools/gate-areas.json): which e2e files a change runs.
 *
 *   node tools/check-gate-areas.mjs                 the check (npm run build): every e2e file sits in an area,
 *                                                   every file an area names exists, `core` is there
 *   node tools/check-gate-areas.mjs --for <files…>  the areas the changed files reach, one a line
 *   node tools/check-gate-areas.mjs --e2e <areas…>  the e2e files of those areas, one a line (an unknown area fails)
 *   node tools/check-gate-areas.mjs --names         every area's name
 *   node tools/check-gate-areas.mjs --times <log> [areas…]  test time by area from a Playwright list log (a
 *                                                   file in two areas counts in both; only the areas named, if any)
 *
 * The map is checked so it cannot rot: an e2e file in no area would never run outside a full gate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E = 'tests/e2e';
const { areas } = JSON.parse(readFileSync(join(ROOT, 'tools/gate-areas.json'), 'utf8'));

/** A source glob as a regular expression: `**` crosses folders, `*` stays inside one. */
function areaGlobRegExp(glob) {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

const e2ePath = (name) => `${E2E}/${name}.e2e.ts`;

function areasFor(files) {
  const out = [];
  for (const [name, area] of Object.entries(areas)) {
    const inc = (area.sources ?? []).map(areaGlobRegExp);
    const exc = (area.exclude ?? []).map(areaGlobRegExp);
    if (files.some((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)))) out.push(name);
  }
  return out;
}

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
  if (problems.length > 0) {
    for (const p of problems) console.error(`gate areas: ${p}`);
    process.exit(1);
  }
  console.log(`gate areas: ${files.length} e2e files in ${Object.keys(areas).length} areas`);
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
else if (flag === '--names') for (const n of Object.keys(areas)) console.log(n);
else if (flag === '--times' && rest[0] !== undefined) times(rest[0], rest.slice(1));
else {
  console.error('usage: node tools/check-gate-areas.mjs [--for <files…> | --e2e <areas…> | --names | --times <log> [areas…]]');
  process.exit(2);
}
