/**
 * The real backend deployment bundle (dist/backend/backend.mjs) as a child
 * process on free ports over a given data root: the one launcher behind the
 * browser tests' backend (tests/e2e/backend.ts) and the benchmarks'
 * (tools/perf/backend.ts). The ports are fixed for the process's life: the
 * backend's origins are in its environment before it binds, and a restart
 * binds the same ports again (a page's URL names them).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';

import { launchOnFreePorts, type BackendPorts } from '../../tools/perf/ports';

/** The engine checkout (dist/ is built there). */
export const REPO = resolve(import.meta.dirname, '..', '..');

export interface BackendProcessOptions {
  dataRoot: string;
  exportRoot: string;
  /** The owner token (project and admin routes). */
  token: string;
  /** More environment, over the launcher's own. */
  env?: Readonly<Record<string, string>>;
  /** How long the backend may take to say it listens. */
  startTimeoutMs: number;
  /** After SIGTERM, how long before SIGKILL. */
  killAfterMs: number;
  /** Keep only the stderr's tail while waiting (a large project logs much). */
  tailLog?: boolean;
}

export interface BackendProcess {
  ports: BackendPorts;
  origin: string;
  previewOrigin: string;
  /** The running process's id (-1 when it has none). */
  pid: () => number;
  /** Stop the process (SIGTERM, then SIGKILL); its data stays. */
  halt: () => Promise<void>;
  /** Start it again on the same ports and data. */
  restart: () => Promise<void>;
}

function backendEnv(o: BackendProcessOptions, ports: BackendPorts): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${ports.authoring}`;
  return {
    ...process.env,
    THIRDLIGHT_DATA_ROOT: o.dataRoot,
    THIRDLIGHT_AUTHORING_ORIGIN: origin,
    THIRDLIGHT_PREVIEW_ORIGIN: `http://127.0.0.1:${ports.preview}`,
    THIRDLIGHT_AUTHORING_BIND: `127.0.0.1:${ports.authoring}`,
    THIRDLIGHT_PREVIEW_BIND: `127.0.0.1:${ports.preview}`,
    THIRDLIGHT_AUTHORING_ORIGINS: origin,
    THIRDLIGHT_EDITOR_DIR: join(REPO, 'dist', 'editor'),
    THIRDLIGHT_PREVIEW_DIR: join(REPO, 'dist', 'preview'),
    THIRDLIGHT_OWNER_TOKEN: o.token,
    THIRDLIGHT_EXPORT_ROOT: o.exportRoot,
    THIRDLIGHT_ENGINE_ROOT: REPO,
    // No headless editor unless a test asks for one.
    THIRDLIGHT_HEADLESS: 'off',
    ...o.env,
  };
}

/** Start the backend on fresh ports (picked again when one was taken before the bind). */
export async function launchBackend(o: BackendProcessOptions): Promise<BackendProcess> {
  let proc: ChildProcess | null = null;
  const launch = async (env: NodeJS.ProcessEnv): Promise<void> => {
    const child = spawn(process.execPath, [join(REPO, 'dist', 'backend', 'backend.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    proc = child;
    let log = '';
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`backend did not start: ${log}`)), o.startTimeoutMs);
      child.stderr!.on('data', (d: Buffer) => {
        log += d.toString();
        if (o.tailLog === true && log.length > 20_000) log = log.slice(-10_000);
        if (log.includes('listening')) {
          clearTimeout(timer);
          ok();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`backend exited (${code}): ${log}`));
      });
    });
  };
  const halt = async (): Promise<void> => {
    const p = proc;
    proc = null;
    if (!p || p.exitCode !== null) return;
    const exited = new Promise<void>((ok) => p.once('exit', () => ok()));
    p.kill('SIGTERM');
    const timer = setTimeout(() => p.kill('SIGKILL'), o.killAfterMs);
    await exited;
    clearTimeout(timer);
  };
  const { ports } = await launchOnFreePorts((p) => launch(backendEnv(o, p)));
  const env = backendEnv(o, ports);
  return {
    ports,
    origin: `http://127.0.0.1:${ports.authoring}`,
    previewOrigin: `http://127.0.0.1:${ports.preview}`,
    pid: () => (proc as ChildProcess | null)?.pid ?? -1,
    halt,
    restart: async () => {
      await halt();
      await launch(env);
    },
  };
}
