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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Where the engine checkout keeps the skill. */
export const SKILL_SOURCE_DIR = 'skills/thirdlight';
/** Where it is installed in a game folder (Claude Code's project skills). */
export const SKILL_INSTALL_DIR = '.claude/skills/thirdlight';
/** The install record, inside the installed folder. */
export const SKILL_RECORD = '.thirdlight-skill.json';
/** The frontmatter metadata key holding the stamp of the engine the skill was installed from. */
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

/** The stamp a SKILL.md's frontmatter carries, or null. */
export function skillStamp(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front === null) return null;
  const m = new RegExp(`^metadata:[ \\t]*\\n(?:[ \\t]+.*\\n)*?[ \\t]+${SKILL_STAMP_KEY}:[ \\t]*"?([^"\\n]+?)"?[ \\t]*$`, 'm').exec(`${front[1]}\n`);
  return m === null ? null : m[1];
}

/** The engine version part of a stamp (`0.1.0` of `0.1.0+3fa2c1d9e0ab`). */
export function stampVersion(stamp) {
  return stamp === null || stamp === undefined ? null : stamp.split('+')[0];
}

/**
 * The skill as installed from its source files (rel -> bytes) for an engine
 * version: SKILL.md stamped `<version>+<12 hex of the source's digest>`, the
 * files' digests, one digest over all and the stamp. The package version
 * alone stays the same for many engine releases; the digest part changes
 * whenever the skill does, so a copy from another engine shows in its stamp.
 */
export function skillOfFiles(source, version) {
  const sourceDigests = {};
  for (const [rel, bytes] of source) sourceDigests[rel] = sha256(bytes);
  const main = source.get('SKILL.md');
  if (main === undefined) throw new Error('the skill has no SKILL.md');
  const stamp = `${version}+${setDigest(sourceDigests).slice(0, 12)}`;
  const text = main.toString('utf8');
  if (skillStamp(text) === null) throw new Error(`SKILL.md has no metadata.${SKILL_STAMP_KEY} line to stamp`);
  const stamped = text.replace(new RegExp(`^([ \\t]+${SKILL_STAMP_KEY}:[ \\t]*).*$`, 'm'), `$1"${stamp}"`);
  const files = new Map(source);
  files.set('SKILL.md', Buffer.from(stamped, 'utf8'));
  const digests = {};
  for (const [rel, bytes] of files) digests[rel] = sha256(bytes);
  return { files, digests, digest: setDigest(digests), stamp };
}

/** The skill as this engine ships it: its files as installed, their digests, one digest over all and the stamp. */
export function engineSkill(engineRoot) {
  const dir = join(engineRoot, SKILL_SOURCE_DIR);
  const source = new Map();
  for (const rel of listFiles(dir)) source.set(rel, readFileSync(join(dir, rel)));
  const version = String(JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8')).version);
  return { dir, ...skillOfFiles(source, version) };
}

/**
 * A record's file name as a path inside the skill folder, or null. The record
 * sits in the game folder, often a cloned repository, so its names are not
 * trusted: only plain relative names (no `..`, no absolute path, no
 * backslash) that stay inside the folder are used.
 */
function insideSkill(target, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0') || isAbsolute(rel)) return null;
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  const file = resolve(target, rel);
  const back = relative(resolve(target), file);
  return back === '' || back.startsWith(`..${sep}`) || back === '..' || isAbsolute(back) ? null : file;
}

/**
 * The first symbolic link on the way from `folder` down to `file` (the
 * install folder's own parts and the file included), or null. Writing or
 * deleting through a link would reach outside the game folder.
 */
function linkOnPath(folder, file) {
  const parts = relative(resolve(folder), resolve(file)).split(sep);
  let at = resolve(folder);
  for (const part of parts) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null;
    }
  }
  return null;
}

function readRecord(target) {
  try {
    const r = JSON.parse(readFileSync(join(target, SKILL_RECORD), 'utf8'));
    if (r === null || typeof r !== 'object' || r.files === null || typeof r.files !== 'object' || Array.isArray(r.files)) return null;
    // Only names inside the skill folder with a digest; anything else in the record is ignored.
    const files = {};
    for (const [rel, digest] of Object.entries(r.files)) if (insideSkill(target, rel) !== null && typeof digest === 'string') files[rel] = digest;
    return { ...r, files };
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
  // Every path written or removed, checked before anything changes: a link anywhere on the way refuses the
  // whole install (force included), as it could point outside the game folder.
  const writes = [...engine.files.keys(), SKILL_RECORD].map((rel) => join(target, rel));
  const removes = record === null ? [] : Object.keys(record.files).filter((rel) => !engine.files.has(rel)).map((rel) => insideSkill(target, rel));
  for (const file of [...writes, ...removes]) {
    const link = linkOnPath(folder, file);
    if (link !== null) throw new Error(`${link} is a symbolic link; the skill is installed into real folders only (nothing was changed)`);
  }
  for (const [rel, bytes] of engine.files) {
    const file = join(target, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  for (const file of removes) rmSync(file, { force: true });
  const next = { skill: 'thirdlight', stamp: engine.stamp, digest: engine.digest, files: engine.digests };
  writeFileSync(join(target, SKILL_RECORD), `${JSON.stringify(next, null, 2)}\n`);
  return { action: status.state === 'missing' ? 'installed' : 'updated', modified: status.modified, target, stamp: engine.stamp };
}
