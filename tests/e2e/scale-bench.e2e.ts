/**
 * The scale bench end to end at its small size: the generated project opens
 * in the real backend and the editor, takes commands, plays (scene loads,
 * a script loading assets by a label and releasing them, a voiced dialogue
 * played through, large textures streamed past the camera under a small
 * texture budget) and exports, and every number the bench
 * reports is there. Checks the plumbing, not speed; the numbers at full size
 * are recorded by `node tools/perf/run.mjs scale` (docs/plan-phase-26.md).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { gpuAvailable } from './browser-env.mjs';
import { PERF_ROOT } from '../../tools/perf/backend';
import { ScaleBench } from '../../tools/perf/scale';
import { generateScaleProject, SCALE_SMALL } from '../../tools/perf/scale-generate';

const root = join(PERF_ROOT, 'e2e', `scale-${process.pid}-${Date.now()}`);
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

test('the scale bench generates, opens, edits, plays, walks scenes, loads by label, plays a voiced dialogue, streams textures and exports', async () => {
  test.setTimeout(300_000);
  const generated = await generateScaleProject(join(root, 'data'), 'scale', SCALE_SMALL);
  const bench = new ScaleBench({
    dataRoot: join(root, 'data'),
    exportRoot: join(root, 'exports'),
    projectId: 'scale',
    generated,
    renderer: 'webgl2',
    gpu: gpuAvailable(),
    commands: 3,
    walk: 3,
    lines: SCALE_SMALL.walkthroughLines,
    streamTextures: 2,
    streamBudgetMb: 8,
    steps: ['files', 'open', 'commands', 'play', 'walk', 'handles', 'dialogue', 'stream', 'export'],
    log: () => undefined,
  });
  const r = await bench.run();
  expect(r.broke).toEqual({});
  // The file check saw every asset's file, before and after a restart.
  expect(r.files!.entries).toBe(generated.counts['assets']);
  expect(r.files!.afterRestartMs).toBeGreaterThan(0);
  expect(r.open!.assetsListed).toBe(generated.counts['assets']);
  expect(r.open!.editorFirstFrameMs).toBeGreaterThan(0);
  expect(r.commands!.sceneEdit.n).toBe(3);
  expect(r.commands!.contentEdit!.n).toBe(3);
  expect(r.play!.split.firstFrameMs).toBeGreaterThan(0);
  expect(r.play!.memory.heapMiB).toBeGreaterThan(1);
  expect(r.play!.backendRssPeakMiB).toBeGreaterThan(0);
  expect(r.play!.backendRssAfterStopMiB).toBeGreaterThan(0);
  // Each walked scene was loaded (its prefab copies read their models and textures) and unloaded.
  expect(r.walk!.scenes).toBe(3);
  expect(r.walk!.loaded).toHaveLength(3);
  expect(r.walk!.loaded[0]!.assetReads!.reads).toBeGreaterThan(r.walk!.before.assetReads!.reads);
  expect(r.walk!.loaded[0]!.live.textures).toBeGreaterThan(r.walk!.before.live.textures);
  // A script loaded the labelled assets by their label and released them: held while loaded, back where they were after.
  const resident = (m: { resources?: { resident: Record<string, { count: number; bytes: number }> } }): Record<string, number> => Object.fromEntries(Object.entries(m.resources?.resident ?? {}).filter(([, v]) => v.count > 0).map(([k, v]) => [k, v.bytes]));
  expect(r.handles!.assets).toBe(generated.counts['labelled']);
  expect(r.handles!.loaded.resources!.resident['texture']!.count).toBeGreaterThanOrEqual(SCALE_SMALL.labelled / 2);
  expect(r.handles!.loaded.resources!.handles).toBe(1);
  expect(resident(r.handles!.after)).toEqual(resident(r.handles!.before));
  // Every line started, and its own voice was heard playing.
  expect(r.dialogue!.linesSeen).toBe(SCALE_SMALL.walkthroughLines);
  expect(r.dialogue!.voicesHeard).toBe(SCALE_SMALL.walkthroughLines);
  expect(r.dialogue!.gapMs.n).toBe(SCALE_SMALL.walkthroughLines - 1);
  // Two large KTX2 textures brought up to the camera in turn under an 8 MiB budget: each reached full size, inside the budget.
  expect(r.stream!.textures).toBe(2);
  expect(r.stream!.upgradeMs.n).toBe(2);
  expect(r.stream!.fullChainBytes).toBeGreaterThan(r.stream!.tailBytes * 50);
  expect(r.stream!.maxResidentBytes).toBeLessThanOrEqual(r.stream!.budgetBytes);
  expect(r.stream!.overBudgetSamples).toBe(0);
  expect(r.stream!.afterBytes).toBe(0);
  expect(r.export!.files).toBeGreaterThan(0);
  expect(r.export!.firstFrameMs).toBeGreaterThan(0);
  expect(r.export!.state).toBe('running');
  expect(r.export!.pageErrors).toEqual([]);
});
