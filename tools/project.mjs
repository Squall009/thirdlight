#!/usr/bin/env node
/**
 * Folder projects (a Thirdlight project inside a game's own repository),
 * driven through the RUNNING backend — one backend serves every project.
 *
 *   node tools/project.mjs create <folder> --id <projectId> [--name NAME] [--template ID]
 *   node tools/project.mjs register <folder>          # open an existing folder (holding thirdlight.json)
 *   node tools/project.mjs unregister <projectId>     # forget it; files are never touched
 *   node tools/project.mjs list
 *   node tools/project.mjs check <folder> [--repin]   # the folder's engine pin and skill vs this engine (offline)
 *   node tools/project.mjs skill <folder> [--force]   # install or update the agent skill (offline)
 *   node tools/project.mjs export <folder|projectId> [--out DIR] [--force]
 *
 * Options: --origin URL (default $THIRDLIGHT_ORIGIN or http://127.0.0.1:8501),
 *          --token-file PATH (default ~/thirdlight/owner-token).
 *
 * Layout written by `create`: <folder>/thirdlight.json (project id, name,
 * engine pin), <folder>/thirdlight/ (project.json, scenes/, sources/, and
 * a .gitignore keeping .thirdlight/ process state out of git) and the
 * engine's agent skill in <folder>/.claude/skills/thirdlight/.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_INSTALL_DIR, SKILL_SOURCE_DIR, installSkill, skillOfFiles, skillStatus, stampVersion } from '@thirdlight/backend/skill';

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'thirdlight.json';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The engine identity: version + commit + lockfile digest. */
export function engineIdentity(root = ENGINE_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = readFileSync(join(root, 'package-lock.json'));
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return {
    version: String(pkg.version),
    commit: git.status === 0 ? git.stdout.trim() : 'unknown',
    lockfileDigest: createHash('sha256').update(lock).digest('hex'),
  };
}

export function readMarker(folder) {
  const file = join(folder, MARKER);
  if (!existsSync(file)) throw new CliError('not_a_project', `${folder} has no ${MARKER}`);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (m.thirdlightProject !== 1) throw new CliError('not_a_project', `${file} is not a Thirdlight project marker`);
  return m;
}

/** Differences between a marker's pin and this engine (version/lockfile decide; commit is informational). */
export function checkPin(marker, engine = engineIdentity()) {
  const pin = marker.engine ?? {};
  const problems = [];
  if (pin.version !== undefined && pin.version !== engine.version) problems.push(`engine version: pinned ${pin.version}, this engine is ${engine.version}`);
  if (pin.lockfileDigest !== undefined && pin.lockfileDigest !== engine.lockfileDigest) problems.push(`dependency lockfile: pinned ${pin.lockfileDigest.slice(0, 12)}…, this engine has ${engine.lockfileDigest.slice(0, 12)}…`);
  const commitNote = pin.commit !== undefined && pin.commit !== engine.commit ? `pinned commit ${pin.commit.slice(0, 12)}, this engine is at ${engine.commit.slice(0, 12)}` : null;
  return { problems, commitNote };
}

/** Warnings about the folder's installed skill against this engine's and the pinned engine version (none when all is well). */
export function skillWarnings(folder, marker, root = ENGINE_ROOT) {
  const st = skillStatus(root, folder);
  const fix = `node tools/project.mjs skill ${folder}`;
  const out = [];
  if (st.state === 'missing') return [`no agent skill in ${SKILL_INSTALL_DIR}; install it with \`${fix}\``];
  if (st.state === 'modified') out.push(`the agent skill was edited locally (${st.modified.join(', ')}); \`${fix} --force\` replaces it with this engine's`);
  if (st.state === 'outdated') out.push(`the agent skill differs from this engine's (installed for engine ${st.installedStamp ?? 'unknown'}, this engine ships ${st.engineStamp ?? 'unknown'}); update it with \`${fix}\``);
  const pin = marker.engine ?? {};
  // The skill of the engine the project is pinned to, when this checkout has the pinned commit; else the version.
  const pinnedStamp = typeof pin.commit === 'string' ? skillStampAt(root, pin.commit) : null;
  if (pinnedStamp !== null) {
    if (st.installedStamp !== pinnedStamp) out.push(`the agent skill is stamped ${st.installedStamp ?? 'unknown'}, the engine the project is pinned to (commit ${pin.commit.slice(0, 12)}) ships ${pinnedStamp}; \`${fix}\` installs this engine's`);
  } else if (pin.version !== undefined && stampVersion(st.installedStamp) !== pin.version) {
    out.push(`the agent skill is stamped for engine ${st.installedStamp ?? 'unknown'}, the project is pinned to ${pin.version}`);
  }
  return out;
}

/** The stamp of the skill the engine at `commit` installs (read with git from this checkout), or null when it has no such commit. */
export function skillStampAt(root, commit) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
  const git = (args) => spawnSync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const list = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', SKILL_SOURCE_DIR]);
  const pkg = git(['show', `${commit}:package.json`]);
  if (list.status !== 0 || pkg.status !== 0) return null;
  const source = new Map();
  for (const path of list.stdout.toString('utf8').split('\0').filter((p) => p !== '')) {
    const file = git(['show', `${commit}:${path}`]);
    if (file.status !== 0) return null;
    source.set(path.slice(SKILL_SOURCE_DIR.length + 1), file.stdout);
  }
  try {
    return skillOfFiles(source, String(JSON.parse(pkg.stdout.toString('utf8')).version)).stamp;
  } catch {
    return null;
  }
}

/** Install or update the skill and say what happened; a locally edited copy is refused without --force. */
function runSkillInstall(folder, force) {
  let r;
  try {
    r = installSkill(ENGINE_ROOT, folder, { force });
  } catch (e) {
    throw new CliError('skill_refused', e instanceof Error ? e.message : String(e));
  }
  if (r.action === 'refused') {
    throw new CliError('skill_modified', `the agent skill in ${r.target} was edited locally (${r.modified.join(', ')}); nothing was changed. Keep your edits elsewhere and pass --force to replace it`);
  }
  return `skill ${r.action}: ${r.target} (engine ${r.stamp ?? 'unknown'})`;
}

function parse(argv) {
  const opts = { positional: [], id: null, name: null, template: null, out: null, repin: false, force: false, origin: process.env.THIRDLIGHT_ORIGIN ?? 'http://127.0.0.1:8501', tokenFile: join(homedir(), 'thirdlight', 'owner-token') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new CliError('usage', `${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--id') opts.id = next();
    else if (a === '--name') opts.name = next();
    else if (a === '--template') opts.template = next();
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--origin') opts.origin = next().replace(/\/$/, '');
    else if (a === '--token-file') opts.tokenFile = resolve(next());
    else if (a === '--repin') opts.repin = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) throw new CliError('usage', `unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

async function api(opts, method, path, body) {
  let token;
  try {
    token = readFileSync(opts.tokenFile, 'utf8').trim();
  } catch {
    throw new CliError('no_token', `cannot read the owner token at ${opts.tokenFile} (use --token-file)`);
  }
  let res;
  try {
    res = await fetch(`${opts.origin}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new CliError('backend_unreachable', `the Thirdlight backend at ${opts.origin} is not reachable (${e.message}); is it running?`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok !== true) throw new CliError('backend_error', `${method} ${path} failed (${res.status}): ${json.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Download one export as the backend's stored zip and unpack it into `out`. */
async function downloadExport(opts, projectId, dir, out) {
  const token = readFileSync(opts.tokenFile, 'utf8').trim();
  const res = await fetch(`${opts.origin}/api/v1/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(dir)}/zip`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new CliError('backend_error', `downloading the export failed (${res.status})`);
  const b = Buffer.from(await res.arrayBuffer());
  let i = 0;
  let n = 0;
  while (i + 30 <= b.length && b.readUInt32LE(i) === 0x04034b50) {
    if (b.readUInt16LE(i + 8) !== 0) throw new CliError('backend_error', 'unexpected compressed zip entry');
    const size = b.readUInt32LE(i + 18);
    const nameLen = b.readUInt16LE(i + 26);
    const extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new CliError('backend_error', `refusing zip entry ${name}`);
    const data = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    const target = join(out, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    n += 1;
    i += 30 + nameLen + extra + size;
  }
  return n;
}

const absFolder = (p) => {
  if (!p) throw new CliError('usage', 'a folder is required');
  return isAbsolute(p) ? p : resolve(p);
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const opts = parse(rest);
    const arg = opts.positional[0];
    if (cmd === 'create') {
      const folder = absFolder(arg);
      if (!opts.id) throw new CliError('usage', 'create needs --id <projectId>');
      await api(opts, 'POST', '/admin/projects', { projectId: opts.id, name: opts.name ?? opts.id, folder, ...(opts.template ? { template: opts.template } : {}) });
      process.stdout.write(`created ${opts.id} in ${folder}\n  ${join(folder, MARKER)}\n  ${join(folder, 'thirdlight')}/\n`);
      // The backend installs the skill of the engine it runs; this makes sure the folder has this engine's.
      process.stdout.write(`  ${runSkillInstall(folder, false)}\n`);
    } else if (cmd === 'register') {
      const r = await api(opts, 'POST', '/admin/projects/register', { folder: absFolder(arg) });
      process.stdout.write(`registered ${r.projectId}${r.created ? '' : ' (already registered)'}\n`);
    } else if (cmd === 'unregister') {
      if (!arg) throw new CliError('usage', 'unregister needs a project id');
      const r = await api(opts, 'POST', `/admin/projects/${encodeURIComponent(arg)}/unregister`, {});
      process.stdout.write(`unregistered ${arg}; its files in ${r.folder} are untouched\n`);
    } else if (cmd === 'list') {
      const r = await api(opts, 'GET', '/projects');
      for (const p of r.projects) process.stdout.write(`${p.projectId.padEnd(24)} ${p.loadable ? 'ok  ' : 'N/A '} ${p.folder ?? '(data root)'}${p.note ? `  — ${p.note}` : ''}\n`);
    } else if (cmd === 'check') {
      const folder = absFolder(arg);
      const marker = readMarker(folder);
      const engine = engineIdentity();
      if (opts.repin) {
        marker.engine = engine;
        writeFileSync(join(folder, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
        process.stdout.write(`re-pinned ${marker.projectId} to engine ${engine.version} @ ${engine.commit.slice(0, 12)}\n`);
        return;
      }
      const { problems, commitNote } = checkPin(marker, engine);
      for (const w of skillWarnings(folder, marker)) process.stderr.write(`check: warning: ${w}\n`);
      if (problems.length > 0) {
        process.stderr.write(`check: MISMATCH\n  ${problems.join('\n  ')}\n`);
        process.exit(1);
      }
      process.stdout.write(`check: OK — ${marker.projectId} matches engine ${engine.version}${commitNote ? ` (${commitNote})` : ''}\n`);
    } else if (cmd === 'skill') {
      const folder = absFolder(arg);
      if (!existsSync(folder)) throw new CliError('usage', `${folder} does not exist`);
      process.stdout.write(`${runSkillInstall(folder, opts.force)}\n`);
      if (!existsSync(join(folder, MARKER))) process.stdout.write(`note: ${folder} holds no ${MARKER}; the MCP tools find a project only from a folder that has one\n`);
    } else if (cmd === 'export') {
      if (!arg) throw new CliError('usage', 'export needs a folder or a project id');
      let projectId = arg;
      if (arg.includes('/') || existsSync(join(resolve(arg), MARKER))) {
        const marker = readMarker(absFolder(arg));
        projectId = marker.projectId;
        const { problems } = checkPin(marker);
        if (problems.length > 0 && !opts.force) {
          throw new CliError('engine_pin_mismatch', `this engine does not match the project's pin:\n  ${problems.join('\n  ')}\nUse the pinned engine, run \`check --repin\`, or pass --force`);
        }
      }
      const r = await api(opts, 'POST', `/admin/projects/${encodeURIComponent(projectId)}/export`, {});
      process.stdout.write(`exported ${projectId} revision ${r.revision} to the server export root: ${r.outputDir}\n`);
      if (opts.out) {
        const files = await downloadExport(opts, projectId, r.outputDir, opts.out);
        process.stdout.write(`unpacked ${files} files into ${opts.out}\n`);
      }
    } else {
      throw new CliError('usage', 'command must be create | register | unregister | list | check | skill | export');
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`project: ${e.message}\n`);
      if (e.code === 'usage') process.stderr.write('usage: node tools/project.mjs create <folder> --id <id> [--name N] [--template T] | register <folder> | unregister <id> | list | check <folder> [--repin] | skill <folder> [--force] | export <folder|id> [--out DIR] [--force]\n');
      process.exit(e.code === 'usage' ? 2 : 1);
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
