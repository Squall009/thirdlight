/**
 * The kit checker over a project read: a kit's pieces are checked again only
 * when that kit's inputs change (an unrelated material edit reads no file and
 * re-checks nothing), piece facts are let go when no kit names them, a piece
 * is sized in the cell of the block layer that uses its kit, and two sheets
 * whose textures carry no digest never share pixel checks.
 */
import { describe, expect, it } from 'vitest';

import { defaultTrimSheet, trimRowOf, trimRowV } from '@thirdlight/project-model/trim-sheet';
import type { WorkspaceService } from '@thirdlight/workspace';

import { glbBytes } from '@thirdlight/shared';
import { createKitChecker } from './kit-check';
import { createKitProblemChecker } from './kit-problems';
import type { TextureEncoder } from './texture-encode';

const SHEET = defaultTrimSheet();
/** The pieces' own material name (the model's material map points it at the kit's sheet). */
const SOURCE_MATERIAL = 'wood';
const FRAME_V = trimRowV(SHEET, trimRowOf(SHEET, 'frame')!);

/** A 1 × 2 m slab (door-sized) as a GLB of one node, `dx` off the bottom centre, its v inside the frame row. */
function slab(name: string, dx = 0): Uint8Array {
  const x0 = -0.5 + dx, x1 = 0.5 + dx;
  const positions = new Float32Array([x0, 0, 0.05, x1, 0, 0.05, x1, 2, 0.05, x0, 2, 0.05, x0, 0, -0.05, x1, 2, -0.05]);
  const [v0, v1] = FRAME_V;
  const uvs = new Float32Array([0, v1, 0.25, v1, 0.25, v0, 0, v0, 0, v1, 0.25, v0]);
  const index = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 1]);
  const bytes = [positions, uvs, index].map((a) => new Uint8Array(a.buffer));
  const bin = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  const bufferViews = bytes.map((b) => {
    bin.set(b, at);
    const v = { buffer: 0, byteOffset: at, byteLength: b.length };
    at += b.length;
    return v;
  });
  const min = [0, 1, 2].map((c) => Math.min(...positions.filter((_, i) => i % 3 === c)));
  const max = [0, 1, 2].map((c) => Math.max(...positions.filter((_, i) => i % 3 === c)));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    materials: [{ name: SOURCE_MATERIAL }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: index.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  return glbBytes(JSON.stringify(json), bin);
}

interface World {
  kits: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  assets: { assetId: string; kind: string; currentVersion: number; versions: { version: number; sourceDigest: string }[]; materials?: Record<string, string> }[];
  entities: { components: Record<string, unknown> }[];
  files: Map<string, Uint8Array>;
}

function fakeService(world: World): { service: WorkspaceService; reads: string[] } {
  const reads: string[] = [];
  const service = {
    readCapturedV3: () => ({ ok: true, read: { revision: 1, content: { kits: world.kits, materials: world.materials, assets: world.assets }, scene: { entities: world.entities }, scenes: [{ entities: world.entities }] } }),
    readBlob: (_p: string, ref: { assetId: string; version: number }) => {
      reads.push(`${ref.assetId}@${ref.version}`);
      const bytes = world.files.get(`${ref.assetId}@${ref.version}`);
      return bytes === undefined ? { ok: false, error: { code: 'blob_missing', message: 'missing' } } : { ok: true, bytes };
    },
    query: (q: { args: { assetId: string } }) => {
      const a = world.assets.find((x) => x.assetId === q.args.assetId);
      return { ok: true, assets: a === undefined ? [] : [a] };
    },
  };
  return { service: service as unknown as WorkspaceService, reads };
}

const trimMaterial = (materialId: string, albedo: string): Record<string, unknown> => ({ materialId, name: materialId, shader: 'trim', trim: SHEET, params: {}, textures: { map: albedo } });
const model = (assetId: string, digest: string, version = 1): World['assets'][number] => ({ assetId, kind: 'model', currentVersion: version, versions: [{ version, sourceDigest: digest }], materials: { [SOURCE_MATERIAL]: 'trim' } });
const kit = (kitId: string, assetId: string, trimMaterialId = 'trim'): Record<string, unknown> => ({ kitId, name: kitId, trimMaterial: trimMaterialId, pieces: { door: [{ assetId, piece: 'door' }] } });

describe('the kit checker', () => {
  it('checks a kit again only when its inputs change, and lets go of pieces no kit names', () => {
    const world: World = {
      kits: [kit('k1', 'door-a'), kit('k2', 'door-b')],
      materials: [trimMaterial('trim', 'albedo'), { materialId: 'other', name: 'other', shader: 'standard', params: { roughness: 0.5 }, textures: {} }],
      assets: [model('door-a', 'd1'), model('door-b', 'd2'), { assetId: 'albedo', kind: 'texture', currentVersion: 1, versions: [{ version: 1, sourceDigest: 't1' }] }],
      entities: [],
      files: new Map([['door-a@1', slab('door', 0.4)], ['door-b@1', slab('door')]]),
    };
    const { service, reads } = fakeService(world);
    const checker = createKitChecker({ service, encoder: undefined });
    const first = checker.pieceErrors('p');
    expect([...first.keys()]).toEqual(['k1']);
    expect(first.get('k1')![0]).toContain('origin is not at the bottom centre');
    expect(reads).toEqual(['door-a@1', 'door-b@1']);
    // A slider edit of a material no kit uses: no file read, the same answer object (not re-checked).
    world.materials = [world.materials[0]!, { ...world.materials[1]!, params: { roughness: 0.7 } }];
    const second = checker.pieceErrors('p');
    expect(second.get('k1')).toBe(first.get('k1'));
    expect(reads.length).toBe(2);
    // The piece's file changes (a new version): only that kit's piece is read again.
    world.assets[0] = model('door-a', 'd3', 2);
    world.files.set('door-a@2', slab('door'));
    expect(checker.pieceErrors('p').size).toBe(0);
    expect(reads).toEqual(['door-a@1', 'door-b@1', 'door-a@2']);
    // A kit taken out: its piece's facts go; naming it again reads the file again.
    world.kits = [world.kits[0]!];
    checker.pieceErrors('p');
    world.kits = [kit('k1', 'door-a'), kit('k2', 'door-b')];
    checker.pieceErrors('p');
    expect(reads.slice(3)).toEqual(['door-b@1']);
  });

  it('sizes a piece in the cell of the block layer that uses its kit (the default cell when none does)', async () => {
    const world: World = {
      kits: [kit('k1', 'door-a')],
      materials: [trimMaterial('trim', 'albedo')],
      assets: [model('door-a', 'd1')],
      entities: [],
      files: new Map([['door-a@1', slab('door')]]),
    };
    const { service } = fakeService(world);
    const checker = createKitChecker({ service, encoder: undefined });
    const sizeCheck = async () => {
      const r = await checker.check('p', 'k1', { image: false });
      if (!('pieces' in r)) throw new Error('no report');
      return r.pieces[0]!.checks.find((c) => c.id === 'size')!;
    };
    expect((await sizeCheck()).state).toBe('ok');
    world.entities = [{ components: { blockLayer: { kitId: 'k1', cellSize: [2, 2, 2] } } }];
    const big = await sizeCheck();
    expect(big.state).toBe('warn');
    expect(big.detail).toContain('2.00 m cells');
  });

  it('never shares one sheet\'s pixel checks with another whose texture has no digest', async () => {
    const world: World = {
      kits: [kit('k1', 'door-a', 'trim-a'), kit('k2', 'door-a', 'trim-b')],
      materials: [trimMaterial('trim-a', 'tex-a'), trimMaterial('trim-b', 'tex-b')],
      assets: [model('door-a', 'd1'), ...['tex-a', 'tex-b'].map((assetId) => ({ assetId, kind: 'texture', currentVersion: 1, versions: [{ version: 1, sourceDigest: '' }] }))],
      entities: [],
      files: new Map([['door-a@1', slab('door')], ['tex-a@1', new Uint8Array(16)], ['tex-b@1', new Uint8Array(16)]]),
    };
    const { service } = fakeService(world);
    const [w, h] = SHEET.size;
    const encoder = { decode: async () => ({ ok: true, data: new Uint8Array(w * h * 4), width: w, height: h, transcoded: false }) } as unknown as TextureEncoder;
    const checker = createKitChecker({ service, encoder });
    const a = await checker.check('p', 'k1', { image: true });
    expect('sheet' in a && a.sheet?.imageRead).toBe(true);
    const b = await checker.check('p', 'k2', { image: false });
    expect('sheet' in b && b.sheet?.imageRead).toBe(false);
  });
});

describe('the kit Problems', () => {
  it('check again after a block layer\'s cell or kit changes, not after its other fields', async () => {
    let checks = 0;
    const problems = createKitProblemChecker({
      service: { readCapturedV3: () => ((checks += 1), { ok: true, read: { content: { kits: [] } } }) } as never,
      recordProblem: () => undefined,
      logStartup: () => undefined,
      closed: () => false,
    });
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
    problems.changed('p', { type: 'setComponent', component: 'blockLayer', changedFields: ['castShadow'] });
    await settle();
    expect(checks).toBe(0);
    problems.changed('p', { type: 'setComponent', component: 'blockLayer', changedFields: ['cellSize'] });
    await settle();
    expect(checks).toBe(1);
    problems.changed('p', { type: 'setMaterial' });
    await settle();
    expect(checks).toBe(2);
  });
});
