/**
 * Parallel backend starts, to show whether picking ports can still lose them
 * (EADDRINUSE between the pick and the backend's bind).
 *
 *   node tools/perf/run.mjs ports [--parallel 16] [--rounds 8] [--picker reserved|ephemeral]
 *                                 [--attempts N] [--churn 64] [--listeners 16]
 *
 * Each round starts `--parallel` backends at once (each on a throwaway data
 * root under ~/.cache/thirdlight-perf/ports/), waits for them to listen, then
 * stops them. `--churn` keeps that many client connections opening and
 * closing meanwhile (the browser's and fetch's sockets in an e2e run take
 * their local ports from the ephemeral range), `--listeners` that many
 * servers on port 0 (the specs' static servers for exports, other pickers). `--picker ephemeral` with
 * `--attempts 1` is how the helpers picked ports before; the default is
 * theirs now. Prints the starts, the retries and the starts lost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';

import { PERF_ROOT, REPO } from './backend';
import { launchOnFreePorts, lostPort, PORT_ATTEMPTS, type BackendPorts } from './ports';

function startOn(dataRoot: string, ports: BackendPorts): Promise<ChildProcess> {
  const origin = `http://127.0.0.1:${ports.authoring}`;
  const child = spawn(process.execPath, [join(REPO, 'dist', 'backend', 'backend.mjs')], {
    env: {
      ...process.env,
      THIRDLIGHT_DATA_ROOT: dataRoot,
      THIRDLIGHT_AUTHORING_ORIGIN: origin,
      THIRDLIGHT_PREVIEW_ORIGIN: `http://127.0.0.1:${ports.preview}`,
      THIRDLIGHT_AUTHORING_BIND: `127.0.0.1:${ports.authoring}`,
      THIRDLIGHT_PREVIEW_BIND: `127.0.0.1:${ports.preview}`,
      THIRDLIGHT_AUTHORING_ORIGINS: origin,
      THIRDLIGHT_EDITOR_DIR: join(REPO, 'dist', 'editor'),
      THIRDLIGHT_PREVIEW_DIR: join(REPO, 'dist', 'preview'),
      THIRDLIGHT_OWNER_TOKEN: `ports-${Math.random().toString(16).slice(2)}`,
      THIRDLIGHT_EXPORT_ROOT: join(dataRoot, 'exports'),
      THIRDLIGHT_ENGINE_ROOT: REPO,
      THIRDLIGHT_HEADLESS: 'off',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`backend did not start: ${log}`));
    }, 60_000);
    child.stderr!.on('data', (d: Buffer) => {
      log += d.toString();
      if (log.includes('listening')) {
        clearTimeout(timer);
        ok(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`backend exited (${code}): ${log}`));
    });
  });
}

const stop = (child: ChildProcess): Promise<void> =>
  new Promise((ok) => {
    if (child.exitCode !== null) return ok();
    child.once('exit', () => ok());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  });

/** Servers on port 0 opening and closing until stopped (each holds its port a moment). */
function listenerChurn(count: number): () => Promise<void> {
  let running = true;
  const loop = async (): Promise<void> => {
    while (running) {
      const server = createServer();
      await new Promise<void>((ok) => {
        server.once('error', () => ok());
        server.listen(0, '127.0.0.1', () => ok());
      });
      await new Promise((ok) => setTimeout(ok, 20 + Math.random() * 200));
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
  const loops = Array.from({ length: count }, () => loop());
  return async () => {
    running = false;
    await Promise.all(loops);
  };
}

/** Client connections opening and closing against a local listener until stopped. */
async function churn(count: number): Promise<() => Promise<void>> {
  if (count <= 0) return async () => undefined;
  const server = createServer((s) => s.on('error', () => undefined));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  let running = true;
  const live = new Set<Socket>();
  const loop = async (): Promise<void> => {
    while (running) {
      await new Promise<void>((ok) => {
        const s = connect(port, '127.0.0.1');
        live.add(s);
        const done = (): void => {
          live.delete(s);
          s.destroy();
          ok();
        };
        s.once('error', done);
        s.once('connect', () => setTimeout(done, 5 + Math.random() * 40));
      });
    }
  };
  const loops = Array.from({ length: count }, () => loop());
  return async () => {
    running = false;
    await Promise.all(loops);
    for (const s of live) s.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
  };
}

export async function runPortStress(argv: string[]): Promise<void> {
  const opt = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  const parallel = Number(opt('parallel', '16'));
  const rounds = Number(opt('rounds', '8'));
  const picker = opt('picker', 'reserved') === 'ephemeral' ? 'ephemeral' : 'reserved';
  const attempts = Number(opt('attempts', String(PORT_ATTEMPTS)));
  const root = join(PERF_ROOT, 'ports');
  mkdirSync(root, { recursive: true });
  const stopChurn = await churn(Number(opt('churn', '64')));
  const stopListeners = listenerChurn(Number(opt('listeners', '16')));
  let started = 0;
  let lost = 0;
  let retries = 0;
  const other: string[] = [];
  try {
    for (let r = 0; r < rounds; r++) {
      const results = await Promise.allSettled(
        Array.from({ length: parallel }, async (_, i) => {
          const dataRoot = join(root, `r${r}-${i}`);
          mkdirSync(dataRoot, { recursive: true });
          try {
            const { value } = await launchOnFreePorts((ports) => startOn(dataRoot, ports), { attempts, picker, onRetry: () => (retries += 1) });
            await stop(value);
          } finally {
            rmSync(dataRoot, { recursive: true, force: true });
          }
        }),
      );
      for (const res of results) {
        if (res.status === 'fulfilled') started += 1;
        else if (lostPort(res.reason)) lost += 1;
        else other.push(String(res.reason).slice(0, 300));
      }
      console.log(`ports: round ${r + 1}/${rounds}: started ${started}, lost ${lost}, retries ${retries}`);
    }
  } finally {
    await stopChurn();
    await stopListeners();
  }
  console.log(JSON.stringify({ picker, attempts, parallel, rounds, started, lost, retries, otherFailures: other.length }));
  for (const o of other) console.log(`ports: other failure: ${o}`);
  if (lost > 0 || other.length > 0) process.exitCode = 1;
}
