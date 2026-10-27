/**
 * "Bake lighting" across its real boundaries: an agent's tl_bake_lighting
 * (the real stdio MCP server) reaches the real backend process, which asks
 * the project's editor over the real WebSocket (`lighting.bake.request`).
 * This test answers as the editor page does (`lighting-bake-run.ts`): the
 * saved result of a real surface-cache host — every tile at the bake's
 * level — written into its PNG files, published as texture assets and
 * recorded with `setLighting`, all through the commands, then acked. The
 * agent gets the editor's answer; the project's bake names the files; the
 * export ships them and the files read back from the export are the saved
 * light. A scene the project lacks, and a second bake while one runs, are
 * refused.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  CONTENT_PROJECT,
  REPO_ROOT,
  base64,
  cleanupBundles,
  createMcp,
  establish,
  http,
  makeRoot,
  openWs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
  type WsInbox,
} from '../m2-content/harness';
import { BlockGrid, type BlockType } from '../../../packages/runtime/src/index';
import { SurfaceCacheHost } from '../../../packages/three-adapter/src/surface-cache-host';
import { opaqueByBlockTypes } from '../../../packages/three-adapter/src/tracer-sources';
import { encodeSavedSurface, savedSurfaceFiles, savedSurfaceFromFiles, type SavedSurfaceLight } from '../../../packages/three-adapter/src/surface-bake-file';
import { SURFACE_PAGE_TEXELS } from '../../../packages/three-adapter/src/surface-cache-atlas';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;
let ws: WsInbox;
let exportRoot = '';
const SCENE = 'scene-main';

/** What a bake of a block floor saves: the host's tiles at the level that fits, pages holding a known value. */
function bakedFloor(): SavedSurfaceLight {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 4, 16] } });
  for (let x = 0; x < 16; x += 1) for (let z = 0; z < 16; z += 1) grid.set(x, 0, z, { block: 'rock' });
  const host = new SurfaceCacheHost({ layers: () => [{ id: 'floor', origin: [0, 0, 0], grid, version: 1, chunks: [['0,0', 1]], opaque: opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]) }], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 64 * 1024 * 1024);
  for (let i = 0; i < 50 && !((host.preparedTiles()?.length ?? 0) > 0); i += 1) host.update([8, 2, 8]);
  host.cache.setBakeLevel(host.cache.fitLevel(host.preparedTiles() ?? [], 32 * 1024 * 1024));
  host.update([8, 2, 8]);
  const tiles = host.savedTiles();
  const pages = Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1;
  const texels = new Uint16Array(pages * SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4).map((_, i) => (i % 4 === 3 ? 0x3c00 : 0x3800 + (i % 97)));
  return { level: tiles[0]!.level, pages, texels, tiles, probes: [] };
}

async function mcpOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await mcp.call(name, args);
  expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
  return r.body;
}

async function revision(): Promise<number> {
  return Number((await mcpOk('tl_inspect', { target: 'project' })).revision);
}

/** The editor's part: save `saved` as texture assets and record the bake, through the commands (what `runLightingBake` does). */
async function saveAsEditor(saved: SavedSurfaceLight): Promise<string[]> {
  const files = await savedSurfaceFiles(encodeSavedSurface(saved));
  const ids: string[] = [];
  for (const [i, png] of files.entries()) {
    const up = await mcpOk('tl_content_upload', { dataBase64: base64(png), kind: 'texture' });
    const p = up.proposal as Record<string, unknown>;
    const assetId = `asset-lighting-${i}`;
    await mcpOk('tl_command', { op: 'publishAsset', expectedRevision: await revision(), args: { mode: 'create', kind: 'texture', assetId, displayName: `lighting ${i + 1}`, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') } });
    ids.push(assetId);
  }
  const hash = '0123456789abcdef';
  const createdAt = new Date().toISOString();
  await mcpOk('tl_command', {
    op: 'setLighting',
    expectedRevision: await revision(),
    args: {
      sceneId: SCENE,
      lighting: {
        bakeId: 'bake-test', createdAt, source: 'cache', range: 1, texelsPerMeter: 10, samples: 1, bounces: 0, atlases: [], entries: [], bakedLights: [], lightsHash: hash, staticsHash: hash,
        surface: { createdAt, files: ids, level: saved.level, tiles: saved.tiles.length, pages: saved.pages, probes: 0, bytes: files.reduce((n, f) => n + f.length, 0), millis: 1234, lightsHash: hash, staticsHash: hash },
      },
    },
  });
  return files.map((f) => createHash('sha256').update(f).digest('hex'));
}

beforeAll(async () => {
  root = makeRoot('bake');
  exportRoot = mkdtempSync(join(root.root, 'exports-'));
  bp = await spawnBackend(root, [{ token: AUTH_TOKEN, scope: `authoring:${CONTENT_PROJECT}` }, { token: ADMIN_TOKEN, scope: 'admin' }], { exportRoot, engineRoot: REPO_ROOT });
  mcp = await createMcp(bp.origin, 'bake-lighting-test');
  ws = await openWs(bp.origin, await establish(bp.origin));
}, 120_000);

afterAll(async () => {
  cleanupBundles();
  ws?.close();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('Bake lighting (real stdio MCP, real backend, real WS, real files)', () => {
  it('is refused for a scene the project lacks', async () => {
    const r = await mcp.call('tl_bake_lighting', { sceneId: 'scene-none' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('scene_not_found');
  });

  it('asks the editor, which saves through the commands; the agent gets its answer; the export ships the files and they read back as the saved light', async () => {
    const saved = bakedFloor();
    expect(saved.tiles.map((t) => t.key)).toEqual(['floor/0,0']);
    const asked = mcp.call('tl_bake_lighting', { sceneId: SCENE, timeoutMs: 60_000 });
    const req = await ws.waitFor((e) => e.type === 'lighting.bake.request', 20_000);
    expect(req.sceneId).toBe(SCENE);
    // A second bake of the project while this one runs.
    const busy = await mcp.call('tl_bake_lighting', { sceneId: SCENE, timeoutMs: 1000 });
    expect(JSON.stringify(busy.body)).toContain('bake_busy');
    const digests = await saveAsEditor(saved);
    ws.send({ type: 'lighting.bake.ack', relayId: req.relayId, ok: true, message: 'Baked lighting: 1 surface tile' });
    const answer = await asked;
    expect(answer.isError, JSON.stringify(answer.body)).toBe(false);
    expect(answer.body.state).toBe('done');
    expect(answer.body.message).toBe('Baked lighting: 1 surface tile');

    // The bake names its files; the export ships them unchanged.
    const config = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/commands`, { body: { op: 'queryGameConfig', projectId: CONTENT_PROJECT }, token: AUTH_TOKEN });
    const bake = (config.body as { lighting: Record<string, { surface?: { files: string[] } }> }).lighting[SCENE]!;
    expect(bake.surface?.files).toEqual(['asset-lighting-0']);
    // The seeded project's model is a stand-in file no export ships: the scene keeps the camera and the bake.
    await mcpOk('tl_command', { op: 'deleteEntity', expectedRevision: await revision(), args: { entityId: 'model-0001' } });
    const out = await http(`${bp.origin}/api/v1/admin/projects/${CONTENT_PROJECT}/export`, { body: {}, token: ADMIN_TOKEN });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const dir = join(exportRoot, String((out.body as { outputDir: string }).outputDir));
    const shipped = new Map<string, Uint8Array>();
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) walk(full);
        else {
          const bytes = new Uint8Array(readFileSync(full));
          shipped.set(createHash('sha256').update(bytes).digest('hex'), bytes);
        }
      }
    };
    walk(dir);
    const files = digests.map((d) => shipped.get(d));
    expect(files.every((f) => f !== undefined)).toBe(true);
    const back = await savedSurfaceFromFiles(files as Uint8Array[]);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.saved.tiles).toEqual(saved.tiles.map((t) => ({ ...t, blocks: [...t.blocks] })));
    expect(back.saved.texels).toEqual(saved.texels);
  }, 180_000);

  it('passes on the editor\'s refusal as the agent\'s error', async () => {
    const asked = mcp.call('tl_bake_lighting', { sceneId: SCENE, timeoutMs: 60_000 });
    const req = await ws.waitFor((e) => e.type === 'lighting.bake.request' && ws.events.filter((x) => x.type === 'lighting.bake.request').indexOf(e) === 1, 20_000);
    ws.send({ type: 'lighting.bake.ack', relayId: req.relayId, ok: false, error: { code: 'scene_not_open', message: 'the editor has another scene open' } });
    const r = await asked;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('scene_not_open');
  }, 60_000);
});
