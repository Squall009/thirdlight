/**
 * Scene reload and the deprecated run restart, against a real backend in a
 * real browser (the starter template; its camera and player keep loaded).
 *
 * A director in the start scene loads a second scene, spawns a copy, moves a
 * kept lamp and keeps a `ctx.save` value; the second scene's crate counts its
 * starts in `ctx.save` and, on a debug command, moves itself, spawns a copy,
 * starts a looping sound and adds to a counter. A button of a project UI
 * document with the `reloadScene` engine action puts that scene back: the
 * crate where it was authored, its copy gone, its sound stopped, its script
 * started over (its start counted again); the director's copy, the kept lamp
 * where the director put it, the counter, the save value and the start scene
 * stay. The built-in pause panel has only Resume. `restartLevel`, `newGame`
 * and `ctx.lifecycle.restart()` still restart the run, and each writes one
 * Problems line per Play naming what replaces it, however often it is used.
 * State is read through the play relay (observe, diagnostics, the Problems
 * route); the sound is the Web Audio graph's state, not heard.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type FrameLocator } from '@playwright/test';

import { publishScript, publishWav, startBackend, type E2EBackend } from './backend';
import { openWindow } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-reload' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function problems(): Promise<{ code: string; message: string }[]> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/problems`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
  return ((await r.json()) as { problems: { code: string; message: string }[] }).problems;
}

/** The second scene's crate: counts its starts; `act` moves it, spawns a copy, starts a loop and adds to a counter. */
const crateScript = (crate: string): string => [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    state.n += 1;',
  "    if (state.n === 1) ctx.save.set('starts', (ctx.save.get('starts') ?? 0) + 1);",
  "    for (const _ of ctx.debug.command('act', { description: 'Move, spawn, play, count', args: [] })) {",
  `      ctx.entity('${crate}').set('transform', { position: [5, 3, 0] });`,
  "      ctx.spawn('chip', { position: [8, 1, 0] });",
  "      ctx.audio.play('amb', { loop: true, volume: 0.2 });",
  "      ctx.game.add('tally', 1);",
  '    }',
  '  },',
  '};',
].join('\n');

/** The start scene's director: shows the buttons, loads the scene, spawns its own copy, moves the kept lamp; debug commands. */
const directorScript = (crate: string, lamp: string): string => [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    state.n += 1;',
  '    if (state.n === 1) {',
  "      ctx.ui.show('reload-ui');",
  "      ctx.scenes.load('level');",
  "      ctx.spawn('chip', { position: [-8, 1, 0] });",
  "      ctx.save.set('note', 'kept');",
  '    }',
  `    if (state.n === 2) ctx.entity('${lamp}').set('transform', { position: [-4, 2, 0] });`,
  "    for (const _ of ctx.debug.command('restart', { description: 'The deprecated run restart', args: [] })) ctx.lifecycle.restart();",
  "    for (const _ of ctx.debug.command('report', { description: 'Log the state', args: [] })) {",
  "      const seq = (ctx.save.get('seq') ?? 0) + 1;",
  "      ctx.save.set('seq', seq);",
  `      ctx.log('info', 'report ' + JSON.stringify({ seq, crate: ctx.world.transform('${crate}')?.position ?? null, lamp: ctx.world.transform('${lamp}')?.position ?? null, starts: ctx.save.get('starts') ?? 0, note: ctx.save.get('note') ?? null, n: state.n }));`,
  '    }',
  '  },',
  '};',
].join('\n');

type Voice = { handle: number; assetId: string; state: string };
type Obs = { state?: string; scenes?: { loaded?: string[] }; spawned?: { count: number; ids: string[] }; counters?: Record<string, number>; audio?: { voices?: Voice[] }; sound?: { unlocked?: boolean } };
type Report = { seq: number; crate: number[] | null; lamp: number[] | null; starts: number; note: string | null; n: number };

test('reloadScene puts a scene back as authored and leaves the rest; the pause panel has only Resume; the deprecated restarts work with one Problems line each', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('scene-reload-e2e', 'starter');
  await publishWav(be, 'cue-max.wav', 'amb', 'Ambience');
  await cmd('setLabels', { items: [{ kind: 'asset', id: 'amb' }], add: ['played'] });
  // The copy scripts spawn: a small box from a scene the game never loads.
  await cmd('createScene', { sceneId: 'scene-src', name: 'Source' });
  const src = String((await cmd('createEntity', { sceneId: 'scene-src', kind: 'box', name: 'Chip', transform: { position: [0, 0, 0], scale: [0.3, 0.3, 0.3] } }))['createdId']);
  await cmd('createPrefab', { prefabId: 'chip', displayName: 'Chip', sourceEntityId: src });
  await cmd('createScene', { sceneId: 'level', name: 'Level' });
  const crate = String((await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Crate', transform: { position: [2, 0.5, -2] } }))['createdId']);
  const lamp = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Lamp', keepLoaded: true, transform: { position: [-3, 0.5, 0] } }))['createdId']);
  const director = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -10, 0] } }))['createdId']);
  await publishScript(be, 'crate', crateScript(crate), crate);
  await publishScript(be, 'director', directorScript(crate, lamp), director);
  const button = (id: string, text: string, onClick: unknown, y: number): unknown => ({ type: 'button', id, anchor: [0, 0], pivot: [0, 0], offset: [12, y], size: [170, 36], text, css: { color: '#ffffff', background: '#406080', fontSize: 16 }, onClick });
  await cmd('setUiDocument', { document: { uiDocumentId: 'reload-ui', name: 'Reload', root: { type: 'panel', stretch: 'both', children: [
    button('reload', 'Reload level', { do: 'engine', action: 'reloadScene', scene: 'level' }, 12),
    button('restart', 'Restart (old)', { do: 'engine', action: 'restartLevel' }, 56),
    button('fresh', 'New game (old)', { do: 'engine', action: 'newGame' }, 100),
  ] } } });
  // A shell without a pause screen: the pause key opens the engine's pause panel.
  await cmd('setShell', { shell: { pause: true } });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs> => {
    const r = await api(`play/${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  const debug = async (name: string): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name, args: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  let reports = 0;
  /** The director's report (a debug command logs it; read from the play's diagnostics). */
  const report = async (): Promise<Report> => {
    reports += 1;
    const want = reports;
    await debug('report');
    let found: Report | null = null;
    await expect.poll(async () => {
      const d = (await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { runtime?: { errors?: { message: string }[] } } };
      // The log is a ring: this report is found by its sequence number (kept in ctx.save across restarts).
      const lines = (d.diagnostics?.runtime?.errors ?? []).map((e) => e.message).filter((m) => m.startsWith('report ')).map((m) => JSON.parse(m.slice('report '.length)) as Report);
      found = lines.find((r) => r.seq === want) ?? null;
      return found !== null;
    }, { timeout: 30_000 }).toBe(true);
    return found!;
  };
  const loops = async (): Promise<number> => ((await observe()).audio?.voices ?? []).filter((v) => v.handle > 0 && v.assetId === 'amb' && v.state === 'playing').length;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const frame: FrameLocator = page.frameLocator('iframe.tl-app__preview-frame');
  const ui = frame.locator('[data-tl-ui-doc="reload-ui"]');
  await expect(ui.locator('[data-widget="reload"]')).toBeVisible({ timeout: 30_000 });
  // A click in the game turns sound on.
  const box = (await page.locator('iframe.tl-app__preview-frame').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 30_000 }).toEqual(['scene-main', 'level']);
  await expect.poll(async () => (await observe()).spawned?.count ?? 0, { timeout: 30_000 }).toBe(1);
  const directorCopy = (await observe()).spawned!.ids[0]!;

  // The scene's script acts: its object moved, a copy, a loop, the counter.
  await debug('act');
  await expect.poll(async () => (await observe()).spawned?.count ?? 0, { timeout: 30_000 }).toBe(2);
  await expect.poll(loops, { timeout: 30_000 }).toBe(1);
  expect((await observe()).counters).toEqual({ tally: 1 });
  const before = await report();
  expect(before).toMatchObject({ crate: [5, 3, 0], lamp: [-4, 2, 0], starts: 1, note: 'kept' });

  // The reloadScene button: the scene as authored, the rest untouched.
  await ui.locator('[data-widget="reload"]').click();
  await expect.poll(async () => (await observe()).spawned?.ids ?? [], { timeout: 30_000, message: 'the scene\'s copy goes, the director\'s stays' }).toEqual([directorCopy]);
  await expect.poll(loops, { timeout: 30_000, message: 'the scene\'s loop stops' }).toBe(0);
  const after = await report();
  expect(after.crate).toEqual([2, 0.5, -2]);
  expect(after.lamp).toEqual([-4, 2, 0]);
  expect(after.starts).toBe(2);
  expect(after.note).toBe('kept');
  expect(after.n).toBeGreaterThan(before.n);
  const o = await observe();
  expect(o.scenes?.loaded).toEqual(['scene-main', 'level']);
  expect(o.counters).toEqual({ tally: 1 });
  // Its script works again from its start.
  await debug('act');
  await expect.poll(async () => (await observe()).counters?.['tally'] ?? 0, { timeout: 30_000 }).toBe(2);
  expect((await problems()).filter((p) => p.code.startsWith('deprecated_'))).toEqual([]);

  // The engine's pause panel: Resume only.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await page.keyboard.press('Escape');
  const panel = frame.locator('[data-tl-pause-panel]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-tl-pause-item]')).toHaveCount(1);
  await expect(panel.locator('[data-tl-pause-item="resume"]')).toHaveText('Resume');
  await expect.poll(async () => (await observe()).state).toBe('paused');
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await observe()).state).toBe('running');

  // The deprecated run restarts still restart the run; each writes one Problems line per Play.
  const restarted = async (use: () => Promise<void>): Promise<void> => {
    // The director's step count grows first (it ran a while), then drops when the run starts over.
    let n = 0;
    await expect.poll(async () => (n = (await report()).n), { timeout: 30_000 }).toBeGreaterThan(60);
    await use();
    await expect.poll(async () => (await report()).n, { timeout: 30_000, message: 'the run started over' }).toBeLessThan(n);
  };
  await restarted(() => ui.locator('[data-widget="restart"]').click());
  await restarted(() => ui.locator('[data-widget="restart"]').click());
  await restarted(() => ui.locator('[data-widget="fresh"]').click());
  await restarted(() => debug('restart'));
  await restarted(() => debug('restart'));
  const codes = async (): Promise<string[]> => (await problems()).filter((p) => p.code.startsWith('deprecated_')).map((p) => p.code).sort();
  await expect.poll(codes, { timeout: 30_000 }).toEqual(['deprecated_lifecycle_restart', 'deprecated_new_game', 'deprecated_restart_level']);
  const lines = (await problems()).filter((p) => p.code.startsWith('deprecated_'));
  expect(lines.find((p) => p.code === 'deprecated_restart_level')!.message).toMatch(/restartLevel engine action is deprecated.*reloadScene engine action/);
  expect(lines.find((p) => p.code === 'deprecated_new_game')!.message).toMatch(/newGame engine action is deprecated.*builds in a script/);
  expect(lines.find((p) => p.code === 'deprecated_lifecycle_restart')!.message).toMatch(/ctx\.lifecycle\.restart\(\) is deprecated.*ctx\.scenes\.reload/);
  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-panel.tl-problems .tl-problem').filter({ hasText: 'restartLevel engine action is deprecated' })).toHaveCount(1, { timeout: 15_000 });
  expect(errors).toEqual([]);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
