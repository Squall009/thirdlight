/**
 * The editor at scale, driven in a real browser against the bench project:
 * how long the editor takes to be usable, the asset list scrolled from top
 * to bottom (frame times, what the page holds before and after, what it
 * fetched), a search in a reference picker, placing an asset from far down
 * the list, and giving a dialogue line a voice through its picker.
 *
 * Used by the scale bench's `editor` step (scale.ts) and its end-to-end test
 * (tests/e2e/editor-scale.e2e.ts). Only the page's public DOM is driven.
 */
import type { Page } from '@playwright/test';

import { readSample } from './instrument';
import { summarize, type Summary } from './stats';

/**
 * Show one of the bottom dock's panels. An item's editor window (opened by an
 * earlier step, or remembered from an earlier visit) covers the dock: it is
 * closed first, as a person would with Esc.
 */
export async function showDockTab(page: Page, name: string): Promise<void> {
  const close = page.getByRole('button', { name: 'Close the editor window', exact: true });
  if ((await close.count()) > 0) await close.click();
  await page.locator('.tl-dock--bottom > [role="tablist"]').getByRole('tab', { name, exact: true }).click();
}

export interface EditorScaleReport {
  /** Page opened → connected, and → the asset list showing its first tiles and the catalog's size. */
  connectedMs: number;
  interactiveMs: number;
  /** What the asset list says it holds (the project index's asset entries). */
  listTotal: number;
  /** The heap after a collection once the editor is usable (MiB; null: not measurable here). */
  heapOpenMiB: number | null;
  scroll: {
    /** Every tile the scroll drew (distinct assets). */
    tilesSeen: number;
    /** Screens scrolled, and how long it took. */
    steps: number;
    ms: number;
    /** Frame-to-frame times while scrolling (ms). */
    frameMs: Summary;
    heapBeforeMiB: number | null;
    heapAfterMiB: number | null;
    /** What the page fetched while scrolling: index pages, summaries, thumbnails, and asset bytes (a model's to draw its thumbnail the first time). */
    requests: { index: number; summaries: number; thumbnails: number; assetBytes: number };
    /** The assets whose bytes were read while scrolling (a model's, to make its thumbnail; the Scene view's models). */
    bytesOf: string[];
  };
  /** Typing into a reference picker → the first match shown. */
  pickerSearch: { ms: number; matches: number };
  /** A model far down the list: its tile clicked → placed (its object in the hierarchy). */
  place: { ms: number; assetId: string; position: number };
  /** A dialogue line given a voice through its picker: chosen → stored (the backend has it). */
  voice: { ms: number; assetId: string; dialogueId: string; node: string };
}

export interface EditorScaleOptions {
  /** A read-only query on the project (the backend's command route). */
  query: (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Wait for each screen's tiles to be drawn before scrolling on (true: every tile is seen; false: scroll at frame rate, as a fling). */
  settle: boolean;
  /** The editor page URL. */
  url: string;
  /** Load the page (false: it is loaded already, and connected). */
  open?: boolean;
  log?: (s: string) => void;
}

/** The asset kinds the Assets tab lists. */
const ASSET_KINDS = ['model', 'audio', 'texture', 'font'];

const heapOf = async (page: Page): Promise<number | null> => {
  const s = await page.evaluate(readSample, false);
  return s.heap === null ? null : Math.round(s.heap.usedMiB * 100) / 100;
};

/** Requests the page made, by what they read. */
function countRequests(page: Page): { stop(): { index: number; summaries: number; thumbnails: number; assetBytes: number }; bytesOf: string[] } {
  const n = { index: 0, summaries: 0, thumbnails: 0, assetBytes: 0 };
  const bytesOf: string[] = [];
  const onRequest = (r: { url(): string; method(): string; postData(): string | null }): void => {
    const url = r.url();
    if (url.includes('/content/thumbnails/')) n.thumbnails += 1;
    else if (/\/content\/assets\/[^/]+\/versions\/\d+\/bytes/.test(url)) {
      n.assetBytes += 1;
      bytesOf.push(decodeURIComponent(/\/content\/assets\/([^/]+)\//.exec(url)![1]!));
    }
    else if (url.endsWith('/commands') && r.method() === 'POST') {
      const body = r.postData() ?? '';
      if (body.includes('"queryIndex"')) n.index += 1;
      else if (body.includes('"queryAssets"')) n.summaries += 1;
    }
  };
  page.on('request', onRequest);
  return {
    bytesOf,
    stop() {
      page.off('request', onRequest);
      return { ...n };
    },
  };
}

export async function measureEditorAtScale(page: Page, o: EditorScaleOptions): Promise<EditorScaleReport> {
  const log = o.log ?? (() => undefined);
  const list = page.locator('.tl-assets__list');
  let connectedMs = 0;
  let interactiveMs = 0;
  if (o.open !== false) {
    // A page on the editor already is left first (the same URL would only change its fragment).
    await page.goto('about:blank');
    const t0 = Date.now();
    await page.goto(o.url);
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 600_000 });
    connectedMs = Date.now() - t0;
    await showDockTab(page, 'Assets');
    await page.locator('.tl-assets__paging[data-total]:not([data-total=""])').waitFor({ timeout: 120_000 });
    await list.locator('li[data-asset-id]').first().waitFor({ timeout: 120_000 });
    interactiveMs = Date.now() - t0;
  } else {
    await showDockTab(page, 'Assets');
    await list.locator('li[data-asset-id]').first().waitFor({ timeout: 120_000 });
  }
  const listTotal = Number(await page.locator('.tl-assets__paging').getAttribute('data-total'));
  const heapOpenMiB = await heapOf(page);
  log(`editor: connected ${connectedMs} ms, interactive ${interactiveMs} ms, ${listTotal} assets listed`);

  // ---- the asset list, top to bottom
  const heapBeforeMiB = await heapOf(page);
  const requests = countRequests(page);
  const t1 = Date.now();
  const scrolled = await page.evaluate(
    async ({ settle }) => {
      const el = document.querySelector('.tl-assets__list') as HTMLElement;
      el.scrollTop = 0;
      const seen = new Set<string>();
      const frames: number[] = [];
      let last = performance.now();
      let steps = 0;
      const frame = (): Promise<number> => new Promise((r) => requestAnimationFrame((t) => r(t)));
      const collect = (): void => {
        for (const li of el.querySelectorAll('li[data-asset-id]')) seen.add((li as HTMLElement).dataset['assetId']!);
      };
      const settled = async (): Promise<void> => {
        // Every drawn slot has its tile (no placeholder) and the pictures asked for have come or failed.
        for (let i = 0; i < 1200; i++) {
          if (el.querySelector('.tl-tile--loading, img[data-thumb="pending"]') === null) return;
          await frame();
        }
      };
      for (;;) {
        const t = await frame();
        frames.push(t - last);
        last = t;
        if (settle) {
          await settled();
          last = performance.now();
        }
        collect();
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) break;
        el.scrollTop += settle ? Math.max(1, Math.floor(el.clientHeight * 0.9)) : el.clientHeight;
        steps += 1;
      }
      if (settle) await settled();
      collect();
      return { seen: seen.size, steps, frames };
    },
    { settle: o.settle },
  );
  const scrollMs = Date.now() - t1;
  const counted = requests.stop();
  const heapAfterMiB = await heapOf(page);
  log(`editor: scrolled ${scrolled.steps} screens in ${scrollMs} ms, ${scrolled.seen} tiles, requests ${JSON.stringify(counted)}`);

  // ---- a model far down the list: its tile, then "place"
  const models = await o.query('queryIndex', { kinds: ASSET_KINDS, refs: false, limit: 1024, offset: 0 });
  let position = -1;
  let modelId = '';
  const total = Number(models['total'] ?? 0);
  for (let offset = 0; offset < total && position < 0; offset += 1024) {
    const page_ = offset === 0 ? models : await o.query('queryIndex', { kinds: ASSET_KINDS, refs: false, limit: 1024, offset });
    const entries = (page_['entries'] as { kind: string; id: string }[]) ?? [];
    const k = entries.findIndex((e, i) => e.kind === 'model' && offset + i >= 128);
    if (k >= 0) {
      position = offset + k;
      modelId = entries[k]!.id;
    }
  }
  if (position < 0) throw new Error('the bench project has no model past the first 128 assets');
  // Scroll the list to it (the list draws what is in view).
  await page.evaluate(
    async ({ position }) => {
      const el = document.querySelector('.tl-assets__list') as HTMLElement;
      const count = Number(el.dataset['virtualCount']);
      el.scrollTop = (position / Math.max(1, count)) * el.scrollHeight - el.clientHeight / 2;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { position },
  );
  const tile = list.locator(`li[data-asset-id="${modelId}"]`);
  for (let i = 0; i < 50 && (await tile.count()) === 0; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.tl-assets__list') as HTMLElement;
      el.scrollTop += 40;
    });
    await page.waitForTimeout(50);
  }
  await tile.click();
  const placedCount = async (): Promise<number> => Number((await o.query('queryEntities', { limit: 1, component: 'model' }))['total'] ?? 0);
  const before = await placedCount();
  await page.getByRole('button', { name: 'place', exact: true }).waitFor({ timeout: 60_000 });
  const t2 = Date.now();
  await page.getByRole('button', { name: 'place', exact: true }).click();
  // Placed: the backend has the object and the editor's hierarchy shows it (a row named after the model).
  while ((await placedCount()) <= before) {
    if (Date.now() - t2 > 60_000) throw new Error(`placing ${modelId} made no object`);
    await page.waitForTimeout(10);
  }
  const placeMs = Date.now() - t2;
  log(`editor: placed ${modelId} (list position ${position}) in ${placeMs} ms`);

  // ---- a dialogue line's voice, through its picker (a search over the project's sounds)
  const dialogues = await o.query('queryIndex', { kind: 'dialogue', refs: false, limit: 1 });
  const dialogue = ((dialogues['entries'] as { id: string; name: string }[]) ?? [])[0];
  if (dialogue === undefined) throw new Error('the bench project has no conversation');
  const voices = await o.query('queryIndex', { kind: 'audio', refs: false, limit: 1, offset: Math.max(0, Number((await o.query('queryIndex', { kind: 'audio', refs: false, limit: 1 }))['total'] ?? 1) - 1) });
  const voice = ((voices['entries'] as { id: string; name: string }[]) ?? [])[0];
  if (voice === undefined) throw new Error('the bench project has no sound');
  await showDockTab(page, 'Dialogue');
  await page.locator(`.tl-dialogue-panel li[data-dialogue-id="${dialogue.id}"]`).getByRole('button', { name: `Open ${dialogue.name}` }).click();
  const graph = page.locator('[aria-label="dialogue graph"]');
  await graph.waitFor({ timeout: 60_000 });
  // A line node the graph shows (it draws the nodes in view).
  const lineNode = graph.locator('[data-node-type="line"]').first();
  await lineNode.waitFor({ timeout: 60_000 });
  const node = (await lineNode.getAttribute('data-node-id')) ?? '';
  await lineNode.click();
  const picker = page.getByRole('button', { name: 'Voice clip', exact: true });
  await picker.click();
  const search = page.getByRole('textbox', { name: 'Voice clip search' });
  const t3 = Date.now();
  await search.fill(voice.name);
  const option = page.getByRole('listbox', { name: 'Voice clip list' }).locator(`[role="option"][data-id="${voice.id}"]`);
  await option.waitFor({ timeout: 60_000 });
  const searchMs = Date.now() - t3;
  const matches = await page.getByRole('listbox', { name: 'Voice clip list' }).locator('[role="option"][data-id]').count();
  log(`editor: picker search "${voice.name}" in ${searchMs} ms (${matches} shown)`);
  const t4 = Date.now();
  await option.click();
  for (;;) {
    const d = await o.query('queryIndex', { kind: 'dialogue', ids: [dialogue.id], records: true, refs: false });
    const rec = ((d['entries'] as { record?: { graph: { nodes: { id: string; data?: Record<string, unknown> }[] } } }[]) ?? [])[0]?.record;
    if (rec?.graph.nodes.find((x) => x.id === node)?.data?.['voice'] === voice.id) break;
    if (Date.now() - t4 > 60_000) throw new Error(`the line ${dialogue.id}/${node} never got the voice ${voice.id}`);
    await page.waitForTimeout(20);
  }
  const voiceMs = Date.now() - t4;
  log(`editor: voice ${voice.id} on ${dialogue.id}/${node} in ${voiceMs} ms`);
  return {
    connectedMs,
    interactiveMs,
    listTotal,
    heapOpenMiB,
    scroll: { tilesSeen: scrolled.seen, steps: scrolled.steps, ms: scrollMs, frameMs: summarize(scrolled.frames.slice(1)), heapBeforeMiB, heapAfterMiB, requests: counted, bytesOf: [...new Set(requests.bytesOf)] },
    pickerSearch: { ms: searchMs, matches },
    place: { ms: placeMs, assetId: modelId, position },
    voice: { ms: voiceMs, assetId: voice.id, dialogueId: dialogue.id, node },
  };
}
