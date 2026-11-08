import { describe, expect, it } from 'vitest';
import { sectionGrid } from './coords';
import { reliefNeighbourBit } from './relief-mesh';
import { DEFAULT_RELIEF_RADIUS_CELLS, RELIEF_HYSTERESIS_CELLS, reliefFade, ReliefRing, sectionHalfDiagonal, type SectionCoord } from './relief-ring';

const g = sectionGrid(16);
const H = sectionHalfDiagonal(16);
const centre = (c: SectionCoord): [number, number, number] => [(c.sx + 0.5) * 16, (c.sy + 0.5) * 16, (c.sz + 0.5) * 16];
const dist = (c: SectionCoord, f: { x: number; y: number; z: number }): number => {
  const [x, y, z] = centre(c);
  return Math.hypot(x - f.x, y - f.y, z - f.z);
};
const keyOf = (c: SectionCoord): string => `${c.sx},${c.sy},${c.sz}`;

describe('the relief ring', () => {
  it('holds the sections whose centre lies within the radius and a half diagonal, displacing to the radius', () => {
    const ring = new ReliefRing(g);
    ring.set({ n: 2, radius: DEFAULT_RELIEF_RADIUS_CELLS });
    const f = { x: 3, y: 70, z: -5 };
    const changed = ring.plan(f)!;
    expect(changed.length).toBe(ring.size);
    expect(ring.size).toBeGreaterThan(8);
    for (const c of ring.list()) expect(dist(c, f)).toBeLessThanOrEqual(DEFAULT_RELIEF_RADIUS_CELLS + H);
    // Every point within the radius belongs to a relief section.
    for (let k = 0; k < 2000; k++) {
      const r = DEFAULT_RELIEF_RADIUS_CELLS * Math.cbrt(((k * 7919) % 1000) / 1000);
      const t = (k * 2.399) % (2 * Math.PI);
      const p = Math.acos(1 - (2 * ((k * 104729) % 997)) / 997);
      const x = f.x + r * Math.sin(p) * Math.cos(t);
      const y = f.y + r * Math.cos(p);
      const z = f.z + r * Math.sin(p) * Math.sin(t);
      expect(ring.has(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)), `${x},${y},${z}`).toBe(true);
    }
    expect(ring.displaceRadius).toBe(DEFAULT_RELIEF_RADIUS_CELLS);
    expect(reliefFade(ring.displaceRadius)).toEqual({ start: DEFAULT_RELIEF_RADIUS_CELLS - 8, end: DEFAULT_RELIEF_RADIUS_CELLS });
    // n 0: no relief anywhere.
    ring.set({ n: 0, radius: DEFAULT_RELIEF_RADIUS_CELLS });
    expect(ring.plan(f)!.length).toBeGreaterThan(8);
    expect(ring.size).toBe(0);
    expect(ring.displaceRadius).toBe(0);
  });

  it('plans again only when the focus moves a cell, and keeps a section until it is past the hysteresis', () => {
    const ring = new ReliefRing(g);
    ring.set({ n: 4, radius: 24 });
    const f = { x: 0, y: 0, z: 0 };
    ring.plan(f);
    expect(ring.plan({ x: 0.5, y: 0, z: 0.4 })).toBeNull();
    const before = new Set([...ring.list()].map(keyOf));
    // A step that takes some sections just past the join distance but not past the hysteresis keeps them all.
    const step = { x: RELIEF_HYSTERESIS_CELLS - 1, y: 0, z: 0 };
    const changed = ring.plan(step)!;
    for (const c of changed) expect(before.has(keyOf(c)), `${keyOf(c)} left within the hysteresis`).toBe(false);
    for (const c of ring.list()) expect(dist(c, step)).toBeLessThanOrEqual(24 + H + RELIEF_HYSTERESIS_CELLS);
    // Far away, everything changes: the old sections go, new ones join.
    const was = ring.size;
    const far = ring.plan({ x: 400, y: 0, z: 0 })!;
    expect(far.length).toBe(was + ring.size);
    for (const c of ring.list()) expect(dist(c, { x: 400, y: 0, z: 0 })).toBeLessThanOrEqual(24 + H);
  });

  it('asks each relief section to keep its edges whole toward its plain neighbours, and names the relief neighbours of a change', () => {
    const ring = new ReliefRing(g);
    ring.set({ n: 2, radius: 8 });
    ring.plan({ x: 8, y: 8, z: 8 });
    let border = 0;
    for (const c of ring.list()) {
      const o = ring.optionsFor(c.sx, c.sy, c.sz)!;
      expect(o.n).toBe(2);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const plain = !ring.has(c.sx + dx, c.sy + dy, c.sz + dz);
        expect((o.plainNeighbours! & reliefNeighbourBit(dx, dy, dz)) !== 0).toBe(plain);
        if (plain) border++;
      }
    }
    expect(border).toBeGreaterThan(0);
    expect(ring.optionsFor(40, 0, 0)).toBeNull();
    // A section that changed: itself and every relief section round it.
    const changed = { sx: 2, sy: 0, sz: 0 };
    const out = new Set(ring.affected([changed]).map(keyOf));
    expect(out.has(keyOf(changed))).toBe(true);
    for (const c of ring.list()) {
      const near = Math.max(Math.abs(c.sx - 2), Math.abs(c.sy), Math.abs(c.sz)) <= 1;
      expect(out.has(keyOf(c)), keyOf(c)).toBe(near);
    }
  });

  it('shrinks to its budget share, farthest first, displacing only inside what it keeps, and grows back a section edge on', () => {
    const ring = new ReliefRing(g);
    ring.set({ n: 4, radius: 48 });
    const f = { x: 0, y: 0, z: 0 };
    ring.plan(f);
    const all = [...ring.list()];
    const bytes = (): number => 1000;
    expect(ring.fit(all.length * 1000, bytes)).toBeNull();
    const share = (all.length * 1000) / 3;
    const dropped = ring.fit(share, bytes)!;
    expect(ring.size * 1000).toBeLessThanOrEqual(share);
    expect(dropped.length + ring.size).toBe(all.length);
    const kept = [...ring.list()];
    const nearestDropped = Math.min(...dropped.map((c) => dist(c, f)));
    for (const c of kept) expect(dist(c, f)).toBeLessThan(nearestDropped);
    // Nothing displaced past the sections it keeps.
    expect(ring.displaceRadius).toBeLessThan(48);
    expect(ring.displaceRadius + H).toBeLessThanOrEqual(nearestDropped);
    expect(ring.state().shrunk).toBe(true);
    // Moving less than a section edge, sections join only nearer than the nearest dropped one.
    const moved = { x: 5, y: 0, z: 0 };
    ring.plan(moved);
    const keptKeys = new Set(kept.map(keyOf));
    for (const c of ring.list()) if (!keptKeys.has(keyOf(c))) expect(dist(c, moved), keyOf(c)).toBeLessThan(nearestDropped);
    // A section edge on, the full radius again.
    ring.plan({ x: 16, y: 0, z: 0 });
    expect(ring.state().shrunk).toBe(false);
    expect(ring.displaceRadius).toBe(48);
  });

  it('meshes every section again when the lattice step changes', () => {
    const ring = new ReliefRing(g);
    ring.set({ n: 2, radius: 16 });
    ring.plan({ x: 0, y: 0, z: 0 });
    const before = ring.size;
    expect(ring.set({ n: 2, radius: 16 })).toBe(false);
    expect(ring.set({ n: 4, radius: 16 })).toBe(true);
    expect(ring.plan({ x: 0, y: 0, z: 0 })!.length).toBe(before);
    expect(() => ring.set({ n: 3, radius: 16 })).toThrow(/n 3/);
  });
});
