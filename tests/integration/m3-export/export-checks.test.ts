/**
 * What the export route takes, refuses and ships, over HTTP against a real
 * backend in Node (one backend, one project a describe):
 *
 * - a scene's 3D collider point budget counts its model colliders' `_COL`
 *   parts as the build resolves them (an edit cannot see them, so each edit
 *   goes through): an export at the budget exactly is taken, one object past
 *   it refused, naming the count;
 * - the debug console ships only with the project's `debug_console` setting:
 *   the exported manifest carries it when it is on and not otherwise (the
 *   export page starts the console from that setting alone);
 * - a model file changed on disk is imported again before the build, so the
 *   export ships the new bytes and not the old;
 * - a streamed texture ships as its parts (the head with the mip tail, then
 *   the larger levels), never the whole KTX2 as well: the manifest lists the
 *   parts and together they are the whole file.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { testTempBase } from '@thirdlight/backend/testing';
import { COLLIDER_3D_LIMITS, readRuntimeContentSync } from '@thirdlight/project-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeRgbaPng } from '../../../packages/backend/src/image-thumbnail';
import { api, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { encodeKtx2 } from '../../../packages/backend/src/texture-encode';
import { mustCommand, type CommandRoute } from '../../support/commands';
import { multiPieceGlb } from '../../e2e/multi-piece-glb';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const GLB_V1 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');
const GLB_V2 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb');
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('the export route', () => {
  let tb: TestBackend;
  let exportRoot: string;
  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-export-checks-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  // The project's command route as the shared command helpers send to it (the admin token, no browser origin).
  const route: CommandRoute = {
    projectId: PID,
    command: async (body) => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body, token: tb.adminToken, origin: null })).json as Record<string, unknown>,
  };
  const run = (op: string, args: Record<string, unknown>) => mustCommand(route, op, args, { clientId: 'export-checks' });
  const query = (op: string, args: Record<string, unknown>) => route.command({ op, projectId: PID, args });
  const exportNow = () => api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });

  it("an export at the 3D collider point budget, its model colliders' _COL parts counted, is taken; one object past it is refused", async () => {
    // 256 box parts of 8 hull points: 2,048 points an object.
    const colParts = Array.from({ length: 256 }, (_, i) => ({ size: [0.5, 0.5, 0.5] as [number, number, number], at: [i % 16, Math.floor(i / 16), 0] as [number, number, number] }));
    const dir = join(tb.root, 'data', 'projects', PID, 'assets', 'racks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rack.glb'), multiPieceGlb([{ name: 'rack', lods: [[1, 1, 1]], colParts }]));
    await run('importAssets', { folder: 'assets/racks' });
    const assets = ((await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string; kind: string }[]).filter((a) => a.kind === 'model');
    expect(assets).toHaveLength(1);
    const assetId = assets[0]!.assetId;
    const perObject = 256 * 8;
    const full = COLLIDER_3D_LIMITS.pointsTotal / perObject;
    expect(Number.isInteger(full)).toBe(true);
    const rack = (i: number) => ({ kind: 'model', name: `Rack ${i}`, model: { asset: { assetId } }, transform: { position: [(i % 32) * 20, 0, Math.floor(i / 32) * 20] }, components: { collider: { shape: { type: 'model' } } } });
    // In batches (a request is at most 64 KiB).
    for (let from = 0; from < full; from += 256) await run('createEntities', { sceneId: 'scene-main', entities: Array.from({ length: Math.min(256, full - from) }, (_, i) => rack(from + i)) });
    const at = await exportNow();
    expect(at.status, JSON.stringify(at.json).slice(0, 600)).toBe(200);
    // One more: the edit goes through (it cannot count the parts), the build refuses naming the count.
    await run('createEntities', { sceneId: 'scene-main', entities: [rack(full)] });
    const over = await exportNow();
    expect(over.status).not.toBe(200);
    const text = JSON.stringify(over.json);
    expect(text).toContain('collider_vertices_total');
    expect(text).toContain(`has ${(full + 1) * perObject} 3D collider points`);
    // Back at the budget, taken again.
    const last = ((await query('queryEntities', { sceneId: 'scene-main', limit: 1000, offset: 0 }))['entities'] as { id: string; name: string }[]).find((e) => e.name === `Rack ${full}`)!;
    await run('deleteEntity', { entityId: last.id });
    expect((await exportNow()).status).toBe(200);
  }, 120_000);

  it('the exported manifest carries debug_console only when the project turns it on', async () => {
    const settingsOf = (r: Awaited<ReturnType<typeof exportNow>>): Record<string, unknown> => {
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
      return (JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { settings: Record<string, unknown> }).settings;
    };
    expect(settingsOf(await exportNow())['debug_console']).toBeUndefined();
    await run('setSettings', { settings: { debug_console: 1 } });
    expect(settingsOf(await exportNow())['debug_console']).toBe(1);
    await run('setSettings', { settings: { debug_console: 0 } });
    expect(settingsOf(await exportNow())['debug_console'] ?? 0).toBe(0);
  }, 60_000);

  it('a model file changed on disk is imported again before the export: the export ships the new bytes, not the old', async () => {
    const dir = join(tb.root, 'data', 'projects', PID, 'assets', 'crates');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'crate.glb');
    copyFileSync(GLB_V1, file);
    await run('importAssets', { folder: 'assets/crates' });
    const crate = ((await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; sourcePath?: string }[]).find((a) => a.assetId.startsWith('crate'))!;
    await run('createEntities', { sceneId: 'scene-main', entities: [{ kind: 'model', name: 'Crate', model: { asset: { assetId: crate.assetId } }, transform: { position: [0, 0, -40] } }] });
    const shipped = async (): Promise<string[]> => {
      const r = await exportNow();
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      return readdirSync(join(exportRoot, String((r.json as { outputDir: string }).outputDir), 'content', 'sha256'));
    };
    const first = await shipped();
    expect(first).toContain(sha(GLB_V1));
    copyFileSync(GLB_V2, file);
    const second = await shipped();
    expect(second).toContain(sha(GLB_V2));
    expect(second).not.toContain(sha(GLB_V1));
  }, 120_000);

  it('a streamed texture ships as its parts, never the whole KTX2 as well; the parts together are the whole', async () => {
    const dir = join(tb.root, 'data', 'projects', PID, 'assets', 'streamed');
    mkdirSync(dir, { recursive: true });
    // 512² (levels above the 128 px tail): streaming is possible, and turned on (the default is on only over 1024 px).
    const rgba = new Uint8Array(512 * 512 * 4).map((_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % 512) >> 1));
    const encoded = await encodeKtx2(encodeRgbaPng(rgba, 512, 512), 'color');
    if (!encoded.ok) throw new Error(encoded.message);
    writeFileSync(join(dir, 'ramp.ktx2'), encoded.ktx2);
    await run('importAssets', { folder: 'assets/streamed' });
    const tex = ((await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName?: string; kind?: string }[]).find((a) => a.kind === 'texture' && a.displayName === 'ramp')!;
    await run('setAssetOptions', { assetId: tex.assetId, streaming: true });
    await run('setMaterial', { material: { materialId: 'mat-ramp', name: 'Ramp', shader: 'standard', params: {}, textures: { map: tex.assetId } } });
    const box = await run('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Ramp box' });
    await run('setComponent', { entityId: box['createdId'], component: 'materials', value: { '*': 'mat-ramp' } });
    const r = await exportNow();
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const shipped = readdirSync(join(out, 'content', 'sha256'));
    const whole = createHash('sha256').update(encoded.ktx2).digest('hex');
    expect(shipped).not.toContain(whole);
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (p) => {
      try {
        return new Uint8Array(readFileSync(join(out, p)));
      } catch {
        return null;
      }
    }) as unknown as { assets: { assetId: string; mipParts?: { digest: string; byteLength: number; offset: number }[] }[] };
    const row = content.assets.find((a) => a.assetId === tex.assetId);
    const parts = row!.mipParts!;
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) expect(shipped).toContain(p.digest);
    const joined = Buffer.concat([...parts].sort((a, b) => a.offset - b.offset).map((p) => readFileSync(join(out, 'content', 'sha256', p.digest))));
    expect(createHash('sha256').update(joined).digest('hex')).toBe(whole);
  }, 120_000);
});
