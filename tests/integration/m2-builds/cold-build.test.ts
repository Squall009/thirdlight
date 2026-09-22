/**
 * Packet 33 — cold-build reliability (M1 U-2).
 *
 * The behavior compiler runs inside the deployed backend bundle, whose build
 * (packet 13) bundles the workspace packages but keeps `esbuild` EXTERNAL with
 * a `createRequire` banner (esbuild's JS API resolves its platform binary
 * relative to its own file). This test reproduces that arrangement exactly,
 * bundles the cold-build harness with it, and runs the real compile in
 * REPEATED FRESH NODE PROCESSES, recording measured successes/failures.
 *
 * No transient failure is papered over: any non-zero exit or digest divergence
 * fails the test with the raw transcript attached.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import esbuild from 'esbuild';

import { BUILD_FIXTURES, REPO_ROOT, makeRoot } from './helpers';

const RUNS = 6;

describe('packet 33 — cold builds in fresh processes (deployed esbuild-external arrangement)', () => {
  it(`compiles the valid sample ${RUNS}× in fresh processes with identical digests`, async () => {
    const outDir = join(REPO_ROOT, 'dist', 'cold-build-harness');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const harnessOut = join(outDir, 'harness.mjs');
    // The exact packet-13 backend deployment arrangement (tools/build.mjs).
    await esbuild.build({
      entryPoints: [join(REPO_ROOT, 'tests/m2-builds/cold-harness.ts')],
      outfile: harnessOut,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'bundle',
      treeShaking: false,
      sourcemap: false,
      minify: false,
      external: ['esbuild'],
      banner: {
        js: 'import { createRequire as __tl_createRequire } from "node:module"; const require = __tl_createRequire(import.meta.url);',
      },
    });
    const containerPath = join(BUILD_FIXTURES, 'valid/sample.json');
    const declarationPath = join(outDir, 'declaration.json');
    const expected = JSON.parse(readFileSync(join(BUILD_FIXTURES, 'expected.json'), 'utf8')) as {
      declaration: unknown;
      cases: { container: string; expect: Record<string, unknown> }[];
    };
    writeFileSync(declarationPath, JSON.stringify(expected.declaration));
    const expectedSample = expected.cases.find((c) => c.container === 'valid/sample.json')?.expect as Record<string, unknown>;

    const { spawnSync } = await import('node:child_process');
    const results: { run: number; status: number | null; stdout: string; stderr: string; parsed?: Record<string, unknown> }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const proc = spawnSync(process.execPath, [harnessOut, containerPath, declarationPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const stdout = (proc.stdout ?? '').trim();
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(stdout.split('\n').pop() as string) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      results.push({ run: i, status: proc.status, stdout, stderr: (proc.stderr ?? '').trim(), parsed });
    }
    // Honest transcript (measured, not invented) for the evidence manifest.
    writeFileSync(join(outDir, 'cold-build-transcript.json'), `${JSON.stringify({ arrangement: 'packet-13 backend node bundle (external esbuild + createRequire banner)', runs: RUNS, results }, null, 2)}\n`);

    const failures = results.filter((r) => r.status !== 0 || r.parsed?.['ok'] !== true);
    expect(failures.map((f) => ({ run: f.run, status: f.status, stderr: f.stderr }))).toEqual([]);
    const digests = new Set(results.map((r) => r.parsed?.['outputDigest']));
    expect(digests.size).toBe(1);
    const first = results[0]?.parsed as Record<string, unknown>;
    expect(first['outputDigest']).toBe(expectedSample['outputDigest']);
    expect(first['manifestDigest']).toBe(expectedSample['manifestDigest']);
    expect(first['outputByteLength']).toBe(expectedSample['outputByteLength']);

    // The sentinel: the deployed arrangement also never executes the source.
    const sentinel = spawnSync(process.execPath, [harnessOut, 'sentinel'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(sentinel.status).toBe(0);
    expect(JSON.parse((sentinel.stdout ?? '').trim())).toMatchObject({ sentinel: true, ok: true, executed: false });

    // The deployed backend bundle is built by `npm run build` (tools/build.mjs,
    // the same arrangement reproduced above) and inspected in the packet-33
    // evidence manifest (`docs/acceptance/evidence-m2/33/`), not here: a stale
    // dist tree must not fail the cold-build measurement.
    rmSync(outDir, { recursive: true, force: true });
  }, 180_000);

  it('keeps the disposable cold-build root clean', () => {
    const root = makeRoot('cold');
    expect(existsSync(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
});
