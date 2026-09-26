/**
 * Phase 15.3: the gameplay blocks read their tuning from the components
 * (health, enemy, mover, pickup), each absent field at the value every
 * project played with before (`BLOCK_DEFAULTS`); a pickup without a size
 * collects over its model's recorded bounds, else a neutral 1 x 1 m.
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFAULTS, type EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksHost } from './blocks';
import type { ModelBounds, TransformState } from './types';

const HZ = 120;
const T = (x: number, y: number, scale: [number, number, number] = [1, 1, 1]) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale });
const ent = (id: string, components: Record<string, unknown>, parentId?: string): EntityV3 => ({ id, ...(parentId !== undefined ? { parentId } : {}), components: { transform: T(0, 0), ...components } }) as unknown as EntityV3;
const FRAME = { stepIndex: 0, moveX: 0, jump: 'none' as const };

interface Harness {
  blocks: GameplayBlocks;
  player: { x: number; y: number };
  delta: { x: number; y: number };
  rays: { origin: { x: number; y: number }; direction: { x: number; y: number }; max: number }[];
  deaths: number;
}

function harness(entities: EntityV3[], o: { player?: { x: number; y: number }; bounds?: Record<string, ModelBounds>; skin?: number; floor?: boolean; blocked?: boolean } = {}): Harness {
  const curr = new Map<string, TransformState>();
  for (const e of entities) {
    const t = e.components.transform;
    curr.set(e.id, { position: [...t.position] as [number, number, number], rotation: [...t.rotation] as [number, number, number, number], scale: [...t.scale] as [number, number, number] });
  }
  const h: Harness = { blocks: undefined as unknown as GameplayBlocks, player: o.player ?? { x: 100, y: 100 }, delta: { x: 0, y: 0 }, rays: [], deaths: 0 };
  const host: BlocksHost = {
    hz: HZ,
    physics: {
      raycast: (origin: { x: number; y: number }, direction: { x: number; y: number }, max: number) => {
        h.rays.push({ origin, direction, max });
        // a floor everywhere (the ledge probe finds it), no walls
        if (direction.y >= 0 && o.blocked === true) return { entityId: 'wall', point: { x: origin.x + 0.5, y: origin.y }, normal: { x: -1, y: 0 }, distance: 0.5 };
        return direction.y < 0 && o.floor !== false ? { entityId: 'floor', point: { x: origin.x, y: 0 }, normal: { x: 0, y: 1 }, distance: 0.1 } : null;
      },
    } as unknown as BlocksHost['physics'],
    curr,
    playerId: 'player-0001',
    playerCapsule: { radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0 } },
    player: () => h.player,
    playerDelta: () => h.delta,
    groundEntityId: () => null,
    kill: () => {
      h.deaths += 1;
    },
    animator: () => null,
    ...(o.skin !== undefined ? { playerSkin: o.skin } : {}),
    ...(o.bounds !== undefined ? { modelBounds: (id: string) => o.bounds![id] ?? null } : {}),
  };
  h.blocks = new GameplayBlocks(host, entities);
  return h;
}

const step = (h: Harness, n = 1): void => {
  for (let i = 0; i < n; i++) {
    h.blocks.beforeStep(i + 1);
    h.blocks.afterPhysics(FRAME, true);
  }
};

describe('health tuning', () => {
  const player = (health: Record<string, unknown>) => ent('player-0001', { controller: {}, health: { max: 5, ...health } });

  it('a hit bounces the player at hitBounce (default 5 m/s) and pushes for knockbackTime (default 0.25 s)', () => {
    const def = harness([player({ knockback: 4 })], { player: { x: 0, y: 1 } });
    def.blocks.damage(1, -1);
    expect(def.blocks.takeBounce()).toBe(BLOCK_DEFAULTS.hitBounce);
    let pushedSteps = 0;
    for (let i = 0; i < 60; i++) {
      def.blocks.beforeStep(i + 1);
      if (def.blocks.carryDelta().x !== 0) pushedSteps += 1;
    }
    expect(pushedSteps).toBe(Math.round(0.25 * HZ));

    const tuned = harness([player({ knockback: 4, hitBounce: 2, knockbackTime: 0.1 })], { player: { x: 0, y: 1 } });
    tuned.blocks.damage(1, -1);
    expect(tuned.blocks.takeBounce()).toBe(2);
    pushedSteps = 0;
    for (let i = 0; i < 60; i++) {
      tuned.blocks.beforeStep(i + 1);
      if (tuned.blocks.carryDelta().x !== 0) pushedSteps += 1;
    }
    expect(pushedSteps).toBe(12);
  });
});

describe('enemy tuning', () => {
  const enemy = (extra: Record<string, unknown>) => ent('enemy-0001', { enemy: { patrol: 'points', range: [-1, 1], speed: 0, size: [1, 1], contactDamage: 1, stompable: true, health: 1, ...extra } });
  /** The player falling onto the enemy's top (feet `above` m over it before the step). */
  const stomp = (extra: Record<string, unknown>, above: number) => {
    const h = harness([enemy(extra), ent('player-0001', { controller: {}, health: { max: 3 } })]);
    // the enemy stands at 0 (feet), top at y = 1; the capsule half height is 0.9
    h.delta = { x: 0, y: -0.1 };
    h.player = { x: 0, y: 1 + above + 0.9 - 0.1 };
    h.blocks.afterPhysics(FRAME, true);
    return h;
  };

  it('stomp bounce and tolerance are data', () => {
    expect(stomp({}, -0.15).blocks.takeBounce()).toBe(BLOCK_DEFAULTS.stompBounce); // 0.15 m below the top: within 0.2
    expect(stomp({}, -0.25).blocks.takeBounce()).toBe(BLOCK_DEFAULTS.hitBounce); // 0.25 m below: a hit, not a stomp
    expect(stomp({ stompTolerance: 0.3 }, -0.25).blocks.takeBounce()).toBe(BLOCK_DEFAULTS.stompBounce);
    expect(stomp({ stompBounce: 12 }, 0).blocks.takeBounce()).toBe(12);
  });

  it('defeat: squash (default, 0.3 s), fade over defeatTime, or none (gone at once)', () => {
    const squash = stomp({}, 0);
    expect(squash.blocks.hiddenEntities().has('enemy-0001')).toBe(false);
    squash.player = { x: 100, y: 100 };
    step(squash, Math.round(0.3 * HZ) - 1);
    expect(squash.blocks.hiddenEntities().has('enemy-0001')).toBe(false);
    step(squash, 1);
    expect(squash.blocks.hiddenEntities().has('enemy-0001')).toBe(true);
    expect(squash.blocks.entityOpacity().size).toBe(0);

    const fade = stomp({ defeat: 'fade', defeatTime: 0.5 }, 0);
    fade.player = { x: 100, y: 100 };
    step(fade, 30);
    expect(fade.blocks.entityOpacity().get('enemy-0001')).toBeCloseTo(0.5, 9);
    step(fade, 29);
    expect(fade.blocks.hiddenEntities().has('enemy-0001')).toBe(false);
    step(fade, 1);
    expect(fade.blocks.hiddenEntities().has('enemy-0001')).toBe(true);
    expect(fade.blocks.entityOpacity().has('enemy-0001')).toBe(false);
    // a new run shows it again, opaque
    fade.blocks.resetRun();
    expect(fade.blocks.hiddenEntities().size).toBe(0);
    expect(fade.blocks.entityOpacity().size).toBe(0);

    const none = stomp({ defeat: 'none' }, 0);
    expect(none.blocks.hiddenEntities().has('enemy-0001')).toBe(true);
  });

  it('chase height: a player within it (feet over the enemy feet) is chased', () => {
    const chaser = (extra: Record<string, unknown>, feetY: number) => {
      const h = harness([ent('enemy-0001', { enemy: { patrol: 'points', range: [-5, 5], speed: 1, size: [1, 1], contactDamage: 0, stompable: false, health: 1, chase: 4, ...extra } })], { player: { x: -3, y: feetY + 0.9 } });
      step(h, 1);
      return h;
    };
    // the enemy starts walking right (dir 1); a chased player on the left turns it left
    const x = (h: Harness) => (h.blocks as unknown as { enemies: Map<string, { x: number }> }).enemies.get('enemy-0001')!.x;
    expect(x(chaser({}, 1.5))).toBeLessThan(0);
    expect(x(chaser({}, 2.5))).toBeGreaterThan(0);
    expect(x(chaser({ chaseHeight: 3 }, 2.5))).toBeLessThan(0);
  });

  it('chase speed, sight, facing, memory and leaving the post (phase 24.0)', () => {
    type EnemyState = { x: number; dir: number };
    const at = (h: Harness): EnemyState => (h.blocks as unknown as { enemies: Map<string, EnemyState> }).enemies.get('enemy-0001')!;
    const mk = (extra: Record<string, unknown>, player: { x: number; y: number }, blocked?: boolean) =>
      harness([ent('enemy-0001', { enemy: { patrol: 'points', range: [-1, 1], speed: 1, size: [1, 1], contactDamage: 0, stompable: false, health: 1, chase: 10, ...extra } })], { player, ...(blocked !== undefined ? { blocked } : {}) });

    // chaseSpeed: it runs at 4 m/s instead of its 1 m/s walk
    const fast = mk({ chaseSpeed: 4 }, { x: -3, y: 0.5 });
    step(fast, 10);
    expect(at(fast).x).toBeCloseTo((-10 * 4) / HZ, 9);
    const walk = mk({}, { x: -3, y: 0.5 });
    step(walk, 10);
    expect(at(walk).x).toBeCloseTo((-10 * 1) / HZ, 9);

    // chaseFacing: a player behind it is ignored (it keeps walking right)
    const facing = mk({ chaseFacing: true }, { x: -3, y: 0.5 });
    step(facing, 10);
    expect(at(facing).x).toBeGreaterThan(0);
    const behind = mk({}, { x: -3, y: 0.5 });
    step(behind, 10);
    expect(at(behind).x).toBeLessThan(0);

    // chaseSight: a wall between them hides the player
    const walled = mk({ chaseSight: true }, { x: -3, y: 0.5 }, true);
    step(walled, 10);
    expect(at(walled).x).toBeGreaterThan(0);
    const clear = mk({ chaseSight: true }, { x: -3, y: 0.5 });
    step(clear, 10);
    expect(at(clear).x).toBeLessThan(0);

    // chaseMemory: it keeps running them down after they are gone, then walks back
    const withMem = mk({ chaseSpeed: 3, chaseMemory: 0.5, chaseBeyondPatrol: true }, { x: 3, y: 0.5 });
    const noMem = mk({ chaseSpeed: 3, chaseBeyondPatrol: true }, { x: 3, y: 0.5 });
    step(withMem, 1);
    step(noMem, 1);
    withMem.player = { x: 100, y: 0.5 };
    noMem.player = { x: 100, y: 0.5 };
    step(withMem, 30);
    step(noMem, 30);
    expect(at(withMem).x).toBeGreaterThan(at(noMem).x + 0.3);
    step(withMem, 40); // 0.5 s of memory runs out
    expect(at(withMem).dir).toBe(-1);

    // chaseBeyondPatrol: it passes its range while chasing, else it stops at the range
    const bound = mk({ chaseSpeed: 3 }, { x: -9, y: 0.5 });
    step(bound, 120);
    expect(at(bound).x).toBeCloseTo(-1, 9);
    const free = mk({ chaseSpeed: 3, chaseBeyondPatrol: true }, { x: -9, y: 0.5 });
    step(free, 120);
    expect(at(free).x).toBeLessThan(-2.5);
  });

  it('the edge walker probes walls and ledges at its wallProbe / ledgeProbe distances', () => {
    const walker = (extra: Record<string, unknown>) => {
      const h = harness([ent('enemy-0001', { enemy: { patrol: 'edges', speed: 1.2, size: [1, 1], contactDamage: 0, stompable: false, health: 1, ...extra } })]);
      step(h, 1);
      return h.rays;
    };
    const [wall, floor] = walker({});
    expect(wall!.max).toBeCloseTo(0.5 + 1.2 / HZ + 0.05, 12);
    expect(floor!.max).toBe(0.4);
    expect(floor!.origin.x).toBeCloseTo(0.5 + 0.05, 12);
    const [wall2, floor2] = walker({ wallProbe: 0.2, ledgeProbe: 1.5 });
    expect(wall2!.max).toBeCloseTo(0.5 + 1.2 / HZ + 0.2, 12);
    expect(floor2!.max).toBe(1.5);
    expect(floor2!.origin.x).toBeCloseTo(0.5 + 0.2, 12);
  });
});

describe('mover push tuning', () => {
  /** A wide block rising into the player beside it (the 14.7 sideways push), with its maxPush. */
  const push = (maxPush: number | undefined, skin?: number) => {
    const mover = ent('block-0001', { collider: { shape: { type: 'box', hx: 2, hy: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 2.4, mode: 'once', ...(maxPush !== undefined ? { maxPush } : {}) } });
    const h = harness([mover], { player: { x: -1, y: 0.2 }, ...(skin !== undefined ? { skin } : {}) });
    h.blocks.beforeStep(1);
    return h.blocks.carryDelta();
  };
  it('the push per step is maxPush over the step rate (default 60 m/s: 0.5 m at 120 Hz)', () => {
    expect(push(undefined).x).toBeCloseTo(-0.5, 12);
    expect(push(30).x).toBeCloseTo(-0.25, 12);
  });
  it('the gap it keeps is the player controller skin plus 1 mm', () => {
    // A player just outside the block's left edge (gap 0.02 m): no push with the default 0.011 m gap, a push with a 0.05 m skin.
    const edge = (skin?: number) => {
      const mover = ent('block-0001', { collider: { shape: { type: 'box', hx: 2, hy: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 2.4, mode: 'once' } });
      const h = harness([mover], { player: { x: -2 - 0.3 - 0.02, y: 0.2 }, ...(skin !== undefined ? { skin } : {}) });
      h.blocks.beforeStep(1);
      return h.blocks.carryDelta().x;
    };
    expect(edge()).toBe(0);
    expect(edge(0.05)).toBeLessThan(0);
  });
});

describe('pickup area without a size', () => {
  /** Whether a player standing `dx` right of the pickup (same height) collects it. */
  const collects = (entities: EntityV3[], dx: number, bounds?: Record<string, ModelBounds>): boolean => {
    const h = harness(entities, { player: { x: dx, y: 0 }, ...(bounds !== undefined ? { bounds } : {}) });
    h.blocks.afterPhysics(FRAME, true);
    return (h.blocks.countersView()['coins'] ?? 0) > 0;
  };
  const coin = (extra: Record<string, unknown> = {}) => ent('coin-0001', { pickup: { kind: 'coin', value: 1 }, ...extra });
  const WIDE: Record<string, ModelBounds> = { 'model-coin': { min: [-1.5, -0.5, -0.1], max: [1.5, 0.5, 0.1] } };

  it('no model (or no recorded bounds): a neutral 1 x 1 m square', () => {
    // half 0.5 + the capsule's half width 0.3: collected within 0.8 m
    expect(collects([coin()], 0.79)).toBe(true);
    expect(collects([coin()], 0.81)).toBe(false);
    expect(collects([coin({ model: { asset: { assetId: 'model-coin' } } })], 0.81, {})).toBe(false);
  });

  it('its own model: the model bounds (3 m wide) scaled by the transform', () => {
    expect(collects([coin({ model: { asset: { assetId: 'model-coin' } } })], 1.79, WIDE)).toBe(true);
    expect(collects([coin({ model: { asset: { assetId: 'model-coin' } } })], 1.81, WIDE)).toBe(false);
    const scaled = ent('coin-0001', { transform: T(0, 0, [0.5, 1, 1]), pickup: { kind: 'coin', value: 1 }, model: { asset: { assetId: 'model-coin' } } });
    expect(collects([scaled], 1.04, WIDE)).toBe(true);
    expect(collects([scaled], 1.06, WIDE)).toBe(false);
  });

  it('a model child (the usual "pickup root + visual" pair): the child model bounds with the child scale', () => {
    const child = ent('coin-visual', { transform: T(0, 0, [2, 1, 1]), model: { asset: { assetId: 'model-coin' } } }, 'coin-0001');
    expect(collects([coin(), child], 3.29, WIDE)).toBe(true);
    expect(collects([coin(), child], 3.31, WIDE)).toBe(false);
  });

  it('an authored size still wins', () => {
    expect(collects([coin({ model: { asset: { assetId: 'model-coin' } } }), ent('x', {})].map((e) => (e.id === 'coin-0001' ? ({ ...e, components: { ...e.components, pickup: { kind: 'coin', value: 1, size: [0.4, 0.4] } } } as unknown as EntityV3) : e)), 0.51, WIDE)).toBe(false);
  });
});
