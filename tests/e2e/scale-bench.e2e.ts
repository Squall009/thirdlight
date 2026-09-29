/**
 * The scale bench end to end at its small size: the generated project opens
 * in the real backend and the editor, takes commands, plays (scene loads,
 * a voiced dialogue played through) and exports, and every number the bench
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

test('the scale bench generates, opens, edits, plays, walks scenes, plays a voiced dialogue and exports', async () => {
  test.setTimeout(300_000);
  const generated = generateScaleProject(join(root, 'data'), 'scale', SCALE_SMALL);
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
    steps: ['open', 'commands', 'play', 'walk', 'dialogue', 'export'],
    log: () => undefined,
  });
  const r = await bench.run();
  expect(r.broke).toEqual({});
  expect(r.open!.assetsListed).toBe(generated.counts['assets']);
  expect(r.open!.editorFirstFrameMs).toBeGreaterThan(0);
  expect(r.commands!.sceneEdit.n).toBe(3);
  expect(r.commands!.contentEdit!.n).toBe(3);
  expect(r.play!.split.firstFrameMs).toBeGreaterThan(0);
  expect(r.play!.memory.heapMiB).toBeGreaterThan(1);
  // Each walked scene was loaded (its prefab copies read their models and textures) and unloaded.
  expect(r.walk!.scenes).toBe(3);
  expect(r.walk!.loaded).toHaveLength(3);
  expect(r.walk!.loaded[0]!.assetReads!.reads).toBeGreaterThan(r.walk!.before.assetReads!.reads);
  expect(r.walk!.loaded[0]!.live.textures).toBeGreaterThan(r.walk!.before.live.textures);
  // Every line started, and its own voice was heard playing.
  expect(r.dialogue!.linesSeen).toBe(SCALE_SMALL.walkthroughLines);
  expect(r.dialogue!.voicesHeard).toBe(SCALE_SMALL.walkthroughLines);
  expect(r.dialogue!.gapMs.n).toBe(SCALE_SMALL.walkthroughLines - 1);
  expect(r.export!.files).toBeGreaterThan(0);
  expect(r.export!.firstFrameMs).toBeGreaterThan(0);
  expect(r.export!.state).toBe('running');
  expect(r.export!.pageErrors).toEqual([]);
});
