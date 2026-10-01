/**
 * Dialogue with voice against a real backend and a real browser
 * — the editor's previewer, Play (the simulation worker) and the static
 * export (backend stopped).
 *
 * Neutral content made with the same commands MCP sends, on a blank project:
 * two speakers (a host with two expressions, a guest with a text blip), three
 * portrait textures and two WAV sounds imported through the Asset browser, a
 * conversation graph (a voiced line with auto-advance, a line, a choice whose
 * option sets a variable, a branch on it), the dialogue settings, and a
 * script that starts the conversation when a key is pressed.
 *
 * Checked in Play and the export: the engine dialogue document shows the
 * speaker's name plate, portrait (pixels: the expression's colour) and the
 * typewriter text; the voice plays on the voice bus and the music and SFX
 * ducks go down (the host's audio observation — graph state, not heard
 * sound) and come back after the clip; the line auto-advances; clicks
 * advance; a choice sets the variable the branch reads; the backlog shows the
 * conversation. In the editor: the Dialogue window lists it, its tab shows
 * the graph, and the previewer plays it with portraits outside Play.
 *
 * What the voice and blips sound like is owner look pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Frame, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { makePng } from './png-make';
import { projectWindow, openWindow, editorTab } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: E2EBackend | null = null;
let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-dialogue-e2e-'));
});
test.afterEach(async () => {
  await be?.stop();
  be = null;
  rmSync(dir, { recursive: true, force: true });
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-dialogue' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Import one file through the editor's Assets tab; returns its asset id. */
async function importFile(page: Page, file: string, name: string): Promise<string> {
  const assets = async () => (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string }[];
  const before = (await assets()).length;
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(before + 1);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

const SCRIPT = [
  'export default {',
  '  instantiate() { return { last: -1 }; },',
  '  step(state: any, ctx: any) {',
  '    if (state.last === ctx.stepIndex) return;',
  '    state.last = ctx.stepIndex;',
  '    const d = ctx.dialogue;',
  '    const act = ctx.action.actions ?? {};',
  "    if (act.talk?.p === 'pressed' && !d.isRunning()) d.start('talk');",
  "    ctx.ui.set('probe', { served: d.get('served') });",
  '  },',
  '};',
].join('\n');

async function publishScript(entityId: string): Promise<void> {
  const behaviorId = 'talker';
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: SCRIPT }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: 'Talker', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Talker', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

type Ids = { voice: string; happy: string; neutral: string; guest: string };

/** Everything the checks share: portraits, sounds, speakers, the conversation, settings, the script and its key. */
async function setUp(page: Page): Promise<Ids> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const png = (name: string, rgb: [number, number, number]): string => {
    const f = join(dir, `${name}.png`);
    writeFileSync(f, makePng(16, 16, () => [rgb[0], rgb[1], rgb[2], 255]));
    return f;
  };
  const happy = await importFile(page, png('host-happy', [230, 40, 40]), 'host-happy');
  const neutral = await importFile(page, png('host-neutral', [40, 60, 230]), 'host-neutral');
  const guest = await importFile(page, png('guest-neutral', [40, 200, 60]), 'guest-neutral');
  const voice = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-max.wav'), 'cue-max');
  const blip = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'), 'cue-jump');

  await cmd('setSpeaker', { speaker: { speakerId: 'host', name: 'Host', color: '#ffcc66', portraits: { happy, neutral }, defaultExpression: 'neutral', voiceProfile: 'host-voice' } });
  await cmd('setSpeaker', { speaker: { speakerId: 'guest', name: 'Guest', color: '#88ddff', portraits: { neutral: guest }, blip, blipEvery: 3 } });
  const node = (id: string, type: string, y: number, data?: Record<string, unknown>) => ({ id, type, position: [0, y], ...(data !== undefined ? { data } : {}) });
  const wire = (id: string, from: string, port: string, to: string) => ({ id, from: { node: from, port }, to: { node: to, port: 'in' } });
  await cmd('setDialogue', {
    dialogue: {
      dialogueId: 'talk',
      name: 'Garden talk',
      graph: {
        nodes: [
          node('start', 'start', 0),
          node('hello', 'line', 100, { speaker: 'host', expression: 'happy', text: 'Welcome to the [b]garden[/b].' }),
          node('intro', 'line', 150, { speaker: 'host', expression: 'neutral', text: 'The water is fresh today.', voice, auto: 'on' }),
          node('ask', 'line', 200, { speaker: 'guest', text: 'May I have some water?' }),
          node('c', 'choice', 300),
          node('yes', 'option', 400, { text: 'Of course', effects: 'served = true' }),
          node('no', 'option', 500, { text: 'Not now' }),
          node('b', 'branch', 600, { condition: 'served' }),
          node('thanks', 'line', 700, { speaker: 'host', text: 'Here you are.' }),
          node('pity', 'line', 800, { speaker: 'host', text: 'Maybe later.' }),
        ],
        edges: [wire('w1', 'start', 'next', 'hello'), wire('w2', 'hello', 'next', 'intro'), wire('w2b', 'intro', 'next', 'ask'), wire('w3', 'ask', 'next', 'c'), wire('w4', 'c', 'options', 'yes'), wire('w5', 'c', 'options', 'no'), wire('w6', 'yes', 'next', 'b'), wire('w7', 'no', 'next', 'b'), wire('w8', 'b', 'true', 'thanks'), wire('w9', 'b', 'false', 'pity')],
      },
    },
  });
  await cmd('setDialogueSettings', { settings: { textSpeed: 40, autoDelay: 0.3, duck: 0.3 } });
  await cmd('setInput', { input: { actions: [{ name: 'talk', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyT' }] }] } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [10, 1, 10], material: { color: '#8a8f98' } } });
  const talker = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Talker', transform: { position: [0, 0, 0] } }))['createdId']);
  await publishScript(talker);
  // MCP reads it back.
  const cfg = await query('queryGameConfig');
  expect((cfg['dialogues'] as { dialogueId: string }[]).map((d) => d.dialogueId)).toEqual(['talk']);
  expect((cfg['speakers'] as unknown[]).length).toBe(2);
  return { voice, happy, neutral, guest };
}

type Obs = {
  dialogue?: { running: boolean; kind: string; line: { id: string; name: string; expression: string; portrait: string; reveal: number; total: number; voiced: boolean } | null; choices: string[]; backlog: number; backlogTail: { text: string }[]; backlogOpen: boolean };
  audio?: { voices: { assetId: string; bus: string; state: string }[]; music: { duck: number }; sfxDuck: number };
  sound?: { unlocked?: boolean };
};

/**
 * The colour of the image an element draws as its background (decoded in the
 * page from the element's blob: URL) — the portrait the element shows. (A
 * page screenshot of a running game can take longer than a poll allows on a
 * CPU-rastered host; the editor previewer's check below uses real pixels.)
 */
async function imageColourOf(loc: Locator): Promise<[number, number, number]> {
  return loc.evaluate(async (el) => {
    const m = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage);
    if (m === null) return [0, 0, 0] as [number, number, number];
    const bmp = await createImageBitmap(await (await fetch(m[1]!)).blob());
    const c = new OffscreenCanvas(1, 1);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, bmp.width / 2, bmp.height / 2, 1, 1, 0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!] as [number, number, number];
  });
}

/** The colour at the centre of an element, from a clip of the page (no stability wait: the game keeps drawing). */
async function colourOf(loc: Locator): Promise<[number, number, number]> {
  const box = await loc.boundingBox();
  if (box === null) return [0, 0, 0];
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  const img = decodePng(await loc.page().screenshot({ clip: { x: cx - 2, y: cy - 2, width: 4, height: 4 }, animations: 'allow' }));
  const [r, g, b] = img.pixel(1, 1);
  return [r, g, b];
}

/**
 * The conversation, driven the same way in Play and the export: `root` holds
 * the game's DOM, `click` clicks an element (by coordinates: an export's
 * overlay may cover it), `observe` reads the host's observation.
 */
/** What the audio observation showed while the voice played (sampled all along: the clip lasts 2 s). */
export interface AudioSampler {
  start(): Promise<void>;
  result(): Promise<{ voiceBus: string | null; minDuck: number; minSfx: number; portraits: Record<string, string> }>;
}

/** Sample through an observation reader in a loop (Play: the backend relay). */
function loopSampler(observe: () => Promise<Obs | null>, voice: string): AudioSampler {
  const r = { voiceBus: null as string | null, minDuck: 1, minSfx: 1, portraits: {} as Record<string, string> };
  let running = false;
  let loop: Promise<void> = Promise.resolve();
  return {
    start: async () => {
      running = true;
      loop = (async () => {
        // Paced and bounded: a failed test never stops it, and an unpaced loop against a stopped backend
        // kept the worker busy past its timeouts (the whole run hung).
        const until = Date.now() + 120_000;
        while (running && Date.now() < until) {
          await new Promise((ok) => setTimeout(ok, 30));
          const o = await observe().catch(() => null);
          if (o?.dialogue?.line) r.portraits[o.dialogue.line.id] = o.dialogue.line.portrait;
          const a = o?.audio;
          if (a === undefined) continue;
          r.minDuck = Math.min(r.minDuck, a.music.duck);
          r.minSfx = Math.min(r.minSfx, a.sfxDuck);
          const v = a.voices.find((x) => x.assetId === voice);
          if (v !== undefined) r.voiceBus = v.bus;
        }
      })();
    },
    result: async () => {
      running = false;
      await loop;
      return { ...r };
    },
  };
}

/** Sample inside the game page (the export's own observation, every 30 ms). */
function pageSampler(game: Page, voice: string): AudioSampler {
  return {
    start: () =>
      game.evaluate((id) => {
        const w = window as unknown as { __tlSamples: { voiceBus: string | null; minDuck: number; minSfx: number; portraits: Record<string, string> }; __thirdlightObserve?: () => { audio?: { voices: { assetId: string; bus: string }[]; music: { duck: number }; sfxDuck: number }; dialogue?: { line: { id: string; portrait: string } | null } } | null };
        w.__tlSamples = { voiceBus: null, minDuck: 1, minSfx: 1, portraits: {} };
        setInterval(() => {
          const o = w.__thirdlightObserve?.();
          const s = w.__tlSamples;
          if (o?.dialogue?.line) s.portraits[o.dialogue.line.id] = o.dialogue.line.portrait;
          const a = o?.audio;
          if (a === undefined) return;
          s.minDuck = Math.min(s.minDuck, a.music.duck);
          s.minSfx = Math.min(s.minSfx, a.sfxDuck);
          const v = a.voices.find((x) => x.assetId === id);
          if (v !== undefined) s.voiceBus = v.bus;
        }, 30);
      }, voice),
    result: () => game.evaluate(() => (window as unknown as { __tlSamples: { voiceBus: string | null; minDuck: number; minSfx: number; portraits: Record<string, string> } }).__tlSamples),
  };
}

async function drive(page: Page, root: Page | Frame, click: (l: Locator) => Promise<void>, observe: () => Promise<Obs | null>, ids: Ids, sampler: AudioSampler): Promise<void> {
  const doc = root.locator('[data-tl-ui-doc="tl-dialogue"]');
  const line = async () => (await observe())?.dialogue?.line ?? null;
  await page.keyboard.press('t');
  await expect(doc).toHaveCount(1, { timeout: 40_000 });
  await expect.poll(async () => (await line())?.id ?? null, { timeout: 40_000 }).toBe('hello');
  await expect(doc.locator('[data-widget="name"]')).toHaveText('Host');
  await expect(doc.locator('[data-widget="text"]')).toContainText('Welcome to the garden.');
  // The typewriter: the reveal grows over time (or is already whole on a slow host).
  const first = (await line())!;
  if (first.id === 'hello' && first.reveal < first.total) await expect.poll(async () => (await line())?.reveal ?? 99, { timeout: 30_000 }).toBeGreaterThan(first.reveal);
  const portrait = doc.locator('[data-widget="portrait"]');
  // The portrait's image colour, read once the element shows a new image (a busy host makes every page call slow).
  const colour = async (channel: number, label: string, not?: string): Promise<string> => {
    await expect.poll(async () => portrait.evaluate((el) => getComputedStyle(el).backgroundImage), { timeout: 60_000, message: `${label} portrait image` }).toMatch(/blob:/);
    if (not !== undefined) await expect.poll(async () => portrait.evaluate((el) => getComputedStyle(el).backgroundImage), { timeout: 60_000, message: `${label} portrait changes` }).not.toBe(not);
    const bg = await portrait.evaluate((el) => getComputedStyle(el).backgroundImage);
    const c = await imageColourOf(portrait);
    expect(c[channel], `${label} portrait colour ${c.join(',')}`).toBeGreaterThan(150);
    return bg;
  };
  const happyImage = await colour(0, 'happy'); // the host's happy portrait (red)
  expect((await line())!).toMatchObject({ id: 'hello', name: 'Host', expression: 'happy', portrait: ids.happy });
  // Clicks: the rest of the line, then the voiced line (the host's neutral expression).
  await sampler.start();
  const box = doc.locator('[data-widget="box"]');
  await expect
    .poll(
      async () => {
        if ((await line())?.id === 'hello') await click(box);
        // No observation is no line: only a line past the first counts.
        return (await line())?.id ?? 'unobserved';
      },
      { timeout: 40_000, intervals: [400] },
    )
    .toMatch(/^(intro|ask)$/);
  // The host's neutral portrait (blue) — its pixels while the voiced line is still up (a slow host may be past it; the observation records it anyway).
  const neutralImage = (await line())?.id === 'intro' ? await colour(2, 'neutral', happyImage) : happyImage;
  // Auto-advance after the 2 s clip and the delay; the ducks come back up.
  await expect.poll(async () => (await line())?.id ?? null, { timeout: 30_000, message: 'auto-advance after the voice' }).toBe('ask');
  // While the voice played: on the voice bus, music and SFX ducked to the settings' 0.3.
  const heard = await sampler.result();
  expect(heard.voiceBus, `the voice plays on the voice bus (${JSON.stringify(heard)})`).toBe('voice');
  expect(heard.minDuck, 'music ducked').toBeCloseTo(0.3, 2);
  expect(heard.minSfx, 'SFX ducked').toBeCloseTo(0.3, 2);
  expect(heard.portraits['intro'], 'the voiced line showed the host\'s neutral portrait').toBe(ids.neutral);
  await expect.poll(async () => (await observe())?.audio?.music.duck ?? 0, { timeout: 30_000 }).toBeCloseTo(1, 2);
  await expect.poll(async () => (await observe())?.audio?.sfxDuck ?? 0, { timeout: 30_000 }).toBeCloseTo(1, 2);
  await expect(doc.locator('[data-widget="name"]')).toHaveText('Guest');
  await colour(1, 'guest', neutralImage); // the guest's portrait (green)
  // Clicks: reveal the rest, then go on to the choice.
  await expect
    .poll(
      async () => {
        const o = await observe();
        if (o !== null && o.dialogue?.kind !== 'choice') await click(box);
        return (await observe())?.dialogue?.kind ?? null;
      },
      { timeout: 40_000, intervals: [400] },
    )
    .toBe('choice');
  const choices = doc.locator('[data-widget="choice"]');
  await expect(choices).toHaveText(['Of course', 'Not now']);
  await click(choices.first());
  // The option set `served`; the branch read it.
  await expect.poll(async () => (await line())?.id ?? null, { timeout: 30_000 }).toBe('thanks');
  // The backlog shows the conversation.
  await click(doc.locator('[data-widget="log"]'));
  await expect.poll(async () => (await observe())?.dialogue?.backlogOpen ?? false, { timeout: 30_000 }).toBe(true);
  const backlog = doc.locator('[data-widget="backlog"]');
  await expect(backlog).toBeVisible();
  for (const t of ['Welcome to the garden.', 'The water is fresh today.', 'May I have some water?', '> Of course', 'Here you are.']) await expect(backlog).toContainText(t);
  expect((await observe())!.dialogue!.backlogTail.map((b) => b.text)).toEqual(['Welcome to the [b]garden[/b].', 'The water is fresh today.', 'May I have some water?', '> Of course', 'Here you are.']);
  await page.screenshot({ path: `test-results/dialogue-backlog-${root === page ? 'page' : 'frame'}.png` }).catch(() => undefined);
  await click(doc.locator('[data-widget="backlogClose"]'));
  await expect.poll(async () => (await observe())?.dialogue?.backlogOpen ?? true, { timeout: 30_000 }).toBe(false);
  // To the end: the document hides.
  await expect
    .poll(
      async () => {
        if ((await observe())?.dialogue?.running === true && (await doc.count()) > 0) await click(box).catch(() => undefined);
        return (await observe())?.dialogue?.running ?? null;
      },
      { timeout: 40_000, intervals: [400] },
    )
    .toBe(false);
  await expect(doc).toHaveCount(0, { timeout: 30_000 });
}

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

test('dialogue with voice: the editor previewer, Play and the export', async ({ page }) => {
  test.setTimeout(600_000);
  be = await startBackend('dialogue-e2e');
  const ids = await setUp(page);

  // The editor: the Dialogue window lists the conversation; its tab shows the graph; the previewer plays it outside Play.
  await openWindow(page, 'Dialogue');
  const row = page.locator('.tl-dialogue-panel li[data-dialogue-id="talk"]');
  await expect(row).toContainText('Garden talk');
  await page.getByRole('button', { name: 'Open Garden talk' }).click();
  await expect(editorTab(page, 'Dialogue', 'Garden talk')).toBeVisible();
  await expect(page.locator('[aria-label="dialogue graph"]')).toBeVisible();
  await page.getByRole('button', { name: 'play dialogue preview' }).click();
  const stage = page.locator('[aria-label="dialogue preview stage"]');
  const pdoc = stage.locator('[data-tl-ui-doc="tl-dialogue"]');
  await expect(pdoc).toHaveCount(1, { timeout: 40_000 });
  await expect(pdoc.locator('[data-widget="text"]')).toContainText('Welcome to the garden.', { timeout: 30_000 });
  await expect(pdoc.locator('[data-widget="name"]')).toHaveText('Host');
  const ppor = pdoc.locator('[data-widget="portrait"]');
  await expect.poll(async () => (await colourOf(ppor))[0], { timeout: 30_000 }).toBeGreaterThan(180);
  // Clicks go on to the voiced line (the host's neutral portrait, blue) …
  await expect
    .poll(
      async () => {
        const t = (await pdoc.locator('[data-widget="text"]').textContent()) ?? '';
        if (t.includes('Welcome')) await pdoc.locator('[data-widget="box"]').click();
        return t.includes('Welcome') ? 'hello' : 'past';
      },
      { timeout: 30_000, intervals: [400] },
    )
    .toBe('past');
  // … whose voice length was measured in the page: it auto-advances after the clip.
  await expect(pdoc.locator('[data-widget="name"]')).toHaveText('Guest', { timeout: 30_000 });
  await expect
    .poll(
      async () => {
        if ((await pdoc.locator('[data-widget="choice"]').count()) === 0) await pdoc.locator('[data-widget="box"]').click();
        return pdoc.locator('[data-widget="choice"]').count();
      },
      { timeout: 15_000, intervals: [400] },
    )
    .toBe(2);
  await pdoc.locator('[data-widget="choice"]').first().click();
  await expect(pdoc.locator('[data-widget="text"]')).toContainText('Here you are.', { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/dialogue-preview.png' });
  await page.getByRole('button', { name: 'stop dialogue preview' }).click();
  await expect(pdoc).toHaveCount(0, { timeout: 30_000 });

  // Play (the simulation worker): a click unlocks sound and focuses the game.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const iframe = page.locator('iframe.tl-app__preview-frame');
  // One observation at a time: the backend relays one per Play and refuses a second while one is
  // pending (`input_relay_conflict`), and the sampler polls beside the driver.
  let queue: Promise<unknown> = Promise.resolve();
  const observe = (): Promise<Obs | null> => {
    const next = queue.then(async () => {
      const r = await api(`play/${psid}/observe`, {});
      return r.status === 200 ? (r.json as Obs) : null;
    });
    queue = next.catch(() => null);
    return next;
  };
  await expect.poll(async () => ((await observe()) as { state?: string } | null)?.state ?? null, { timeout: 60_000 }).toBe('running');
  const fb = (await iframe.boundingBox())!;
  await page.mouse.click(fb.x + fb.width / 2, fb.y + 20);
  await expect.poll(async () => (await observe())?.sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
  const playFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/play'))!;
  expect(playFrame).toBeDefined();
  const clickIn = async (l: Locator): Promise<void> => {
    const b = await l.boundingBox();
    if (b === null) throw new Error('not visible');
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await drive(page, playFrame, clickIn, observe, ids, loopSampler(observe, ids.voice));
  await page.getByTitle('Stop the play preview').click();
  await expect(iframe).toHaveCount(0, { timeout: 40_000 });

  // The static export with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Obs | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Obs | null);
    await expect.poll(async () => ((await read()) as { state?: string } | null)?.state ?? null, { timeout: 60_000 }).toBe('running');
    await game.mouse.click(400, 40);
    await expect.poll(async () => (await read())?.sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
    const clickGame = async (l: Locator): Promise<void> => {
      const b = await l.boundingBox();
      if (b === null) throw new Error('not visible');
      await game.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    await drive(game, game, clickGame, read, ids, pageSampler(game, ids.voice));
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
