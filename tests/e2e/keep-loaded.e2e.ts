/**
 * Keep loaded, against a real backend in a real browser.
 *
 * - The editor: the Inspector's "Keep loaded" flag writes the object's
 *   `keepLoaded` (one undoable edit) and the hierarchy marks every kept
 *   object — its own flag, or kept with the object above (the Inspector says
 *   which). A new project's camera and player are kept (the upgrade's shape).
 *   The stored flag is read back over HTTP.
 * - Play: a second scene holds a kept crate, a beacon a kept watcher in the
 *   start scene aims at, and the spawn the shell's scene list names for it. A
 *   director loads it (the kept player arrives at that spawn), moves the
 *   crate, unloads the scene (the crate stays where it was put; the watcher's
 *   target reads as empty with one Problems line and the game runs on), loads
 *   it again (still one crate, where the director put it) and reloads it with
 *   `ctx.scenes.reload` (the crate untouched, the beacon, moved again, back
 *   as authored, no second Problems line). Read through the director's log
 *   lines in Play diagnostics, the play observation and the Problems route.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from './pw';

import { publishScript, STARTER, startBackend, type E2EBackend } from './backend';
import { createBox, inspector } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-keep-loaded' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
const kept = async (id: string): Promise<boolean> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as { keepLoaded?: boolean } | undefined)?.keepLoaded === true;
const row = (page: Page, id: string) => page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`);
const marker = (page: Page, id: string) => row(page, id).locator('[data-flag="kept"]');

/** The Keep loaded flag in the Inspector, kept objects marked in the hierarchy (a fresh starter editor open). */
async function keepLoadedFlag(page: Page): Promise<void> {

  // The starter's camera and player are kept; its spawn and ground are not.
  await expect(marker(page, STARTER.cameraId)).toHaveCount(1);
  await expect(marker(page, STARTER.playerId)).toHaveCount(1);
  await expect(marker(page, STARTER.spawnId)).toHaveCount(0);
  await expect(marker(page, STARTER.groundId)).toHaveCount(0);
  await row(page, STARTER.playerId).click();
  await expect(inspector(page).getByLabel('Keep loaded', { exact: true })).toBeChecked();

  // A new box: not kept; the Inspector flag keeps it.
  const ids = async (): Promise<string[]> => ((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { id: string }[]).map((e) => e.id);
  const before = await ids();
  await createBox(page);
  await expect.poll(async () => (await ids()).length).toBe(before.length + 1);
  const boxId = (await ids()).find((id) => !before.includes(id))!;
  await row(page, boxId).click();
  const flag = inspector(page).getByLabel('Keep loaded', { exact: true });
  await expect(flag).not.toBeChecked();
  await expect(marker(page, boxId)).toHaveCount(0);
  await flag.click();
  await expect.poll(() => kept(boxId)).toBe(true);
  await expect(marker(page, boxId)).toHaveCount(1);
  await expect(marker(page, boxId)).toHaveAttribute('title', /survives scene changes/);

  // A child of a kept object is kept with it: marked, and the Inspector says from where.
  const child = String((await cmd('createEntity', { parentId: boxId, kind: 'group', name: 'Lid' }))['createdId']);
  await expect(marker(page, child)).toHaveCount(1);
  await expect(marker(page, child)).toHaveAttribute('title', /kept loaded with the object above/);
  await row(page, child).click();
  await expect(inspector(page).locator('[data-flag="keepLoaded"]')).toContainText('kept loaded — inherited from');
  await expect(inspector(page).getByLabel('Keep loaded', { exact: true })).not.toBeChecked();

  // Clear the flag: the box and its child are not kept any more.
  await row(page, boxId).click();
  await inspector(page).getByLabel('Keep loaded', { exact: true }).click();
  await expect.poll(() => kept(boxId)).toBe(false);
  await expect(marker(page, boxId)).toHaveCount(0);
  await expect(marker(page, child)).toHaveCount(0);
}

/** The director: debug commands load, unload and reload the level and move the kept crate; `report` logs what it reads. */
const directorScript = (beacon: string): string => [
  'export default {',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const _ of ctx.debug.command('load', { description: 'Load the level', args: [] })) ctx.scenes.load('level');",
  "    for (const _ of ctx.debug.command('unload', { description: 'Unload the level', args: [] })) ctx.scenes.unload('level');",
  "    for (const _ of ctx.debug.command('reload', { description: 'Reload the level', args: [] })) ctx.scenes.reload('level');",
  `    for (const _ of ctx.debug.command('move', { description: 'Move the crate', args: [] })) { ctx.entity(ctx.world.find('Kept crate')).set('transform', { position: [207, 2, 0] }); ctx.entity('${beacon}')?.set('transform', { position: [190, 2, 0] }); }`,
  "    for (const _ of ctx.debug.command('report', { description: 'Log the state', args: [] })) {",
  "      const seq = (ctx.save.get('seq') ?? 0) + 1;",
  "      ctx.save.set('seq', seq);",
  "      const crates = ctx.world.findAll('Kept crate');",
  `      ctx.log('info', 'report ' + JSON.stringify({ seq, level: ctx.scenes.status('level'), crates: crates.length, crate: crates.length > 0 ? ctx.world.transform(crates[0]).position : null, beacon: ctx.world.transform('${beacon}') ?? null, player: ctx.world.transform('${STARTER.playerId}')?.position ?? null }));`,
  '    }',
  '  },',
  '};',
].join('\n');

type Report = { seq: number; level: string; crates: number; crate: number[] | null; beacon: unknown; player: number[] | null };

// The editor part first, on the fresh starter; Play then runs in the same editor (the editor part's box is not kept and sits in the start scene).
test('the Keep loaded flag in the Inspector, kept objects marked in the hierarchy; in Play a kept object lives through unload, load and reload as one object; a kept reference into an unloaded scene reads empty with one Problems line; a kept player arrives at the listed spawn', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('keep-loaded-play-e2e', 'starter');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await test.step('the Keep loaded flag in the Inspector, kept objects marked in the hierarchy', () => keepLoadedFlag(page));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await cmd('createScene', { sceneId: 'level', name: 'Level' });
  await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Far floor', transform: { position: [200, -0.2, 0] }, box: { size: [16, 0.4, 1], material: { color: '#6f6f6f' } }, components: { collider: { shape: { type: 'box', hx: 8, hy: 0.2 } } } });
  const arrival = String((await cmd('createEntity', { sceneId: 'level', kind: 'group', name: 'Arrival', transform: { position: [198, 0.91, 0] }, components: { playerSpawn: {} } }))['createdId']);
  const crate = String((await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Kept crate', keepLoaded: true, transform: { position: [204, 0.5, 0] } }))['createdId']);
  const beacon = String((await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Beacon', transform: { position: [196, 0.5, 0] } }))['createdId']);
  // A kept shot in the start scene aiming at the beacon (which shot is live does not matter here).
  const watcher = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Watcher', keepLoaded: true, components: { virtualCamera: { rig: 'fixed', priority: -1000, target: beacon } } }))['createdId']);
  const director = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -10, 0] } }))['createdId']);
  await publishScript(be, 'director', directorScript(beacon), director);
  await cmd('setShell', { shell: { scenes: [{ scene: 'scene-main', spawn: STARTER.spawnId }, { scene: 'level', spawn: arrival }] } });

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const api = async (path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  type Obs = { state?: string; scenes?: { loaded?: string[] }; spawned?: { count: number; ids: string[] } };
  const observe = async (): Promise<Obs> => {
    const r = await api(`play/${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  const debug = async (name: string): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name, args: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const keptLines = async (): Promise<{ code: string; message: string }[]> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/problems`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
    return ((await r.json()) as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'kept_reference_unloaded');
  };
  let reports = 0;
  const report = async (): Promise<Report> => {
    reports += 1;
    const want = reports;
    await debug('report');
    let found: Report | null = null;
    await expect.poll(async () => {
      const d = (await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { runtime?: { errors?: { message: string }[] } } };
      const lines = (d.diagnostics?.runtime?.errors ?? []).map((e) => e.message).filter((m) => m.startsWith('report ')).map((m) => JSON.parse(m.slice('report '.length)) as Report);
      found = lines.find((r) => r.seq === want) ?? null;
      return found !== null;
    }, { timeout: 30_000 }).toBe(true);
    return found!;
  };
  const near = (a: number[] | null, b: number[], tol = 0.05): boolean => a !== null && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tol);

  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  expect(await report()).toMatchObject({ level: 'unloaded', crates: 0, beacon: null });

  // A plain load: the kept player arrives at the spawn the scene list names for it.
  await debug('load');
  await expect.poll(async () => (await report()).level, { timeout: 30_000 }).toBe('loaded');
  await expect.poll(async () => (await report()).player?.[0] ?? 0, { timeout: 30_000, message: 'the player arrived at the listed spawn' }).toBeCloseTo(198, 0);
  await debug('move');
  await expect.poll(async () => near((await report()).crate, [207, 2, 0]), { timeout: 30_000 }).toBe(true);
  expect(await keptLines()).toEqual([]);

  // Unload: the crate stays where it was put (listed with the scene-less objects); the watcher's target reads empty, said once.
  await debug('unload');
  await expect.poll(async () => (await report()).level, { timeout: 30_000 }).toBe('unloaded');
  const gone = await report();
  expect(gone.crates).toBe(1);
  expect(near(gone.crate, [207, 2, 0])).toBe(true);
  expect(gone.beacon).toBeNull();
  expect((await observe()).spawned?.ids).toContain(crate);
  await expect.poll(async () => (await keptLines()).length, { timeout: 15_000 }).toBe(1);
  expect((await keptLines())[0]!.message).toContain(`"${watcher}" → "${beacon}"`);
  expect((await observe()).state).toBe('running');

  // Load again: no second crate; it is where the director put it, back in its scene.
  await debug('load');
  await expect.poll(async () => (await report()).level, { timeout: 30_000 }).toBe('loaded');
  const again = await report();
  expect(again.crates).toBe(1);
  expect(near(again.crate, [207, 2, 0])).toBe(true);
  expect(again.beacon).not.toBeNull();
  expect((await observe()).spawned?.ids ?? []).not.toContain(crate);

  // Reload: the beacon (moved again) goes back as authored, the kept crate is untouched, no new Problems line.
  await debug('move');
  await expect.poll(async () => near(((await report()).beacon as { position: number[] } | null)?.position ?? null, [190, 2, 0]), { timeout: 30_000 }).toBe(true);
  await debug('reload');
  await expect.poll(async () => near(((await report()).beacon as { position: number[] } | null)?.position ?? null, [196, 0.5, 0]), { timeout: 30_000, message: 'the beacon is back as authored' }).toBe(true);
  const reloaded = await report();
  expect(reloaded).toMatchObject({ level: 'loaded', crates: 1 });
  expect(near(reloaded.crate, [207, 2, 0])).toBe(true);
  expect(near((reloaded.beacon as { position: number[] } | null)?.position ?? null, [196, 0.5, 0])).toBe(true);
  // A second unload in the same Play adds no second line.
  await debug('unload');
  await expect.poll(async () => (await report()).level, { timeout: 30_000 }).toBe('unloaded');
  expect(await keptLines()).toHaveLength(1);
  expect((await observe()).state).toBe('running');
  expect(errors).toEqual([]);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
