#!/usr/bin/env node
/**
 * Project backup and restore for a Thirdlight data root (plain Node).
 *
 *   node tools/backup.mjs create  <projectId> [--data-root DIR] [--out DIR]
 *   node tools/backup.mjs verify  <backupDir>
 *   node tools/backup.mjs restore <backupDir> [--data-root DIR] [--as <newProjectId>]
 *   node tools/backup.mjs list    [--out DIR]
 *
 * A backup is a directory `<out>/<projectId>-<UTC stamp>/` holding the
 * project's authoritative files (`project.json`, `scenes/`, `sources/`, and
 * anything else in the project directory except `.thirdlight/`, which is
 * process state and derived data) plus `backup-manifest.json` — the file
 * inventory with SHA-256 digests, written LAST: a directory without a valid
 * manifest is not a backup. `verify` re-hashes every file. Retention is
 * manual: nothing is pruned.
 *
 * `create` refuses a project a running backend currently owns (release it
 * or stop the backend first). `restore` verifies first and refuses a
 * destination that already exists; `--as` restores under a new project id
 * (the id is rewritten in project.json and the scene envelope, and the
 * envelope's retry records — request dedupe state of the original — are
 * dropped).
 *
 * Folder projects (registered in <data root>/registry.json) are found through
 * the registry, and their backup is the WHOLE game folder (the folder holding
 * `thirdlight.json`): the marker, the project subfolder, the assets it
 * references in place, the art sources and `.git` — everything except
 * Thirdlight's process state (`<projectDir>/.thirdlight/`). The game folder
 * is the bound: nothing outside it is referenced or backed up. Such a backup
 * (backupVersion 2, `scope: "game-folder"`) restores only with
 * `restore --folder <dir>` into a new or empty folder; register it afterwards
 * (picker "Open project folder…" or `node tools/project.mjs register <dir>`).
 * Older backups (backupVersion 1: the project subfolder + the marker in the
 * manifest) still verify and restore.
 *
 * Defaults: data root `~/thirdlight`, backups under `<data root>/backups`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_VERSION = 1;
/** A whole-game-folder backup (folder projects). */
export const FOLDER_BACKUP_VERSION = 2;
const MANIFEST = 'backup-manifest.json';
const EXCLUDED_TOP = new Set(['.thirdlight']);
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Every regular file under `dir` (relative POSIX paths, sorted); symlinks are refused. `skip`: relative paths left out. */
function listFiles(dir, skip = new Set()) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (skip.has(r)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (lstatSync(p).isSymbolicLink()) throw new BackupError('backup_symlink', `refusing symbolic link ${r}`);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.push(r);
      else throw new BackupError('backup_special_file', `refusing special file ${r}`);
    }
  };
  walk(dir, '');
  return out;
}

/** The ownership verdict for a project directory: is a backend holding it? */
export function ownershipState(projectDir, procRoot = '/proc') {
  const file = join(projectDir, '.thirdlight', 'ownership.json');
  if (!existsSync(file)) return { live: false, reason: 'no ownership record' };
  let rec;
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { live: true, reason: 'the ownership record is unreadable (treated as live)' };
  }
  if (rec.state === 'released') return { live: false, reason: 'released' };
  if (rec.state !== 'owned' || !Number.isInteger(rec.pid)) return { live: true, reason: 'unrecognized ownership record (treated as live)' };
  // Conservative liveness (like the workspace): only a missing /proc entry proves death.
  try {
    statSync(join(procRoot, String(rec.pid)));
    return { live: true, reason: `owned by backend ${rec.backendId} (pid ${rec.pid}, still running)` };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { live: false, reason: `owned by a dead process (pid ${rec.pid})` };
    return { live: true, reason: 'the process table is unavailable (treated as live)' };
  }
}

function readEnvelopeRevision(projectDir) {
  try {
    const env = JSON.parse(readFileSync(join(projectDir, 'scenes', 'main.json'), 'utf8'));
    const r = env?.scene?.revision;
    return Number.isInteger(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Where a project's files live: a folder project (registered in
 * <dataRoot>/registry.json) or <dataRoot>/projects/<id>.
 */
export function locateProject(dataRoot, projectId) {
  try {
    const reg = JSON.parse(readFileSync(join(dataRoot, 'registry.json'), 'utf8'));
    const folder = reg?.projects?.[projectId]?.folder;
    if (typeof folder === 'string') {
      const marker = JSON.parse(readFileSync(join(folder, 'thirdlight.json'), 'utf8'));
      return { projectDir: join(folder, marker.projectDir ?? 'thirdlight'), folder, marker };
    }
  } catch {
    // no registry, or an unreadable folder: fall through to the data root
  }
  return { projectDir: join(dataRoot, 'projects', projectId), folder: null, marker: null };
}

/** Create a backup of `<dataRoot>/projects/<projectId>` under `outRoot`. Returns the backup directory. */
export function createBackup({ dataRoot, projectId, outRoot, now = new Date(), procRoot = '/proc' }) {
  if (!PROJECT_ID_RE.test(projectId)) throw new BackupError('invalid_project_id', `"${projectId}" is not a project id`);
  const { projectDir, folder, marker } = locateProject(dataRoot, projectId);
  if (!existsSync(join(projectDir, 'project.json'))) throw new BackupError('project_not_found', `no project "${projectId}" under ${join(dataRoot, 'projects')}`);
  const own = ownershipState(projectDir, procRoot);
  if (own.live) throw new BackupError('backup_live_project', `project "${projectId}" is in use: ${own.reason}. Release it (POST /api/v1/admin/projects/${projectId}/release) or stop the backend first`);
  // A folder project: the whole game folder, minus Thirdlight's process state.
  const sub = marker?.projectDir ?? 'thirdlight';
  const base = folder !== null ? folder : projectDir;
  if (folder !== null) {
    const out = resolve(outRoot);
    const f = resolve(folder);
    if (out === f || out.startsWith(`${f}/`)) throw new BackupError('backup_destination_inside', `the backup directory ${out} is inside the game folder ${f}; choose --out outside it`);
  }
  const files = listFiles(base, folder !== null ? new Set([`${sub}/.thirdlight`]) : EXCLUDED_TOP);
  const stamp = utcStamp(now);
  const dest = join(outRoot, `${projectId}-${stamp}`);
  if (existsSync(dest)) throw new BackupError('backup_destination_exists', `${dest} already exists`);
  const tmp = `${dest}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const inventory = [];
  for (const rel of files) {
    const bytes = readFileSync(join(base, rel));
    const target = join(tmp, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    inventory.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
  }
  const manifest = {
    backupVersion: folder !== null ? FOLDER_BACKUP_VERSION : BACKUP_VERSION,
    projectId,
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    revision: readEnvelopeRevision(projectDir),
    // A folder project: file paths are relative to the game folder.
    ...(folder !== null ? { scope: 'game-folder', folder, marker, projectDir: sub } : {}),
    files: inventory,
    inventoryDigest: sha256(JSON.stringify(inventory)),
  };
  // The manifest is the last write: a directory without it is not a backup.
  writeFileSync(join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, dest);
  return { dir: dest, manifest };
}

/** Read + check a backup directory. Returns the manifest and the problems found. */
export function verifyBackup(backupDir) {
  const problems = [];
  const manifestPath = join(backupDir, MANIFEST);
  if (!existsSync(manifestPath)) return { ok: false, manifest: null, problems: [`no ${MANIFEST} (not a complete backup)`] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, manifest: null, problems: [`${MANIFEST} is not valid JSON: ${e.message}`] };
  }
  const whole = manifest.backupVersion === FOLDER_BACKUP_VERSION;
  if (
    (manifest.backupVersion !== BACKUP_VERSION && !whole) ||
    (whole && (manifest.scope !== 'game-folder' || typeof manifest.projectDir !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(manifest.projectDir))) ||
    !PROJECT_ID_RE.test(String(manifest.projectId)) ||
    !Array.isArray(manifest.files)
  ) {
    return { ok: false, manifest, problems: [`${MANIFEST} has an unexpected shape`] };
  }
  if (sha256(JSON.stringify(manifest.files)) !== manifest.inventoryDigest) problems.push('the file inventory does not match its digest');
  const listed = new Set();
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..')) {
      problems.push(`inventory path rejected: ${String(f.path)}`);
      continue;
    }
    listed.add(f.path);
    const p = join(backupDir, f.path);
    if (!existsSync(p)) {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    const bytes = readFileSync(p);
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) problems.push(`modified: ${f.path}`);
  }
  let present;
  try {
    present = listFiles(backupDir).filter((r) => r !== MANIFEST);
  } catch (e) {
    problems.push(e.message);
    present = [];
  }
  for (const r of present) if (!listed.has(r)) problems.push(`not in the inventory: ${r}`);
  const pre = whole ? `${manifest.projectDir}/` : '';
  if (!listed.has(`${pre}project.json`) || !listed.has(`${pre}scenes/main.json`)) problems.push(`the backup lacks ${pre}project.json or ${pre}scenes/main.json`);
  if (whole && !listed.has('thirdlight.json')) problems.push('the game-folder backup lacks thirdlight.json');
  return { ok: problems.length === 0, manifest, problems };
}

/** Restore a verified backup into `<dataRoot>/projects/<projectId or --as>`. */
export function restoreBackup({ backupDir, dataRoot, as, folder }) {
  const v = verifyBackup(backupDir);
  if (!v.ok) throw new BackupError('backup_invalid', `refusing to restore ${backupDir}:\n  ${v.problems.join('\n  ')}`);
  const projectId = as ?? v.manifest.projectId;
  if (!PROJECT_ID_RE.test(projectId)) throw new BackupError('invalid_project_id', `"${projectId}" is not a project id`);
  if (v.manifest.backupVersion === FOLDER_BACKUP_VERSION) return restoreGameFolder(backupDir, v.manifest, projectId, folder);
  let dest;
  let tmp;
  let markerOut = null;
  if (folder !== undefined && folder !== null) {
    // Into a game folder: <folder>/thirdlight.json + <folder>/<projectDir>/.
    const sub = v.manifest.marker?.projectDir ?? 'thirdlight';
    if (existsSync(join(folder, 'thirdlight.json'))) throw new BackupError('restore_destination_exists', `${folder} already holds a thirdlight.json; restore never overwrites`);
    dest = join(folder, sub);
    if (existsSync(dest)) throw new BackupError('restore_destination_exists', `${dest} already exists; restore never overwrites`);
    mkdirSync(folder, { recursive: true });
    tmp = join(folder, `.restore-${projectId}-${process.pid}`);
    markerOut = { thirdlightProject: 1, name: v.manifest.marker?.name ?? projectId, ...(v.manifest.marker ?? {}), projectId, projectDir: sub };
  } else {
    dest = join(dataRoot, 'projects', projectId);
    if (existsSync(dest)) throw new BackupError('restore_destination_exists', `${dest} already exists; restore never overwrites (use --as <newProjectId> or move it away)`);
    tmp = join(dataRoot, 'projects', `.restore-${projectId}-${process.pid}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const f of v.manifest.files) {
    let bytes = readFileSync(join(backupDir, f.path));
    if (projectId !== v.manifest.projectId) {
      if (f.path === 'project.json') {
        const doc = JSON.parse(bytes.toString('utf8'));
        doc.id = projectId;
        bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      } else if (f.path === 'scenes/main.json') {
        const doc = JSON.parse(bytes.toString('utf8'));
        doc.projectId = projectId;
        if (doc.retry && Array.isArray(doc.retry.records)) doc.retry.records = [];
        bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      }
    }
    const target = join(tmp, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  renameSync(tmp, dest);
  if (markerOut !== null) writeFileSync(join(folder, 'thirdlight.json'), `${JSON.stringify(markerOut, null, 2)}\n`);
  return { dir: dest, projectId, revision: v.manifest.revision, ...(markerOut !== null ? { folder } : {}) };
}

/** Rewrite the project identity in one restored file (`--as`). */
function reidentify(bytes, kind, projectId) {
  const doc = JSON.parse(bytes.toString('utf8'));
  if (kind === 'project') doc.id = projectId;
  else if (kind === 'marker') doc.projectId = projectId;
  else {
    doc.projectId = projectId;
    if (doc.retry && Array.isArray(doc.retry.records)) doc.retry.records = [];
  }
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}

/** Restore a whole-game-folder backup into a new or empty folder. */
function restoreGameFolder(backupDir, manifest, projectId, folder) {
  if (folder === undefined || folder === null) {
    throw new BackupError('restore_needs_folder', 'this backup holds a whole game folder; restore it with --folder <dir> (a new or empty folder)');
  }
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    throw new BackupError('restore_destination_exists', `${folder} already exists and is not empty; restore never overwrites`);
  }
  const sub = manifest.projectDir;
  const rename = projectId !== manifest.projectId;
  const special = { 'thirdlight.json': 'marker', [`${sub}/project.json`]: 'project', [`${sub}/scenes/main.json`]: 'envelope' };
  const tmp = `${resolve(folder)}.restore-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const f of manifest.files) {
    let bytes = readFileSync(join(backupDir, f.path));
    if (rename && special[f.path] !== undefined) bytes = reidentify(bytes, special[f.path], projectId);
    const target = join(tmp, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  if (existsSync(folder)) rmSync(folder, { recursive: true });
  renameSync(tmp, folder);
  return { dir: join(folder, sub), projectId, revision: manifest.revision, folder, files: manifest.files.length };
}

export function listBackups(outRoot) {
  if (!existsSync(outRoot)) return [];
  const out = [];
  for (const name of readdirSync(outRoot).sort()) {
    const dir = join(outRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const m = join(dir, MANIFEST);
    if (!existsSync(m)) {
      out.push({ dir, complete: false });
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(m, 'utf8'));
      out.push({ dir, complete: true, projectId: manifest.projectId, createdAt: manifest.createdAt, revision: manifest.revision, files: manifest.files.length });
    } catch {
      out.push({ dir, complete: false });
    }
  }
  return out;
}

function parse(argv) {
  const opts = { dataRoot: join(homedir(), 'thirdlight'), out: null, as: null, folder: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new BackupError('usage', `${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--data-root') opts.dataRoot = resolve(next());
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--as') opts.as = next();
    else if (a === '--folder') opts.folder = resolve(next());
    else if (a.startsWith('--')) throw new BackupError('usage', `unknown option ${a}`);
    else opts.positional.push(a);
  }
  if (opts.out === null) opts.out = join(opts.dataRoot, 'backups');
  return opts;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const opts = parse(rest);
    if (cmd === 'create') {
      const [projectId] = opts.positional;
      if (!projectId) throw new BackupError('usage', 'create needs a project id');
      mkdirSync(opts.out, { recursive: true });
      const r = createBackup({ dataRoot: opts.dataRoot, projectId, outRoot: opts.out });
      process.stdout.write(`backup: ${r.dir} (${r.manifest.files.length} files, revision ${r.manifest.revision ?? 'unknown'})\n`);
    } else if (cmd === 'verify') {
      const [dir] = opts.positional;
      if (!dir) throw new BackupError('usage', 'verify needs a backup directory');
      const v = verifyBackup(resolve(dir));
      if (!v.ok) {
        process.stderr.write(`verify: FAILED\n  ${v.problems.join('\n  ')}\n`);
        process.exit(1);
      }
      process.stdout.write(`verify: OK (${v.manifest.projectId}, ${v.manifest.files.length} files, revision ${v.manifest.revision ?? 'unknown'})\n`);
    } else if (cmd === 'restore') {
      const [dir] = opts.positional;
      if (!dir) throw new BackupError('usage', 'restore needs a backup directory');
      const r = restoreBackup({ backupDir: resolve(dir), dataRoot: opts.dataRoot, as: opts.as ?? undefined, folder: opts.folder });
      process.stdout.write(`restore: ${r.dir} (project ${r.projectId}, revision ${r.revision ?? 'unknown'})\n`);
      if (r.folder) process.stdout.write(`register it: node tools/project.mjs register ${r.folder}   (or the editor's "Open project folder…")\n`);
    } else if (cmd === 'list') {
      for (const b of listBackups(opts.out)) {
        process.stdout.write(b.complete ? `${basename(b.dir)}  ${b.projectId}  revision ${b.revision ?? '?'}  ${b.files} files  ${b.createdAt}\n` : `${basename(b.dir)}  INCOMPLETE (no manifest)\n`);
      }
    } else {
      throw new BackupError('usage', 'command must be create | verify | restore | list');
    }
  } catch (e) {
    if (e instanceof BackupError) {
      process.stderr.write(`backup: ${e.message}\n`);
      if (e.code === 'usage') process.stderr.write('usage: node tools/backup.mjs create <projectId> | verify <dir> | restore <dir> [--as <id>] [--folder <dir>] | list  [--data-root DIR] [--out DIR]\n');
      process.exit(e.code === 'usage' ? 2 : 1);
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
