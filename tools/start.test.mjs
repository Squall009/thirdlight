/**
 * tools/start.mjs, the one-command start, run as a user runs it: on an empty
 * data root it creates the owner token (0600, never printed to a log), starts
 * the backend and prints the editor URL; the URL serves the editor page; a
 * SIGTERM stops it cleanly (exit 0, ports free, the project released); a
 * second start reuses the token. Behind a proxy, --origin/--preview-origin are
 * what it prints, what the backend accepts and what the editor page is told.
 *
 * Data roots go under ~/.cache/tmp (never /tmp, RAM on this host).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pickPorts } from './perf/ports';

const REPO = resolve(import.meta.dirname, '..');
const TEMP = join(homedir(), '.cache', 'tmp');

function portFree(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never: ${what}`);
}

const running = [];
const roots = [];
afterEach(() => {
  for (const p of running.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function dataRoot(tag) {
  mkdirSync(TEMP, { recursive: true });
  const r = mkdtempSync(join(TEMP, `tl-start-${tag}-`));
  roots.push(r);
  return r;
}

async function start(root, port, previewPort, extra = []) {
  const proc = spawn(process.execPath, [join(REPO, 'tools', 'start.mjs'), '--data-root', root, '--port', String(port), '--preview-port', String(previewPort), ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  running.push(proc);
  let log = '';
  const exited = new Promise((ok) => proc.once('exit', (code) => ok(code)));
  const editorUrl = await new Promise((ok, fail) => {
    const onData = (d) => {
      log += d.toString();
      const m = /editor:\s+(\S+)/.exec(log);
      if (m) ok(m[1]);
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    void exited.then((code) => fail(new Error(`start.mjs exited (${code}):\n${log}`)));
  });
  return { proc, editorUrl, output: () => log, exited };
}

describe('tools/start.mjs', () => {
  it('starts the backend on an empty data root, prints the editor URL (not the token), stops cleanly, and reuses the token', async () => {
    const root = dataRoot('plain');
    const { authoring: port, preview: previewPort } = await pickPorts();
    const first = await start(root, port, previewPort);
    const tokenFile = join(root, 'owner-token');
    expect(first.output()).toContain('created the owner token');
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, 'utf8').trim();
    // Not a terminal (like systemd's journal): the URL is printed without the token.
    expect(first.editorUrl).toBe(`http://127.0.0.1:${port}/`);
    expect(first.output()).not.toContain(token);
    expect(existsSync(join(root, 'projects'))).toBe(true);
    // The printed URL serves the editor page; the token opens the API (no projects yet).
    const page = await fetch(first.editorUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('window.__thirdlightEditor');
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/projects`)).status).toBe(401);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: auth })).json()).toMatchObject({ projects: [] });
    // A project from the first template, opened (as the picker does).
    const templates = (await (await fetch(`http://127.0.0.1:${port}/api/v1/templates`, { headers: auth })).json()).templates;
    const made = await fetch(`http://127.0.0.1:${port}/api/v1/admin/projects`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'first-game', name: 'First game', template: templates[0].id }) });
    expect([200, 201]).toContain(made.status);
    expect(existsSync(join(root, 'projects', 'first-game', 'project.json'))).toBe(true);
    const opened = await fetch(`http://127.0.0.1:${port}/api/v1/projects/first-game/commands`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'queryProject', projectId: 'first-game', args: {} }) });
    expect(opened.status).toBe(200);
    // SIGTERM (as systemd stops it; Ctrl+C is SIGINT through the same handler): exit 0, ports free, the project released.
    first.proc.kill('SIGTERM');
    expect(await first.exited, first.output()).toBe(0);
    await until(() => portFree(port), 'the editor port is free');
    await until(() => portFree(previewPort), 'the preview port is free');
    expect(JSON.parse(readFileSync(join(root, 'projects', 'first-game', '.thirdlight', 'ownership.json'), 'utf8')).state).toBe('released');
    // A second start reuses the token.
    const second = await start(root, port, previewPort);
    expect(second.output()).not.toContain('created the owner token');
    expect(second.editorUrl).toBe(first.editorUrl);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: auth })).json();
    expect(list.projects.map((p) => p.projectId)).toEqual(['first-game']);
    second.proc.kill('SIGTERM');
    expect(await second.exited, second.output()).toBe(0);
  }, 60_000);

  it('behind a reverse proxy: --origin/--preview-origin are printed, accepted, and handed to the editor page', async () => {
    const root = dataRoot('proxy');
    const { authoring: port, preview: previewPort } = await pickPorts();
    // "localhost" stands in for the proxy's name: another origin string than the 127.0.0.1 bind.
    const origin = `http://localhost:${port}`;
    const preview = `http://localhost:${previewPort}`;
    const started = await start(root, port, previewPort, ['--origin', origin, '--preview-origin', preview]);
    expect(started.editorUrl).toBe(`${origin}/`);
    const token = readFileSync(join(root, 'owner-token'), 'utf8').trim();
    const html = await (await fetch(started.editorUrl)).text();
    expect(html).toContain(`"previewOrigin":"${preview}"`);
    // The proxy's origin is allowed; another origin is refused.
    const asked = (o) => fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: { authorization: `Bearer ${token}`, origin: o } });
    expect((await asked(origin)).status).toBe(200);
    expect((await asked('http://elsewhere.example')).status).toBe(403);
    started.proc.kill('SIGTERM');
    expect(await started.exited, started.output()).toBe(0);
  }, 60_000);

  it('refuses one origin without the other, and the same origin for both', async () => {
    const run = (extra) =>
      new Promise((ok) => {
        const p = spawn(process.execPath, [join(REPO, 'tools', 'start.mjs'), '--data-root', dataRoot('refuse'), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.once('exit', (code) => ok({ code, err }));
      });
    const lone = await run(['--origin', 'https://editor.example']);
    expect(lone.code).toBe(2);
    expect(lone.err).toContain('--origin and --preview-origin go together');
    const same = await run(['--origin', 'https://editor.example', '--preview-origin', 'https://editor.example']);
    expect(same.code).toBe(2);
    expect(same.err).toContain('must differ');
  });
});
