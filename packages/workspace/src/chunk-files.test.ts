/**
 * Block chunk files in either form, through the real service and filesystem.
 *
 * A new project stores its chunks as binary files (`block_chunk_storage` 1);
 * the cells read back the same after a reopen. Turning the setting to 0
 * rewrites every chunk file as JSON text in the same save (undo turns it
 * back); a project that never set it keeps JSON. A project whose scenes are
 * in different forms (as a merge or an older engine may leave it) opens with
 * every cell, and a scene written afterwards moves to the project's form
 * while the other stays as it is. Paint survives a reopen in both forms, and
 * so does every other optional chunk field (edge pieces, wall paint, the
 * scatter rules' copies) in a JSON project. A damaged binary chunk file is
 * refused with its path.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import { chunkFileBytes, readBinaryChunkFile } from './chunk-files';
import type { WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const PID = 'demo';
/** A new project's scene. */
const MAIN = 'scene-main';
let seq = 0;

function project(tag: string): { dir: string; open: () => WorkspaceService } {
  const root = join(tmpdir(), `tl-chunks-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const open = (): WorkspaceService => openWorkspaceService({ root });
  const s = open();
  expect(s.createProject(PID, 'Demo').ok).toBe(true);
  s.close();
  return { dir: join(root, 'projects', PID), open };
}

const revision = (s: WorkspaceService): number => (s.query({ op: 'queryProject', projectId: PID }) as unknown as { revision: number }).revision;
type Result = { ok: boolean; error?: { code: string; message?: string }; createdId?: string };
function ok(s: WorkspaceService, op: string, args: Record<string, unknown>): Result {
  seq += 1;
  const r = s.runCommand({ op, projectId: PID, expectedRevision: revision(s), requestId: `req-${(0xc000 + seq).toString(16).padStart(32, '0')}`, args }) as unknown as Result;
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
}

/** Every cell of every layer, as `queryBlocks` gives them (what the editor reads). */
function cells(s: WorkspaceService): unknown {
  const list = s.query({ op: 'queryBlocks', projectId: PID, args: {} }) as unknown as { layers: { entityId: string }[] };
  return list.layers.map((l) => s.query({ op: 'queryBlocks', projectId: PID, args: { entityId: l.entityId, box: [0, 0, 0, 40, 4, 40] } }));
}

/** A layer of two block types over 3 × 3 chunks, painted in one place, in a scene (the main scene's makes the block types). */
function buildLayer(s: WorkspaceService, sceneId = MAIN): string {
  if (sceneId === MAIN) ok(s, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#777777' }], shape: 'full' } });
  if (sceneId === MAIN) ok(s, 'setBlockType', { block: { blockId: 'moss', name: 'Moss', variants: [{ color: '#447744' }], shape: 'full' } });
  const id = ok(s, 'createEntity', { kind: 'group', name: `Ground ${sceneId}`, sceneId }).createdId!;
  ok(s, 'setComponent', { entityId: id, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [40, 4, 40] } } });
  ok(s, 'editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 40, 1, 40], cell: { block: 'stone' } }, { kind: 'fill', box: [5, 1, 5, 30, 2, 9], cell: { block: 'moss', rot: 90 } }, { kind: 'paint', at: [8, 7], radius: 3, strength: 1, channel: 1 }] });
  return id;
}

const blocksDir = (dir: string, sceneId: string): string => join(dir, 'scenes', `${sceneId}.blocks`);
const sceneFile = (dir: string, sceneId: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'scenes', `${sceneId}.json`), 'utf8')) as Record<string, unknown>;
const extensions = (dir: string, sceneId: string): string[] => [...new Set(readdirSync(blocksDir(dir, sceneId)).map((n) => n.split('.').pop()!))].sort();

describe('block chunk files: binary and JSON', () => {
  it('a new project writes binary chunk files; the cells and paint read back after a reopen', () => {
    const p = project('new');
    let s = p.open();
    const content = JSON.parse(readFileSync(join(p.dir, 'content.json'), 'utf8')) as { content: { settings: Record<string, unknown> } };
    expect(content.content.settings['block_chunk_storage']).toBe(1);
    const layer = buildLayer(s);
    const before = cells(s);
    s.close();
    const sid = MAIN;
    expect(extensions(p.dir, sid)).toEqual(['bin']);
    expect(readdirSync(blocksDir(p.dir, sid))).toHaveLength(9);
    expect(sceneFile(p.dir, sid)['blockChunkFormat']).toBe('binary');
    const painted = readBinaryChunkFile(readFileSync(join(blocksDir(p.dir, sid), `${layer}.0.0.bin`)));
    expect(painted.paint).toBeDefined();
    s = p.open();
    expect(cells(s)).toEqual(before);
    s.close();
  });

  it('the setting converts every chunk file in one save, undo converts them back; JSON keeps paint across a reopen', () => {
    const p = project('convert');
    let s = p.open();
    const layer = buildLayer(s);
    const before = cells(s);
    const sid = MAIN;
    ok(s, 'setSettings', { settings: { block_chunk_storage: 0 } });
    expect(extensions(p.dir, sid)).toEqual(['json']);
    expect(sceneFile(p.dir, sid)['blockChunkFormat']).toBeUndefined();
    const text = readFileSync(join(blocksDir(p.dir, sid), `${layer}.0.0.json`), 'utf8');
    expect(text).toContain('"type": "block-chunk"');
    expect(text).toContain('"paint": "');
    ok(s, 'undo', {});
    expect(extensions(p.dir, sid)).toEqual(['bin']);
    ok(s, 'redo', {});
    expect(extensions(p.dir, sid)).toEqual(['json']);
    // An edit in a JSON project stays JSON.
    ok(s, 'editBlocks', { entityId: layer, edits: [{ kind: 'cells', at: [1, 1, 1], cell: { block: 'moss' } }] });
    expect(extensions(p.dir, sid)).toEqual(['json']);
    const edited = cells(s);
    expect(edited).not.toEqual(before);
    s.close();
    s = p.open();
    expect(cells(s)).toEqual(edited);
    // The paint came back from the JSON file: converting again carries it into the binary one.
    ok(s, 'setSettings', { settings: { block_chunk_storage: 1 } });
    expect(readBinaryChunkFile(readFileSync(join(blocksDir(p.dir, sid), `${layer}.0.0.bin`))).paint).toBeDefined();
    s.close();
  });

  it('a JSON project keeps edge pieces, wall paint and block-layer scatter across a reopen', () => {
    const p = project('json-fields');
    let s = p.open();
    ok(s, 'setSettings', { settings: { block_chunk_storage: 0 } });
    const layer = buildLayer(s);
    // The scatter rule's model (any bytes: the rule only names the asset).
    const glb = new TextEncoder().encode('glTF a tuft');
    expect(s.holdAssetBytes(PID, glb).ok).toBe(true);
    const metrics = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 };
    ok(s, 'publishAsset', { mode: 'create', assetId: 'tuft', kind: 'model', displayName: 'Tuft', sourceDigest: createHash('sha256').update(glb).digest('hex'), sourceByteLength: glb.length, importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] }, metrics, importedAt: '2026-10-09T00:00:00Z' });
    ok(s, 'setBlockType', { block: { blockId: 'fence', name: 'Fence', variants: [{ color: '#996633' }], shape: 'full', placement: 'edge' } });
    ok(s, 'setComponent', {
      entityId: layer,
      component: 'blockLayer',
      value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [40, 4, 40] }, wallPaint: true, scatter: [{ id: 'tufts', asset: { assetId: 'tuft' }, density: 0.5, scale: [1, 1], blocks: ['stone'] }] },
    });
    ok(s, 'editBlocks', {
      entityId: layer,
      edits: [
        { kind: 'edges', at: [2, 1, 2, 1, 3, 1, 2, 1], edge: { block: 'fence' } },
        { kind: 'paint', at: [5, 7], y: 1.25, radius: 2, strength: 1, falloff: 'constant', channel: 2, target: 'walls' },
        { kind: 'bakeScatter' },
      ],
    });
    const file = JSON.parse(readFileSync(join(blocksDir(p.dir, MAIN), `${layer}.0.0.json`), 'utf8')) as Record<string, unknown>;
    const fields = ['edgePalette', 'edges', 'paint', 'wallPaint', 'scatter'] as const;
    for (const k of fields) expect(file[k], k).toBeDefined();
    const before = cells(s);
    s.close();
    s = p.open();
    expect((s.query({ op: 'queryProject', projectId: PID }) as unknown as { ok: boolean }).ok).toBe(true);
    expect(cells(s)).toEqual(before);
    // What the reopen read is what was written: converting to binary carries every field over unchanged.
    ok(s, 'setSettings', { settings: { block_chunk_storage: 1 } });
    const chunk = readBinaryChunkFile(readFileSync(join(blocksDir(p.dir, MAIN), `${layer}.0.0.bin`)));
    for (const k of fields) expect(chunk[k], k).toEqual(file[k]);
    s.close();
  });

  it('a project in both forms opens with every cell; a scene written later moves to the project\'s form', () => {
    const p = project('mixed');
    let s = p.open();
    ok(s, 'createScene', { name: 'Cave', sceneId: 'cave' });
    buildLayer(s);
    const caveLayer = buildLayer(s, 'cave');
    const before = cells(s);
    s.close();
    const main = MAIN;
    // The cave as an older engine wrote it: JSON chunk files and no form key.
    const dir = blocksDir(p.dir, 'cave');
    for (const n of readdirSync(dir)) {
      const chunk = readBinaryChunkFile(readFileSync(join(dir, n)));
      writeFileSync(join(dir, n.replace(/\.bin$/, '.json')), chunkFileBytes(PID, 'cave', n.split('.')[0]!, chunk, 'json').bytes);
      unlinkSync(join(dir, n));
    }
    const file = sceneFile(p.dir, 'cave');
    delete file['blockChunkFormat'];
    writeFileSync(join(p.dir, 'scenes', 'cave.json'), `${JSON.stringify(file, null, 2)}\n`);
    s = p.open();
    expect(cells(s)).toEqual(before);
    expect(extensions(p.dir, 'cave')).toEqual(['json']);
    expect(extensions(p.dir, main)).toEqual(['bin']);
    // An edit in the cave writes it in the project's form (binary); the other scene stays as it is.
    ok(s, 'editBlocks', { entityId: caveLayer, edits: [{ kind: 'cells', at: [6, 1, 6], cell: null }] });
    expect(extensions(p.dir, 'cave')).toEqual(['bin']);
    expect(sceneFile(p.dir, 'cave')['blockChunkFormat']).toBe('binary');
    const after = cells(s);
    s.close();
    s = p.open();
    expect(cells(s)).toEqual(after);
    s.close();
  });

  it('a damaged binary chunk file is refused with its path', () => {
    const p = project('damaged');
    let s = p.open();
    const layer = buildLayer(s);
    s.close();
    const sid = MAIN;
    const f = join(blocksDir(p.dir, sid), `${layer}.1.1.bin`);
    const bytes = readFileSync(f);
    writeFileSync(f, bytes.subarray(0, bytes.length - 4));
    s = p.open();
    const q = s.query({ op: 'queryProject', projectId: PID }) as unknown as { ok: boolean; error?: { message?: string; details?: unknown } };
    expect(q.ok).toBe(false);
    expect(JSON.stringify(q)).toContain(`${layer}.1.1.bin`);
    s.close();
    expect(existsSync(f)).toBe(true);
  });
});
