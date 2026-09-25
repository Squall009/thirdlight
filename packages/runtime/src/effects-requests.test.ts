/**
 * Phase 20.2: effect requests are presentation events — recorded in step
 * order, deterministic for the same inputs, never read back by the
 * simulation: scripts (`ctx.effects.play/stop`), effect components' signals
 * and the gameplay hooks (pickup collected, enemy hit / defeated, player
 * hit, checkpoint / goal reached). Neutral fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksEffectRequest, type BlocksHost } from './blocks';
import { makeM2Runtime, probeSpec } from './m2-helpers';
import type { EffectRequest, StepContext, TransformState } from './types';

const HZ = 120;
const T = (x: number, y: number) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const ent = (id: string, x: number, y: number, components: Record<string, unknown>): EntityV3 => ({ id, components: { transform: T(x, y), ...components } }) as unknown as EntityV3;
const FRAME = { stepIndex: 0, moveX: 0, jump: 'none' as const };

function blocksWith(entities: EntityV3[], player: { x: number; y: number }, delta = { x: 0, y: 0 }): { blocks: GameplayBlocks; requests: BlocksEffectRequest[]; player: { x: number; y: number }; delta: { x: number; y: number } } {
  const curr = new Map<string, TransformState>();
  for (const e of entities) {
    const t = e.components.transform;
    curr.set(e.id, { position: [...t.position] as [number, number, number], rotation: [...t.rotation] as [number, number, number, number], scale: [...t.scale] as [number, number, number] });
  }
  const out = { blocks: undefined as unknown as GameplayBlocks, requests: [] as BlocksEffectRequest[], player, delta };
  const host: BlocksHost = {
    hz: HZ,
    physics: undefined,
    curr,
    playerId: 'player-0001',
    playerCapsule: { radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0 } },
    player: () => out.player,
    playerDelta: () => out.delta,
    groundEntityId: () => null,
    kill: () => undefined,
    animator: () => null,
    effect: (r) => out.requests.push(r),
  };
  out.blocks = new GameplayBlocks(host, entities);
  return out;
}

describe('gameplay hooks name effects', () => {
  it('a collected pickup plays its effect once, where it was', () => {
    const h = blocksWith([ent('coin-0001', 2, 1, { pickup: { kind: 'coin', value: 1, effect: 'fx-sparkle' } }), ent('coin-0002', 9, 1, { pickup: { kind: 'coin', value: 1 } })], { x: 2, y: 1 });
    h.blocks.beforeStep(1);
    h.blocks.afterPhysics(FRAME, true);
    h.blocks.beforeStep(2);
    h.blocks.afterPhysics(FRAME, true);
    expect(h.requests).toEqual([{ op: 'play', effectId: 'fx-sparkle', entityId: null, position: [2, 1, 0], source: 'pickup' }]);
  });

  it('a stomp plays the enemy\'s hit effect, the last one its defeat effect too', () => {
    const enemy = ent('enemy-0001', 0, 0, { enemy: { patrol: 'points', range: [-1, 1], speed: 0, size: [1, 1], contactDamage: 1, stompable: true, health: 2, hitEffect: 'fx-hit', defeatEffect: 'fx-poof' } });
    const h = blocksWith([enemy], { x: 0, y: 1.75 }, { x: 0, y: -0.1 });
    // The player falls onto its top (its feet were above it the step before).
    h.blocks.beforeStep(1);
    h.blocks.afterPhysics(FRAME, true);
    expect(h.requests.map((r) => [r.effectId, r.source])).toEqual([['fx-hit', 'enemyHit']]);
    h.player = { x: 0, y: 1.75 };
    h.blocks.beforeStep(2);
    h.blocks.afterPhysics(FRAME, true);
    expect(h.requests.map((r) => [r.effectId, r.source])).toEqual([['fx-hit', 'enemyHit'], ['fx-hit', 'enemyHit'], ['fx-poof', 'enemyDefeat']]);
    expect(h.requests[2]!.position).toEqual([0, 0, 0]);
  });

  it('a hit on the player plays its health hit effect where the player is', () => {
    const h = blocksWith([ent('player-0001', 3, 1, { controller: {}, health: { max: 3, hitEffect: 'fx-ouch' } })], { x: 3, y: 1 });
    h.blocks.beforeStep(1);
    expect(h.blocks.damage(1)).toBe('alive');
    expect(h.requests).toEqual([{ op: 'play', effectId: 'fx-ouch', entityId: null, position: [3, 1, 0], source: 'playerHit' }]);
  });

  it('a checkpoint or goal reached plays its zone effect', () => {
    const h = blocksWith([ent('cp-0001', 5, 2, { gameZone: { role: 'checkpoint', size: [1, 1], safeSpawnId: 's', activation: { emissive: '#ffffff', emissiveIntensity: 1, cueAssetId: null }, effect: 'fx-flag' } }), ent('goal-0001', 9, 2, { gameZone: { role: 'goal', size: [1, 1] } })], { x: 0, y: 0 });
    h.blocks.zoneReached('cp-0001', 'checkpoint');
    h.blocks.zoneReached('goal-0001', 'goal');
    expect(h.requests).toEqual([{ op: 'play', effectId: 'fx-flag', entityId: null, position: [5, 2, 0], source: 'checkpoint' }]);
  });

  it('an effect component restarts on its signal and stops on its stop signal (entity order)', () => {
    const h = blocksWith([ent('fire-0001', 0, 0, { effect: { effectId: 'fx-fire', playOnStart: false, signal: 'light', stopSignal: 'douse' } }), ent('fire-0002', 4, 0, { effect: { effectId: 'fx-fire', signal: 'light' } }), ent('lamp-0001', 8, 0, { effect: { effectId: 'fx-glow' } })], { x: 100, y: 100 });
    h.blocks.emit('light');
    h.blocks.beforeStep(1);
    expect(h.requests).toEqual([
      { op: 'play', effectId: 'fx-fire', entityId: 'fire-0001', position: [0, 0, 0], source: 'component' },
      { op: 'play', effectId: 'fx-fire', entityId: 'fire-0002', position: [0, 0, 0], source: 'component' },
    ]);
    h.blocks.emit('douse');
    h.blocks.beforeStep(2);
    expect(h.requests.slice(2)).toEqual([{ op: 'stop', effectId: '', entityId: 'fire-0001', position: [0, 0, 0], source: 'component' }]);
    // Unloaded entities no longer react.
    h.blocks.remove(new Set(['fire-0001', 'fire-0002']));
    h.blocks.emit('light');
    h.blocks.beforeStep(3);
    expect(h.requests).toHaveLength(3);
  });
});

describe('ctx.effects (scripts)', () => {
  /** A script that plays at step 2 (on itself and at a point), stops the first at step 4, and tries 40 plays at step 6. */
  function run(): { requests: EffectRequest[]; handles: number[] } {
    const handles: number[] = [];
    const h = makeM2Runtime({
      modules: ['thirdlight.test-fx:probe'],
      specs: [
        probeSpec({
          id: 'thirdlight.test-fx:probe',
          phases: ['intent'],
          step: (_phase, ctx: StepContext) => {
            const fx = ctx.effects!;
            if (ctx.stepIndex === 2) {
              handles.push(fx.play('fx-burst', { entityId: 'box-0001', position: [0, 1, 0], params: { tint: '#ff0000', rate: 3, bad: {} as unknown as number } }));
              handles.push(fx.play('fx-burst', { position: [1, 2, 3] }));
              handles.push(fx.play('Not An Id'));
            }
            if (ctx.stepIndex === 4) {
              fx.stop(handles[0]!);
              fx.stop('box-0001');
            }
            if (ctx.stepIndex === 6) for (let i = 0; i < 40; i++) handles.push(fx.play('fx-spam'));
          },
        }),
      ],
    });
    h.boot();
    for (let k = 1; k <= 60; k++) h.tick(k / 60);
    const requests = (h.rt as unknown as { takeEffectRequests(): EffectRequest[] }).takeEffectRequests();
    return { requests, handles };
  }

  it('records plays and stops in step order with handles, refuses bad ids and more than 32 plays a step, and is deterministic', () => {
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    expect(a.handles.slice(0, 3)).toEqual([1, 2, 0]);
    const first = a.requests.slice(0, 4).map((r) => ({ op: r.op, effectId: r.effectId, handle: r.handle, entityId: r.entityId, position: r.position, params: r.params, source: r.source }));
    expect(first).toEqual([
      { op: 'play', effectId: 'fx-burst', handle: 1, entityId: 'box-0001', position: [0, 1, 0], params: { tint: '#ff0000', rate: 3 }, source: 'script' },
      { op: 'play', effectId: 'fx-burst', handle: 2, entityId: null, position: [1, 2, 3], params: null, source: 'script' },
      { op: 'stop', effectId: '', handle: 1, entityId: null, position: [0, 0, 0], params: null, source: 'script' },
      { op: 'stop', effectId: '', handle: 0, entityId: 'box-0001', position: [0, 0, 0], params: null, source: 'script' },
    ]);
    expect(a.requests[0]!.stepIndex).toBeLessThan(a.requests[2]!.stepIndex);
    // Step 6: 32 plays, then refusals (handle 0).
    const spam = a.handles.slice(3);
    expect(spam.filter((x) => x > 0)).toHaveLength(32);
    expect(spam.slice(32).every((x) => x === 0)).toBe(true);
    expect(a.requests.filter((r) => r.effectId === 'fx-spam')).toHaveLength(32);
  });

  it('taking the requests changes nothing the simulation computes', () => {
    const plain = makeM2Runtime({ modules: ['thirdlight.test-fx:probe'], specs: [probeSpec({ id: 'thirdlight.test-fx:probe', phases: ['intent'], step: (_p, ctx) => void ctx.effects?.play('fx-burst', { position: [0, 0, 0] }) })] });
    const taken = makeM2Runtime({ modules: ['thirdlight.test-fx:probe'], specs: [probeSpec({ id: 'thirdlight.test-fx:probe', phases: ['intent'], step: (_p, ctx) => void ctx.effects?.play('fx-burst', { position: [0, 0, 0] }) })] });
    plain.boot();
    taken.boot();
    for (let k = 1; k <= 30; k++) {
      plain.tick(k / 60);
      taken.tick(k / 60);
      (taken.rt as unknown as { takeEffectRequests(): EffectRequest[] }).takeEffectRequests();
    }
    const state = (h: typeof plain): unknown => {
      const s = h.rt.getInterpolatedState();
      return s.ok ? s.state.transforms : null;
    };
    expect(state(taken)).toEqual(state(plain));
    // Without a taker the queue keeps only the newest 256.
    expect((plain.rt as unknown as { takeEffectRequests(): EffectRequest[] }).takeEffectRequests().length).toBeLessThanOrEqual(256);
  });
});
