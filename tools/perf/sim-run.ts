/**
 * Phase 21.1: build the simulation benchmark (sim.ts) into one Node bundle
 * under dist/perf/ (workspace packages bundled, third-party packages resolved
 * from the repository's node_modules) and run it in a child process with
 * `--expose-gc` and a large young generation (fewer collections inside the
 * allocation windows).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO } from './backend';
import type { SimResult } from './sim';

export interface SimOptions {
  warmup?: number;
  steps?: number;
  window?: number;
  windows?: number;
}

let bundled: Promise<string> | null = null;

/** Bundle sim.ts once per process. */
export function simBundle(): Promise<string> {
  if (bundled !== null) return bundled;
  bundled = (async () => {
    const esbuild = await import('esbuild');
    const out = join(REPO, 'dist', 'perf', 'sim.mjs');
    mkdirSync(join(REPO, 'dist', 'perf'), { recursive: true });
    await esbuild.build({
      entryPoints: [join(REPO, 'tools', 'perf', 'sim.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: out,
      logLevel: 'warning',
      plugins: [
        {
          name: 'external-third-party',
          setup(build) {
            // Workspace packages (TypeScript sources) are bundled; everything else stays a package import.
            build.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@thirdlight/') ? undefined : { path: args.path, external: true }));
          },
        },
      ],
    });
    return out;
  })();
  return bundled;
}

export async function runSimChild(projectDir: string, opts: SimOptions = {}): Promise<SimResult | { ok: false; error: string }> {
  const bundle = await simBundle();
  const input = { projectDir, warmup: opts.warmup ?? 240, steps: opts.steps ?? 1200, window: opts.window ?? 60, windows: opts.windows ?? 20 };
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['--expose-gc', '--max-semi-space-size=64', bundle], { env: { ...process.env, TL_SIM: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        ok(JSON.parse(line) as SimResult | { ok: false; error: string });
      } catch {
        ok({ ok: false, error: `no result: ${out.slice(-400)} ${err.slice(-800)}` });
      }
    });
  });
}
