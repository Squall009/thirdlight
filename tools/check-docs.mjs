#!/usr/bin/env node
/**
 * Docs check. The status file and the plans' progress tables are read at the
 * start of every session, so they have to stay short and true, or they grow
 * until nobody reads them:
 *
 *   - a row of the phase table in STATUS_FILE, or of a plan's progress table
 *     (the table under a `## N. Progress` heading in docs/plan-phase-*.md), is
 *     at most ROW_CHARS_MAX characters of markdown source (one table row is one
 *     source line; about two lines of the rendered page);
 *   - every `*.md` path a STATUS row names in backticks exists;
 *   - every defect row has a known status, the closed list (AUDIT_CLOSED_FILE)
 *     holds no open or watch row, and a D-number is in one of the two lists once.
 *
 * Rows over the limit today are named in the ratchet list (RATCHET_FILE) by
 * file and row key (the row's first cell; a repeated key gets `#2`, `#3`) with
 * their current length. An entry may only shrink, as in check-size: the check
 * fails when a listed row grows, when a row not on the list is over the limit,
 * when a listed row got shorter than its entry (record it) and when a listed
 * row fits or is gone (drop its entry).
 *
 * Usage: node tools/check-docs.mjs            (check; exit 1 on a violation)
 *        node tools/check-docs.mjs --update   (lower shrunk entries, drop fitting ones; never adds or raises)
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { committedEntries, handEdits, handEditText } from './ratchet-base.mjs';

/** The limit, defined here only: characters (code points) of one table row's markdown line. */
export const ROW_CHARS_MAX = 400;
export const STATUS_FILE = 'docs/STATUS.md';
export const PLANS_DIR = 'docs';
export const PLAN_RE = /^plan-phase-[^/]+\.md$/;
export const AUDIT_OPEN_FILE = 'docs/audit-2026-09-22.md';
export const AUDIT_CLOSED_FILE = 'docs/audit-closed.md';
/** The ratchet list, relative to the workspace root. */
export const RATCHET_FILE = 'tools/docs-ratchet.json';

const OPEN_STATUSES = new Set(['open', 'watch']);
const CLOSED_STATUSES = new Set(['fixed', 'superseded', "won't"]);
const PROGRESS_HEADING_RE = /^##\s+(?:\d+[a-z]?\.\s+)?Progress\b/;
const STATUS_TABLE_HEADER_RE = /^\|\s*Phase\s*\|/;

const length = (line) => [...line].length;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line) => /^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line.trim());

/**
 * The body rows of the table whose header line is at `headerIndex`: `[{ key, line, length }]`. The table ends
 * at the first line that is not a table row. Keys repeat-numbered in order (`#2`, `#3`).
 */
function tableRows(lines, headerIndex) {
  const rows = [];
  const seen = new Map();
  for (let i = headerIndex + 1; i < lines.length && lines[i].trimStart().startsWith('|'); i++) {
    if (isSeparator(lines[i])) continue;
    const first = cells(lines[i])[0];
    const count = (seen.get(first) ?? 0) + 1;
    seen.set(first, count);
    rows.push({ key: count === 1 ? first : `${first}#${count}`, line: lines[i], length: length(lines[i]) });
  }
  return rows;
}

/** The rows of a plan's progress table (the first table after its Progress heading); none if it has none. */
export function progressRows(text) {
  const lines = text.split('\n');
  const heading = lines.findIndex((l) => PROGRESS_HEADING_RE.test(l));
  if (heading < 0) return [];
  for (let i = heading + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i++) {
    if (lines[i].trimStart().startsWith('|')) return tableRows(lines, i);
  }
  return [];
}

/** The rows of the status file's phase table. */
export function statusRows(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => STATUS_TABLE_HEADER_RE.test(l));
  return header < 0 ? [] : tableRows(lines, header);
}

/** The plan files the check reads (relative paths, sorted); `archive/` is history and is not read. */
export function planFiles(root) {
  let names;
  try {
    names = readdirSync(join(root, PLANS_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => PLAN_RE.test(n)).sort().map((n) => `${PLANS_DIR}/${n}`);
}

const read = (root, file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return undefined;
  }
};

/** Every checked row with its length: `[{ file, row, size, line }]`. */
export function measuredRows(root) {
  const out = [];
  const status = read(root, STATUS_FILE);
  if (status !== undefined) for (const r of statusRows(status)) out.push({ file: STATUS_FILE, row: r.key, size: r.length, line: r.line });
  for (const file of planFiles(root)) {
    for (const r of progressRows(read(root, file))) out.push({ file, row: r.key, size: r.length, line: r.line });
  }
  return out;
}

/** Rows over the limit: `[{ file, row, size }]`. */
export function longRows(root) {
  return measuredRows(root)
    .filter((r) => r.size > ROW_CHARS_MAX)
    .map(({ file, row, size }) => ({ file, row, size }));
}

const keyOf = (e) => `${e.file}\u0000${e.row}`;

/**
 * The long rows against the ratchet entries (`[{ file, row, size }]`): every violation as
 * `{ entry, problem: 'new' | 'grew' | 'shrank' | 'stale' | 'added' | 'raised', size? }`, and the entries as
 * they should read after an update (shrunk ones lowered, stale ones dropped, nothing added). `committed`:
 * the list as HEAD has it (null: no comparison), so an entry added or raised by hand fails.
 */
export function compareRatchet(found, entries, committed = null) {
  const byKey = new Map(found.map((e) => [keyOf(e), e]));
  const hand = new Map(handEdits(entries, committed, keyOf).map((h) => [keyOf(h.entry), h]));
  const listed = new Set();
  const problems = [];
  const updated = [];
  for (let entry of entries) {
    const key = keyOf(entry);
    const edit = hand.get(key);
    if (edit !== undefined) problems.push(edit);
    if (edit?.problem === 'added') continue;
    if (edit?.problem === 'raised') entry = { ...entry, size: edit.size };
    listed.add(key);
    const now = byKey.get(key);
    if (!now) {
      problems.push({ entry, problem: 'stale' });
      continue;
    }
    if (now.size > entry.size) problems.push({ entry, problem: 'grew', size: now.size });
    else if (now.size < entry.size) problems.push({ entry, problem: 'shrank', size: now.size });
    updated.push({ ...entry, size: Math.min(entry.size, now.size) });
  }
  for (const e of found) {
    if (!listed.has(keyOf(e))) problems.push({ entry: e, problem: 'new', size: e.size });
  }
  return { problems, updated };
}

/** STATUS rows naming a `*.md` path that does not exist: `[{ row, path }]`. */
export function missingLinks(root) {
  const status = read(root, STATUS_FILE);
  if (status === undefined) return [];
  const out = [];
  for (const r of statusRows(status)) {
    for (const m of r.line.matchAll(/`([^`\s]+\.md)`/g)) {
      if (!existsSync(join(root, m[1]))) out.push({ row: r.key, path: m[1] });
    }
  }
  return out;
}

/** The D-rows of a defect list: `[{ id, status }]`, status being the third cell's first word. */
export function defectRows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(D\d+)\s*\|/.exec(line);
    if (!m) continue;
    const status = (cells(line)[2] ?? '').split(/[\s:(`]/)[0];
    out.push({ id: m[1], status: status.toLowerCase() });
  }
  return out;
}

/**
 * Defect rows in the wrong list, with an unknown status, or listed twice: `[text]`. A row closed in the open
 * list may wait there for the next tidy (at the latest the phase end), so only the closed list's side is held:
 * it never carries an open or watch row.
 */
export function defectProblems(root) {
  const problems = [];
  const seen = new Map();
  for (const file of [AUDIT_OPEN_FILE, AUDIT_CLOSED_FILE]) {
    const text = read(root, file);
    if (text === undefined) continue;
    for (const { id, status } of defectRows(text)) {
      if (seen.has(id)) problems.push(`${id} is listed twice (${seen.get(id)} and ${file}); a D-number is never reused`);
      seen.set(id, file);
      if (!OPEN_STATUSES.has(status) && !CLOSED_STATUSES.has(status)) {
        problems.push(`${file}: ${id} has status '${status}'; a status is open, watch, fixed, superseded or won't fix`);
      } else if (file === AUDIT_CLOSED_FILE && OPEN_STATUSES.has(status)) {
        problems.push(`${file}: ${id} has status '${status}'; an open or watch row belongs in ${AUDIT_OPEN_FILE}`);
      }
    }
  }
  return problems;
}

/** One ratchet violation as a line of the check's output. */
export function problemText({ entry, problem, size }) {
  const where = `${entry.file} row '${entry.row}'`;
  switch (problem) {
    case 'added':
    case 'raised':
      return handEditText(where, { problem, size }, RATCHET_FILE);
    case 'new':
      return `${where}: ${size} characters, over the limit of ${ROW_CHARS_MAX}; shorten it (details go in the plan's decision log or results)`;
    case 'grew':
      return `${where}: grew to ${size} characters (the ratchet list allows ${entry.size}); shorten it, never raise the entry`;
    case 'shrank':
      return `${where}: shrank to ${size} characters (listed at ${entry.size}); record it: node tools/check-docs.mjs --update`;
    default:
      return `${where}: fits the limit of ${ROW_CHARS_MAX} now or is gone; drop its entry: node tools/check-docs.mjs --update`;
  }
}

/** Reads the ratchet list under `root` (an absent file is an empty list). */
export function readRatchet(root) {
  const text = read(root, RATCHET_FILE);
  return text === undefined ? [] : JSON.parse(text).entries;
}

/** Writes the ratchet list: one entry per line, sorted, so a change to it reads as a one-line diff. */
export function writeRatchet(root, entries) {
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.row.localeCompare(b.row, 'en', { numeric: true }));
  const lines = sorted.map((e) => `    ${JSON.stringify({ file: e.file, row: e.row, size: e.size })}`);
  writeFileSync(join(root, RATCHET_FILE), `{\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`);
}

/** The check over a workspace root: `{ rows, found, problems, updated, links, defects }`. */
export function checkDocs(root) {
  const rows = measuredRows(root).length;
  const found = longRows(root);
  const { problems, updated } = compareRatchet(found, readRatchet(root), committedEntries(root, RATCHET_FILE));
  return { rows, found, problems, updated, links: missingLinks(root), defects: defectProblems(root) };
}

function main(argv) {
  const root = process.cwd();
  const { rows, found, problems, updated, links, defects } = checkDocs(root);
  const other = [
    ...links.map((l) => `${STATUS_FILE} row '${l.row}' names ${l.path}, which does not exist`),
    ...defects,
  ];
  if (argv.includes('--update')) {
    writeRatchet(root, updated);
    const left = [...problems.filter((p) => p.problem === 'new' || p.problem === 'grew').map(problemText), ...other];
    for (const p of left) console.error(`check-docs: ${p}`);
    console.log(`check-docs: ${RATCHET_FILE} updated (${updated.length} entries)`);
    return left.length > 0 ? 1 : 0;
  }
  const all = [...problems.map(problemText), ...other];
  if (all.length > 0) {
    for (const p of all) console.error(`check-docs: ${p}`);
    console.error(
      `check-docs: FAIL — ${all.length} problem(s). A STATUS row or plan progress row is at most ${ROW_CHARS_MAX} characters; ` +
        `${RATCHET_FILE} lists today's longer rows, and an entry may only shrink.`,
    );
    return 1;
  }
  console.log(`check-docs: OK — ${rows} row(s), ${found.length} over the limit, each within its ratchet entry; links and defect lists consistent.`);
  return 0;
}

// Realpath-based, so a symlinked or relative tool path still runs the check.
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));
