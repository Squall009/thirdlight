/**
 * Phase 9.6: the final light bake — Blender Cycles on a bake host.
 *
 * The editor sends a bake package (its scene's static meshes in world space,
 * where each lightmap goes, the baked/mixed lights). One bake runs at a time:
 * the package and the bake script go to the bake host (`scp`), Blender bakes
 * there (`ssh`; OptiX when the GPU has room, else the CPU) and the lightmap
 * atlases come back as PNGs, which the editor then publishes as texture
 * assets. With the host `local` Blender runs on this machine (tests, or a
 * backend on the GPU machine itself). Work files live under
 * `<dataRoot>/cache/bakes` and are removed when a job is forgotten.
 *
 * Package format (little-endian): "TLBK", u32 version 1, u32 header length,
 * the header JSON (UTF-8), zero padding to 4 bytes, then the data blob the
 * header's byte offsets point into.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CYCLES_BAKE_SCRIPT } from './cycles-bake-script';

export const BAKE_PACKAGE_BYTES_MAX = 256 * 1024 * 1024;
const HEADER_BYTES_MAX = 16 * 1024 * 1024;
const OBJECTS_MAX = 4096;
const ATLASES_MAX = 16;
const ATLAS_EDGE_MAX = 4096;
const JOB_KEEP_MS = 60 * 60 * 1000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface BakeHostConfig {
  /** `user@host` (ssh), `local` (this machine), or absent (no final bake). */
  host?: string;
  /** Blender on the bake host. */
  blender: string;
  /** Kill a bake after this long. */
  timeoutMs: number;
  /** Work files (`<dataRoot>/cache/bakes`). */
  workRoot: string;
  /** Remote work folder parent (ssh hosts). */
  remoteRoot?: string;
}

export type BakeJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BakeJobView {
  jobId: string;
  projectId: string;
  state: BakeJobState;
  progress: { done: number; total: number };
  message: string | null;
  atlases: number;
  startedAt: number;
  millis: number | null;
  device: string | null;
}

export interface BakeService {
  status(): { ok: true; host: string } | { ok: false; message: string };
  /** Start a bake; refused while another one runs or when the package is malformed. */
  start(projectId: string, pkg: Uint8Array): { ok: true; jobId: string } | { ok: false; code: string; message: string };
  job(projectId: string, jobId: string): BakeJobView | null;
  atlas(projectId: string, jobId: string, index: number): Uint8Array | null;
  cancel(projectId: string, jobId: string): boolean;
  dispose(): void;
}

/** Check the package frame and header (the bake script re-checks the blob). */
export function checkBakePackage(pkg: Uint8Array): { ok: true; atlases: number; objects: number } | { ok: false; message: string } {
  if (pkg.byteLength < 12 || pkg[0] !== 0x54 || pkg[1] !== 0x4c || pkg[2] !== 0x42 || pkg[3] !== 0x4b) return { ok: false, message: 'not a bake package (TLBK)' };
  const view = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  if (view.getUint32(4, true) !== 1) return { ok: false, message: 'unknown bake package version' };
  const headerLength = view.getUint32(8, true);
  if (headerLength > HEADER_BYTES_MAX || 12 + headerLength > pkg.byteLength) return { ok: false, message: 'the bake package header is too large or truncated' };
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pkg.subarray(12, 12 + headerLength)));
  } catch {
    return { ok: false, message: 'the bake package header is not JSON' };
  }
  const h = header as { atlases?: unknown; objects?: unknown; geometries?: unknown; lights?: unknown };
  if (!Array.isArray(h.atlases) || h.atlases.length < 1 || h.atlases.length > ATLASES_MAX) return { ok: false, message: `a bake has 1–${ATLASES_MAX} atlases` };
  for (const a of h.atlases as { width?: unknown; height?: unknown }[]) {
    const ok = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= ATLAS_EDGE_MAX;
    if (!ok(a.width) || !ok(a.height)) return { ok: false, message: `atlas sizes are 16–${ATLAS_EDGE_MAX} texels` };
  }
  if (!Array.isArray(h.objects) || h.objects.length < 1 || h.objects.length > OBJECTS_MAX) return { ok: false, message: `a bake has 1–${OBJECTS_MAX} objects` };
  if (!Array.isArray(h.geometries) || !Array.isArray(h.lights)) return { ok: false, message: 'the bake package needs geometries and lights' };
  return { ok: true, atlases: h.atlases.length, objects: h.objects.length };
}

function isPng(b: Uint8Array): boolean {
  return b.byteLength > 33 && PNG_SIGNATURE.every((x, i) => b[i] === x);
}

interface Job {
  view: BakeJobView;
  dir: string;
  atlases: Uint8Array[];
  kill: (() => void) | null;
  log: string;
}

/** Run a command; stdout lines go to `onLine`. */
function run(cmd: string, args: string[], timeoutMs: number, onLine: (line: string) => void, register: (kill: () => void) => void): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let pending = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, output: '', timedOut: false, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    register(() => child.kill('SIGKILL'));
    const keep = (d: Buffer): void => {
      output = (output + d.toString()).slice(-16384);
    };
    child.stdout?.on('data', (d: Buffer) => {
      keep(d);
      pending += d.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output, timedOut, spawnError: e.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (pending !== '') onLine(pending);
      resolve({ code, output, timedOut });
    });
  });
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

export function createBakeService(config: BakeHostConfig): BakeService {
  const jobs = new Map<string, Job>();
  let running: Job | null = null;
  const forget = (): void => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j === running || now - j.view.startedAt < JOB_KEEP_MS) continue;
      rmSync(j.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  };

  const execute = async (job: Job): Promise<void> => {
    job.view.state = 'running';
    const started = Date.now();
    const host = config.host!;
    const local = host === 'local';
    const scriptPath = join(job.dir, 'cycles_bake.py');
    writeFileSync(scriptPath, CYCLES_BAKE_SCRIPT);
    const outDir = join(job.dir, 'out');
    mkdirSync(outDir, { recursive: true });
    const onLine = (line: string): void => {
      const m = /^TL_PROGRESS (\d+)\/(\d+)/.exec(line);
      if (m !== null) job.view.progress = { done: Number(m[1]), total: Number(m[2]) };
      const d = /^TL_DEVICE (.+)$/.exec(line);
      if (d !== null) job.view.device = d[1]!.trim();
    };
    const register = (kill: () => void): void => {
      job.kill = kill;
    };
    const cancelled = (): boolean => (job.view.state as BakeJobState) === 'cancelled';
    const fail = (message: string): void => {
      if (cancelled()) return;
      job.view.state = 'failed';
      job.view.message = message;
    };
    const left = (): number => Math.max(1000, config.timeoutMs - (Date.now() - started));
    try {
      let remoteDir = '';
      let remoteOut = '';
      if (!local) {
        remoteDir = `${config.remoteRoot ?? '/tmp/thirdlight-bake'}/${job.view.jobId}`;
        remoteOut = `${remoteDir}/out`;
        const mk = await run('ssh', [...SSH_OPTS, host, `mkdir -p '${remoteOut}'`], 30_000, () => {}, register);
        if (mk.code !== 0) return fail(`the bake host ${host} is not reachable over ssh: ${(mk.spawnError ?? mk.output).trim().slice(-300)}`);
        const cp = await run('scp', [...SSH_OPTS, '-q', join(job.dir, 'package.tlbk'), scriptPath, `${host}:${remoteDir}/`], left(), () => {}, register);
        if (cp.code !== 0) return fail(`copying the bake to ${host} failed: ${cp.output.trim().slice(-300)}`);
      }
      const pkgPath = local ? join(job.dir, 'package.tlbk') : `${remoteDir}/package.tlbk`;
      const script = local ? scriptPath : `${remoteDir}/cycles_bake.py`;
      const blenderArgs = ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', pkgPath, local ? outDir : remoteOut];
      const r = local
        ? await run(config.blender, blenderArgs, left(), onLine, register)
        : await run('ssh', [...SSH_OPTS, host, [config.blender, ...blenderArgs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')], left(), onLine, register);
      job.log = r.output;
      if (cancelled()) return;
      if (r.timedOut) return fail(`the bake took longer than ${Math.round(config.timeoutMs / 60000)} minutes`);
      if (r.code !== 0) return fail(`Blender failed: ${(r.spawnError ?? r.output).trim().split('\n').slice(-6).join(' | ').slice(-600)}`);
      if (!local) {
        const back = await run('scp', [...SSH_OPTS, '-q', `${host}:${remoteOut}/*.png`, `${outDir}/`], left(), () => {}, register);
        void run('ssh', [...SSH_OPTS, host, `rm -rf '${remoteDir}'`], 30_000, () => {}, () => {});
        if (back.code !== 0) return fail(`copying the lightmaps back failed: ${back.output.trim().slice(-300)}`);
      }
      const files = readdirSync(outDir).filter((f) => /^atlas-\d+\.png$/.test(f)).sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
      const atlases = files.map((f) => new Uint8Array(readFileSync(join(outDir, f))));
      if (atlases.length !== job.view.atlases || !atlases.every(isPng)) return fail(`the bake returned ${atlases.length} of ${job.view.atlases} lightmaps`);
      job.atlases = atlases;
      job.view.state = 'done';
      job.view.millis = Date.now() - started;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      job.kill = null;
      rmSync(join(job.dir, 'package.tlbk'), { force: true });
    }
  };

  return {
    status() {
      if (config.host === undefined || config.host === '') return { ok: false, message: 'no bake host is configured (set THIRDLIGHT_BAKE_HOST to user@host or local, and THIRDLIGHT_BAKE_BLENDER)' };
      return { ok: true, host: config.host };
    },
    start(projectId, pkg) {
      forget();
      if (config.host === undefined || config.host === '') return { ok: false, code: 'bake_unavailable', message: 'no bake host is configured' };
      if (running !== null) return { ok: false, code: 'bake_busy', message: 'another bake is running; try again when it is done' };
      const checked = checkBakePackage(pkg);
      if (!checked.ok) return { ok: false, code: 'bake_package_invalid', message: checked.message };
      const jobId = `bake-${randomBytes(8).toString('hex')}`;
      const dir = join(config.workRoot, jobId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.tlbk'), pkg);
      const job: Job = {
        view: { jobId, projectId, state: 'queued', progress: { done: 0, total: 1 }, message: null, atlases: checked.atlases, startedAt: Date.now(), millis: null, device: null },
        dir,
        atlases: [],
        kill: null,
        log: '',
      };
      jobs.set(jobId, job);
      running = job;
      void execute(job).finally(() => {
        running = null;
      });
      return { ok: true, jobId };
    },
    job(projectId, jobId) {
      const j = jobs.get(jobId);
      return j !== undefined && j.view.projectId === projectId ? { ...j.view, progress: { ...j.view.progress } } : null;
    },
    atlas(projectId, jobId, index) {
      const j = jobs.get(jobId);
      if (j === undefined || j.view.projectId !== projectId || j.view.state !== 'done') return null;
      return j.atlases[index] ?? null;
    },
    cancel(projectId, jobId) {
      const j = jobs.get(jobId);
      if (j === undefined || j.view.projectId !== projectId || (j.view.state !== 'running' && j.view.state !== 'queued')) return false;
      j.view.state = 'cancelled';
      j.view.message = 'the bake was cancelled';
      j.kill?.();
      // Killing ssh does not stop Blender on the host: stop it there as well.
      if (config.host !== undefined && config.host !== 'local') {
        void run('ssh', [...SSH_OPTS, config.host, `pkill -f '${config.remoteRoot ?? '/tmp/thirdlight-bake'}/${jobId}' ; rm -rf '${config.remoteRoot ?? '/tmp/thirdlight-bake'}/${jobId}'`], 30_000, () => {}, () => {});
      }
      return true;
    },
    dispose() {
      running?.kill?.();
      for (const j of jobs.values()) if (existsSync(j.dir)) rmSync(j.dir, { recursive: true, force: true });
      jobs.clear();
    },
  };
}
