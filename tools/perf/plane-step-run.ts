/**
 * Run the side-scroller physics benchmark (plane-step.ts) on both backends
 * (3D also plane-locked), each in its own child process (the WASM memory of one backend never counts
 * against the other), and print one JSON line per run.
 *
 *   node tools/perf/run.mjs plane-step [--levels 1,4] [--steps 2400] [--warmup 240] [--rounds 3] [--seed 7] [--arcade]
 *
 * `--arcade` gives every run the arcade profile's step-up (autostep; on 3D by the 2D rule).
 */
import { spawn } from 'node:child_process';

import { perfBundle } from './sim-run';

function child(bundle: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((ok) => {
    const c = spawn(process.execPath, ['--expose-gc', '--max-semi-space-size=64', bundle], { env: { ...process.env, TL_PLANE: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr.on('data', (d: Buffer) => (err += d.toString()));
    c.on('exit', () => {
      try {
        ok(JSON.parse(out.trim().split('\n').pop() ?? '') as Record<string, unknown>);
      } catch {
        ok({ ok: false, error: `no result: ${out.slice(-400)} ${err.slice(-800)}` });
      }
    });
  });
}

export async function runPlaneStepCli(argv: string[]): Promise<void> {
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1]! : fallback;
  };
  const levels = flag('levels', '1,4').split(',').map(Number);
  const rounds = Number(flag('rounds', '3'));
  const base = { warmup: Number(flag('warmup', '240')), steps: Number(flag('steps', '2400')), seed: Number(flag('seed', '7')), arcade: argv.includes('--arcade') };
  const bundle = await perfBundle('plane-step');
  // Rounds interleave the backends so host drift lands on both alike.
  for (let r = 0; r < rounds; r += 1) {
    for (const lv of levels) {
      // 3D twice: as the 41.0 baseline ran it (nothing locked), and plane-locked.
      for (const [dim, plane] of [[2, false], [3, false], [3, true]] as const) {
        const res = await child(bundle, { ...base, dim, levels: lv, plane });
        process.stdout.write(`${JSON.stringify({ round: r + 1, ...res })}\n`);
        if (res['ok'] !== true) process.exitCode = 1;
      }
    }
  }
}
