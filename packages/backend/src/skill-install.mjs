/**
 * The engine's agent skill (`skills/thirdlight/` in the engine) installed into
 * a game folder at `.claude/skills/thirdlight/`, where Claude Code finds a
 * project's skills.
 *
 * Plain JavaScript so `tools/project.mjs` runs it without a build while the
 * backend's folder create runs the very same code.
 *
 * A record beside the installed copy holds the digest of every file as it was
 * installed. An update compares the files with it, so a copy the user edited
 * is never overwritten silently (only with `force`), and `check` can tell an
 * edited copy from one an older engine installed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the engine checkout keeps the skill. */
export const SKILL_SOURCE_DIR = 'skills/thirdlight';
/** Where it is installed in a game folder (Claude Code's project skills). */
export const SKILL_INSTALL_DIR = '.claude/skills/thirdlight';
/** The install record, inside the installed folder. */
export const SKILL_RECORD = '.thirdlight-skill.json';
/** The frontmatter metadata key holding the engine version the skill was written for. */
export const SKILL_STAMP_KEY = 'thirdlight-engine';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, as sorted `/`-separated relative paths (the record left out). */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile() && rel !== SKILL_RECORD) out.push(rel);
  }
  return out.sort();
}

/** One digest over a set of `{path: fileDigest}`, independent of key order. */
function setDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((p) => `${p}\0${files[p]}\n`)
      .join(''),
  );
}

/** The engine version a SKILL.md's frontmatter is stamped with, or null. */
export function skillStamp(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front === null) return null;
  const m = new RegExp(`^metadata:[ \\t]*\\n(?:[ \\t]+.*\\n)*?[ \\t]+${SKILL_STAMP_KEY}:[ \\t]*"?([^"\\n]+?)"?[ \\t]*$`, 'm').exec(`${front[1]}\n`);
  return m === null ? null : m[1];
}

/** The skill as this engine ships it: its files, their digests, one digest over all and the stamp. */
export function engineSkill(engineRoot) {
  const dir = join(engineRoot, SKILL_SOURCE_DIR);
  const files = new Map();
  const digests = {};
  for (const rel of listFiles(dir)) {
    const bytes = readFileSync(join(dir, rel));
    files.set(rel, bytes);
    digests[rel] = sha256(bytes);
  }
  const main = files.get('SKILL.md');
  if (main === undefined) throw new Error(`${dir} has no SKILL.md`);
  return { dir, files, digests, digest: setDigest(digests), stamp: skillStamp(main.toString('utf8')) };
}

function readRecord(target) {
  try {
    const r = JSON.parse(readFileSync(join(target, SKILL_RECORD), 'utf8'));
    return r !== null && typeof r === 'object' && r.files !== null && typeof r.files === 'object' ? r : null;
  } catch {
    return null;
  }
}

/** Files of the installed copy that differ from what was installed (or, with no record, from this engine's skill). */
function changedFiles(target, expected) {
  const changed = [];
  for (const [rel, digest] of Object.entries(expected)) {
    const file = join(target, rel);
    if (!existsSync(file) || sha256(readFileSync(file)) !== digest) changed.push(rel);
  }
  return changed;
}

/**
 * The installed copy in `folder` against this engine's skill:
 * - `missing`: no SKILL.md installed;
 * - `modified`: files differ from what was installed (`modified` names them);
 *   a copy without a record counts as modified unless it equals this engine's;
 * - `outdated`: installed unchanged, but this engine ships a different skill;
 * - `current`: the same as this engine's.
 * `installedStamp` is the engine version the installed SKILL.md was written for.
 */
export function skillStatus(engineRoot, folder) {
  const engine = engineSkill(engineRoot);
  const target = join(folder, SKILL_INSTALL_DIR);
  const main = join(target, 'SKILL.md');
  if (!existsSync(main)) return { state: 'missing', target, modified: [], installedStamp: null, engineStamp: engine.stamp };
  const installedStamp = skillStamp(readFileSync(main, 'utf8'));
  const record = readRecord(target);
  const base = { target, installedStamp, engineStamp: engine.stamp };
  if (record === null) {
    const modified = changedFiles(target, engine.digests);
    return modified.length === 0 ? { state: 'current', modified, ...base } : { state: 'modified', modified, ...base };
  }
  const modified = changedFiles(target, record.files);
  if (modified.length > 0) return { state: 'modified', modified, ...base };
  return { state: record.digest === engine.digest ? 'current' : 'outdated', modified, ...base };
}

/**
 * Install or update the skill in `folder`. Refuses (writes nothing) when the
 * installed copy was edited, unless `force`. Files an older skill had and this
 * one has not are removed; files the user added are left alone.
 * Returns `{action: installed | updated | unchanged | refused, modified, target, stamp}`.
 */
export function installSkill(engineRoot, folder, { force = false } = {}) {
  const engine = engineSkill(engineRoot);
  const status = skillStatus(engineRoot, folder);
  const { target } = status;
  if (status.state === 'modified' && !force) return { action: 'refused', modified: status.modified, target, stamp: engine.stamp };
  const record = readRecord(target);
  if (status.state === 'current' && record !== null) return { action: 'unchanged', modified: [], target, stamp: engine.stamp };
  for (const [rel, bytes] of engine.files) {
    const file = join(target, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  if (record !== null) {
    for (const rel of Object.keys(record.files)) if (!engine.files.has(rel)) rmSync(join(target, rel), { force: true });
  }
  const next = { skill: 'thirdlight', stamp: engine.stamp, digest: engine.digest, files: engine.digests };
  writeFileSync(join(target, SKILL_RECORD), `${JSON.stringify(next, null, 2)}\n`);
  return { action: status.state === 'missing' ? 'installed' : 'updated', modified: status.modified, target, stamp: engine.stamp };
}
