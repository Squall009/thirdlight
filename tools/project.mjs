#!/usr/bin/env node
/**
 * Folder projects (a Thirdlight project inside a game's own repository),
 * driven through the RUNNING backend — one backend serves every project.
 *
 *   node tools/project.mjs create <folder> --id <projectId> [--name NAME] [--template ID]
 *   node tools/project.mjs register <folder>          # open an existing folder (holding thirdlight.json)
 *   node tools/project.mjs unregister <projectId>     # forget it; files are never touched
 *   node tools/project.mjs list
 *   node tools/project.mjs check <folder> [--repin]   # the folder's engine pin vs this engine (offline)
 *   node tools/project.mjs export <folder|projectId> [--out DIR] [--force]
 *
 * Options: --origin URL (default $THIRDLIGHT_ORIGIN or http://127.0.0.1:8501),
 *          --token-file PATH (default ~/thirdlight/owner-token).
 *
 * Layout written by `create`: <folder>/thirdlight.json (project id, name,
 * engine pin) and <folder>/thirdlight/ (project.json, scenes/, sources/, and
 * a .gitignore keeping .thirdlight/ process state out of git).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      if (problems.length > 0) {
        process.stderr.write(`check: MISMATCH\n  ${problems.join('\n  ')}\n`);
        process.exit(1);
      }
      process.stdout.write(`check: OK — ${marker.projectId} matches engine ${engine.version}${commitNote ? ` (${commitNote})` : ''}\n`);
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
      throw new CliError('usage', 'command must be create | register | unregister | list | check | export');
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`project: ${e.message}\n`);
      if (e.code === 'usage') process.stderr.write('usage: node tools/project.mjs create <folder> --id <id> [--name N] [--template T] | register <folder> | unregister <id> | list | check <folder> [--repin] | export <folder|id> [--out DIR] [--force]\n');
      process.exit(e.code === 'usage' ? 2 : 1);
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
