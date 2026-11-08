/**
 * The voxel kit check (slots): a kit filling every slot passes every rule;
 * an empty kit and a kit filling one slot pass too (every slot is optional:
 * no warning for an empty one); each rule fires on a kit broken for it and
 * on no other; one texture set a kit; a mesh's envelope is checked turned
 * by its slot rotation; trim rows only for a kit that names a layout, each
 * of T1–T7 firing on its own fault, U read along the slot's run through the
 * rotation; a real GLB's facts (triangles, bounds, UVs, one node, an
 * embedded image's size, its texture set) read from its bytes.
 */
import { glbBytes, pngBytes } from '@thirdlight/shared';
import { CUBE_ROTATION_X90, CUBE_ROTATION_ZM90, EDGE_CASE_CATALOGUE, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import type { VoxelKit, VoxelKitMesh } from './voxel-kit';
import { voxelKitCheck, voxelKitMeshFacts, voxelKitMeshKey, type VoxelKitAssets, type VoxelKitCheckRow, type VoxelKitMeshFacts } from './voxel-kit-check';

const H = VOXEL_SIZE_M / 2;
const CATALOGUE = EDGE_CASE_CATALOGUE;
const D = (n: number): string => n.toString(16).padStart(64, '0');
const mesh = (assetId: string, n = 1): VoxelKitMesh => ({ assetId, digest: D(n) });

/** Facts of triangles given as [x, y, z, u, v] corners. */
function facts(tris: number[][][]): VoxelKitMeshFacts {
  const positions = new Float32Array(tris.length * 9);
  const uv = new Float32Array(tris.length * 6);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  tris.forEach((t, i) => t.forEach((c, k) => {
    for (let a = 0; a < 3; a++) {
      positions[i * 9 + k * 3 + a] = c[a]!;
      min[a] = Math.min(min[a]!, c[a]!);
      max[a] = Math.max(max[a]!, c[a]!);
    }
    uv[i * 6 + k * 2] = c[3]!;
    uv[i * 6 + k * 2 + 1] = c[4]!;
  }));
  return { unreadable: null, found: true, triangles: tris.length, bounds: { min, max }, positions, uv, textures: { count: 0, bytes: 0, sizes: [] }, textureSets: ['kit-standin'] };
}

/** A quad in the plane z = `z` over x × y, two triangles, UVs from (x, y). */
function quad(x0: number, x1: number, y0: number, y1: number, z: number, uvOf: (x: number, y: number) => [number, number]): number[][][] {
  const c = (x: number, y: number): number[] => [x, y, z, ...uvOf(x, y)];
  return [[c(x0, y0), c(x1, y0), c(x1, y1)], [c(x0, y0), c(x1, y1), c(x0, y1)]];
}

/** The draft layout's U and V of a front face on strip `top` px: U 0.25 a metre from the section's start, V at real size from the band's top. */
const onStrip = (top: number, yTop: number, scaleV = 1, uOff = 0) => (x: number, y: number): [number, number] => [0.25 * (x + H) + uOff, (top + (yTop - y) * 1024 * scaleV) / 4096];

/** A box mesh's facts centred on the cell (UVs on the field). */
const box = (lo = -H, hi = H): VoxelKitMeshFacts => facts(quad(lo, hi, lo, hi, hi, (x, y) => [0.25 * (x + H), (32 + (hi - y) * 1024) / 4096]));

/** A kit with every slot filled, one mesh each. */
function fullKit(): VoxelKit {
  const slots: VoxelKit['slots'] = {};
  for (const c of CATALOGUE.cases) slots[c.id] = { meshes: [{ mesh: mesh(`${c.id}-h`) }] };
  return { kitFormat: 1, voxelKitId: 'full', name: 'Full', version: 1, materialType: 'wood', materials: [11], slots };
}

function assetsOf(kit: VoxelKit): Map<string, { kind: string; digests: string[]; current?: string }> {
  const out = new Map<string, { kind: string; digests: string[]; current?: string }>();
  for (const c of Object.values(kit.slots)) for (const m of c.meshes) out.set(m.mesh.assetId, { kind: 'model', digests: [m.mesh.digest] });
  return out;
}

function run(kit: VoxelKit, opts: { assets?: VoxelKitAssets; facts?: (m: VoxelKitMesh) => VoxelKitMeshFacts | null } = {}): VoxelKitCheckRow[] {
  return voxelKitCheck(kit, CATALOGUE, opts.assets ?? assetsOf(kit), opts.facts ?? (() => box())).rows;
}

const bad = (rows: VoxelKitCheckRow[]): string[] => rows.filter((r) => r.state === 'warn' || r.state === 'err').map((r) => `${r.state} ${r.id}`);

const slotsOf = (k: VoxelKit, f: (c: VoxelKit['slots']) => void): VoxelKit => {
  const next = structuredClone(k);
  f(next.slots);
  return next;
};

describe('the voxel kit check', () => {
  it('passes a kit with every slot filled (one mesh a piece, one texture set)', () => {
    const rows = run(fullKit());
    expect(bad(rows)).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(['catalogue', 'slots', 'damage', 'assets', 'pivot', 'fit', 'texture-set', 'budget']);
    expect(rows.find((r) => r.id === 'slots')!.title).toBe(`${CATALOGUE.cases.length} of ${CATALOGUE.cases.length} slots filled`);
    expect(rows.find((r) => r.id === 'budget')!.title).toBe(`${CATALOGUE.cases.length} slot meshes: ${CATALOGUE.cases.length * 2} triangles`);
    expect(rows.some((r) => r.id.startsWith('trim:'))).toBe(false);
  });

  it('gives no warning for empty slots: an empty kit and a kit with one slot filled pass, the slots row says what is filled', () => {
    const empty: VoxelKit = { ...fullKit(), slots: {} };
    const rows = run(empty);
    expect(bad(rows)).toEqual([]);
    expect(rows.find((r) => r.id === 'slots')).toMatchObject({ state: 'info', title: `0 of ${CATALOGUE.cases.length} slots filled`, detail: expect.stringMatching(/plain voxel edge/) });
    const one = slotsOf(empty, (c) => (c['edge-out-top'] = { meshes: [{ mesh: mesh('top') }] }));
    const oneRows = run(one);
    expect(bad(oneRows)).toEqual([]);
    expect(oneRows.find((r) => r.id === 'slots')!.detail).toMatch(/^edge-out-top; the other 16 draw nothing/);
    // One mesh filling every slot, each turned its own way: still no warning.
    const shared = slotsOf(empty, (c) => {
      for (const cs of CATALOGUE.cases) c[cs.id] = { meshes: [{ mesh: mesh('one'), rotation: cs.id.includes('vertical') ? CUBE_ROTATION_ZM90 : 0 }] };
    });
    expect(bad(run(shared))).toEqual([]);
  });

  it('fires each rule on a kit broken for it, and only that rule', () => {
    const full = fullKit();
    const only = (rows: VoxelKitCheckRow[]): string[] => bad(rows).sort();
    // A slot the catalogue does not have never draws (beams and banisters are no slots).
    const unknown = run(slotsOf(full, (c) => { c['beam'] = c['edge-out-top']!; c['gazebo'] = c['edge-out-top']!; }));
    expect(only(unknown)).toEqual(['err catalogue']);
    expect(unknown.find((r) => r.id === 'catalogue')!.detail).toMatch(/^beam, gazebo: never drawn/);
    // Assets: missing, not a model, unreadable, a node not in the file; a digest no version has.
    const assets = assetsOf(full);
    assets.delete('damage-stage-2-h');
    assets.set('roof-ridge-h', { kind: 'texture', digests: [D(1)] });
    assets.set('edge-out-vertical-h', { kind: 'model', digests: [D(2)] });
    const noFile = (m: VoxelKitMesh): VoxelKitMeshFacts | null => (m.assetId === 'roof-hip-h' ? { ...box(), unreadable: 'not a GLB (version 2)' } : m.assetId === 'roof-valley-h' ? { ...box(), found: false } : box());
    const broken = run(full, { assets, facts: noFile });
    expect(only(broken)).toEqual(['err assets', 'warn digests']);
    expect(broken.find((r) => r.id === 'assets')!.detail).toMatch(/no such model: damage-stage-2 \(damage-stage-2-h\).*not a model: roof-ridge.*unreadable: roof-hip.*no such node: roof-valley.*Their slots draw nothing/);
    // A mesh naming an older version of its model (v1 of two, v2 current): the pin holds only while nothing else
    // uses the model; one naming the current version is fine.
    const pinned = assetsOf(full);
    pinned.set('edge-out-vertical-h', { kind: 'model', digests: [D(1), D(9)], current: D(9) });
    pinned.set('edge-out-top-h', { kind: 'model', digests: [D(9), D(1)], current: D(1) });
    const older = run(full, { assets: pinned });
    expect(only(older)).toEqual(['warn pinned']);
    expect(older.find((r) => r.id === 'pinned')!.detail).toMatch(/^edge-out-vertical \(edge-out-vertical-h\): a build ships that version only while nothing else uses the model/);
    // Pivots: a piece beside its cell; one reaching into the neighbours.
    expect(only(run(full, { facts: (m) => (m.assetId === 'edge-out-top-h' ? box(H + 0.1, H + 0.4) : box()) }))).toEqual(['err pivot']);
    expect(only(run(full, { facts: (m) => (m.assetId === 'edge-out-top-h' ? facts(quad(-H, 0.8, -H, H, H, () => [0, 0])) : box()) }))).toEqual(['warn fit']);
  });

  it('checks a mesh\'s envelope turned by its slot rotation: a roof\'s height allowance follows the slot, not the mesh', () => {
    // A mesh reaching a cell above its centre along x (0.75 m): too long for an edge, as authored.
    const long = facts(quad(-H, 3 * H, -H, H, H, () => [0, 0]));
    const one = (slot: string, rotation: number): VoxelKit => ({ ...fullKit(), slots: { [slot]: { meshes: [{ mesh: mesh('long'), rotation }] } } });
    const at = (slot: string, rotation: number): string[] => bad(run(one(slot, rotation), { facts: () => long }));
    expect(at('edge-out-top', 0)).toEqual(['warn fit']);
    // Turned so its length runs up y (−z quarter turn: +x to −y, so the reach goes down: still past the cell).
    expect(at('edge-out-top', CUBE_ROTATION_ZM90)).toEqual(['warn fit']);
    // In a roof slot, turned so it reaches up: inside the roof's taller envelope.
    const up = facts(quad(-H, H, -H, 3 * H, H, () => [0, 0]));
    expect(bad(run(one('roof-ridge', 0), { facts: () => up }))).toEqual([]);
    // The same mesh turned under (+x quarter turn: +y to +z) in that roof slot now reaches out along z: past the cell.
    expect(bad(run(one('roof-ridge', CUBE_ROTATION_X90), { facts: () => up }))).toEqual(['warn fit']);
  });

  it('allows one texture set a kit: two materials, or one material name over two sheets, is an error', () => {
    const full = fullKit();
    const set = (name: string): VoxelKitMeshFacts => ({ ...box(), textureSets: [name] });
    const two = run(full, { facts: (m) => (m.assetId === 'damage-stage-3-h' ? set('stone [0badf00d]') : set('wood [12345678]')) });
    expect(bad(two)).toEqual(['err texture-set']);
    expect(two.find((r) => r.id === 'texture-set')!.detail).toMatch(/^wood \[12345678\]: edge-out-top, .*; stone \[0badf00d\]: damage-stage-3\. .*make two kits/);
    // A mesh using two materials itself.
    expect(bad(run(full, { facts: (m) => (m.assetId === 'roof-eave-h' ? { ...box(), textureSets: ['a', 'b'] } : { ...box(), textureSets: ['a'] }) }))).toEqual(['err texture-set']);
    // Every mesh on the same set (across files: the same name and images): fine.
    expect(bad(run(full, { facts: () => set('wood [12345678]') }))).toEqual([]);
  });

  describe('trim conformance (draft layout), only for a kit that names one', () => {
    /** An edge kit on the draft layout: two slots, a 0.125 m face on the profiled 0.125 m strip. */
    const trimKit = (): VoxelKit => ({
      ...fullKit(),
      voxelKitId: 'trim',
      trimLayout: 'detail-trim',
      slots: { 'edge-out-top': { meshes: [{ mesh: mesh('b-h') }] }, 'roof-eave': { meshes: [{ mesh: mesh('s-h') }] } },
    });
    /** The profiled 0.125 m strip's top, half a texel in, and a face that fills the strip to half a texel. */
    const S12P = 3104.5;
    const F = 0.062;
    const good = facts(quad(-H, H, -F, F, H, onStrip(S12P, F)));
    const runTrim = (over: Record<string, VoxelKitMeshFacts>): VoxelKitCheckRow[] => run(trimKit(), { facts: (m) => over[m.assetId] ?? good }).filter((r) => r.id.startsWith('trim:'));
    const fired = (rows: VoxelKitCheckRow[]): string[] => rows.filter((r) => r.state === 'warn' || r.state === 'err').map((r) => `${r.state} ${r.id}`);

    it('passes a mesh on its strip at the layout density, rows labelled draft; T9 and T10 report', () => {
      const rows = runTrim({});
      expect(fired(rows)).toEqual([]);
      expect(rows.map((r) => r.id)).toEqual(['trim:T1', 'trim:T2', 'trim:T3', 'trim:T4', 'trim:T5', 'trim:T6', 'trim:T7', 'trim:T9', 'trim:T10']);
      expect(rows.every((r) => r.draft === true && /draft layout/.test(r.title))).toBe(true);
      expect(rows.find((r) => r.id === 'trim:T10')!.detail).toMatch(/S12p: 2 meshes, 0\.124 m²/);
      expect(run({ ...trimKit(), trimLayout: 'other' }).filter((r) => r.id.startsWith('trim:')).map((r) => `${r.state} ${r.id}`)).toEqual(['err trim:layout']);
    });

    it("checks a kit's own declared sheet layout (its size, density and regions), rows labelled the kit's, not draft", () => {
      // A 1024 px sheet at 512 px/m: one profiled 0.125 m strip on rows 64-128 and a field below.
      const sheetLayout = { pxPerMetre: 512, size: 1024, regions: [{ kind: 'profiled' as const, id: 'trim', metres: 0.125, y: [64, 128] as [number, number] }, { id: 'wall', kind: 'field' as const, metres: 1, y: [192, 704] as [number, number] }] };
      const own = (): VoxelKit => ({ ...trimKit(), trimLayout: undefined, sheetLayout });
      // A face 0.123 m high fills the 64 px strip to half a texel at this density.
      const G = 0.0615;
      const onOwn = (scaleU = 1) => (x: number, y: number): [number, number] => [0.5 * scaleU * (x + H), (64.5 + (G - y) * 512) / 1024];
      const ownRows = (m: VoxelKitMeshFacts): VoxelKitCheckRow[] => run(own(), { facts: () => m }).filter((r) => r.id.startsWith('trim:'));
      const rows = ownRows(facts(quad(-H, H, -G, G, H, onOwn())));
      expect(fired(rows)).toEqual([]);
      expect(rows.every((r) => r.draft === undefined && /the kit's layout/.test(r.title))).toBe(true);
      expect(rows.find((r) => r.id === 'trim:T10')!.detail).toMatch(/trim: 2 meshes/);
      // U at the draft's density (0.25 a metre) is off this sheet's 0.5: T4.
      expect(fired(ownRows(facts(quad(-H, H, -G, G, H, onOwn(0.5)))))).toEqual(['err trim:T4']);
      // The draft layout's strip is a gutter on this sheet.
      expect(fired(ownRows(good))).toContain('err trim:T2');
    });

    it('fires T1–T7 each on its own fault', () => {
      const t = (over: Record<string, VoxelKitMeshFacts>): string[] => fired(runTrim(over));
      // T1: a face straddling the field and the 0.5 m strip.
      expect(t({ 'b-h': facts(quad(-H, H, -0.0625, 0.0625, H, onStrip(1000, 0.0625))) })).toContain('err trim:T1');
      // T2: in the gutter between them.
      expect(t({ 'b-h': facts(quad(-H, H, -0.01, 0.01, H, onStrip(1070, 0.01))) })).toContain('err trim:T2');
      // T3: V at twice the density.
      expect(t({ 'b-h': facts(quad(-H, H, -0.03, 0.03, H, onStrip(S12P, 0.03, 2))) })).toContain('warn trim:T3');
      // T4: the section starting at U 0.1.
      expect(t({ 'b-h': facts(quad(-H, H, -F, F, H, onStrip(S12P, F, 1, 0.1))) })).toEqual(['err trim:T4']);
      // T5: a 0.0625 m face on the profiled 0.125 m strip.
      expect(t({ 'b-h': facts(quad(-H, H, -0.03125, 0.03125, H, onStrip(S12P, 0.03125))) })).toEqual(['warn trim:T5']);
      // T6: an end face on cap cell b of its size.
      const cap = (x0: number) => facts([...quad(-H, H, -F, F, H, onStrip(S12P, F)), ...quad(-0.1, 0.1, -0.1, 0.1, 0, (x, y) => [(x0 + 1 + (x + 0.1) * 1024) / 4096, (3297 + (0.1 - y) * 1024) / 4096])]);
      expect(t({ 'b-h': cap(2656) })).toEqual(['warn trim:T6']);
      expect(t({ 'b-h': cap(2336) })).toEqual([]);
      // Both ends of a member closed in one mesh: each end face is measured on its own, not the box round both.
      const capUv = (x: number, y: number): [number, number] => [(2337 + (x + 0.1) * 1024) / 4096, (3297 + (0.1 - y) * 1024) / 4096];
      const ends = facts([...quad(-H, H, -F, F, H, onStrip(S12P, F)), ...quad(-0.1, 0.1, -0.1, 0.1, 0, capUv), ...quad(-0.1, 0.1, -0.1, 0.1, 0.3, capUv)]);
      expect(t({ 'b-h': ends })).toEqual([]);
      // T7: a second mesh of a slot on the plain strip.
      const twoMeshes = trimKit();
      twoMeshes.slots['edge-out-top']!.meshes.push({ mesh: mesh('b2-h') });
      const plain = facts(quad(-H, H, -F, F, H, onStrip(2912.5, F)));
      expect(fired(run(twoMeshes, { facts: (m) => (m.assetId === 'b2-h' ? plain : good) }).filter((r) => r.id.startsWith('trim:')))).toEqual(['warn trim:T7']);
    });

    it('reads U along the slot\'s run through the mesh\'s rotation: a vertical edge filled by a mesh along x is checked along x', () => {
      // The mesh runs along x; the vertical edge's run is y, and the −z quarter turn carries the mesh's x onto it.
      const vertical = (rotation: number): VoxelKit => ({ ...trimKit(), slots: { 'edge-out-vertical': { meshes: [{ mesh: mesh('b-h'), rotation }] } } });
      const t = (rotation: number): string[] => fired(run(vertical(rotation), { facts: () => good }).filter((r) => r.id.startsWith('trim:')));
      expect(t(CUBE_ROTATION_ZM90)).toEqual([]);
      // Unturned, its U would have to grow up y: the faces along x read as off the run density.
      expect(t(0)).toEqual(['err trim:T4']);
    });
  });

  it('reads a GLB\'s facts: triangles, bounds, UV0, one node, an embedded image\'s size', () => {
    const pos = new Float32Array([-0.25, 0, 0.25, 0.25, 0, 0.25, 0.25, 0.1, 0.25, 0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const uv = new Float32Array([0, 0.75, 0.125, 0.75, 0.125, 0.76, 0, 0, 0, 0, 0, 0]);
    const png = pngBytes({ width: 64, height: 32, bitDepth: 8, colorType: 6, idat: new Uint8Array([120, 156, 3, 0, 0, 0, 0, 1]) });
    const bin = new Uint8Array(pos.byteLength + uv.byteLength + png.length + ((4 - (png.length % 4)) % 4));
    bin.set(new Uint8Array(pos.buffer), 0);
    bin.set(new Uint8Array(uv.buffer), pos.byteLength);
    bin.set(png, pos.byteLength + uv.byteLength);
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ name: 'Body', mesh: 0 }, { name: 'Other', mesh: 1 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.25, 0, 0.25], max: [0.25, 0.1, 0.25] },
        { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength }, { buffer: 0, byteOffset: pos.byteLength + uv.byteLength, byteLength: png.length }],
      images: [{ bufferView: 2, mimeType: 'image/png' }],
      buffers: [{ byteLength: bin.length }],
    };
    const bytes = glbBytes(JSON.stringify(json), bin);
    const size = (b: Uint8Array): [number, number] => [new DataView(b.buffer, b.byteOffset).getUint32(16), new DataView(b.buffer, b.byteOffset).getUint32(20)];
    const f = voxelKitMeshFacts(bytes, 'Body', size);
    expect({ found: f.found, triangles: f.triangles, bounds: f.bounds, uv: Array.from(f.uv!).map((x) => Math.round(x * 1000) / 1000), textures: f.textures }).toEqual({
      found: true,
      triangles: 1,
      bounds: { min: [-0.25, 0, 0.25], max: [0.25, expect.closeTo(0.1, 6), 0.25] },
      uv: [0, 0.75, 0.125, 0.75, 0.125, 0.76],
      textures: { count: 1, bytes: png.length, sizes: [[64, 32]] },
    });
    // The whole file: both nodes, and the second has no UV0.
    expect(voxelKitMeshFacts(bytes)).toMatchObject({ triangles: 2, uv: null });
    expect(voxelKitMeshFacts(bytes, 'Missing')).toMatchObject({ found: false, triangles: 0 });
    expect(voxelKitMeshFacts(new Uint8Array(8)).unreadable).toMatch(/GLB/);
    // No material on the primitives: one set, none.
    expect(f.textureSets).toEqual(['(none)']);
    expect(voxelKitMeshKey({ assetId: 'a', digest: D(3), node: 'Body' })).toBe(`a@${D(3)}#Body`);
  });
});
