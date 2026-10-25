/**
 * Build the simulation benchmark (sim.ts) into one Node bundle
 * under dist/perf/ (workspace packages bundled, third-party packages resolved
 * from the repository's node_modules) and run it in a child process with
 * `--expose-gc` and a large young generation (fewer collections inside the
 * allocation windows).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { REPO } from './backend';
import type { SimResult } from './sim';

export interface SimOptions {
  warmup?: number;
  steps?: number;
  window?: number;
  windows?: number;
}

const bundled = new Map<string, Promise<string>>();

/** Bundle sim.ts once per process. */
export function simBundle(): Promise<string> {
  return perfBundle('sim');
}

/** Bundle one headless benchmark (`tools/perf/<name>.ts`) into dist/perf/<name>.mjs, once per process. */
export function perfBundle(name: string): Promise<string> {
  const known = bundled.get(name);
  if (known !== undefined) return known;
  const made = (async () => {
    const esbuild = await import('esbuild');
    const out = join(REPO, 'dist', 'perf', `${name}.mjs`);
    mkdirSync(join(REPO, 'dist', 'perf'), { recursive: true });
    await esbuild.build({
      entryPoints: [join(REPO, 'tools', 'perf', `${name}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // Written aside and renamed into place: a harness and a test bundling at
      // the same time never start a child on a half-written file.
      outfile: `${out}.${process.pid}.tmp`,
      logLevel: 'warning',
      plugins: [
        {
          name: 'external-third-party',
          setup(build) {
            // Workspace packages (TypeScript sources) are bundled; everything else stays a package import.
            // Rapier is pinned per package (packages/physics-rapier/node_modules), while the root holds an
            // older transitive copy: a bare import from dist/perf would load that one, so Rapier is
            // resolved from the importing package and imported by its file path.
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (args.path.startsWith('@thirdlight/')) return undefined;
              if (args.path.startsWith('@dimforge/')) return { path: createRequire(join(args.resolveDir, 'index.js')).resolve(args.path), external: true };
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    renameSync(`${out}.${process.pid}.tmp`, out);
    return out;
  })();
  bundled.set(name, made);
  return made;
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
