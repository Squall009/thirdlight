/**
 * Animator timing on the neutral skinned column (skinned-glb.ts):
 *
 * - a 1D blend tree whose clips carry the ground speed they were authored
 *   for (set in the blend clip Inspector) plays them at the rate that covers
 *   the parameter's ground speed, measured from the clip times the running
 *   game reports between two held steps;
 * - an `animator` start time (Inspector field) puts the entry state there,
 *   and `randomStart` (Inspector checkbox) starts copies at different times
 *   drawn from the game's seed: the same in a replay, other with another seed;
 * - a script's `play(state, fade, layer, time)` starts a state part-way.
 *
 * Measured in a real browser against a real backend: every number comes from
 * the play relays (exercises restart the run and hold it after a known number
 * of steps, then the observation reads that object's animator pose).
 */
import { expect, test, type Page } from './pw';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { closeEditor, editorPane, inspector as inspectorOf, openEditor } from './ui';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend('anim-timing');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x28a900 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-anim-timing' }, args });
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

interface Pose {
  state: string;
  clips: { clip: string; time: number; weight: number }[];
}
interface Observed {
  stepIndex: number;
  simTime: number;
  run?: { runStep: number };
  animator?: Pose;
  counters?: Record<string, number>;
}

const CLIPS = [
  { name: 'walk', bend: 10, duration: 1 },
  { name: 'run', bend: 30, duration: 0.8 },
  { name: 'breathe', bend: 5, duration: 2 },
  { name: 'talk', bend: -20, duration: 2 },
];
const LENGTH: Record<string, number> = Object.fromEntries(CLIPS.map((c) => [c.name, c.duration]));
const GROUND: Record<string, number> = { walk: 1.4, run: 2.2 };

const PLAYER = [
  'export default {',
  '  instantiate() { return { played: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.played) return;",
  '    state.played = true;',
  "    if (ctx.animator(ctx.entityId)?.play('Talk', 0, 0, 0.5) === true) ctx.game.add('played', 1);",
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

async function stopPlay(page: Page): Promise<void> {
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
}

/** Restart the run, step exactly `steps` fixed steps and hold there. */
async function stepFromStart(psid: string, steps: number): Promise<void> {
  const r = await relay(`${psid}/input`, { mode: 'exclusive-test', restart: true, hold: true, frames: [{ stepOffset: 0, steps }] });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

async function observe(psid: string, entityId: string, runStep: number): Promise<Observed> {
  let o: Observed = { stepIndex: 0, simTime: 0 };
  // The held step reaches the page's mirror within a frame or two.
  await expect
    .poll(async () => {
      o = (await relay(`${psid}/observe`, { entityId })).json as unknown as Observed;
      return o.run?.runStep === runStep && o.animator !== undefined;
    }, { timeout: 15_000 })
    .toBe(true);
  return o;
}

/** A looping clip's normalized phase (0–1). */
const phaseOf = (p: Pose, clip: string): number => p.clips.find((c) => c.clip === clip)!.time / LENGTH[clip]!;

test('blend ground speeds, start times, random starts and play time, measured in Play', async ({ page }) => {
  test.setTimeout(300_000);
  const column = await publishBytes(be, skinnedGlb(CLIPS), 'model', 'column', 'Column');
  const clip = (name: string) => ({ assetId: column, clip: name, duration: LENGTH[name]! });
  await cmd('setAnimator', {
    controller: {
      controllerId: 'gait',
      name: 'Gait',
      parameters: [{ name: 'speed', type: 'float', default: 0 }],
      states: [{ id: 'move', name: 'Move', motion: { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 1.4, clip: clip('walk') }, { threshold: 2.2, clip: clip('run') }] }, speed: 1, loop: true }],
      transitions: [],
      entry: 'move',
      events: [],
    },
  });
  await cmd('setAnimator', {
    controller: {
      controllerId: 'npc',
      name: 'Npc',
      parameters: [],
      states: [
        { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip('breathe') }, speed: 1, loop: true },
        { id: 'talk', name: 'Talk', motion: { kind: 'clip', clip: clip('talk') }, speed: 1, loop: true },
      ],
      transitions: [],
      entry: 'idle',
      events: [],
    },
  });
  const make = async (name: string, x: number, animator: Record<string, unknown>): Promise<string> => {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name, model: { asset: { assetId: column } }, transform: { position: [x, 0, 0] } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'animator', value: animator });
    return id;
  };
  const walker = await make('Walker', 0, { controller: 'gait', parameters: { speed: 1.8 } });
  const npcA = await make('Villager A', 2, { controller: 'npc' });
  const npcB = await make('Villager B', 4, { controller: 'npc' });
  const talker = await make('Talker', -2, { controller: 'npc' });
  await publishScript(be, 'play-talk', PLAYER, talker);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The blend clips' ground speeds, typed in the blend clip Inspector.
  const gait = async () => ((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as { controllerId: string; states: { motion: { children: { speed?: number }[] } }[] }[]).find((c) => c.controllerId === 'gait')!;
  await openEditor(page, 'Animator', 'Gait');
  const doc = editorPane(page, 'Animator', 'Gait');
  const graph = doc.getByLabel('animator graph');
  const move = graph.locator('[data-node-id="move"]');
  await expect(move).toBeVisible();
  const box = (await move.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height - 12);
  await expect(doc.getByLabel('graph path')).toContainText('Blend tree: Move');
  const inspector = inspectorOf(page);
  for (const [i, speed] of [[0, '1.4'], [1, '2.2']] as const) {
    await graph.locator(`[data-node-id="C${i}"]`).click();
    await expect(inspector.getByLabel('blend ground speed')).toHaveValue('');
    await inspector.getByLabel('blend ground speed').fill(speed);
    await inspector.getByLabel('blend ground speed').press('Enter');
    await expect.poll(async () => (await gait()).states[0]!.motion.children[i]!.speed).toBe(Number(speed));
  }

  await closeEditor(page);

  // The animator's start time and random start, in the object Inspector.
  const animatorOf = async (id: string) => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as { components: { animator: Record<string, unknown> } }).components.animator;
  const select = async (id: string) => {
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
    await expect(page.locator('.tl-inspector [data-component="animator"]')).toBeVisible();
  };
  await select(walker);
  await page.locator('.tl-inspector').getByLabel('animator startTime', { exact: true }).fill('0.5');
  await page.locator('.tl-inspector').getByLabel('animator startTime', { exact: true }).press('Enter');
  await expect.poll(async () => (await animatorOf(walker))['startTime']).toBe(0.5);
  for (const id of [npcA, npcB]) {
    await select(id);
    await page.locator('.tl-inspector').getByLabel('animator randomStart', { exact: true }).click();
    await expect.poll(async () => (await animatorOf(id))['randomStart']).toBe(true);
  }

  // Play. The blend at 1.8 m/s: walk and run half each; between two held steps the clips must cover 1.8 m a second.
  let psid = await startPlay(page);
  await stepFromStart(psid, 10);
  const a = await observe(psid, walker, 10);
  await stepFromStart(psid, 40);
  const b = await observe(psid, walker, 40);
  const hz = b.stepIndex / b.simTime;
  const seconds = 30 / hz;
  let ground = 0;
  for (const c of b.animator!.clips) {
    let dt = c.time - a.animator!.clips.find((x) => x.clip === c.clip)!.time;
    while (dt < 0) dt += LENGTH[c.clip]!;
    ground += c.weight * GROUND[c.clip]! * (dt / seconds);
  }
  console.log(`[animator-timing] blend at 1.8 m/s: clips cover ${ground.toFixed(4)} m/s (${hz} Hz, weights ${b.animator!.clips.map((c) => `${c.clip} ${c.weight.toFixed(2)}`).join(', ')})`);
  expect(b.animator!.clips.map((c) => c.clip).sort()).toEqual(['run', 'walk']);
  expect(ground).toBeCloseTo(1.8, 3);
  // The start time: at run step 10 the blend is half a cycle plus its steps in (at the matched rate; the
  // animators stepped 9 or 10 times by then, depending on whether the restart's own step counts).
  const cycleRate = 1.8 / b.animator!.clips.reduce((s, c) => s + c.weight * GROUND[c.clip]! * LENGTH[c.clip]!, 0);
  const startPhase = (phaseOf(a.animator!, 'walk') - (10 / hz) * cycleRate + 2) % 1;
  console.log(`[animator-timing] walker start phase ${startPhase.toFixed(4)} (authored 0.5)`);
  expect(Math.abs(startPhase - 0.5)).toBeLessThanOrEqual(cycleRate / hz + 1e-6);

  // Random starts: the two villagers differ; a replay starts them at exactly the same times.
  const starts = async (): Promise<number[]> => {
    const out: number[] = [];
    for (const id of [npcA, npcB]) {
      await stepFromStart(psid, 1);
      out.push(phaseOf((await observe(psid, id, 1)).animator!, 'breathe'));
    }
    return out;
  };
  const first = await starts();
  const again = await starts();
  console.log(`[animator-timing] random starts ${first.map((x) => x.toFixed(4)).join(', ')}; replayed ${again.map((x) => x.toFixed(4)).join(', ')}`);
  expect(again).toEqual(first);
  expect(Math.abs(first[0]! - first[1]!)).toBeGreaterThan(0.01);

  // A script's play(state, fade, layer, time): Talk from half its length.
  await stepFromStart(psid, 2);
  const t = await observe(psid, talker, 2);
  expect(t.counters?.['played']).toBe(1);
  expect(t.animator!.state).toBe('Talk');
  const talkTime = t.animator!.clips.find((c) => c.clip === 'talk')!.time;
  expect(talkTime).toBeGreaterThanOrEqual(1);
  expect(talkTime).toBeLessThanOrEqual(1 + 2 / hz + 1e-9);
  await stopPlay(page);

  // Another seed: other random starts.
  await cmd('setSettings', { settings: { random_seed: 12345 } });
  psid = await startPlay(page);
  const other = await starts();
  console.log(`[animator-timing] random starts with seed 12345: ${other.map((x) => x.toFixed(4)).join(', ')}`);
  expect(other).not.toEqual(first);
  await stopPlay(page);
});
