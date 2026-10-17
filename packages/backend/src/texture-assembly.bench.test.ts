/**
 * Cold assembly timings on the deployment's encoder (the built worker
 * thread pool), run on demand only: `TL_BENCH=1` (and, to time a worker built
 * elsewhere, `TL_KTX2_WORKER=<path to ktx2-worker.mjs>`). Two workloads the
 * editor waits on:
 *
 * - a decal atlas of 200 decal images (100 at 128², 70 at 256², 30 at 512²,
 *   each its own decal material, all placed): the build's planner and the
 *   backend's decal page assembly, every page composed (nothing cached);
 * - a layered surface's six slot arrays: two 2048² textures and two 512²
 *   ones, each pair as an albedo, normal and data array, requested two at a
 *   time as the editor requests them.
 *
 * Not a pass/fail test: it prints the numbers (the plan records them).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { closureDecalPages, shippedMaterialsOfCapture, type AssetRecordLike } from '@thirdlight/exporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDecalPageAssembler } from './decal-page-assembly';
import { encodeRgbaPng } from './image-thumbnail';
import { createWorkerTextureEncoder, type Ktx2Mode } from './texture-encode';
import { createTextureSlotAssembler, type SlotLayer } from './texture-slots';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const PID = 'demo-0001';
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WORKER = new URL(`file://${process.env.TL_KTX2_WORKER ?? join(REPO, 'dist', 'backend', 'ktx2-worker.mjs')}`);
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** A noisy test image (encoders are slower on noise than on flat colour, as on real art). */
function noisy(w: number, h: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  let s = seed * 2654435761 || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const n = s & 63;
      const o = (y * w + x) * 4;
      out[o] = ((x * 3 + seed * 17) & 255) ^ n;
      out[o + 1] = ((y * 5 + seed * 29) & 255) ^ n;
      out[o + 2] = ((x + y + seed) & 255) ^ (n >> 1);
      out[o + 3] = Math.min(255, 128 + ((x ^ y) & 127));
    }
  }
  return out;
}

describe.skipIf(process.env.TL_BENCH !== '1')('cold assembly timings', () => {
  let tb: TestBackend;
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'assembly-bench' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
  };
  /** Forget what the assemblies cached, so the next one is cold. */
  const dropCache = (importer: string): void => {
    const root = game('cache', 'imported');
    for (const digest of readdirSync(root, { withFileTypes: true })) {
      if (!digest.isDirectory()) continue;
      for (const d of readdirSync(join(root, digest.name))) if (d.startsWith(`${importer}-`)) rmSync(join(root, digest.name, d), { recursive: true, force: true });
    }
  };
  const threads = process.env.TL_BENCH_THREADS !== undefined ? Number(process.env.TL_BENCH_THREADS) : undefined;
  const encoder = createWorkerTextureEncoder(WORKER, { idleMs: 60_000, ...(threads !== undefined ? { threads } : {}) });

  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
    mkdirSync(game('assets', 'decals'), { recursive: true });
    mkdirSync(game('assets', 'layers'), { recursive: true });
    const sides = [...Array<number>(100).fill(128), ...Array<number>(70).fill(256), ...Array<number>(30).fill(512)];
    sides.forEach((side, i) => writeFileSync(game('assets', 'decals', `d${String(i).padStart(3, '0')}.png`), encodeRgbaPng(noisy(side, side, i + 1), side, side)));
    // TL_BENCH_SHEETS=<a.png>,<b.png>[,<c.png>,<d.png>]: real images of one size (2048² albedos) as the big ones instead of noise.
    const sheets = (process.env.TL_BENCH_SHEETS ?? '').split(',').filter((x) => x !== '');
    const bigs = ['big-a', 'big-b', 'big-c', 'big-d'];
    for (const [name, side] of [['big-a', 2048], ['big-b', 2048], ['big-c', 2048], ['big-d', 2048], ['small-a', 512], ['small-b', 512]] as const) {
      const at = bigs.indexOf(name);
      const real = at >= 0 && at < sheets.length ? sheets[at]! : null;
      writeFileSync(game('assets', 'layers', `${name}.png`), real !== null ? readFileSync(real) : encodeRgbaPng(noisy(side, side, name.length * 31 + side), side, side));
    }
    await command('importAssets', { folder: 'assets/decals' });
    await command('importAssets', { folder: 'assets/layers' });
    const assets: { assetId: string; displayName: string }[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset } }) as unknown as { assets: { assetId: string; displayName: string }[] }).assets;
      assets.push(...page);
      if (page.length < 50) break;
    }
    for (const a of assets.filter((x) => /^d\d{3}$/.test(x.displayName))) {
      const id = `mat-${a.displayName}`;
      await command('setMaterial', { material: { materialId: id, name: a.displayName, shader: 'decal', params: {}, textures: { map: a.assetId } } });
      await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: a.displayName, components: { decal: { size: [1, 1, 0.5], material: id } } });
    }
  }, 600_000);
  afterAll(async () => {
    encoder.dispose?.();
    await tb?.teardown();
  });

  it('a decal atlas of 200 images, cold', async () => {
    const service = tb.backend._test.service;
    const assembler = createDecalPageAssembler({ service, encoder, now: () => performance.now() });
    const captured = service.readCapturedV3(PID);
    if (!captured.ok) throw new Error(captured.error.code);
    const materials = shippedMaterialsOfCapture(captured.read, sha256) ?? [];
    const assets = ((captured.read.content as { assets?: AssetRecordLike[] } | null)?.assets ?? []) as readonly AssetRecordLike[];
    const run = async (preview = false): Promise<{ ms: number; pages: number; composed: number }> => {
      const t0 = performance.now();
      let composed = 0;
      const made = await closureDecalPages({
        port: {
          decalPages: async (p, request) => {
            const r = await assembler.assemble(p, request, preview ? { preview: true } : undefined);
            if (r.ok) composed = r.stats.composed;
            return r;
          },
        },
        service,
        projectId: PID,
        assets,
        materials,
        locate: true,
        hash: sha256,
        previews: preview,
      });
      if (!made.ok) throw new Error(made.error.message);
      return { ms: Math.round(performance.now() - t0), pages: made.pages.pages, composed };
    };
    dropCache('decal-pages');
    // What Rebuild pages shows first on a cold atlas: every page at the preview size (nothing stored).
    const preview = await run(true);
    const cold = await run();
    const warm = await run();
    console.log(`decal atlas bench: ${cold.pages} pages ${512}², composed ${cold.composed}: preview ${preview.ms} ms, cold ${cold.ms} ms, warm ${warm.ms} ms (threads ${threads ?? 'default'})`);
    expect(cold.composed).toBeGreaterThan(0);
  }, 600_000);

  it("a layered surface's six slot arrays, cold, two requests at a time", async () => {
    const service = tb.backend._test.service;
    const assembler = createTextureSlotAssembler({ service, encoder, now: () => performance.now() });
    const captured = service.readCapturedV3(PID);
    if (!captured.ok) throw new Error(captured.error.code);
    const assets = ((captured.read.content as { assets?: AssetRecordLike[] } | null)?.assets ?? []) as readonly (AssetRecordLike & { displayName?: string })[];
    const layer = (name: string): SlotLayer => {
      const a = assets.find((x) => x.displayName === name)!;
      const v = a.versions!.find((x) => x.version === a.currentVersion)!;
      return { assetId: a.assetId, version: v.version, sourceDigest: v.sourceDigest! };
    };
    const jobs: { layers: SlotLayer[]; mode: Ktx2Mode }[] = [];
    for (const pair of [['big-a', 'big-b'], ['small-a', 'small-b']]) for (const mode of ['color', 'normal', 'data'] as const) jobs.push({ layers: pair.map(layer), mode });
    dropCache('texture-slots');
    const t0 = performance.now();
    const each: string[] = [];
    // The editor runs at most two array requests at once.
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        const r = await assembler.assemble(PID, j.layers, j.mode);
        if (!r.ok) throw new Error(r.message);
        each.push(`${j.layers[0]!.assetId.slice(0, 6)}/${j.mode} ${r.ms} ms`);
      }
    };
    await Promise.all([lane(), lane()]);
    console.log(`slot arrays bench: 6 arrays cold in ${Math.round(performance.now() - t0)} ms (threads ${threads ?? 'default'}): ${each.join(', ')}`);

    // As the editor asks now: every array's preview first (all at once), each array once its preview is in (two at a time).
    dropCache('texture-slots');
    const t1 = performance.now();
    const previews: string[] = [];
    let previewsMs = 0;
    const previewed = jobs.map(async (j) => {
      const r = await assembler.preview!(PID, j.layers, j.mode);
      if (!r.ok) throw new Error(r.message);
      const ms = Math.round(performance.now() - t1);
      previewsMs = Math.max(previewsMs, ms);
      previews.push(`${j.layers[0]!.assetId.slice(0, 6)}/${j.mode} ${ms} ms`);
    });
    const finals: string[] = [];
    let at = 0;
    const finalLane = async (): Promise<void> => {
      while (at < jobs.length) {
        const k = at++;
        await previewed[k];
        const j = jobs[k]!;
        const r = await assembler.assemble(PID, j.layers, j.mode);
        if (!r.ok) throw new Error(r.message);
        finals.push(`${j.layers[0]!.assetId.slice(0, 6)}/${j.mode} ${Math.round(performance.now() - t1)} ms`);
      }
    };
    await Promise.all([finalLane(), finalLane()]);
    console.log(`slot arrays bench (previews first): every preview in ${previewsMs} ms (${previews.join(', ')}); every array in ${Math.round(performance.now() - t1)} ms (${finals.join(', ')})`);
  }, 900_000);

  it('a colour array of four 2048² layers (past one encode), against three (the most one ETC1S job takes)', async () => {
    const service = tb.backend._test.service;
    const captured = service.readCapturedV3(PID);
    if (!captured.ok) throw new Error(captured.error.code);
    const assets = ((captured.read.content as { assets?: AssetRecordLike[] } | null)?.assets ?? []) as readonly (AssetRecordLike & { displayName?: string })[];
    const layer = (name: string): SlotLayer => {
      const a = assets.find((x) => x.displayName === name)!;
      const v = a.versions!.find((x) => x.version === a.currentVersion)!;
      return { assetId: a.assetId, version: v.version, sourceDigest: v.sourceDigest! };
    };
    // The process's resident memory, sampled while each array is made (the encoder's workers are threads of it).
    const peak = async (run: () => Promise<unknown>): Promise<{ result: unknown; mib: number }> => {
      const base = process.memoryUsage().rss;
      let top = base;
      const timer = setInterval(() => (top = Math.max(top, process.memoryUsage().rss)), 20);
      try {
        return { result: await run(), mib: Math.round((top - base) / 2 ** 20) };
      } finally {
        clearInterval(timer);
      }
    };
    // The four first: resident memory freed by a worker is not always given back, so the first array's peak is the clean one.
    for (const names of [['big-a', 'big-b', 'big-c', 'big-d'], ['big-a', 'big-b', 'big-c']]) {
      dropCache('texture-slots');
      // Fresh workers for each array: a worker's WASM memory never shrinks, so one kept from the last array would hide this one's peak.
      const fresh = createWorkerTextureEncoder(WORKER, { idleMs: 60_000, ...(threads !== undefined ? { threads } : {}) });
      const assembler = createTextureSlotAssembler({ service, encoder: fresh, now: () => performance.now() });
      const { result, mib } = await peak(() => assembler.assemble(PID, names.map(layer), 'color')).finally(() => fresh.dispose?.());
      const r = result as Awaited<ReturnType<typeof assembler.assemble>>;
      if (!r.ok) throw new Error(r.message);
      console.log(`colour array bench: ${names.length} × 2048² in ${r.ms} ms, ${(r.file.byteLength / 2 ** 20).toFixed(1)} MiB, resident +${mib} MiB at peak (threads ${threads ?? 'default'})`);
    }
  }, 900_000);
});
