/**
 * The editor on a bench project of 1,800 assets (the scale bench at ×0.1),
 * in a real browser against the real backend: it opens with the asset list
 * paged from the project index; the whole catalog scrolls through a list
 * that draws only what is in view; a model far past the first 128 assets is
 * placed; a dialogue line gets a voice through a picker that searches the
 * project's 1,100 sounds; and drawing the tiles reads their thumbnails from
 * the import cache — never a texture's bytes, and a model's only to make its
 * thumbnail the first time (none on the next open). The dialogue previewer
 * reads the voices ahead of the line it plays, not every voice. In the
 * project window 1,000 voice files are chosen, labelled in one command and
 * moved into a new folder in one command (their files and sidecars on disk).
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { generateScaleProject, scaledSpec } from '../../tools/perf/scale-generate';
import { measureEditorAtScale } from '../../tools/perf/scale-editor';
import { measureProjectWindowAtScale } from '../../tools/perf/scale-project';
import { installPerfInstrumentation } from '../../tools/perf/instrument';

const root = join(PERF_ROOT, 'e2e', `editor-scale-${process.pid}-${Date.now()}`);
let be: PerfBackend | null = null;
test.afterEach(async () => {
  await be?.stop().catch(() => undefined);
  be = null;
  rmSync(root, { recursive: true, force: true });
});

test('the editor at 1,800 assets: open, scroll the whole catalog, place, a voice through the picker, tiles from the import cache', async ({ page }) => {
  test.setTimeout(600_000);
  const spec = scaledSpec(0.1);
  const generated = generateScaleProject(join(root, 'data'), 'scale', spec);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
  const p = be.project('scale');
  const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => p.query(op, args);
  await page.addInitScript(installPerfInstrumentation);
  const url = `${be.origin}/?project=scale#token=${be.token}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Every tile scrolled into view and drawn, each screen settled before the next.
  const first = await measureEditorAtScale(page, { query, settle: true, url });
  expect(first.listTotal).toBe(generated.counts['assets']);
  expect(first.scroll.tilesSeen).toBe(generated.counts['assets']);
  // The list is read in pages, the summaries of the tiles in view by id: never one request per asset.
  expect(first.scroll.requests.index).toBeLessThan(generated.counts['assets']! / 100);
  expect(first.scroll.requests.summaries).toBeLessThan(generated.counts['assets']! / 10);
  // A tile never reads a texture's or a sound's bytes (the backend makes a texture's thumbnail); a model's are read once, to make its thumbnail.
  expect(first.scroll.bytesOf.filter((id) => !id.startsWith('model-'))).toEqual([]);
  expect(first.scroll.requests.assetBytes).toBeLessThanOrEqual(spec.models);
  expect(first.place.position).toBeGreaterThanOrEqual(128);
  expect(first.pickerSearch.matches).toBeGreaterThanOrEqual(1);
  const placed = (await query('queryEntities', { limit: 1024 }))['entities'] as { components: { model?: { asset?: { assetId?: string } } } }[];
  expect(placed.some((e) => e.components.model?.asset?.assetId === first.place.assetId)).toBe(true);

  // The previewer reads the voices ahead of the line it plays (a few), not the project's every voice.
  await page.getByRole('button', { name: 'play dialogue preview' }).click();
  const stage = page.locator('[aria-label="dialogue preview stage"]');
  await expect(stage.locator('[data-tl-ui-doc="tl-dialogue"]')).toHaveCount(1, { timeout: 40_000 });
  await expect.poll(async () => Number(await stage.getAttribute('data-sounds-read')), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(Number(await stage.getAttribute('data-sounds-read'))).toBeLessThanOrEqual(8);
  await page.getByRole('button', { name: 'stop dialogue preview' }).click();

  // The project window: 1,000 voice files chosen with a Shift-click, labelled in one command, moved in one command (then undone).
  const voiceDir = join(generated.dir, 'assets', 'voice');
  const voicesBefore = readdirSync(voiceDir).length;
  const batch = await measureProjectWindowAtScale(page, {
    query,
    files: 1000,
    folder: 'assets/voice',
    onMoved: async (to) => {
      const moved = readdirSync(join(generated.dir, ...to.split('/')));
      // Each file with its sidecar.
      expect(moved.filter((f) => f.endsWith('.tlasset')).length).toBe(1000);
      expect(moved.length).toBe(2000);
    },
  });
  expect(batch.revisions).toEqual({ label: 1, move: 1 });
  expect(readdirSync(voiceDir).length).toBe(voicesBefore);
  expect(existsSync(join(generated.dir, 'assets', 'voice-moved'))).toBe(true);

  // Opened again, every thumbnail comes from the import cache: no asset's bytes are read to draw the list.
  await page.goto('about:blank');
  const again = await measureEditorAtScale(page, { query, settle: true, url });
  expect(again.scroll.tilesSeen).toBe(generated.counts['assets']);
  // (The Scene view reads the model placed above: that is the view, not a tile.)
  const drawnInView = new Set([first.place.assetId]);
  const made = await query('queryIndex', { kind: 'model', refs: false, limit: 1024 });
  expect(again.scroll.bytesOf.filter((id) => !drawnInView.has(id))).toEqual([]);
  expect(Number(made['total'])).toBe(spec.models);
  expect(again.scroll.requests.thumbnails).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
