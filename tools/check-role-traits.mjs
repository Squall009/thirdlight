#!/usr/bin/env node
/**
 * Voxel roles are asked, never compared: what a role does is one row of the
 * role traits table (`packages/voxel/src/role-traits.ts`), and a consumer
 * that compares a role id itself has to be found and changed by hand when a
 * role is added. This check refuses, in the packages' sources:
 *
 * - a role id used to decide something: `VOXEL_ROLE.<name>` (or an alias of
 *   `VOXEL_ROLE`) beside a comparison, as a `case`, in a list or as an
 *   index, handed to a call that is not a write, or kept in a variable;
 * - a role compared with a number (`role === 2`, `valueRole(v) !== 9`,
 *   `switch (role)`, and `role == 2u` in shader text) in a file that reads
 *   voxels.
 *
 * Writing a role is fine anywhere (`role: VOXEL_ROLE.wall`, `out.role[i] =
 * VOXEL_ROLE.air`, `recordValue(m, VOXEL_ROLE.terrain, …)`): a generator or
 * a tool says which role it makes.
 *
 * A file that holds a role's own behaviour may name that role: OWNERS lists
 * each with the roles it names and why. An entry no longer needed fails the
 * check, so the list only shrinks unless a role gains a file of its own.
 *
 *   node tools/check-role-traits.mjs          the check (npm run build)
 *   node tools/check-role-traits.mjs <root>   the same over another checkout (the check's own test)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The table and the record's role ids: the two files every role is defined in. */
const EVERY_ROLE = '*';

/**
 * Files that may name roles, each with the roles (or {@link EVERY_ROLE}) and
 * the reason: the role's own behaviour lives there.
 */
export const OWNERS = [
  { file: 'packages/voxel/src/record.ts', roles: EVERY_ROLE, why: 'the format\'s constants: the role ids, the count of assigned roles, the air record' },
  { file: 'packages/voxel/src/role-traits.ts', roles: EVERY_ROLE, why: 'the table itself' },
  { file: 'packages/voxel/src/roof-words.ts', roles: ['roof'], why: 'the roof\'s own form: which cells are read as roof words and drawn as planes (isRoofRole, asked by the mips, the far faces and the kit rules)' },
  { file: 'packages/voxel/src/voxel-mips.ts', roles: ['roof'], why: 'a sloped roof is laid again as a one-cell stair at each coarser level: it counts the roof cells under a parent' },
  { file: 'packages/voxel/src/kit-cases.ts', roles: ['wall', 'floor', 'roof', 'foundation', 'stair', 'pillar'], why: 'the case vocabulary: a symbol set a construction role, by name, as the role spec\'s cases are written' },
  { file: 'packages/voxel/src/kit-case-catalogue.ts', roles: ['roof'], why: 'the case catalogue: the roof\'s edge cases are listed apart from the shared ones' },
  { file: 'packages/voxel/src/edge-cases.ts', roles: ['wall', 'floor', 'roof', 'foundation', 'stair', 'pillar'], why: 'which construction role dresses a shared edge first (the role spec\'s piece order)' },
  { file: 'packages/voxel/src/structures/building.ts', roles: ['wall', 'floor', 'roof', 'foundation', 'stair', 'opening'], why: 'the building generator: each part of a building is written in its role' },
  { file: 'packages/voxel/src/water/level-fill.ts', roles: ['liquid'], why: 'the liquid part: the fill writes liquid and reads its own cells back' },
  { file: 'packages/voxel/src/water/body.ts', roles: ['liquid'], why: 'the liquid part: a water body owns the liquid cells it wrote' },
];

/** Calls a role may be handed to: they write it into a value. */
const WRITE_CALLS = new Set(['recordValue', 'voxel']);
/** Calls that ask whether a role is one of some: a comparison. */
const MEMBER_CALLS = new Set(['includes', 'indexOf', 'lastIndexOf', 'has']);
const COMPARE = ['===', '!==', '==', '!=', '<=', '>=', '<', '>'];

/** `text` with comments blanked (same length, line breaks kept); strings and templates stay, so shader text is read. */
export function withoutComments(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (quote !== null) {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c;
      i++;
    } else if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (out[i] !== '\n') out[i] = ' ';
    } else i++;
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The innermost bracket still open at `index` (looking back a statement's worth): its character and the word before it. */
function enclosing(text, index) {
  let depth = 0;
  for (let i = index - 1; i >= Math.max(0, index - 600); i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) depth--;
      else return { open: c, callee: /([\w$]+)\s*$/.exec(text.slice(Math.max(0, i - 60), i))?.[1] ?? '', before: text.slice(Math.max(0, i - 60), i) };
    } else if (c === ';' && depth === 0) break;
  }
  return { open: '', callee: '', before: '' };
}

/** Why a role named at `index` (length `len`) decides something rather than being written, or null. */
function decides(text, index, len) {
  const after = text.slice(index + len).trimStart();
  const before = text.slice(Math.max(0, index - 200), index).trimEnd();
  const op = COMPARE.find((o) => after.startsWith(o) && !after.startsWith('=>'));
  if (op !== undefined) return `compared (${op})`;
  const prev = COMPARE.find((o) => before.endsWith(o) && !before.endsWith('=>'));
  if (prev !== undefined) return `compared (${prev})`;
  if (/\bcase$/.test(before)) return 'a switch case';
  if (/\b(const|let|var)\s+[\w$]+(\s*:\s*[\w$<>[\] |]+)?\s*=$/.test(before)) return 'kept in a variable (an alias hides the comparison it is for)';
  const inside = enclosing(text, index);
  if (inside.open === '[') return /[\w$\])]\s*$/.test(inside.before) ? 'used as an index' : 'listed (a list of roles is a comparison: ask the table)';
  if (inside.open === '(' && MEMBER_CALLS.has(inside.callee)) return `asked of a list (${inside.callee})`;
  if (inside.open === '(' && inside.callee !== '' && !WRITE_CALLS.has(inside.callee) && !/\b(if|while|for|return|switch)$/.test(inside.callee) && /^[,)]/.test(after) && /[(,]$/.test(before)) return `handed to ${inside.callee}() (not a call that writes a role)`;
  return null;
}

/** Whether a file reads voxel records (the number rule applies there only: other code has roles of its own). */
function readsVoxels(file, text) {
  return file.startsWith('packages/voxel/src/') || /@thirdlight\/voxel|\bvalueRole\b|\bVOXEL_ROLE\b|\bVoxelRecord\b/.test(text);
}

/** A role (`role`, `x.role`, `roles[i]`, `valueRole(v)`) against a number, either way round, or switched on. */
const NUMBER_RULES = [
  [/(?<![\w$])(?:[\w$]+(?:\[[^\]\n]*\])?!?\??\.)*(?:roles?|[\w$]*Role)(?:\[[^\]\n]*\]|\([^()\n]*\))?!?\s*(===|!==|==|!=)\s*\d+u?\b/g, 'a role compared with a number'],
  [/\b\d+u?\s*(===|!==|==|!=)\s*(?:[\w$]+(?:\[[^\]\n]*\])?!?\??\.)*(?:roles?|[\w$]*Role)\b(?:\[[^\]\n]*\]|\([^()\n]*\))?/g, 'a role compared with a number'],
  [/\bswitch\s*\(\s*(?:[\w$]+(?:\[[^\]\n]*\])?!?\??\.)*(?:roles?|[\w$]*Role)(?:\[[^\]\n]*\]|\([^()\n]*\))?!?\s*\)/g, 'a switch on a role'],
];

/**
 * The role comparisons in one file's text: `{ line, role, what }` each
 * (`role` null for a comparison with a number).
 */
export function roleComparisons(file, source) {
  const text = withoutComments(source);
  const out = [];
  const names = ['VOXEL_ROLE'];
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*VOXEL_ROLE\s*;/g)) names.push(m[1]);
  const named = new RegExp(`(?<![\\w$.])(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\.([a-z]\\w*)`, 'g');
  for (const m of text.matchAll(named)) {
    const what = decides(text, m.index, m[0].length);
    if (what !== null) out.push({ line: lineOf(text, m.index), role: m[1], what });
  }
  if (readsVoxels(file, text)) {
    for (const [rule, what] of NUMBER_RULES) for (const m of text.matchAll(rule)) out.push({ line: lineOf(text, m.index), role: null, what: `${what}: ${m[0].trim()}` });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Source files of the packages, repository-relative: no tests, no declarations. */
export function sourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') walk(path);
      } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$|\.generated\./.test(name)) out.push(relative(root, path).split('\\').join('/'));
    }
  };
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return out;
  for (const p of readdirSync(packages).sort()) if (existsSync(join(packages, p, 'src'))) walk(join(packages, p, 'src'));
  return out;
}

/**
 * What is wrong (empty: nothing): each comparison outside the owners, and
 * each owner entry that no longer covers anything.
 */
export function roleTraitProblems(root = ROOT, owners = OWNERS) {
  const problems = [];
  const used = new Map(owners.map((o) => [o.file, new Set()]));
  for (const file of sourceFiles(root)) {
    const owner = owners.find((o) => o.file === file);
    for (const c of roleComparisons(file, readFileSync(join(root, file), 'utf8'))) {
      if (owner !== undefined && (owner.roles === EVERY_ROLE || (c.role !== null && owner.roles.includes(c.role)))) {
        used.get(file).add(c.role ?? EVERY_ROLE);
        continue;
      }
      const which = c.role === null ? c.what : `VOXEL_ROLE.${c.role} ${c.what}`;
      problems.push(`${file}:${c.line}: ${which}. Ask the role traits table (packages/voxel/src/role-traits.ts: a predicate, or a column a new question needs)${owner !== undefined ? `; this file owns only ${owner.roles.join(', ')}` : ''}.`);
    }
  }
  for (const o of owners) {
    if (!existsSync(join(root, o.file))) problems.push(`tools/check-role-traits.mjs: owner ${o.file} does not exist: take its entry out`);
    else if (o.roles !== EVERY_ROLE) for (const r of o.roles) if (!used.get(o.file).has(r)) problems.push(`tools/check-role-traits.mjs: owner ${o.file} no longer names ${r} in a comparison: take ${r} out of its entry`);
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] !== undefined ? resolve(process.argv[2]) : ROOT;
  const problems = roleTraitProblems(root);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`check-role-traits: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log(`check-role-traits: ${sourceFiles(root).length} source files, no role comparison outside the table and its ${OWNERS.length} owner files`);
}
