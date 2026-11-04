/**
 * The voxel kit check: a complete kit passes every rule, the engine's
 * default kit passes (no error: its cases without a piece of their own are
 * warnings naming what draws them), and each rule fires on a kit broken for
 * it and on no other; trim rows only for a kit that names a layout, each of
 * T1–T8 firing on its own fault; a real GLB's facts (triangles, bounds, UVs,
 * one node, an embedded image's size) read from its bytes.
 */
import { glbBytes, pngBytes } from '@thirdlight/shared';
import { DEFAULT_KIT_PIECES, DEFAULT_KIT_UNITS, DRAFT_CASE_CATALOGUE, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import type { VoxelKit, VoxelKitMesh } from './voxel-kit';
import { voxelKitCheck, voxelKitCheckState, voxelKitMeshFacts, voxelKitMeshKey, type VoxelKitAssets, type VoxelKitCheckRow, type VoxelKitMeshFacts } from './voxel-kit-check';

const H = VOXEL_SIZE_M / 2;
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
  return { unreadable: null, found: true, triangles: tris.length, bounds: { min, max }, positions, uv, textures: { count: 0, bytes: 0, sizes: [] } };
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

/** A kit with a body piece (high and low) for every case, its ends on one profile. */
function fullKit(): VoxelKit {
  const cases: VoxelKit['cases'] = {};
  for (const c of DRAFT_CASE_CATALOGUE.cases) cases[c.id] = { sections: { body: { variants: [{ high: mesh(`${c.id}-h`), low: mesh(`${c.id}-l`) }], ends: { start: 'flat', end: 'flat' } } } };
  return { kitFormat: 1, voxelKitId: 'full', name: 'Full', version: 1, materialType: 'wood', materials: [11], cases, joinProfiles: { flat: { outline: [[0, 0], [16, 0], [16, 16]] } } };
}

function assetsOf(kit: VoxelKit): Map<string, { kind: string; digests: string[] }> {
  const out = new Map<string, { kind: string; digests: string[] }>();
  for (const c of Object.values(kit.cases)) for (const s of Object.values(c.sections ?? {})) for (const v of s.variants) for (const m of [v.high, v.low]) if (m !== undefined) out.set(m.assetId, { kind: 'model', digests: [m.digest] });
  return out;
}

function run(kit: VoxelKit, opts: { assets?: VoxelKitAssets; facts?: (m: VoxelKitMesh) => VoxelKitMeshFacts | null } = {}): VoxelKitCheckRow[] {
  return voxelKitCheck(kit, DRAFT_CASE_CATALOGUE, opts.assets ?? assetsOf(kit), opts.facts ?? ((m) => (m.assetId.endsWith('-l') ? facts(quad(-H, H, -H, H, H, () => [0, 0.01])) : box()))).rows;
}

const bad = (rows: VoxelKitCheckRow[]): string[] => rows.filter((r) => r.state === 'warn' || r.state === 'err').map((r) => `${r.state} ${r.id}`);

describe('the voxel kit check', () => {
  it('passes a kit with every case, high and low, on one join profile', () => {
    const rows = run(fullKit());
    expect(bad(rows)).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['catalogue', 'required', 'optional', 'fallback:wall', 'pairs', 'assets', 'pivot', 'fit', 'joins', 'budget']));
    expect(rows.find((r) => r.id === 'budget')!.title).toBe(`${DRAFT_CASE_CATALOGUE.cases.length} pieces: ${DRAFT_CASE_CATALOGUE.cases.length * 2} triangles high, ${DRAFT_CASE_CATALOGUE.cases.length * 2} low`);
    expect(rows.some((r) => r.id.startsWith('trim:'))).toBe(false);
  });

  it('passes the engine default kit: no error; the cases it leaves to the base surface or the stand-ins are warnings saying so', () => {
    const cases: VoxelKit['cases'] = {};
    const shapes = new Map<string, VoxelKitMeshFacts>();
    const u = VOXEL_SIZE_M / DEFAULT_KIT_UNITS;
    for (const [id, p] of Object.entries(DEFAULT_KIT_PIECES)) {
      if (p === null) continue;
      cases[id] = { sections: { body: { variants: [{ high: mesh(`default-${id}`) }] } } };
      // Each box's front face in metres, centred on the cell (default pieces are written from the cell's corner).
      shapes.set(`default-${id}`, facts(p.boxes.flatMap(([x0, y0, z0, x1, y1, z1]) => [...quad(x0 * u - H, x1 * u - H, y0 * u - H, y1 * u - H, z1 * u - H, () => [0, 0]), ...quad(x0 * u - H, x1 * u - H, y0 * u - H, y1 * u - H, z0 * u - H, () => [0, 0])])));
    }
    const kit: VoxelKit = { kitFormat: 1, voxelKitId: 'engine-default', name: 'Engine default', version: 1, materialType: 'any', cases };
    const report = voxelKitCheck(kit, DRAFT_CASE_CATALOGUE, assetsOf(kit), (m) => shapes.get(m.assetId) ?? null);
    expect(voxelKitCheckState(report)).not.toBe('err');
    const ids = bad(report.rows);
    expect(ids).toEqual(expect.arrayContaining(['warn required:wall-plain', 'warn required:beam', 'warn fallback:wall']));
    expect(report.rows.find((r) => r.id === 'required:beam')!.detail).toMatch(/engine's stand-in bar/);
    expect(report.rows.find((r) => r.id === 'required:wall-plain')!.detail).toMatch(/base surface/);
    expect(report.totals.pieces).toBe(Object.values(DEFAULT_KIT_PIECES).filter((p) => p !== null).length);
  });

  it('fires each rule on a kit broken for it, and only that rule', () => {
    const cases = (k: VoxelKit, f: (c: VoxelKit['cases']) => void): VoxelKit => {
      const next = structuredClone(k);
      f(next.cases);
      return next;
    };
    const full = fullKit();
    const only = (rows: VoxelKitCheckRow[]): string[] => bad(rows).sort();
    // An unknown case and an unknown section never draw.
    expect(only(run(cases(full, (c) => { c['gazebo'] = c['wall-top']!; c['beam']!.sections!['middle'] = c['beam']!.sections!['body']!; })))).toEqual(['err catalogue']);
    // A required case missing: covered by the role's fallback piece, or by the engine's stand-in.
    const noTop = run(cases(full, (c) => { delete c['wall-top']; delete c['beam']; }));
    expect(only(noTop)).toEqual(['warn required:beam', 'warn required:wall-top']);
    expect(noTop.find((r) => r.id === 'required:wall-top')!.detail).toMatch(/wall-plain piece stands in/);
    // An optional case missing is info only.
    const noMould = run(cases(full, (c) => { delete c['moulding']; }));
    expect(only(noMould)).toEqual([]);
    expect(noMould.find((r) => r.id === 'optional')!.state).toBe('info');
    // No fallback piece for a role.
    expect(only(run(cases(full, (c) => { delete c['stair-plain']; })))).toEqual(['warn fallback:stair', 'warn required:stair-plain']);
    // A variant without a low is info; a low heavier than its high a warn.
    const noLow = run(cases(full, (c) => { delete c['wall-top']!.sections!['body']!.variants[0]!.low; }));
    expect([only(noLow), noLow.find((r) => r.id === 'pairs')!.state]).toEqual([[], 'info']);
    expect(only(run(full, { facts: (m) => (m.assetId === 'wall-top-l' ? facts([...quad(-H, H, -H, H, H, () => [0, 0]), ...quad(-H, H, -H, H, -H, () => [0, 0])]) : box()) }))).toEqual(['warn pairs-heavy']);
    // Assets: missing, not a model, unreadable, a node not in the file; a digest no version has.
    const assets = assetsOf(full);
    assets.delete('beam-h');
    assets.set('roof-peak-h', { kind: 'texture', digests: [D(1)] });
    assets.set('wall-end-h', { kind: 'model', digests: [D(2)] });
    const noFile = (m: VoxelKitMesh): VoxelKitMeshFacts | null => (m.assetId === 'soffit-h' ? { ...box(), unreadable: 'not a GLB (version 2)' } : m.assetId === 'moulding-h' ? { ...box(), found: false } : box());
    const broken = run(full, { assets, facts: noFile });
    expect(only(broken)).toEqual(['err assets', 'warn digests']);
    expect(broken.find((r) => r.id === 'assets')!.detail).toMatch(/no such model: beam\/body \(beam-h\).*not a model: roof-peak.*unreadable: soffit.*no such node: moulding/);
    // Pivots: a piece beside its cell; one reaching into the neighbours.
    expect(only(run(full, { facts: (m) => (m.assetId === 'wall-top-h' ? box(H + 0.1, H + 0.4) : box()) }))).toEqual(['err pivot']);
    expect(only(run(full, { facts: (m) => (m.assetId === 'wall-top-h' ? facts(quad(-H, 0.8, -H, H, H, () => [0, 0])) : box()) }))).toEqual(['warn fit']);
    // Join profiles: a start section meeting the body on another outline; an end with no profile is not checked.
    const steps = cases(full, (c) => { c['beam']!.sections!['start'] = { variants: [{ high: mesh('beam-h'), low: mesh('beam-l') }], ends: { start: 'flat', end: 'round' } }; });
    steps.joinProfiles!['round'] = { outline: [[0, 0], [8, 0], [8, 8], [0, 8]] };
    expect(only(run(steps))).toEqual(['warn joins']);
    const same = structuredClone(steps);
    same.joinProfiles!['round'] = same.joinProfiles!['flat']!;
    expect(only(run(same))).toEqual([]);
    const open = cases(full, (c) => { delete c['beam']!.sections!['body']!.ends; });
    expect([only(run(open)), run(open).find((r) => r.id === 'joins-unchecked')?.state]).toEqual([[], 'info']);
  });

  describe('trim conformance (draft layout), only for a kit that names one', () => {
    /** A beam kit on the draft layout: body and start sections, a 0.125 m face on the profiled 0.125 m strip, its low the same. */
    const trimKit = (): VoxelKit => ({
      ...fullKit(),
      voxelKitId: 'trim',
      trimLayout: 'detail-trim',
      cases: { beam: { sections: { body: { variants: [{ high: mesh('b-h'), low: mesh('b-l') }] }, start: { variants: [{ high: mesh('s-h'), low: mesh('s-l') }] } } } },
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
      expect(rows.map((r) => r.id)).toEqual(['trim:T1', 'trim:T2', 'trim:T3', 'trim:T4', 'trim:T5', 'trim:T6', 'trim:T7', 'trim:T8', 'trim:T9', 'trim:T10']);
      expect(rows.every((r) => r.draft === true && /draft layout/.test(r.title))).toBe(true);
      expect(rows.find((r) => r.id === 'trim:T10')!.detail).toMatch(/S12p: 4 meshes, 0\.248 m²/);
      expect(run({ ...trimKit(), trimLayout: 'other' }).filter((r) => r.id.startsWith('trim:')).map((r) => `${r.state} ${r.id}`)).toEqual(['err trim:layout']);
    });

    it('fires T1–T8 each on its own fault', () => {
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
      expect(t({ 'b-h': facts(quad(-H, H, -0.03125, 0.03125, H, onStrip(S12P, 0.03125))), 'b-l': facts(quad(-H, H, -0.03125, 0.03125, H, onStrip(S12P, 0.03125))) })).toEqual(['warn trim:T5']);
      // T6: an end face on cap cell b of its size.
      const cap = (x0: number) => facts([...quad(-H, H, -F, F, H, onStrip(S12P, F)), ...quad(-0.1, 0.1, -0.1, 0.1, 0, (x, y) => [(x0 + 1 + (x + 0.1) * 1024) / 4096, (3297 + (0.1 - y) * 1024) / 4096])]);
      expect(t({ 'b-h': cap(2656), 'b-l': cap(2656) })).toEqual(['warn trim:T6']);
      expect(t({ 'b-h': cap(2336), 'b-l': cap(2336) })).toEqual([]);
      // Both ends of a member closed in one mesh: each end face is measured on its own, not the box round both.
      const capUv = (x: number, y: number): [number, number] => [(2337 + (x + 0.1) * 1024) / 4096, (3297 + (0.1 - y) * 1024) / 4096];
      const ends = facts([...quad(-H, H, -F, F, H, onStrip(S12P, F)), ...quad(-0.1, 0.1, -0.1, 0.1, 0, capUv), ...quad(-0.1, 0.1, -0.1, 0.1, 0.3, capUv)]);
      expect(t({ 'b-h': ends, 'b-l': ends })).toEqual([]);
      // T7: the low on the plain strip.
      expect(t({ 'b-l': facts(quad(-H, H, -F, F, H, onStrip(2912.5, F))) })).toEqual(['warn trim:T7']);
      // T8: the start section's end face on another strip than the body's start (both its levels, so T7 holds).
      const other = facts(quad(-H, H, -F, F, H, onStrip(2912.5, F)));
      expect(t({ 's-h': other, 's-l': other })).toEqual(['warn trim:T8']);
    });

    it('meets sections along their case run: up y for a run that climbs (a wall end), never across x', () => {
      const endKit = (): VoxelKit => ({ ...trimKit(), cases: { 'wall-end': structuredClone(trimKit().cases['beam']!) } });
      const t = (over: Record<string, VoxelKitMeshFacts>): string[] => fired(run(endKit(), { facts: (m) => over[m.assetId] ?? good }).filter((r) => r.id.startsWith('trim:')));
      // Faces touching the x planes on other strips: no join there for a run up y.
      const other = facts(quad(-H, H, -F, F, H, onStrip(2912.5, F)));
      expect(t({ 's-h': other, 's-l': other })).toEqual([]);
      // Faces touching the y planes (the field, the cell's height) on other regions do meet.
      const tall = (top: number): VoxelKitMeshFacts => facts(quad(-0.06, 0.06, -H, H, H, onStrip(top, H)));
      expect(t({ 'b-h': tall(32.5), 'b-l': tall(32.5), 's-h': tall(32.5), 's-l': tall(32.5) })).toEqual([]);
      const topped = facts([...quad(-0.06, 0.06, -H, H, H, onStrip(32.5, H)), ...quad(0.1, 0.2, H - 0.06, H, H, onStrip(2912.5, H))]);
      expect(t({ 'b-h': tall(32.5), 'b-l': tall(32.5), 's-h': topped, 's-l': topped })).toEqual(['warn trim:T8']);
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
    expect(voxelKitMeshKey({ assetId: 'a', digest: D(3), node: 'Body' })).toBe(`a@${D(3)}#Body`);
  });
});
