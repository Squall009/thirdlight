/**
 * The trim material's cost against the standard material on the same mesh
 * (`node tools/perf/run.mjs trim [--renderers webgpu,webgl2] [--record-ms N] [--gpu-ms N]`).
 *
 * One mesh of trim strips (`tests/e2e/trim-strips.ts`: 30 patches of strips
 * 0.25 m deep, 40 m long, the four rows of the neutral test sheet) fills the
 * view from a camera looking down at it — most of the 1920 × 1080 frame is
 * the material, near and at a grazing angle. Two projects differ only in the
 * material on it: the trim material (albedo, normal and ORM of the sheet;
 * COLOR_0 occlusion, grime and wetness blended; the footprint cap) and the
 * standard material with the same three textures. Each is exported and
 * measured like the village (frame-run.ts: uncapped, the host's GPU, GPU time
 * per render pass from timestamp queries), on both renderers; the log ends
 * with the GPU time per frame of each and the difference.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, startPerfBackend } from './backend';
import { publishFileVia } from './build';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { frameLine } from './village-run';
import { makePng } from '../../tests/e2e/png-make';
import { STRIP_PATCH_GAP, STRIP_PATCH_WIDTH, TEST_TRIM_SHEET, testTrimSheetPng, trimStripsGlb } from '../../tests/e2e/trim-strips';

/** The patches across the view, each strip patch this long (metres). */
const PATCHES = 30;
const LENGTH = 40;
/** The camera above the patches' middle, pitched down (radians). */
const PITCH = (-30 * Math.PI) / 180;
const STARTER_REMOVED = ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002'];

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function runTrimCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const log = (s: string): void => console.log(s);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  const recordMs = Number(get('record-ms') ?? 8000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const runDir = join(PERF_ROOT, 'runs', `trim-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });
  const kinds = ['trim', 'standard'] as const;
  const exportDirs: Partial<Record<(typeof kinds)[number], string>> = {};
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const kind of kinds) {
      const projectId = `trim-cost-${kind}`;
      const created = await be.post('/api/v1/admin/projects', { projectId, name: `Perf trim ${kind}` });
      if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
      const p = be.project(projectId);
      const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => p.command(op, args);
      for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
      const textures = [
        { assetId: 'sheet-albedo', bytes: testTrimSheetPng() },
        { assetId: 'sheet-normal', bytes: makePng(256, 256, () => [128, 128, 255, 255]) },
        { assetId: 'sheet-orm', bytes: makePng(256, 256, () => [255, 200, 0, 255]) },
      ];
      for (const t of textures) await publishFileVia(be, projectId, cmd, { assetId: t.assetId, kind: 'texture', displayName: t.assetId, bytes: new Uint8Array(t.bytes) });
      const patches = Array.from({ length: PATCHES }, (_, i) => ({ slot: TEST_TRIM_SHEET.rows[i % TEST_TRIM_SHEET.rows.length]!.slot }));
      await publishFileVia(be, projectId, cmd, { assetId: 'strips', kind: 'model', displayName: 'strips', bytes: new Uint8Array(trimStripsGlb(TEST_TRIM_SHEET, patches, LENGTH)) });
      const maps = { map: 'sheet-albedo', normalMap: 'sheet-normal', ormMap: 'sheet-orm' };
      const material = kind === 'trim' ? { materialId: 'mat-strips', name: 'Strips', shader: 'trim', params: {}, textures: maps, trim: TEST_TRIM_SHEET } : { materialId: 'mat-strips', name: 'Strips', shader: 'standard', params: { roughness: 1, metalness: 1 }, textures: maps };
      await cmd('setMaterial', { material });
      const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Strips', model: { asset: { assetId: 'strips' } }, transform: { position: [0, 0, 0] } }))['createdId']);
      await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'mat-strips' } });
      const middle = (PATCHES * (STRIP_PATCH_WIDTH + STRIP_PATCH_GAP)) / 2;
      await cmd('setTransform', { entityId: 'cam-main', transform: { position: [middle, 4, 2], rotation: [Math.sin(PITCH / 2), 0, 0, Math.cos(PITCH / 2)] } });
      const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      exportDirs[kind] = join(be.exportRoot, String(res.json['outputDir']));
      log(`trim cost: ${kind} project built and exported`);
    }
  } finally {
    await be.stop();
  }

  const results: Partial<Record<(typeof kinds)[number], Partial<Record<FrameRenderer, FrameRunResult>>>> = {};
  const browser = await launchGpuBrowser();
  try {
    for (const kind of kinds) {
      const site = await serveStatic(exportDirs[kind]!);
      try {
        for (const r of renderers) {
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}`, warmupMs: 3000, recordMs, gpuMs, profileMs: 0, sourceOf: sourcesOf(site), shot: join(runDir, `${kind}-${r}.png`) });
          (results[kind] ??= {})[r] = res;
          log(frameLine(`trim cost ${kind} ${r}`, res));
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }
  for (const r of renderers) {
    const gpu = (k: (typeof kinds)[number]): number | null => {
      const g = results[k]?.[r]?.gpu;
      return g?.available === true ? g.msPerFrame : null;
    };
    const t = gpu('trim');
    const s = gpu('standard');
    log(`trim cost ${r}: gpu ${t ?? '-'} ms/frame trim, ${s ?? '-'} ms/frame standard${t !== null && s !== null ? `, difference ${Math.round((t - s) * 100) / 100} ms (${Math.round(((t - s) / s) * 1000) / 10} %)` : ''}; frame p50 ${results.trim?.[r]?.frames.p50 ?? '-'} vs ${results.standard?.[r]?.frames.p50 ?? '-'} ms`);
  }
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
