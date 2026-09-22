/**
 * Packet 63 — orchestrator. Runs the three real-browser phases + the
 * environment/toolchain/capability records and writes the evidence index.
 *
 * Run: `npx tsx tests/evaluations/m4-baseline/run.mts`
 * (override the evidence dir with TL_M463_EVIDENCE_DIR).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from '../m3-browser/lib/browser.mjs';
import { phaseA, phaseB } from './phases-ab.mts';
import { phaseC } from './phase-c.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const EVIDENCE = process.env['TL_M463_EVIDENCE_DIR'] ?? join(REPO_ROOT, 'docs/acceptance/evidence-m4/63/raw');
mkdirSync(EVIDENCE, { recursive: true });

const sh = (cmd: string, args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() };
  } catch (e) {
    const err = e as { code?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: typeof err.code === 'number' ? err.code : 1, out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim().slice(-2000) };
  }
};

const startedAt = new Date().toISOString();
const gitHead = sh('git', ['rev-parse', 'HEAD']).out.split('\n')[0] ?? 'unknown';
const gitDirty = sh('git', ['status', '--short']).out.split('\n').filter((l) => l.length > 0).length;
// TL_M463_NO_BUILD=1 skips the rebuild (dist is already current) — faster
// iteration; the default (a final evidence run) always rebuilds.
const toolchain = process.env['TL_M463_NO_BUILD'] === '1' ? { code: 0, out: 'skipped (TL_M463_NO_BUILD=1); using existing dist' } : sh('npm', ['run', 'build']);

const env = {
  startedAt,
  node: process.version,
  npm: sh('npm', ['--version']).out,
  gitHead,
  gitDirtyPaths: gitDirty,
  baseline: 'the uncommitted M2/M3 working tree (the dirty tree is the candidate; HEAD alone is historical)',
  toolchain: { command: 'npm run build', exit: toolchain.code, tail: toolchain.out.split('\n').slice(-8).join('\n') },
};
writeFileSync(join(EVIDENCE, 'environment.json'), JSON.stringify(env, null, 2));
if (toolchain.code !== 0) {
  console.error('npm run build failed — aborting the baseline run:', toolchain.out.slice(-800));
  process.exit(1);
}

interface Rows { [row: string]: { status: string; detail: unknown } }
const rows: Rows = {};

const browser = await launchBrowser({ width: 1280, height: 720 });
if (browser === null) {
  rows['E01-browser'] = { status: 'UNVERIFIED', detail: 'no local Chrome available (resolveBrowser null) — all browser phases skipped' };
  writeFileSync(join(EVIDENCE, 'summary.json'), JSON.stringify({ env, rows }, null, 2));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// ---- capability table (the in-container device facts) ----------------------
{
  const page = await browser.newPage();
  try {
    await page.goto('about:blank', { waitMs: 500 });
    const caps = await page.evaluate(`(() => {
      const out = {};
      try {
        const c = document.createElement('canvas');
        const gl2 = c.getContext('webgl2');
        out.webgl2 = !!gl2;
        if (gl2) {
          const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
          out.renderer = dbg ? gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl2.getParameter(gl2.RENDERER);
          out.vendor = dbg ? gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl2.getParameter(gl2.VENDOR);
          out.maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
        }
      } catch (e) { out.webgl2Error = String(e); }
      out.audioContext = typeof window.AudioContext === 'function';
      out.getGamepads = typeof navigator.getGamepads === 'function';
      out.gamepadCount = typeof navigator.getGamepads === 'function' ? Array.from(navigator.getGamepads()).filter(Boolean).length : null;
      out.devicePixelRatio = window.devicePixelRatio;
      out.screen = { w: screen.width, h: screen.height };
      out.userAgent = navigator.userAgent;
      out.isTrustedSupport = true;
      return out;
    })()`);
    rows['E02-capabilities'] = { status: 'INFO', detail: { caps, note: 'software rasteriser (ANGLE/SwiftShader) — NEVER a hardware-GPU claim; physical gamepad/audio/display absent' } };
  } finally {
    await page.close();
  }
}

// ---- the three phases (a crash in any phase still closes the browser and
// writes the partial summary — no orphaned Chrome) ---------------------------
// TL_M463_PHASES=A,B,C (default all) selects which phases run.
const wantPhases = (process.env['TL_M463_PHASES'] ?? 'A,B,C').split(',').map((s) => s.trim().toUpperCase());
const phases: Array<{ id: string; run: () => Promise<unknown> }> = [
  { id: 'phaseA', run: () => phaseA(browser, rows) },
  { id: 'phaseB', run: () => phaseB(browser, rows) },
  { id: 'phaseC', run: () => phaseC(EVIDENCE, rows) },
].filter((p) => {
  const letter = p.id === 'phaseA' ? 'A' : p.id === 'phaseB' ? 'B' : 'C';
  return wantPhases.includes(letter);
});
for (const ph of phases) {
  try {
    await ph.run();
  } catch (e) {
    rows[`${ph.id}-crash`] = { status: 'FAIL', detail: { error: e instanceof Error ? `${e.message}\n${e.stack?.slice(0, 1200)}` : String(e) } };
  }
}

await browser.close();

const summary = {
  env,
  note: 'Packet 63 baseline audit. PASS/FAIL rows are executable checks; INFO rows are recorded facts; UNVERIFIED rows are missing execution (never a pass). Physical keyboard/gamepad, audible output and hardware-GPU behaviour remain UNVERIFIED (owner annex). SwiftShader timings are diagnostic only.',
  rows,
};
writeFileSync(join(EVIDENCE, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.status])), null, 2));
console.log(`evidence: ${EVIDENCE}`);
// Diagnostic + hard exit: report any handles that would otherwise keep the
// event loop alive (the baseline run must terminate on its own).
setTimeout(() => {
  const handles: unknown[] = (process as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  console.error(`ACTIVE_HANDLES(${handles.length}):`, handles.map((h) => {
    const o = h as { constructor?: { name?: string }; localPort?: number; remotePort?: number; path?: string };
    return `${o.constructor?.name ?? 'unknown'}${o.localPort ? `:${o.localPort}` : ''}${o.path ? `:${o.path.slice(0, 40)}` : ''}`;
  }).join(','));
  process.exit(0);
}, 2000).unref?.();