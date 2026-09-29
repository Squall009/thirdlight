/**
 * The generic primitives on their own (a fake host: transforms,
 * hierarchy, counters, signals, a scripted ray port) — health on any object,
 * collectibles, waypoint and edge patrols, hitbox contacts and their normals,
 * the script controls, a new run, and the `components` save section.
 */
import { describe, expect, it } from 'vitest';

import { contactNormal, Primitives, type PrimitivesHost } from './primitives';
import type { PhysicsPort, TransformState } from './index';

type V = [number, number, number];

function fakeHost(dimension: 2 | 3, opts: { character?: V | null; parents?: Record<string, string>; physics?: PhysicsPort } = {}) {
  const curr = new Map<string, TransformState>();
  const counters: Record<string, number> = {};
  const signals: string[] = [];
  const hidden = new Set<string>();
  const parents = opts.parents ?? {};
  let character: V | null = opts.character ?? null;
  const host: PrimitivesHost = {
    hz: 120,
    dimension,
    curr,
    physics: opts.physics,
    physics3d: undefined,
    character: () => (character === null ? null : { id: 'actor', centre: [...character] as V, half: [0.3, 0.9, 0.3] }),
    worldOf: (id) => {
      const t = curr.get(id);
      if (t === undefined) return null;
      const out: V = [t.position[0], t.position[1], t.position[2]];
      for (let p = parents[id]; p !== undefined; p = parents[p]) {
        const pt = curr.get(p)!;
        out[0] += pt.position[0];
        out[1] += pt.position[1];
        out[2] += pt.position[2];
      }
      return out;
    },
    parentOf: (id) => parents[id],
    setHidden: (id, h) => void (h ? hidden.add(id) : hidden.delete(id)),
    addCounter: (name, d) => void (counters[name] = (counters[name] ?? 0) + d),
    emit: (s) => void signals.push(s),
  };
  const place = (id: string, position: V): void => void curr.set(id, { position: [...position], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return { host, curr, counters, signals, hidden, place, moveCharacter: (p: V | null) => void (character = p) };
}

/** One fixed step: last step's events turn over, then the primitives run. */
function step(p: Primitives, i: number, playing = true): void {
  p.turnover(i);
  p.afterPhysics(playing);
}

describe('contact normals', () => {
  const box = (c: V, h: V) => ({ c, half: h, r: 0 });
  const ball = (c: V, r: number) => ({ c, half: null, r });
  it('boxes: the axis they were apart along before (a fall from above), else the shallowest overlap', () => {
    // b falls onto a from above: apart in y the step before, overlapping in both x and y now (x deeper).
    expect(contactNormal(box([0, 0, 0], [1, 0.5, 1]), box([0.2, 0.9, 0], [0.3, 0.5, 0.3]), [0, 0, 0], [0.2, 1.2, 0], 2)).toEqual([0, 1, 0]);
    // No history: the shallowest overlap (x here).
    expect(contactNormal(box([0, 0, 0], [0.5, 0.5, 0.5]), box([0.9, 0.2, 0], [0.5, 0.5, 0.5]), undefined, undefined, 2)).toEqual([1, 0, 0]);
    // A touch is not a contact.
    expect(contactNormal(box([0, 0, 0], [0.5, 0.5, 0.5]), box([1, 0, 0], [0.5, 0.5, 0.5]), undefined, undefined, 2)).toBeNull();
    // 3D: along z; the 2D plane ignores z.
    expect(contactNormal(box([0, 0, 0], [0.5, 0.5, 0.5]), box([0, 0, -0.8], [0.5, 0.5, 0.5]), undefined, undefined, 3)).toEqual([0, 0, -1]);
    expect(contactNormal(box([0, 0, 0], [0.5, 0.5, 0.5]), box([0, 0, -5], [0.5, 0.5, 0.5]), undefined, undefined, 2)).toEqual([1, 0, 0]);
    expect(contactNormal(box([0, 0, 0], [0.5, 0.5, 0.5]), box([0, 0, -5], [0.5, 0.5, 0.5]), undefined, undefined, 3)).toBeNull();
  });
  it('spheres and a box with a sphere: along the line between the closest points', () => {
    const n = contactNormal(ball([0, 0, 0], 1), ball([0.6, 0.8, 0], 0.5), undefined, undefined, 2)!;
    expect(n[0]).toBeCloseTo(0.6, 12);
    expect(n[1]).toBeCloseTo(0.8, 12);
    expect(contactNormal(ball([0, 0, 0], 0.5), ball([1, 0, 0], 0.5), undefined, undefined, 2)).toBeNull();
    // A sphere above a box's top face: straight up from the box, straight down from the sphere.
    expect(contactNormal(box([0, 0, 0], [1, 0.5, 1]), ball([0.3, 0.8, 0], 0.4), undefined, undefined, 3)).toEqual([0, 1, 0]);
    expect(contactNormal(ball([0.3, 0.8, 0], 0.4), box([0, 0, 0], [1, 0.5, 1]), undefined, undefined, 3)?.map((x) => x + 0)).toEqual([0, -1, 0]);
  });
});

describe('health on any object', () => {
  it('damage and heal clamp to 0..max, report damaged/healed/died next step, and name the source', () => {
    const f = fakeHost(2);
    const p = new Primitives(f.host);
    f.place('crate', [0, 0, 0]);
    p.add('crate', { health: { max: 5, start: 4 } }, [0, 0, 0]);
    step(p, 1);
    expect(p.healthOf('crate')).toEqual({ current: 4, max: 5 });
    expect(p.heal('crate', 3)).toBe(true);
    expect(p.healthOf('crate')).toEqual({ current: 5, max: 5 });
    expect(p.heal('crate', 1)).toBe(false); // at its maximum
    expect(p.damage('crate', 2.5, 'lamp')).toBe(true);
    expect(p.damage('crate', 0)).toBe(false);
    expect(p.damage('crate', Number.NaN)).toBe(false);
    expect(p.damage('nothing', 1)).toBe(false);
    expect(p.events()).toEqual([]); // seen next step
    step(p, 2);
    expect(p.events()).toEqual([
      { type: 'healed', entity: 'crate', amount: 1, current: 5, source: '', stepIndex: 0 },
      { type: 'damaged', entity: 'crate', amount: 2.5, current: 2.5, source: 'lamp', stepIndex: 0 },
    ]);
    expect(p.damage('crate', 10, 'fall')).toBe(true);
    expect(p.damage('crate', 1)).toBe(false); // already at 0
    step(p, 3);
    expect(p.healthEvents().map((e) => [e.type, e.amount, e.current])).toEqual([
      ['damaged', 2.5, 0],
      ['died', 0, 0],
    ]);
    // Nothing else happens at 0 (no rule); healing brings it back; a new run starts it over.
    expect(p.heal('crate', 1)).toBe(true);
    p.resetRun();
    expect(p.healthOf('crate')).toEqual({ current: 4, max: 5 });
  });
});

describe('collectibles', () => {
  it('add their amount to a named counter once, hide, signal, and come back after their respawn time', () => {
    const f = fakeHost(2, { character: [5, 0, 0] });
    const p = new Primitives(f.host);
    f.place('token', [0, 0, 0]);
    f.place('plain', [20, 0, 0]);
    p.add('token', { collectible: { counter: 'parts', amount: 3, respawn: 0.5, onCollect: 'got', size: [1, 1] } }, [0, 0, 0]);
    p.add('plain', { collectible: { counter: 'misc' } }, [20, 0, 0]);
    step(p, 1);
    expect(f.counters).toEqual({});
    f.moveCharacter([0.5, 0.2, 0]);
    step(p, 2);
    step(p, 3);
    expect(f.counters).toEqual({ parts: 3 });
    expect(f.signals).toEqual(['got']);
    expect(f.hidden.has('token')).toBe(true);
    expect(p.isCollected('token')).toBe(true);
    expect(p.events()).toEqual([{ type: 'collected', entity: 'token', counter: 'parts', amount: 3, by: 'actor', stepIndex: 1 }]);
    f.moveCharacter(null);
    for (let i = 4; i < 4 + 60; i++) step(p, i);
    expect(p.isCollected('token')).toBe(false);
    expect(f.hidden.has('token')).toBe(false);
    // No respawn time: gone until a script restores it (or a new run).
    f.moveCharacter([20, 0, 0]);
    step(p, 100);
    expect(f.counters['misc']).toBe(1);
    for (let i = 101; i < 400; i++) step(p, i);
    expect(p.isCollected('plain')).toBe(true);
    f.moveCharacter(null);
    expect(p.restore('plain')).toBe(true);
    expect(p.restore('plain')).toBe(false);
    expect(f.hidden.has('plain')).toBe(false);
  });
  it('are not collected while the character does not play, and a 3D area uses its depth', () => {
    const f = fakeHost(3, { character: [0, 0, 1.2] });
    const p = new Primitives(f.host);
    f.place('token', [0, 0, 0]);
    p.add('token', { collectible: { counter: 'parts', size: [1, 1, 2] } }, [0, 0, 0]);
    step(p, 1, false);
    expect(f.counters).toEqual({});
    step(p, 2);
    expect(f.counters).toEqual({ parts: 1 }); // 1.2 < 1 + 0.3
    const g = fakeHost(3, { character: [0, 0, 1.2] });
    const q = new Primitives(g.host);
    g.place('token', [0, 0, 0]);
    q.add('token', { collectible: { counter: 'parts', size: [1, 1] } }, [0, 0, 0]); // depth = width: 0.5 + 0.3 < 1.2
    step(q, 1);
    expect(g.counters).toEqual({});
  });
});

describe('patrols', () => {
  it('waypoints: back and forth along the path, a turned event at each end; stop, turn, and a new run', () => {
    const f = fakeHost(3);
    const p = new Primitives(f.host);
    f.place('rover', [1, 0, 2]);
    p.add('rover', { patrol: { mode: 'waypoints', waypoints: [[0, 0, 1]], speed: 1.2 } }, [1, 0, 2]);
    for (let i = 1; i <= 100; i++) step(p, i);
    expect(f.curr.get('rover')!.position).toEqual([1, 0, 3]); // 1 m at 1.2 m/s: there after 100 steps, turning
    step(p, 101);
    expect(p.events()).toEqual([{ type: 'turned', entity: 'rover', reason: 'end', direction: [0, 0, -1], stepIndex: 99 }]);
    expect(p.patrolOf('rover')).toEqual({ direction: [0, 0, -1], active: true });
    step(p, 102);
    const z = f.curr.get('rover')!.position[2];
    expect(p.setPatrolActive('rover', false)).toBe(true);
    for (let i = 103; i < 120; i++) step(p, i);
    expect(f.curr.get('rover')!.position[2]).toBe(z);
    expect(p.turnPatrol('rover')).toBe(true);
    expect(p.patrolOf('rover')).toEqual({ direction: [0, 0, 1], active: false });
    p.resetRun();
    expect(f.curr.get('rover')!.position).toEqual([1, 0, 2]);
    expect(p.patrolOf('rover')?.active).toBe(true);
    // A loop only goes forward.
    p.add('ring', { patrol: { mode: 'waypoints', waypoints: [[1, 0, 0], [1, 1, 0]], loop: true, speed: 1 } }, [0, 0, 0]);
    expect(p.turnPatrol('ring')).toBe(false);
  });
  it('edges (2D): turns at a wall ahead and at a missing floor, waits, never probes without physics', () => {
    // A floor from x = -3 to 3 (top at y = 0) and a wall face at x = 2 for y above 0.
    const rays: string[] = [];
    const physics = {
      raycast(o: { x: number; y: number }, d: { x: number; y: number }, max: number) {
        rays.push(`${o.x.toFixed(2)},${o.y.toFixed(2)}>${d.x},${d.y}`);
        if (d.y < 0) return o.x > -3 && o.x < 3 && o.y >= 0 && o.y - max <= 0 ? { entityId: 'floor', distance: o.y, normal: { x: 0, y: 1 } } : null;
        if (d.x > 0 && o.y > 0 && o.x < 2 && o.x + max >= 2) return { entityId: 'wall', distance: 2 - o.x, normal: { x: -1, y: 0 } };
        return null;
      },
    } as unknown as PhysicsPort;
    const f = fakeHost(2, { physics });
    const p = new Primitives(f.host);
    f.place('walker', [0, 0.5, 0]);
    p.add('walker', { patrol: { mode: 'edges', speed: 3, wait: 0.05, size: [1, 1] } }, [0, 0.5, 0]);
    const turns: string[] = [];
    for (let i = 1; i < 400; i++) {
      step(p, i);
      for (const e of p.events()) if (e.type === 'turned') turns.push(`${e.reason}:${e.direction[0]}@${Math.round(f.curr.get('walker')!.position[0] * 100) / 100}`);
    }
    // Wall: the ray from its centre reaches 0.5 + 0.025 + 0.05 m (half its width, one step, the probe), so it turns
    // within a step of x = 1.425. Ledge: the floor ray starts 0.55 m ahead, so it turns within a step of x = -2.45.
    expect(turns.slice(0, 3)).toEqual(['wall:-1@1.45', 'ledge:1@-2.47', 'wall:-1@1.45']);
    expect(rays.some((r) => r.endsWith('>0,-1'))).toBe(true);
    // Without a physics port it just walks.
    const g = fakeHost(2);
    const q = new Primitives(g.host);
    g.place('walker', [0, 0.5, 0]);
    q.add('walker', { patrol: { mode: 'edges', speed: 1.2, direction: [-0.2, 0, 0] } }, [0, 0.5, 0]);
    for (let i = 1; i <= 100; i++) step(q, i);
    expect(g.curr.get('walker')!.position[0]).toBeCloseTo(-1, 9);
  });
});

describe('hitbox contacts', () => {
  it('both sides get contact (with opposite normals) and separate; damage goes to the other side or its nearest parent with health', () => {
    const f = fakeHost(2, { parents: { arm: 'body' } });
    const p = new Primitives(f.host);
    f.place('body', [0, 0, 0]);
    f.place('arm', [1, 0, 0]); // at x = 1 under the body
    f.place('ball', [3, 0, 0]);
    p.add('body', { health: { max: 5 }, hitbox: { size: [1, 2] } }, [0, 0, 0]);
    p.add('arm', { hitbox: { size: [1, 0.2], damage: 2 } }, [1, 0, 0]);
    p.add('ball', { health: { max: 3 }, hitbox: { shape: 'sphere', radius: 0.5 } }, [3, 0, 0]);
    step(p, 1);
    // The arm and the body overlap but are one object's parts: no contact.
    expect(p.touching('body')).toEqual([]);
    f.place('ball', [1.9, 0, 0]);
    step(p, 2);
    step(p, 3);
    expect(p.events()).toEqual([
      { type: 'contact', entity: 'arm', other: 'ball', normal: [1, 0, 0], stepIndex: 1 },
      { type: 'contact', entity: 'ball', other: 'arm', normal: [-1, 0, 0], stepIndex: 1 },
      { type: 'damaged', entity: 'ball', amount: 2, current: 1, source: 'arm', stepIndex: 1 },
    ]);
    expect(p.touching('ball')).toEqual(['arm']);
    // A lasting contact is not new: no more damage.
    step(p, 4);
    expect(p.healthOf('ball')?.current).toBe(1);
    // Switched off: the contact ends.
    expect(p.setHitboxActive('arm', false)).toBe(true);
    step(p, 5);
    step(p, 6);
    expect(p.events().map((e) => `${e.type}:${e.entity}`)).toEqual(['separate:arm', 'separate:ball']);
    expect(p.touching('ball')).toEqual([]);
  });
  it('the character takes part while playing, and a fall onto a hitbox reads as from above', () => {
    const f = fakeHost(2, { character: [0, 3, 0] });
    const p = new Primitives(f.host);
    f.place('shell', [0, 0.25, 0]);
    p.add('shell', { hitbox: { size: [1.6, 0.5] } }, [0, 0.25, 0]);
    step(p, 1);
    f.moveCharacter([0.5, 1.3, 0]); // the capsule's box bottom at 0.4: into the top of the shell
    step(p, 2, false);
    expect(p.touching('shell')).toEqual([]);
    step(p, 3);
    step(p, 4);
    const shell = p.events().find((e) => e.type === 'contact' && e.entity === 'shell');
    const mine = p.events().find((e) => e.type === 'contact' && e.entity === 'actor');
    // The character came down onto it (the last pass while playing saw it above): up from the shell, down from the character.
    expect(shell).toMatchObject({ other: 'actor', normal: [0, 1, 0] });
    expect(mine).toMatchObject({ other: 'shell', normal: [0, -1, 0] });
  });
});

describe('the components save section', () => {
  it('keeps health, collected collectibles, patrol positions and switched-off hitboxes; checks what it restores', () => {
    const f = fakeHost(2, { character: [0, 0, 0] });
    const p = new Primitives(f.host);
    f.place('token', [0, 0, 0]);
    f.place('rover', [5, 0, 0]);
    f.place('ward', [9, 0, 0]);
    p.add('token', { collectible: { counter: 'parts', respawn: 10 } }, [0, 0, 0]);
    p.add('rover', { health: { max: 4 }, patrol: { mode: 'waypoints', waypoints: [[2, 0, 0]], speed: 1 } }, [5, 0, 0]);
    p.add('ward', { hitbox: { size: [1, 1] } }, [9, 0, 0]);
    for (let i = 1; i <= 60; i++) step(p, i);
    p.damage('rover', 1);
    p.setHitboxActive('ward', false);
    const saved = JSON.parse(JSON.stringify(p.saveState()));
    const g = saved.patrol.rover;
    expect(g.p[0]).toBeCloseTo(5.5, 9);
    expect(g.u).toBeCloseTo(0.5, 9);
    expect({ ...saved, patrol: { rover: { ...g, p: [5.5, g.p[1], g.p[2]], u: 0.5 } } }).toEqual({ health: { rover: 3 }, collected: { token: 1200 - 59 }, patrol: { rover: { p: [5.5, 0, 0], d: [0, 0, 0], w: 0, a: true, s: 0, u: 0.5, r: 1 } }, off: ['ward'] });
    expect(p.checkState(saved)).toBeNull();
    expect(p.checkState({ health: { rover: -1 } })).toMatch(/health/);
    expect(p.checkState({ patrol: { rover: { p: [0, 0] } } })).toMatch(/patrol/);
    expect(p.checkState({ extra: 1 })).toMatch(/unknown/);
    p.resetRun();
    f.moveCharacter(null);
    step(p, 1);
    expect(p.isCollected('token')).toBe(false);
    p.restoreState(saved);
    expect(p.healthOf('rover')?.current).toBe(3);
    expect(p.isCollected('token')).toBe(true);
    expect(f.hidden.has('token')).toBe(true);
    expect(f.curr.get('rover')!.position).toEqual(g.p);
    expect(JSON.parse(JSON.stringify(p.saveState()))).toEqual(saved);
  });
});

describe('phase 25.13: gravity bodies and the 2D patrol in any direction', () => {
  /** A floor whose top is at y 0 everywhere (a ray down from above it hits at its distance to 0). */
  const floor = (): PhysicsPort =>
    ({ raycast: (o: { x: number; y: number }, d: { x: number; y: number }, max: number) => (d.y < 0 && o.y >= 0 && o.y <= max ? { entityId: 'floor', distance: o.y, normal: { x: 0, y: 1 } } : null) }) as unknown as PhysicsPort;

  it('falls with the project gravity (times its scale), lands with its underside on the floor, is saved and restored', () => {
    const f = fakeHost(2, { physics: floor() });
    const p = new Primitives({ ...f.host, gravityY: -20, maxFallSpeed: -30 });
    f.place('rock', [0, 3, 0]);
    p.add('rock', { gravity: { scale: 1, size: [1, 1] } }, [0, 3, 0]);
    step(p, 1);
    // One step: v = −20/120, down v/120.
    expect(f.curr.get('rock')!.position[1]).toBeCloseTo(3 - 20 / 120 / 120, 12);
    for (let i = 2; i < 200; i++) step(p, i);
    expect(f.curr.get('rock')!.position[1]).toBeCloseTo(0.5, 9);
    const saved = p.saveState();
    expect(saved.fall).toEqual({ rock: [f.curr.get('rock')!.position[1], 0] });
    expect(p.checkState(saved)).toBeNull();
    expect(p.checkState({ fall: { rock: [1] } })).toMatch(/fall/);
    f.curr.get('rock')!.position[1] = 9;
    p.restoreState({ fall: { rock: [2, -1] } });
    expect(f.curr.get('rock')!.position[1]).toBe(2);
    p.resetRun();
    expect(f.curr.get('rock')!.position[1]).toBe(3);
    // Scale 0: it does not fall.
    const g = fakeHost(2, { physics: floor() });
    const q = new Primitives(g.host);
    g.place('leaf', [0, 3, 0]);
    q.add('leaf', { gravity: { scale: 0 } }, [0, 3, 0]);
    for (let i = 1; i < 50; i++) step(q, i);
    expect(g.curr.get('leaf')!.position[1]).toBe(3);
  });

  it('a 2D edge patrol walks along its direction in the plane (a y part moves it up or down)', () => {
    const f = fakeHost(2);
    const p = new Primitives(f.host);
    f.place('riser', [0, 0, 0]);
    p.add('riser', { patrol: { mode: 'edges', speed: 1.2, direction: [0, 1, 0] } }, [0, 0, 0]);
    f.place('diag', [0, 0, 0]);
    p.add('diag', { patrol: { mode: 'edges', speed: 1.2, direction: [-1, 1, 0] } }, [0, 0, 0]);
    for (let i = 1; i <= 100; i++) step(p, i);
    expect(f.curr.get('riser')!.position[0]).toBe(0);
    expect(f.curr.get('riser')!.position[1]).toBeCloseTo(1, 9);
    expect(f.curr.get('diag')!.position[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(f.curr.get('diag')!.position[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(p.patrolOf('diag')?.direction[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });
});
