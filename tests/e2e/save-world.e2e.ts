/**
 * `world` as an opt-in save section, against a real backend in a real
 * browser (the starter template; its camera and player keep loaded).
 *
 * A director in the start scene saves slot 1 while only the start scene is
 * loaded, then loads a second scene (holding a crate and a kept lantern),
 * then loads slot 1, and a little later writes what it sees into the
 * settings field `log`: whether the load worked, the second scene's status,
 * whether the lantern is still there.
 *
 * - `legacyWorld: false` (the game restores scenes itself): the load changes
 *   no scene — the second scene stays loaded; no Problems line.
 * - `sections: ['world']`: the load puts the scenes back as saved (the second
 *   scene unloads) but the kept lantern stays; no Problems line.
 * - neither (a project from before): the same as `world`, plus one Problems
 *   line `deprecated_save_world` for the Play.
 * - The Saves tab names the deprecated default and turns it off; `world` is a
 *   section box like the others.
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from './pw';

import { publishScript, startBackend, type E2EBackend } from './backend';
import { openProjectSettings } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-save-world' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function problems(): Promise<{ code: string; message: string }[]> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/problems`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
  return ((await r.json()) as { problems: { code: string; message: string }[] }).problems;
}

const director = (lantern: string): string =>
  [
    'export default {',
    "  instantiate() { return { phase: 'start', at: 0, ok: '' }; },",
    '  step(m: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    '    const s = ctx.saves;',
    '    if (!s.ready()) return;',
    "    if (m.phase === 'start') { s.write({ v: 1 }); s.save(1); m.phase = 'saving'; return; }",
    '    for (const r of s.results()) {',
    "      if (m.phase === 'saving' && r.op === 'save') { ctx.scenes.load('level'); m.phase = 'arriving'; }",
    "      else if (m.phase === 'loading' && r.op === 'load') { m.ok = String(r.ok); m.at = ctx.stepIndex; m.phase = 'settling'; }",
    '    }',
    "    if (m.phase === 'arriving' && ctx.scenes.status('level') === 'loaded') { s.load(1); m.phase = 'loading'; }",
    "    if (m.phase === 'settling' && ctx.stepIndex >= m.at + 30) {",
    `      s.setSetting('log', 'load=' + m.ok + ' level=' + ctx.scenes.status('level') + ' lantern=' + (ctx.world.transform('${lantern}') !== null && ctx.world.transform('${lantern}') !== undefined));`,
    "      m.phase = 'end';",
    '    }',
    '  },',
    '};',
    '',
  ].join('\n');

async function playAndRead(page: Page): Promise<string> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const log = async (): Promise<string> => String((((await api(`play/${psid}/observe`)).json as { saves?: { settings: Record<string, unknown> } }).saves?.settings['log']) ?? '');
  await expect.poll(log, { timeout: 60_000, message: 'the director finished' }).not.toBe('');
  const seen = await log();
  // Clear what this Play saved, so the next one starts from an empty slot list.
  expect((await api(`play/${psid}/control`, { command: 'clearSave' })).status).toBe(200);
  await page.getByTitle('Stop the play preview').click();
  return seen;
}

test('world is an opt-in save section: without it a load changes no scene; with it (or the deprecated default) scenes go back but a kept object stays', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend(`save-world-${randomUUID().slice(0, 8)}`, 'starter');
  await cmd('createScene', { sceneId: 'level', name: 'Level' });
  await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Crate', transform: { position: [2, 0.5, -2] } });
  const lantern = String((await cmd('createEntity', { sceneId: 'level', kind: 'box', name: 'Lantern', keepLoaded: true, transform: { position: [-2, 0.5, -2] } }))['createdId']);
  const dir = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -10, 0] } }))['createdId']);
  await publishScript(be, 'director', director(lantern), dir);
  const settings = [{ key: 'log', type: 'string', default: '' }];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const worldLines = async (): Promise<{ code: string; message: string }[]> => (await problems()).filter((p) => p.code === 'deprecated_save_world');

  // The game restores scenes itself: the load changes none.
  await cmd('setSaveSchema', { schema: { version: 1, slots: 2, legacyWorld: false, settings } });
  expect(await playAndRead(page)).toBe('load=true level=loaded lantern=true');
  expect(await worldLines()).toEqual([]);

  // `world` listed: the scenes go back as saved; the kept lantern stays.
  await cmd('setSaveSchema', { schema: { version: 1, slots: 2, sections: ['world'], settings } });
  expect(await playAndRead(page)).toBe('load=true level=unloaded lantern=true');
  expect(await worldLines()).toEqual([]);

  // Neither (a project from before): as listed, with one Problems line naming the replacement.
  await cmd('setSaveSchema', { schema: { version: 1, slots: 2, settings } });
  expect(await playAndRead(page)).toBe('load=true level=unloaded lantern=true');
  await expect.poll(async () => (await worldLines()).length, { timeout: 15_000 }).toBe(1);
  expect((await worldLines())[0]!.message).toMatch(/always-on world.*deprecated.*sections.*legacyWorld: false/);

  // The Saves tab: the deprecated default is named, one click turns it off, the section is a box like the others.
  const schemaNow = async (): Promise<unknown> => (await query('queryGameConfig'))['saveSchema'];
  await openProjectSettings(page, 'Saves');
  const panel = page.getByLabel('project saves');
  await expect(panel.locator('[data-legacy-world]')).toBeVisible();
  await panel.getByRole('button', { name: 'restore scenes in the game' }).click();
  await expect(panel.locator('[data-legacy-world]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'apply save schema' }).click();
  await expect.poll(schemaNow).toEqual({ version: 1, slots: 2, legacyWorld: false, settings });
  await panel.getByLabel('save section world').check();
  await panel.getByRole('button', { name: 'apply save schema' }).click();
  await expect.poll(schemaNow).toEqual({ version: 1, slots: 2, sections: ['world'], legacyWorld: false, settings });
  expect(errors).toEqual([]);
});
