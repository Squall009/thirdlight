/**
 * The animator's look-at constraint on the neutral skinned column
 * (skinned-glb.ts: bones `root` at the base and `upper` at 1 m), measured in
 * a real browser against a real backend.
 *
 * Every look-at field is set in the object Inspector (bones picked from the
 * object's own model, limits, target, point, weight, weight parameter, turn
 * speed). In Play, held exercises from the run's start step a known number
 * of steps, and the observation reads the drawn `upper` bone's world rotation
 * (the renderer's skeleton after the clips and the turn) and the
 * simulation's look angles: the head turns toward a target 60° to the side
 * at the turn speed, stops at the chain's limits when a script moves the
 * look point behind it, and turns back when the script sets the weight to 0.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend('anim-look-at');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x28b900 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-look-at' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

interface Observed {
  stepIndex: number;
  simTime: number;
  run?: { runStep: number };
  animator?: { look?: { yaw: number; pitch: number } };
  renderedBones?: Record<string, { position: number[]; rotation: number[] }>;
}

const DEG = Math.PI / 180;
/** Where a rotation turns +Z: its yaw about +Y in degrees. */
function yawOf(q: readonly number[]): number {
  const [x, y, z, w] = q as [number, number, number, number];
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) / DEG;
}

// The script: 2 s in it moves the look to a point 120° to the right (behind the chain's 70° reach),
// 4 s in it sets the weight to 0.
const DIRECTOR = [
  'export default {',
  '  instantiate() { return { armed: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (!state.armed) { state.armed = true; ctx.timers.after('far', 2); ctx.timers.after('rest', 4); }",
  '    const a = ctx.animator(ctx.entityId);',
  `    if (ctx.timers.fired('far')) a?.setLookPoint([${(-5 * Math.sin(60 * DEG)).toFixed(6)}, 1, ${(-5 * Math.cos(60 * DEG)).toFixed(6)}]);`,
  "    if (ctx.timers.fired('rest')) a?.setLookWeight(0);",
  '  },',
  '};',
  '',
].join('\n');

async function startPlay(page: Page): Promise<string> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 60_000 }).toBe(200);
  return psid;
}

/**
 * Step the held run on to run step `runStep` (from `from`; `from` 0 restarts the run first), hold, and observe the
 * column once the drawn frame has caught up. One run serves every sample: held exercises continue step-exactly.
 */
async function at(psid: string, entityId: string, runStep: number, from: number): Promise<Observed> {
  const steps = runStep - from;
  const r = await relay(`${psid}/input`, { mode: 'exclusive-test', restart: from === 0, hold: true, frames: [{ stepOffset: 0, steps }] });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  let o: Observed = { stepIndex: 0, simTime: 0 };
  let last = '';
  // Held: two observations alike in a row (the drawn bones are from a frame after the held step).
  await expect
    .poll(async () => {
      o = (await relay(`${psid}/observe`, { entityId })).json as unknown as Observed;
      const key = JSON.stringify([o.run?.runStep, o.animator?.look, o.renderedBones?.['upper']]);
      const same = key === last;
      last = key;
      return o.run?.runStep === runStep && o.renderedBones?.['upper'] !== undefined && same;
    }, { timeout: 15_000, intervals: [100, 200, 300] })
    .toBe(true);
  return o;
}

async function fill(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.press('Enter');
}

test('the look-at turns the drawn head toward its target within its limits at its turn speed, and back', async ({ page }) => {
  test.setTimeout(300_000);
  const column = await publishBytes(be, skinnedGlb(), 'model', 'column', 'Column');
  await cmd('setAnimator', {
    controller: {
      controllerId: 'npc',
      name: 'Npc',
      parameters: [{ name: 'attention', type: 'float', default: 1 }],
      states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: column, clip: 'idle', duration: 1 } }, speed: 1, loop: true }],
      transitions: [],
      entry: 'idle',
      events: [],
    },
  });
  const npc = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Npc', model: { asset: { assetId: column } }, transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: npc, component: 'animator', value: { controller: 'npc' } });
  // A friend 60° to the npc's left of its front (+Z toward +X), at the upper bone's height.
  const friend = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Friend', transform: { position: [5 * Math.sin(60 * DEG), 1, 5 * Math.cos(60 * DEG)], scale: [0.3, 0.3, 0.3] } }))['createdId']);
  await publishScript(be, 'look-director', DIRECTOR, npc);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${npc}"]`).click();
  const inspector = page.locator('.tl-inspector');
  await expect(inspector.locator('[data-component="animator"]')).toBeVisible();
  const lookAt = async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: npc } }))['entity'] as { components: { animator: { lookAt?: Record<string, unknown> } } }).components.animator.lookAt;
  const field = (name: string) => inspector.getByLabel(`animator lookAt ${name}`, { exact: true });

  await inspector.getByLabel('add animator lookAt', { exact: true }).click();
  await expect.poll(async () => (await lookAt())?.['head']).toBeTruthy();
  // The head bone, picked from the object's own model.
  await expect(field('head bone')).toHaveJSProperty('tagName', 'SELECT', { timeout: 15_000 });
  await field('head bone').selectOption('upper');
  await fill(field('head yaw'), '50');
  await fill(field('head pitch'), '30');
  await expect.poll(lookAt).toMatchObject({ head: { bone: 'upper', yaw: 50, pitch: 30 } });
  // The chest takes part of the turn; a neck is added and taken away again.
  await inspector.getByLabel('add animator lookAt chest', { exact: true }).click();
  await field('chest bone').selectOption('root');
  await fill(field('chest yaw'), '20');
  await fill(field('chest pitch'), '10');
  await inspector.getByLabel('add animator lookAt neck', { exact: true }).click();
  await expect.poll(async () => (await lookAt())?.['neck']).toBeTruthy();
  await fill(field('neck yaw'), '15');
  await fill(field('neck pitch'), '5');
  await expect.poll(async () => (await lookAt())?.['neck']).toMatchObject({ yaw: 15, pitch: 5 });
  await inspector.getByLabel('remove animator lookAt neck', { exact: true }).click();
  await expect.poll(async () => (await lookAt())?.['neck']).toBeUndefined();
  // The target, a point (used when there is no target), the weight, its parameter and the turn speed.
  await field('target').selectOption({ label: 'Friend (Main)' });
  await fill(field('point x'), '0');
  await fill(field('point y'), '1');
  await fill(field('point z'), '5');
  await fill(field('weight'), '0.8');
  await expect.poll(async () => (await lookAt())?.['weight']).toBe(0.8);
  // Back to the default (full weight): stored as absent.
  await fill(field('weight'), '1');
  await expect.poll(async () => (await lookAt())?.['weight']).toBeUndefined();
  await field('weightParameter').selectOption('attention');
  await fill(field('turnSpeed'), '90');
  await expect
    .poll(lookAt)
    .toEqual({ head: { bone: 'upper', yaw: 50, pitch: 30 }, chest: { bone: 'root', yaw: 20, pitch: 10 }, target: friend, point: [0, 1, 5], weightParameter: 'attention', turnSpeed: 90 });

  const psid = await startPlay(page);
  const first = await at(psid, npc, 1, 0);
  const hz = Math.round(first.stepIndex / first.simTime);
  let held = 1;
  const sample = async (seconds: number): Promise<{ sim: number; drawn: number }> => {
    const runStep = Math.round(seconds * hz);
    const o = await at(psid, npc, runStep, held);
    held = runStep;
    const drawn = yawOf(o.renderedBones!['upper']!.rotation);
    const sim = o.animator?.look?.yaw ?? 0;
    console.log(`[look-at] ${seconds} s: simulation yaw ${sim.toFixed(2)}°, drawn upper bone yaw ${drawn.toFixed(2)}°`);
    return { sim, drawn };
  };
  // 90°/s toward 60°: 22.5° after a quarter second (one step either way), 60° once there.
  const quarter = await sample(0.25);
  expect(Math.abs(quarter.sim - 22.5)).toBeLessThanOrEqual(90 / hz + 1e-6);
  expect(quarter.drawn).toBeCloseTo(quarter.sim, 1);
  const there = await sample(1.5);
  expect(there.sim).toBeCloseTo(60, 6);
  expect(there.drawn).toBeCloseTo(60, 1);
  // 2 s: the look point moves 120° to the other side; the chain stops at its 70° (20 + 50).
  const limited = await sample(3.8);
  expect(limited.sim).toBeCloseTo(-70, 6);
  expect(limited.drawn).toBeCloseTo(-70, 1);
  // 4 s: weight 0 — back at 90°/s (−70 + 45 half a second later), straight again by 4.8 s.
  const back = await sample(4.5);
  expect(Math.abs(back.sim + 25)).toBeLessThanOrEqual(90 / hz + 1e-6);
  expect(back.drawn).toBeCloseTo(back.sim, 1);
  const rest = await sample(5.5);
  expect(rest.sim).toBe(0);
  expect(Math.abs(rest.drawn)).toBeLessThan(0.05);

  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
});
