/**
 * Local co-op: two player controllers in one scene sharing the view, in a
 * real browser against a real backend, on the 2D plane and in 3D. The first
 * player is bound to the keyboard (its `move` reads A/D, or W/A/S/D in 3D),
 * the second to the gamepad in slot 2 (its own `move_p2` names `pad: 1`; a
 * standard-mapped pad the test moves through `navigator.getGamepads`, so the
 * page reads it as a browser would). In Play (the simulation worker):
 * holding D walks only the first player; the second's stick walks only the
 * second, through the first. The static export, with the backend stopped,
 * does the same. Positions are read from the observation's `players`
 * (`tl_game_observe` in Play, `window.__thirdlightObserve` in the export).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { serveDir, startBackend, type E2EBackend } from './backend';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

type Placed = { id: string; x: number; y: number; z: number };
type Observation = { stepIndex?: number; players?: Placed[] };

/** A standard-mapped pad in slot 2 (index 1) the test moves (`window.__tlPad`), in every frame. */
const PAD_IN_SLOT_2 = `(() => {
  window.__tlPad = { buttons: new Array(17).fill(false), axes: [0, 0, 0, 0] };
  const snapshot = () => ({
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 1, mapping: 'standard', connected: true, timestamp: performance.now(),
    axes: window.__tlPad.axes.slice(),
    buttons: window.__tlPad.buttons.map((p) => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
    hapticActuators: [], vibrationActuator: null,
  });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [null, snapshot(), null, null]; } });
})();`;

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-co-op' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function observePlay(psid: string): Promise<Observation | null> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' }, body: '{}' });
  return r.status === 200 ? ((await r.json()) as Observation) : null;
}

/** A floor and two players (the second reads its own actions), in 2D or 3D, with the co-op bindings. */
async function buildScene(dim: 2 | 3): Promise<{ p1: string; p2: string }> {
  if (dim === 3) await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const floorShape = dim === 3 ? { type: 'box', hx: 10, hy: 0.5, hz: 10 } : { type: 'box', hx: 10, hy: 0.5 };
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [20, 1, 20], material: { color: '#8a8f98' } }, components: { collider: { shape: floorShape } } });
  const p1 = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player 1', transform: { position: [-2, 0.91, 0] }, components: { controller: {} } }))['createdId']);
  const p2 = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player 2', transform: { position: [2, 0.91, 0] }, components: { controller: { moveAction: 'move_p2', jumpAction: 'jump_p2' } } }))['createdId']);
  // Player 1 on the keyboard (and pad slot 1, empty here), player 2 on the pad in slot 2.
  const move =
    dim === 3
      ? { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }, { kind: 'gamepadStick', x: 0, y: 1, pad: 0 }] }
      : { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }, { kind: 'gamepadAxis', axis: 0, pad: 0 }] };
  const moveP2 = dim === 3 ? { name: 'move_p2', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'gamepadStick', x: 0, y: 1, pad: 1 }] } : { name: 'move_p2', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'gamepadAxis', axis: 0, pad: 1 }] };
  await cmd('setInput', {
    input: {
      actions: [
        move,
        { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0, pad: 0 }] },
        moveP2,
        { name: 'jump_p2', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 0, pad: 1 }] },
      ],
    },
  });
  return { p1, p2 };
}

/** Poll until both players are at rest (two reads with later steps give the same places). */
async function rest(read: () => Promise<Observation | null>, what: string): Promise<Map<string, Placed>> {
  let last: Observation | null = null;
  const key = (o: Observation | null): string => JSON.stringify(o?.players ?? null);
  await expect
    .poll(
      async () => {
        const o = await read();
        const same = (o?.players?.length ?? 0) === 2 && last !== null && key(o) === key(last) && (o!.stepIndex ?? 0) > (last.stepIndex ?? 0);
        last = o;
        return same;
      },
      { timeout: 60_000, intervals: [250], message: `${what}: both at rest` },
    )
    .toBe(true);
  return new Map(last!.players!.map((p) => [p.id, p]));
}

/** Push the pad's stick (axis 0) in every frame of the page. */
async function stick(page: Page, x: number): Promise<void> {
  for (const f of page.frames()) await f.evaluate((v) => void ((window as unknown as { __tlPad?: { axes: number[] } }).__tlPad?.axes.splice(0, 1, v)), x).catch(() => undefined);
}

/** D walks the first player only; the second's pad walks the second only, through the first. */
async function bothWalk(page: Page, read: () => Promise<Observation | null>, ids: { p1: string; p2: string }, where: string): Promise<void> {
  const start = await rest(read, `${where} start`);
  expect(start.get(ids.p1)!.x).toBeCloseTo(-2, 2);
  expect(start.get(ids.p2)!.x).toBeCloseTo(2, 2);
  const placed = async (): Promise<Map<string, Placed> | null> => {
    const o = await read();
    return o?.players !== undefined ? new Map(o.players.map((p) => [p.id, p])) : null;
  };
  // The keyboard: player 1 walks right; player 2 does not move.
  await page.keyboard.down('d');
  try {
    await expect.poll(async () => (await placed())?.get(ids.p1)?.x ?? -9, { timeout: 30_000, intervals: [100], message: `${where}: D walks player 1` }).toBeGreaterThan(0.5);
  } finally {
    await page.keyboard.up('d');
  }
  const after1 = await rest(read, `${where}: after D`);
  expect(Math.abs(after1.get(ids.p2)!.x - 2)).toBeLessThan(0.01);
  // The pad in slot 2: player 2 walks left, through player 1; player 1 does not move.
  await stick(page, -1);
  try {
    await expect.poll(async () => (await placed())?.get(ids.p2)?.x ?? 9, { timeout: 30_000, intervals: [100], message: `${where}: the pad walks player 2` }).toBeLessThan(after1.get(ids.p1)!.x - 1);
  } finally {
    await stick(page, 0);
  }
  const after2 = await rest(read, `${where}: after the pad`);
  expect(Math.abs(after2.get(ids.p1)!.x - after1.get(ids.p1)!.x)).toBeLessThan(0.01);
}

for (const dim of [2, 3] as const) {
  test(`${dim}D: two player controllers in one view move from the keyboard and a second pad, in Play and in the export`, async ({ page }) => {
    test.setTimeout(240_000);
    be = await startBackend(`co-op-${dim}d-e2e`);
    const ids = await buildScene(dim);
    await page.context().addInitScript(PAD_IN_SLOT_2);

    // Play (the simulation worker).
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(be.editorUrl);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    await expect.poll(async () => (await observePlay(psid)) !== null, { timeout: 30_000 }).toBe(true);
    // A click in the game focuses it.
    await page.locator('iframe.tl-app__preview-frame').click();
    await bothWalk(page, () => observePlay(psid), ids, 'Play');
    expect(errors).toEqual([]);

    // The static export with the backend stopped.
    const res = await be.admin(`projects/${be.projectId}/export`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await be.halt();
    const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
    const game = await page.context().newPage();
    const gameErrors: string[] = [];
    game.on('pageerror', (e) => gameErrors.push(e.message));
    try {
      await game.goto(site.url);
      const observe = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
      await expect.poll(async () => (await observe())?.players?.length ?? 0, { timeout: 60_000 }).toBe(2);
      const vp = game.viewportSize()!;
      await game.mouse.click(vp.width / 2, vp.height / 2);
      await bothWalk(game, observe, ids, 'export');
      expect(gameErrors).toEqual([]);
    } finally {
      await game.close();
      await site.close();
    }
  });
}
