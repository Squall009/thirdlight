/**
 * The expansion kept across edits (project-model): an object's outlines
 * expand per group (a building with its rooms, rooms sharing walls, a run),
 * each group remembered by its own inputs, so an edit expands only the
 * groups it touches and keys only the chunks their elements reach. What it
 * makes is what a whole expansion makes (every outline expanded as one
 * group, nothing remembered: the same elements, rooms and chunk keys). With TL_PERF=1 an edit in a furnished village, a shared
 * wall dragged on a painted layer and the chunks' cost are timed.
 * Browser-free; the page's preview and drag are in the layered-material e2e.
 */
import { describe, expect, it } from 'vitest';

import { ARCHITECTURE_PART_WEIGHT_MAX, architectureChunkInput, architectureChunkKeys, generateArchitectureChunk, joinArchitectureChunkParts, type ArchitectureChunk } from '../packages/project-model/src/arch-generate';
import { architectureOutlineGroups } from '../packages/project-model/src/arch-groups';
import { architecturePaintOf } from '../packages/project-model/src/arch-room-grid';
import { expandArchitecture, expandArchitectureUngrouped } from '../packages/project-model/src/arch-rooms';
import { architectureStylesOf, type ArchitectureExpansion, type ArchitectureStyles } from '../packages/project-model/src/arch-style';
import type { ArchitectureBuilding, ArchitectureComponent, ArchitectureOutline, ArchitecturePaint } from '../packages/project-model/src/architecture';
import { encodeWallPaint, wallPaintSteps, wallPointKey } from '../packages/project-model/src/block-wall-paint';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';

import { building, graphs, L_SHAPE } from './arch-plan-fixtures';

const SHEETS = { '*': defaultTrimSheet() };
const ORIGIN = [0, 0, 0];
const fresh = (): ArchitectureStyles => architectureStylesOf(graphs({ upper: true, stairs: true, lights: 4 }));

/** 64 furnished two-storey L houses, 20 m apart. */
function village(): ArchitectureBuilding[] {
  const out: ArchitectureBuilding[] = [];
  for (let i = 0; i < 64; i++) {
    const [ox, oz] = [(i % 8) * 20, Math.floor(i / 8) * 20];
    out.push({ ...building(L_SHAPE.map(([x, z]) => [x + ox, z + oz] as [number, number]), { id: `h${i}`, storeys: 2, storeyHeight: 3, layoutSeed: i, furnishing: 'test-furnishing' }), openings: [{ id: 'front', at: 3, width: 1, bottom: 0, top: 2.1 }] });
  }
  return out;
}

const box = (x0: number, z0: number, x1: number, z1: number): [number, number, number][] => [
  [x0, 0, z0],
  [x1, 0, z0],
  [x1, 0, z1],
  [x0, 0, z1],
];

/** An 8 × 8 grid of 4 m rooms sharing walls (32 × 32 m), a door in each room's first wall; the wall x = `wall` between rooms (3, 3) and (4, 3) moved. */
function roomGrid(wall = 16): ArchitectureOutline[] {
  const out: ArchitectureOutline[] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let [x0, x1] = [i * 4, i * 4 + 4];
      if (j === 3 && i === 3) x1 = wall;
      if (j === 3 && i === 4) x0 = wall;
      out.push({ id: `r${i}-${j}`, preset: 'starter-room', path: { points: box(x0, j * 4, x1, j * 4 + 4), closed: true }, openings: [{ id: 'door', at: 2, width: 1, bottom: 0, top: 2.1 }] });
    }
  }
  return out;
}

/** Wall paint on every wall point of a 32 × 32 cell layer (1 m cells), rows 0-3. */
function paintEverywhere(): ArchitecturePaint {
  const st = wallPaintSteps([1, 1, 1]);
  const chunks: { cx: number; cz: number; wallPaint: string }[] = [];
  for (let cx = 0; cx < 2; cx++) {
    for (let cz = 0; cz < 2; cz++) {
      const points = new Map<number, Uint8Array>();
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let side = 0; side < 4; side++) for (let j = 0; j <= st.along; j++) for (let k = 0; k <= 3 * st.up; k++) points.set(wallPointKey(x, z, side, j, k), Uint8Array.from([0, (x * 7 + z * 3 + k) % 200, 120, 0, 80]));
      chunks.push({ cx, cz, wallPaint: encodeWallPaint(points)! });
    }
  }
  return architecturePaintOf({ cellSize: [1, 1, 1], wallPaint: true }, chunks, ORIGIN, ORIGIN)!;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const worst = (xs: number[]): number => Math.max(...xs);

/** Expand and key, as the page does at an edit; the keys that changed against `before`. */
function pageStep(c: ArchitectureComponent, table: ArchitectureStyles, before: Map<string, { key: string }> | null, paint: ArchitecturePaint | null = null): { component: ArchitectureComponent; keys: ReturnType<typeof architectureChunkKeys>; changed: string[]; expandMs: number } {
  const t0 = performance.now();
  const component = expandArchitecture(c, ORIGIN, table, { paint }).component;
  const expandMs = performance.now() - t0;
  const keys = architectureChunkKeys(component, SHEETS);
  const changed = before === null ? [...keys.keys()] : [...keys].filter(([k, v]) => before.get(k)?.key !== v.key).map(([k]) => k);
  return { component, keys, changed, expandMs };
}

/** An expansion as sets (groups put their elements and rooms in group order, the ungrouped expansion in its own). */
function asSets(x: ArchitectureExpansion): unknown {
  const sorted = (xs: readonly unknown[] | undefined): string[] => (xs ?? []).map((v) => JSON.stringify(v)).sort();
  const byKey = (o: Readonly<Record<string, unknown>> | undefined): [string, string][] => Object.entries(o ?? {}).map(([k, v]): [string, string] => [k, JSON.stringify(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { elements, profiles, ...rest } = x.component;
  return { rest: JSON.stringify(rest), elements: sorted(elements), profiles: byKey(profiles), materials: byKey(x.materials), problems: [...x.problems].sort(), presets: [...x.presets].sort(), rooms: sorted(x.rooms), props: sorted(x.props), lights: sorted(x.lights), planRooms: sorted(x.planRooms), swapped: x.swapped === true };
}

/** A chunk's bytes, every array (to compare two makings). */
function bytesOfChunk(c: ArchitectureChunk): string {
  const parts: string[] = [`${c.cx},${c.cz}`, c.problems.join('|')];
  for (const m of c.meshes) parts.push(m.material, ...[m.mesh.positions, m.mesh.normals, m.mesh.uvs, m.mesh.colors, m.mesh.indices, m.mesh.farIndices].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')));
  for (const s of c.copies) parts.push(JSON.stringify(s.model), String(s.collide), s.ids.join(','), Buffer.from(s.transforms.buffer, s.transforms.byteOffset, s.transforms.byteLength).toString('base64'));
  return parts.join('\n');
}

describe('architecture expansion across edits', () => {
  it('groups outlines that meet: rooms sharing walls, a building and its rooms; apart ones alone', () => {
    const room = (id: string, x0: number, x1: number, extra: Partial<ArchitectureOutline> = {}): ArchitectureOutline => ({ id, preset: 'starter-room', path: { points: box(x0, 0, x1, 4), closed: true }, ...extra });
    const run: ArchitectureOutline = { id: 'fence', preset: 'starter-rail', path: { points: [[0, 0, 10], [4, 0, 10]] } };
    const list = [room('a', 0, 4), room('far', 40, 44), run, room('b', 4, 8), room('in', 101, 103, { building: 'house' }), room('house', 100, 110)];
    expect(architectureOutlineGroups(list, [false, false, false, false, false, true])).toEqual([[0, 3], [1], [2], [4, 5]]);
  });

  it('an edit expands only the groups it changed; the rest keep their elements; it all equals a whole expansion with nothing remembered', () => {
    const houses = village();
    const table = fresh();
    const c0: ArchitectureComponent = { elements: [], buildings: houses, chunkSize: 16 };
    const before = expandArchitecture(c0, ORIGIN, table);
    const edited: ArchitectureComponent = { ...c0, buildings: houses.map((b, i) => (i === 27 ? { ...b, layoutSeed: 999, openings: [{ id: 'front', at: 4, width: 1.2, bottom: 0, top: 2.1 }] } : b)) };
    const after = expandArchitecture(edited, ORIGIN, table);
    // Grouped and remembered against every outline expanded together with nothing remembered.
    expect(asSets(after)).toEqual(asSets(expandArchitectureUngrouped(edited, ORIGIN, fresh())));
    // And against the same grouping with nothing remembered, in order: chunk keys hash their elements in order.
    const whole = expandArchitecture(edited, ORIGIN, fresh());
    expect(JSON.stringify(after)).toBe(JSON.stringify(whole));
    // Other houses' elements are the very objects made before; the edited house's are new.
    const kept = new Set(before.component.elements);
    const fresh27 = after.component.elements.filter((e) => !kept.has(e));
    expect(fresh27.length).toBeGreaterThan(0);
    expect(fresh27.every((e) => e.id.startsWith('h27'))).toBe(true);
    // The same keys as a whole keying, and only the edited house's chunks changed.
    const kAfter = architectureChunkKeys(after.component, SHEETS);
    const kWhole = architectureChunkKeys(JSON.parse(JSON.stringify(whole.component)) as ArchitectureComponent, SHEETS);
    expect([...kAfter].map(([k, v]) => [k, v.key, v.parts?.map((p) => p.key)])).toEqual([...kWhole].map(([k, v]) => [k, v.key, v.parts?.map((p) => p.key)]));
    const kBefore = architectureChunkKeys(before.component, SHEETS);
    const changed = [...kAfter].filter(([k, v]) => kBefore.get(k)?.key !== v.key).map(([k]) => k);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(4);
  });

  it('a shared wall dragged on a painted layer, a preview and a swap: the remembered expansion equals a whole one', () => {
    const table = architectureStylesOf([]);
    const paint = paintEverywhere();
    for (const wall of [16, 16.5, 17, 16]) {
      const c: ArchitectureComponent = { elements: [], outlines: roomGrid(wall), chunkSize: 16 };
      expect(asSets(expandArchitecture(c, ORIGIN, table, { paint }))).toEqual(asSets(expandArchitectureUngrouped(c, ORIGIN, architectureStylesOf([]), { paint })));
    }
    const c: ArchitectureComponent = { elements: [], outlines: [...roomGrid(), { id: 'apart', preset: 'starter-hall', path: { points: box(60, 0, 66, 6), closed: true } }] };
    const preview = { preset: 'starter-hall', values: { wall_thickness: 0.4 } };
    for (const opts of [{ preview }, {}, { swaps: { 'starter-room': 'starter-room-tall' } }, { preview }]) {
      expect(asSets(expandArchitecture(c, ORIGIN, table, opts))).toEqual(asSets(expandArchitectureUngrouped(c, ORIGIN, architectureStylesOf([]), opts)));
    }
  });

  it('a heavy chunk is made in parts: joined, the bytes of the chunk made whole; a wall drag re-keys only some parts', () => {
    const table = architectureStylesOf([]);
    const paint = paintEverywhere();
    const c = expandArchitecture({ elements: [], outlines: roomGrid(), chunkSize: 16 }, ORIGIN, table, { paint }).component;
    const keys = architectureChunkKeys(c, SHEETS);
    const heavy = [...keys.values()].filter((k) => k.parts !== undefined);
    expect(heavy.length).toBeGreaterThan(0);
    for (const k of heavy) {
      const parts = k.parts!;
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.flatMap((p) => p.elements)).toEqual(k.elements);
      const whole = generateArchitectureChunk(architectureChunkInput(c, k), SHEETS, k.cx, k.cz);
      const joined = joinArchitectureChunkParts(parts.map((p) => generateArchitectureChunk(architectureChunkInput(c, { ...p, cx: k.cx, cz: k.cz }), SHEETS, k.cx, k.cz)));
      expect(bytesOfChunk(joined)).toBe(bytesOfChunk(whole));
    }
    expect(ARCHITECTURE_PART_WEIGHT_MAX).toBeGreaterThan(0);
    const moved = architectureChunkKeys(expandArchitecture({ elements: [], outlines: roomGrid(16.5), chunkSize: 16 }, ORIGIN, table, { paint }).component, SHEETS);
    let kept = 0;
    let all = 0;
    for (const [ck, k] of moved) {
      const was = new Set(keys.get(ck)?.parts?.map((p) => p.key) ?? []);
      for (const p of k.parts ?? []) {
        all++;
        if (was.has(p.key)) kept++;
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(all);
  });

  it.runIf(process.env['TL_PERF'] === '1')('times an edit in a furnished village, a shared wall dragged and the jobs it sends', () => {
    // A village of 64 furnished houses: one house's layout seed changed per edit (the page's expand and keys, then its jobs).
    const houses = village();
    const table = fresh();
    let prev = pageStep({ elements: [], buildings: houses, chunkSize: 16 }, table, null);
    const made = new Set<string>();
    makeJobs(prev, made);
    const page: number[] = [];
    const expandOnly: number[] = [];
    const jobs: number[] = [];
    const lanes: number[] = [];
    for (let k = 0; k < 11; k++) {
      const edited = houses.map((b, i) => (i === 27 ? { ...b, layoutSeed: 1000 + k } : b));
      const t0 = performance.now();
      const step = pageStep({ elements: [], buildings: edited, chunkSize: 16 }, table, prev.keys);
      page.push(performance.now() - t0);
      expandOnly.push(step.expandMs);
      const j = makeJobs(step, made);
      jobs.push(...j.times);
      lanes.push(j.twoWorkers);
      prev = step;
    }
    const cold: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      pageStep({ elements: [], buildings: houses, chunkSize: 16 }, fresh(), null);
      cold.push(performance.now() - t0);
    }
    console.log(`[perf] village of 64 furnished houses (16 m chunks): one house edited, page (expand + keys) ${median(page).toFixed(1)} ms median / ${worst(page).toFixed(1)} worst (expand ${median(expandOnly).toFixed(1)}); its jobs ${median(jobs).toFixed(2)} ms median / ${worst(jobs).toFixed(2)} worst, on 2 workers ${median(lanes).toFixed(1)} ms; a new table (nothing remembered) ${median(cold).toFixed(1)} ms`);

    // 64 rooms sharing walls, a shared wall dragged in 0.25 m steps: the page's expand + keys, then its jobs; unpainted and painted.
    for (const paint of [null, paintEverywhere()]) {
      const t = architectureStylesOf([]);
      let before = pageStep({ elements: [], outlines: roomGrid(), chunkSize: 16 }, t, null, paint);
      const seen = new Set<string>();
      const all = makeJobs(before, seen).times;
      const pageMs: number[] = [];
      const expandMs: number[] = [];
      const serial: number[] = [];
      const two: number[] = [];
      const stepJobs: number[] = [];
      let n = 0;
      for (let k = 1; k <= 8; k++) {
        const wall = 16 + (k % 2 === 1 ? 0.25 * k : -0.25 * k);
        const t0 = performance.now();
        const step = pageStep({ elements: [], outlines: roomGrid(wall), chunkSize: 16 }, t, before.keys, paint);
        const t1 = performance.now();
        const j = makeJobs(step, seen);
        pageMs.push(t1 - t0);
        expandMs.push(step.expandMs);
        serial.push(t1 - t0 + j.serial);
        two.push(t1 - t0 + j.twoWorkers);
        stepJobs.push(...j.times);
        n = j.times.length;
        before = step;
      }
      console.log(`[perf] 64 rooms sharing walls${paint !== null ? ', painted everywhere' : ''}: a shared wall dragged, page ${median(pageMs).toFixed(1)} ms (expand ${median(expandMs).toFixed(1)}), then ${n} jobs (${median(stepJobs).toFixed(2)} ms median / ${worst(stepJobs).toFixed(2)} worst): serially ${median(serial).toFixed(1)} ms median / ${worst(serial).toFixed(1)} worst, on 2 workers ${median(two).toFixed(1)} / ${worst(two).toFixed(1)}; all jobs at load ${median(all).toFixed(2)} ms median / ${worst(all).toFixed(2)} worst (${all.length})`);
    }
  });
});

/**
 * The jobs the page sends after keying (as `architecture-view.ts` does): each
 * part or whole chunk whose key it has not made, then the parts joined. Times
 * per job, serially, and on two workers (each job to the less busy one).
 */
function makeJobs(step: ReturnType<typeof pageStep>, made: Set<string>): { times: number[]; serial: number; twoWorkers: number } {
  const times: number[] = [];
  const lanes = [0, 0];
  let joins = 0;
  const run = (elements: number[], cx: number, cz: number): ArchitectureChunk => {
    const t0 = performance.now();
    const chunk = generateArchitectureChunk(architectureChunkInput(step.component, { elements, cx, cz }), SHEETS, cx, cz);
    const ms = performance.now() - t0;
    times.push(ms);
    const lane = lanes[0]! <= lanes[1]! ? 0 : 1;
    lanes[lane] = lanes[lane]! + ms;
    return chunk;
  };
  for (const k of step.keys.values()) {
    if (made.has(k.key)) continue;
    made.add(k.key);
    if (k.parts === undefined) {
      run(k.elements, k.cx, k.cz);
      continue;
    }
    const parts = k.parts.filter((p) => !made.has(p.key)).map((p) => {
      made.add(p.key);
      return run(p.elements, k.cx, k.cz);
    });
    const t0 = performance.now();
    joinArchitectureChunkParts(parts);
    joins += performance.now() - t0;
  }
  return { times, serial: times.reduce((a, b) => a + b, 0) + joins, twoWorkers: Math.max(lanes[0]!, lanes[1]!) + joins };
}
