#!/usr/bin/env node
/**
 * An independent game project: its own directory (own git repository if
 * you like) that pins the engine it was built with.
 *
 *   node tools/game.mjs create <gameDir> --id <projectId> [--name NAME] [--template ID]
 *   node tools/game.mjs check  <gameDir> [--repin]
 *   node tools/game.mjs export <gameDir> [--out DIR]
 *   node tools/game.mjs start  <gameDir> [start options: --host --port --preview-port]
 *
 * The game directory is a Thirdlight data root holding one project:
 *   game.json            the game identity + the engine pin
 *   projects/<id>/       the project (project.json, scenes/, sources/)
 *   exports/, backups/   build output and backups (ignored by git)
 *
 * The engine pin (`game.json.engine`) is the engine repository's version,
 * git commit and the SHA-256 of its package-lock.json. `check` and `export`
 * compare the engine this tool runs from against the pin and refuse on a
 * mismatch; `check --repin` records the current engine on purpose (after
 * an upgrade you verified). Every operation goes through the real backend
 * (started on free loopback ports for the duration of the command), so a
 * game created here is exactly what the editor and MCP work on.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_ROOT, ensureBuilt } from './start.mjs';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The engine identity: version + commit + lockfile digest (no paths). */
export function engineIdentity(engineRoot = ENGINE_ROOT) {
  const pkg = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));
  const lock = readFileSync(join(engineRoot, 'package-lock.json'));
  const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() : 'unknown';
  const dirty = spawnSync('git', ['-C', engineRoot, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return {
    version: String(pkg.version),
    commit,
    lockfileDigest: createHash('sha256').update(lock).digest('hex'),
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
  };
}

export function readGame(gameDir) {
  const file = join(gameDir, 'game.json');
  if (!existsSync(file)) throw new GameError('not_a_game', `${gameDir} has no game.json (create one with: node tools/game.mjs create ${gameDir} --id <projectId>)`);
  const game = JSON.parse(readFileSync(file, 'utf8'));
  if (game.gameVersion !== 1 || !PROJECT_ID_RE.test(String(game.projectId)) || typeof game.engine !== 'object') {
    throw new GameError('game_invalid', `${file} has an unexpected shape`);
  }
  return game;
}

/** Compare the pin with this engine. Returns the mismatches (empty = OK). */
export function checkPin(game, engine = engineIdentity()) {
  const problems = [];
  if (game.engine.version !== engine.version) problems.push(`engine version: pinned ${game.engine.version}, this engine is ${engine.version}`);
  if (game.engine.lockfileDigest !== engine.lockfileDigest) problems.push(`dependency lockfile: pinned ${game.engine.lockfileDigest.slice(0, 12)}…, this engine has ${engine.lockfileDigest.slice(0, 12)}…`);
  if (game.engine.commit !== engine.commit) problems.push(`engine commit: pinned ${game.engine.commit.slice(0, 12)}, this engine is at ${engine.commit.slice(0, 12)}`);
  return problems;
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => ok(port));
    });
  });
}

/** Run the real backend on the game directory for the duration of `fn`. */
async function withBackend(gameDir, fn) {
  ensureBuilt(false);
  const [port, previewPort] = [await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(24).toString('base64url');
  const exportRoot = join(gameDir, 'exports');
  mkdirSync(join(gameDir, 'projects'), { recursive: true });
  mkdirSync(exportRoot, { recursive: true });
  const env = {
    ...process.env,
    THIRDLIGHT_DATA_ROOT: gameDir,
    THIRDLIGHT_AUTHORING_ORIGIN: origin,
    THIRDLIGHT_PREVIEW_ORIGIN: `http://127.0.0.1:${previewPort}`,
    THIRDLIGHT_AUTHORING_BIND: `127.0.0.1:${port}`,
    THIRDLIGHT_PREVIEW_BIND: `127.0.0.1:${previewPort}`,
    THIRDLIGHT_AUTHORING_ORIGINS: origin,
    THIRDLIGHT_EDITOR_DIR: join(ENGINE_ROOT, 'dist', 'editor'),
    THIRDLIGHT_PREVIEW_DIR: join(ENGINE_ROOT, 'dist', 'preview'),
    THIRDLIGHT_OWNER_TOKEN: token,
    THIRDLIGHT_EXPORT_ROOT: exportRoot,
    THIRDLIGHT_ENGINE_ROOT: ENGINE_ROOT,
  };
  delete env.THIRDLIGHT_TOKENS;
  const child = spawn(process.execPath, [join(ENGINE_ROOT, 'dist', 'backend', 'backend.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new GameError('backend_start', `the backend did not start:\n${log}`)), 20_000);
    child.stderr.on('data', (d) => {
      log += d.toString();
      if (log.includes('listening')) {
        clearTimeout(timer);
        ok();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new GameError('backend_start', `the backend exited (${code}):\n${log}`));
    });
  });
  const api = async (path, body) => {
    const r = await fetch(`${origin}/api/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    return await fn({ api, exportRoot });
  } finally {
    const exited = new Promise((ok) => child.once('exit', ok));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
}

export async function createGame({ gameDir, projectId, name, template }) {
  if (!PROJECT_ID_RE.test(projectId)) throw new GameError('usage', `"${projectId}" is not a project id (lowercase letters, digits, - and _)`);
  if (existsSync(join(gameDir, 'game.json'))) throw new GameError('game_exists', `${gameDir} is already a game (game.json exists)`);
  mkdirSync(gameDir, { recursive: true });
  const created = await withBackend(gameDir, async ({ api }) => api('/admin/projects', { projectId, name: name ?? projectId, ...(template ? { template } : {}) }));
  if (created.status !== 201) throw new GameError('create_failed', `creating the project failed (${created.status}): ${JSON.stringify(created.json.error ?? created.json)}`);
  const engine = engineIdentity();
  const game = {
    gameVersion: 1,
    gameId: projectId,
    name: name ?? projectId,
    projectId,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(template ? { template } : {}),
    engine: { version: engine.version, commit: engine.commit, lockfileDigest: engine.lockfileDigest },
  };
  writeFileSync(join(gameDir, 'game.json'), `${JSON.stringify(game, null, 2)}\n`);
  if (!existsSync(join(gameDir, '.gitignore'))) {
    writeFileSync(join(gameDir, '.gitignore'), '# Thirdlight game: process state, build output, backups and the owner token stay out of git\nprojects/*/.thirdlight/\nexports/\nbackups/\nowner-token\n');
  }
  return game;
}

export async function exportGame({ gameDir, out }) {
  const game = readGame(gameDir);
  const problems = checkPin(game);
  if (problems.length > 0) throw new GameError('engine_pin_mismatch', `this engine does not match the game's pin:\n  ${problems.join('\n  ')}\nUse the pinned engine, or run: node tools/game.mjs check ${gameDir} --repin`);
  const r = await withBackend(gameDir, async ({ api, exportRoot }) => {
    const res = await api(`/admin/projects/${game.projectId}/export`, {});
    if (res.status !== 200) throw new GameError('export_failed', `export failed (${res.status}): ${JSON.stringify(res.json.error ?? res.json)}`);
    return join(exportRoot, String(res.json.outputDir));
  });
  if (out !== undefined) {
    const { cpSync } = await import('node:fs');
    mkdirSync(out, { recursive: true });
    cpSync(r, out, { recursive: true });
    return out;
  }
  return r;
}

function parse(argv) {
  const opts = { positional: [], id: null, name: null, template: null, out: null, repin: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new GameError('usage', `${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--id') opts.id = next();
    else if (a === '--name') opts.name = next();
    else if (a === '--template') opts.template = next();
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--repin') opts.repin = true;
    else if (a === '--host' || a === '--port' || a === '--preview-port') opts.rest.push(a, next());
    else if (a.startsWith('--')) throw new GameError('usage', `unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const opts = parse(rest);
    const gameDir = opts.positional[0] !== undefined ? resolve(opts.positional[0]) : null;
    if (gameDir === null) throw new GameError('usage', `${cmd ?? 'the command'} needs a game directory`);
    if (cmd === 'create') {
      if (!opts.id) throw new GameError('usage', 'create needs --id <projectId>');
      const game = await createGame({ gameDir, projectId: opts.id, name: opts.name ?? undefined, template: opts.template ?? undefined });
      process.stdout.write(`game: ${gameDir}\n  project ${game.projectId}${game.template ? ` from template ${game.template}` : ''}\n  engine ${game.engine.version} @ ${game.engine.commit.slice(0, 12)}\n  edit it: node tools/start.mjs --data-root ${gameDir}\n`);
    } else if (cmd === 'check') {
      const game = readGame(gameDir);
      const engine = engineIdentity();
      const problems = checkPin(game, engine);
      if (opts.repin) {
        game.engine = { version: engine.version, commit: engine.commit, lockfileDigest: engine.lockfileDigest };
        writeFileSync(join(gameDir, 'game.json'), `${JSON.stringify(game, null, 2)}\n`);
        process.stdout.write(`check: re-pinned to engine ${engine.version} @ ${engine.commit.slice(0, 12)}${engine.dirty ? ' (working tree has uncommitted changes)' : ''}\n`);
      } else if (problems.length > 0) {
        process.stderr.write(`check: MISMATCH\n  ${problems.join('\n  ')}\n`);
        process.exit(1);
      } else {
        process.stdout.write(`check: OK — engine ${engine.version} @ ${engine.commit.slice(0, 12)} matches the pin${engine.dirty ? ' (working tree has uncommitted changes)' : ''}\n`);
      }
    } else if (cmd === 'export') {
      const dir = await exportGame({ gameDir, out: opts.out ?? undefined });
      process.stdout.write(`export: ${dir}\n  serve that directory statically; it needs nothing else.\n`);
    } else if (cmd === 'start') {
      const child = spawn(process.execPath, [join(ENGINE_ROOT, 'tools', 'start.mjs'), '--data-root', gameDir, ...opts.rest], { stdio: 'inherit' });
      process.on('SIGINT', () => child.kill('SIGINT'));
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.on('exit', (code) => process.exit(code ?? 0));
    } else {
      throw new GameError('usage', 'command must be create | check | export | start');
    }
  } catch (e) {
    if (e instanceof GameError) {
      process.stderr.write(`game: ${e.message}\n`);
      if (e.code === 'usage') process.stderr.write('usage: node tools/game.mjs create <dir> --id <projectId> [--name N] [--template T] | check <dir> [--repin] | export <dir> [--out DIR] | start <dir>\n');
      process.exit(e.code === 'usage' ? 2 : 1);
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
