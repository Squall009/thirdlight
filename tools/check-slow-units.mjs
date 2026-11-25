#!/usr/bin/env node
/**
 * The slow unit list (tests/slow-unit-files.json): the unit test files
 * `tools/gate.sh check` leaves out so the check stays short; `tools/gate.sh
 * phase` runs them with the rest. vitest.config.mts reads the same list
 * through `slowUnitFiles()`, so the list is defined once.
 *
 *   node tools/check-slow-units.mjs     the check (npm run build): every entry
 *                                       names a unit test file that exists,
 *                                       once. A stale entry would silently
 *                                       drop nothing from the check while
 *                                       claiming to, and a renamed slow file
 *                                       would slip back into it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SLOW_UNIT_LIST = 'tests/slow-unit-files.json';
/** vitest's default test file names (the root config keeps its default include). */
const UNIT_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The listed paths, repository-relative. */
export function slowUnitFiles(root = ROOT) {
  const list = JSON.parse(readFileSync(join(root, SLOW_UNIT_LIST), 'utf8'));
  return list.files.map((f) => f.path);
}

/** What is wrong with the list (empty: nothing). */
export function slowUnitProblems(root = ROOT) {
  const out = [];
  let paths;
  try {
    paths = slowUnitFiles(root);
  } catch (e) {
    return [`${SLOW_UNIT_LIST}: ${e instanceof Error ? e.message : String(e)}`];
  }
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') { out.push(`${SLOW_UNIT_LIST}: an entry without a path`); continue; }
    if (seen.has(p)) out.push(`${SLOW_UNIT_LIST}: ${p} is listed twice`);
    seen.add(p);
    if (!UNIT_FILE.test(p)) out.push(`${SLOW_UNIT_LIST}: ${p} is not a unit test file name`);
    else if (p.startsWith('archive/')) out.push(`${SLOW_UNIT_LIST}: ${p} is archived (vitest never runs it): take it off the list`);
    else if (!existsSync(join(root, p))) out.push(`${SLOW_UNIT_LIST}: ${p} does not exist: take it off the list (or fix its path)`);
  }
  return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = slowUnitProblems();
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(`check-slow-units: ${slowUnitFiles().length} slow unit files listed, all present`);
}
