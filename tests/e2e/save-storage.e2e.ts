/**
 * Saves on the player's device, against a real backend in a real browser,
 * on the starter project with a save schema (3 slots, two settings fields).
 *
 * The page gets a test-only wrapper over the browser's own storage (an init
 * script, not a stand-in for the code under test): IndexedDB refuses the
 * transaction of a save whose body carries a marker, at the slot's metadata
 * write — once as the quota does (`QuotaExceededError` on the transaction),
 * once as an interrupted write (the transaction aborted) — and localStorage
 * refuses a settings document carrying a marker for quota. It also counts
 * `navigator.storage.persist()` calls.
 *
 * A script saves slot 1, then tries two more saves into it (refused for
 * quota, then cut off), then a settings value localStorage refuses, then
 * loads slot 1 (and slot 3 when there is one), and writes what it saw into
 * the settings field `log`: the codes, the loaded documents, `persisted`.
 *
 * - Play: the codes are storage_full / storage_failed / storage_full, slot 1
 *   still loads its first save and keeps its title; persistence was asked
 *   once, at the first save; Play diagnostics and the observation carry the
 *   storage facts; the slots are under `thirdlight-play:<projectId>`.
 * - The export (backend stopped): slot 3 holds a save in the layout the
 *   previous code wrote; the same flow, and slot 3 loads; the slots are under
 *   `thirdlight:<projectId>`. Without IndexedDB the save answers
 *   storage_unavailable.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { STARTER, publishScript, serveDir, startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend(`save-storage-${randomUUID().slice(0, 8)}`, 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-save-storage' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** The test-only storage wrapper (runs in every frame before the page's own scripts). */
function refusingStorage(): void {
  const w = window as unknown as { __persistCalls: number };
  w.__persistCalls = 0;
  const put = IDBObjectStore.prototype.put;
  let armed: 'quota' | 'cut' | null = null;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const req = put.call(this, value, key);
    if (typeof value === 'string' && value.includes('__REFUSE_QUOTA__')) armed = 'quota';
    else if (typeof value === 'string' && value.includes('__CUT_OFF__')) armed = 'cut';
    if (armed !== null && typeof key === 'string' && key.endsWith(':meta')) {
      const tx = this.transaction;
      // The quota refuses the whole transaction with its own error; a cut-off write just never commits.
      if (armed === 'quota') Object.defineProperty(tx, 'error', { configurable: true, get: () => new DOMException('The quota has been exceeded.', 'QuotaExceededError') });
      armed = null;
      tx.abort();
    }
    return req;
  };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    if (String(v).includes('__REFUSE_LS__')) throw new DOMException(`Failed to execute 'setItem' on 'Storage': Setting the value of '${k}' exceeded the quota.`, 'QuotaExceededError');
    setItem.call(this, k, v);
  };
  const storage = navigator.storage as StorageManager | undefined;
  if (storage !== undefined) {
    const persist = storage.persist.bind(storage);
    storage.persist = () => {
      w.__persistCalls += 1;
      return persist();
    };
  }
}

const SCRIPT = [
  'export default {',
  "  instantiate() { return { phase: 'start', q: '', c: '', st: '', n1: '', n3: '', wait: 0 }; },",
  '  step(m: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const s = ctx.saves;',
  '    if (!s.ready()) return;',
  "    const code = (r: any) => (r.ok ? 'ok' : String(r.code));",
  "    if (m.phase === 'start') {",
  '      s.write({ n: 1 });',
  "      s.save(1, { title: 'first' });",
  "      m.phase = 's1';",
  '      return;',
  '    }',
  '    for (const r of s.results()) {',
  "      if (m.phase === 's1' && r.op === 'save') {",
  "        if (!r.ok) { s.setSetting('log', 'save=' + code(r)); m.phase = 'end'; return; }",
  "        s.write({ n: 2, mark: '__REFUSE_QUOTA__' });",
  "        s.save(1, { title: 'second' });",
  "        m.phase = 's2';",
  "      } else if (m.phase === 's2' && r.op === 'save') {",
  '        m.q = code(r);',
  "        s.write({ n: 3, mark: '__CUT_OFF__' });",
  "        s.save(1, { title: 'third' });",
  "        m.phase = 's3';",
  "      } else if (m.phase === 's3' && r.op === 'save') {",
  '        m.c = code(r);',
  "        s.setSetting('name', '__REFUSE_LS__');",
  "        m.phase = 'set';",
  "      } else if (m.phase === 'set' && r.op === 'settings') {",
  '        m.st = code(r);',
  "        s.setSetting('name', 'kept');",
  '        s.load(1);',
  "        m.phase = 'l1';",
  "      } else if (m.phase === 'l1' && r.op === 'load') {",
  "        m.n1 = r.ok ? String(s.read().n) : code(r);",
  "        if (s.slots().some((x: any) => x.slot === 3)) { s.load(3); m.phase = 'l3'; } else m.phase = 'fin';",
  "      } else if (m.phase === 'l3' && r.op === 'load') {",
  "        m.n3 = r.ok ? String(s.read().n) : code(r);",
  "        m.phase = 'fin';",
  '      }',
  '    }',
  "    if (m.phase === 'set' && ++m.wait > 120) { m.st = 'no answer'; s.setSetting('name', 'kept'); s.load(1); m.phase = 'l1'; }",
  "    if (m.phase === 'fin' && s.storage().usage !== null) {",
  '      const st = s.storage();',
  "      s.setSetting('log', `quota=${m.q} cut=${m.c} settings=${m.st} slot1=${m.n1} slot3=${m.n3} persisted=${typeof st.persisted} usage=${st.usage > 0} quota=${st.quota > 0}`);",
  "      m.phase = 'end';",
  '    }',
  '  },',
  '};',
  '',
].join('\n');

const SCHEMA = { version: 1, slots: 3, settings: [{ key: 'name', type: 'string', default: 'a' }, { key: 'log', type: 'string', default: '' }] };
const SEEN = (slot3: string) => `quota=storage_full cut=storage_failed settings=storage_full slot1=1 slot3=${slot3} persisted=boolean usage=true quota=true`;

interface SavesObs { storage: string; persisted: boolean | null; usage: number | null; quota: number | null; persistAsked: boolean; slots: { slot: number; title: string; damaged?: string }[]; settings: Record<string, unknown> }

/** Every key of the save database whose name ends with `suffix`. */
async function saveKeys(target: Page | Frame, suffix: string): Promise<string[]> {
  return target.evaluate(
    (sfx) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('thirdlight-saves', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
          req.onsuccess = () => {
            open.result.close();
            resolve((req.result as string[]).filter((k) => k.endsWith(sfx)).sort());
          };
          req.onerror = () => reject(req.error);
        };
      }),
    suffix,
  );
}

/** FNV-1a 32-bit over UTF-16 units: the slot record's checksum of its body, as stored. */
function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

test('a save refused for quota or cut off leaves the slot\'s earlier save whole; a refused settings write is reported; persistence asked at the first save (Play and export)', async ({ page }) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(refusingStorage);
  await cmd('setSaveSchema', { schema: SCHEMA });
  await publishScript(be, 'behavior-saver', SCRIPT, STARTER.playerId);

  // Play.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const savesOf = async (): Promise<SavesObs | undefined> => ((await api(`play/${psid}/observe`, {})).json as { saves?: SavesObs }).saves;
  await expect.poll(async () => (await savesOf())?.settings['log'] ?? null, { timeout: 90_000, message: 'the script finished in Play' }).toBe(SEEN(''));
  const saves = (await savesOf())!;
  expect(saves.slots).toEqual([expect.objectContaining({ slot: 1, title: 'first' })]);
  expect(saves.slots[0]!.damaged).toBeUndefined();
  expect(saves.settings['name']).toBe('kept');
  expect(saves).toMatchObject({ storage: 'indexeddb', persistAsked: true });
  expect(typeof saves.persisted).toBe('boolean');
  expect(saves.usage).toBeGreaterThan(0);
  expect(saves.quota).toBeGreaterThan(0);
  const frame = (await (await page.locator('iframe.tl-app__preview-frame').elementHandle())!.contentFrame())!;
  expect(await frame.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(1);
  expect(await saveKeys(frame, ':slot:1:meta')).toEqual([`thirdlight-play:${be.projectId}:slot:1:meta`]);
  const diag = (await api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { saves?: Record<string, unknown> };
  expect(diag.saves).toMatchObject({ storage: 'indexeddb', persistAsked: true, persisted: saves.persisted });
  expect(diag.saves!['usage']).toBeGreaterThan(0);
  await page.getByTitle('Stop the play preview').click();

  // The export, served with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  try {
    const game = await page.context().newPage();
    game.on('pageerror', (e) => errors.push(e.message));
    await game.addInitScript(refusingStorage);
    const observe = async (): Promise<SavesObs | undefined> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { saves?: unknown } | null }).__thirdlightObserve?.()?.saves ?? undefined) as SavesObs | undefined);
    // Slot 3 in the layout the previous code wrote (its record, body and no picture), before the game starts.
    await game.goto(`${site.url}missing-page`);
    const ns = `thirdlight:${be.projectId}`;
    const body = JSON.stringify({ format: 'thirdlight.save', formatVersion: 2, version: 1, playSeconds: 4, doc: { n: 'old' }, world: { scenes: ['scene-main'], activeSpawn: null, listedScene: -1, character: null } });
    const meta = JSON.stringify({ v: 1, slot: 3, title: 'older', chapter: '', location: '', playSeconds: 4, savedAt: '2026-10-01T00:00:00.000Z', version: 1, bytes: body.length, sum: checksum(body) });
    await game.evaluate(
      ([n, b, m]) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('thirdlight-saves', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => {
            const tx = open.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(b, `${n}:slot:3:body`);
            tx.objectStore('kv').put(m, `${n}:slot:3:meta`);
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      [ns, body, meta] as const,
    );
    await game.goto(site.url);
    await expect.poll(async () => (await observe())?.settings['log'] ?? null, { timeout: 90_000, message: 'the script finished in the export' }).toBe(SEEN('old'));
    const ex = (await observe())!;
    expect(ex.slots.map((s) => [s.slot, s.title, s.damaged ?? null])).toEqual([
      [1, 'first', null],
      [3, 'older', null],
    ]);
    expect(await game.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(1);
    expect(await saveKeys(game, ':slot:1:meta')).toEqual([`${ns}:slot:1:meta`]);
    await game.close();

    // No IndexedDB: the save answers storage_unavailable.
    const bare = await page.context().newPage();
    bare.on('pageerror', (e) => errors.push(e.message));
    await bare.addInitScript(() => Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }));
    await bare.goto(site.url);
    const bareSaves = async (): Promise<SavesObs | undefined> => bare.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { saves?: unknown } | null }).__thirdlightObserve?.()?.saves ?? undefined) as SavesObs | undefined);
    await expect.poll(async () => (await bareSaves())?.settings['log'] ?? null, { timeout: 90_000, message: 'the save answered without IndexedDB' }).toBe('save=storage_unavailable');
    expect((await bareSaves())!.storage).toBe('unavailable');
    await bare.close();
  } finally {
    await site.close();
  }
  expect(errors).toEqual([]);
});
