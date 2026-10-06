/**
 * Internal edges in 2D, observed in a real Play. On the Starter
 * template's ground a neutral wall of five stacked 1 m boxes is added (its
 * right face at x = 1.5). The player walks left into it, jumps and keeps
 * pressing into the wall: it rises past the seams between the boxes and falls
 * back down to the ground, never held at a seam (not "grounded" on the
 * first seam it reaches, and not creeping down a wall on its left).
 */
import { expect, test } from './pw';

import { startBackend, type E2EBackend, controls } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('internal-edges-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function mutate(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  return be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0xed9e00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-internal-edges' }, args });
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

test('Play: jumping against a wall of stacked boxes, the player slides down past every seam to the ground', async ({ page }) => {
  test.setTimeout(180_000);
  for (let i = 0; i < 5; i++) {
    const r = await mutate('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: `Wall ${i + 1}`, transform: { position: [1, 0.5 + i, 0] }, box: { size: [1, 1, 1], material: { color: '#777777' } }, components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  }

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state: string; player?: { x: number; y: number } }> => (await relay(`${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  await page.waitForTimeout(400);

  // Walk left to the wall (from x = 3), jump, keep pressing left: two relays of 240 steps (4 s; a relay body is at most 16 KiB).
  const move = { move: { v: -1, p: 'none' } };
  const walkAndJump = Array.from({ length: 240 }, (_, k) => (k >= 90 && k <= 130 ? { stepOffset: k, ...controls(-1, k === 90 ? 'pressed' : k < 130 ? 'held' : 'released') } : { stepOffset: k, actions: move }));
  const press = Array.from({ length: 240 }, (_, k) => ({ stepOffset: k, actions: move }));
  const samples: { x: number; y: number; t: number }[] = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      const o = await observe();
      if (running && o.player !== undefined) samples.push({ x: o.player.x, y: o.player.y, t: Date.now() });
      await new Promise((r) => setTimeout(r, 40));
    }
  })();
  for (const frames of [walkAndJump, press]) {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  running = false;
  await sampler;

  expect(samples.length).toBeGreaterThan(20);
  const peak = samples.reduce((m, s) => Math.max(m, s.y), -Infinity);
  expect(peak).toBeGreaterThan(1.7); // the capsule's lower half rose past the first seam (y = 1)
  // Against the wall (its face at 1.5 plus the capsule's radius), never inside it.
  for (const s of samples) expect(s.x).toBeGreaterThan(1.5 + 0.3 - 1e-3);
  // Still pressing into the wall at the end: back on the ground, not held at a seam.
  const last = samples[samples.length - 1]!;
  expect(last.x).toBeLessThan(1.85);
  expect(last.y).toBeGreaterThan(0.85);
  expect(last.y).toBeLessThan(0.95);
  // From the peak to the ground in about a free fall (1.2 m: 0.35 s), not held at a seam on the way
  // (observations come a few frames apart, so this is timed, not compared sample by sample).
  const top = samples.findIndex((s) => s.y === peak);
  const ground = samples.findIndex((s, i) => i > top && s.y < 0.95);
  expect(ground, JSON.stringify(samples.slice(top))).toBeGreaterThan(top);
  expect(samples[ground]!.t - samples[top]!.t, JSON.stringify(samples.slice(top, ground + 1))).toBeLessThan(1500);
  for (let i = top + 1; i <= ground; i++) expect(samples[i]!.y).toBeLessThanOrEqual(samples[i - 1]!.y);
});
