/**
 * Phase 24.4e–i: the second set of generic primitives through the production
 * composition — the real game host, the character controller and Rapier
 * physics, a scene without any game session — on the 2D plane and in 3D, in
 * both threading modes, driven by a recorded input:
 *
 * - e: the character walks into a trigger: its `enter` event reaches the
 *   script that names it, and its scene transition loads the second scene
 *   and moves the character to the spawn there (3D: facing the spawn's yaw);
 * - f: a script gives the character an upward impulse (it rises off the
 *   floor); a velocity face-movement model under it turns to face +X as it
 *   walks right;
 * - h: a script sets a look override on an object (read back, in the
 *   renderer's view on either thread);
 * - i: the event → cue table plays one sound for the trigger's signal and one
 *   for its `enter` event (the audio commands the host receives).
 *
 * Both threading modes give the same step digests.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, MODES, startHarness, type Harness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[], rotation = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });

/** Logs the trigger events it owns (the door named in a property), lifts the character at step 20, sets a look at step 30. */
const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    const log = ctx.save.get('log') ?? [];
    for (const e of ctx.events ?? []) if (e.type === 'enter' || e.type === 'exit') log.push(e.type + ':' + e.trigger);
    ctx.save.set('log', log);
    if (ctx.stepIndex === 20) {
      ctx.save.set('impulse', ctx.character.impulse([0, 6, 0]));
      ctx.save.set('badImpulse', ctx.character.impulse([0, 1000, 0]));
    }
    if (ctx.stepIndex === 30) {
      ctx.save.set('lookSet', ctx.look.set('lamp-0001', { emissive: '#ff2000', emissiveIntensity: 2, tint: '#80ff80' }));
      ctx.save.set('lookBad', ctx.look.set('lamp-0001', { emissive: 'red' }));
      ctx.save.set('lookMissing', ctx.look.set('nothing', { tint: '#ffffff' }));
      ctx.save.set('look', ctx.look.get('lamp-0001'));
    }
  },
};
`;
const DECLARATION = { properties: [{ key: 'door', label: 'Door', type: 'entityRef', default: null }] };

function level(dim: 2 | 3): { main: Any[]; two: Any[] } {
  const z = dim === 3;
  const box = (id: string, c: number[], h: number[]): Any => ({
    id,
    components: { transform: T(c), box: { size: [h[0]! * 2, h[1]! * 2, h[2]! * 2], material: { color: '#888888' } }, collider: { shape: z ? { type: 'box', hx: h[0], hy: h[1], hz: h[2] } : { type: 'box', hx: h[0], hy: h[1] } } },
  });
  const main = [
    { id: 'cam-main', components: { transform: T([4, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    // 3D: the character does not turn by input (so the spawn's yaw is what it faces on arrival).
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: z ? { faceMovement: false } : {}, behavior: { behaviorId: 'director', values: { door: 'door-0001' } } } },
    { id: 'look-0001', parentId: 'player-0001', components: { transform: T([0, 0, 0]), faceMovement: { mode: 'velocity', turnSeconds: 0.1 } } },
    box('floor-a', [2, -0.5, 0], [6, 0.5, 2]),
    { id: 'lamp-0001', components: { transform: T([-3, 1, 0]), box: { size: [1, 1, 1], material: { color: '#cccccc' } } } },
    { id: 'door-0001', components: { transform: T([4, 1, 0]), trigger: { size: z ? [1, 2, 2] : [1, 2], signal: 'opened', sceneTransition: { scene: 'scene-two', spawn: 'spawn-two' } } } },
  ];
  const two = [
    box('floor-b', [45, -0.5, 0], [6, 0.5, 2]),
    { id: 'spawn-two', components: { transform: T([42, 0.91, 0]), playerSpawn: z ? { yaw: 180 } : {} } },
  ];
  return { main, two };
}

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

async function run(mode: Mode, dim: 2 | 3): Promise<{ h: Harness; values: Record<string, Any>; maxY: number; final: Any; looks: Any; loaded: string[] }> {
  const { main, two } = level(dim);
  const settings = dim === 3 ? { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 } : { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
  const statics = main
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics =
    dim === 3
      ? physics3DConfigOf(main, settings)
      : { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: settings.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  // Walk right into the door, keep walking a little after arriving, then stand.
  const walk = dim === 3 ? 300 : 200;
  const replay = Array.from({ length: 480 }, (_, i) => ({ stepIndex: i, moveX: i < walk ? 1 : 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none' as const }));
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: `trans${dim}@r1`,
      projectId: `trans${dim}`,
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      eventCues: [
        { on: 'signal', name: 'opened', assetId: 'cue-open' },
        { on: 'event', name: 'enter', entity: 'door-0001', assetId: 'cue-enter', volume: 0.5 },
        { on: 'event', name: 'enter', entity: 'elsewhere', assetId: 'cue-never' },
      ],
    },
    settings,
    physics,
    replay,
    digestSteps: true,
    storage: true,
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return two;
    },
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('director', DIRECTOR, DECLARATION)],
  });
  live.push(h);
  const rt: Any = h.rt;
  let now = 0;
  let maxY = -Infinity;
  const pos = (): number[] => rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'player-0001').position;
  while (h.digests.length < 460) {
    now += DT;
    await h.tick(now);
    if (h.digests.length > 20 && h.digests.length < 100) maxY = Math.max(maxY, pos()[1]!);
    if (h.digests.length % 20 === 0) await new Promise((r) => setTimeout(r, 0)); // scene loads resolve
  }
  const d = rt.getDiagnostics();
  expect(d.ok ? d.diagnostics.errors : d).toEqual([]);
  const st = rt.getInterpolatedState().state.transforms;
  return {
    h,
    values: await h.storage(),
    maxY,
    final: { player: st.find((x: Any) => x.id === 'player-0001'), look: st.find((x: Any) => x.id === 'look-0001') },
    looks: Object.fromEntries(rt.entityLooks?.() ?? []),
    loaded: (rt.sceneSet?.().batches ?? []).map((b: Any) => b.sceneId),
  };
}

describe.each([2, 3] as const)('scene transition, impulse, face velocity, look override, event cues (dimension %s)', (dim) => {
  const digests: Record<string, string[]> = {};
  it.each(MODES)('through the game host (threading: %s)', async (mode) => {
    const { h, values, maxY, final, looks, loaded } = await run(mode, dim);
    // e: the door's enter event reached the script that names it; the second scene loaded; the character arrived at the spawn.
    expect(values['log']).toContain('enter:door-0001');
    expect(loaded).toContain('scene-two');
    expect(final.player.position[0]).toBeGreaterThan(41);
    expect(final.player.position[0]).toBeLessThan(51);
    if (dim === 3) {
      // Arrived facing the spawn's yaw (180°: q = [0, 1, 0, 0]).
      expect(Math.abs(final.player.rotation[1])).toBeCloseTo(1, 3);
    }
    // f: the impulse lifted it well off the floor (6 m/s up: about 0.9 m at this gravity); a bad one is refused.
    expect(values['impulse']).toBe(true);
    expect(values['badImpulse']).toBe(false);
    expect(maxY).toBeGreaterThan(0.91 + 0.5);
    // f: the velocity model under it faces +X (yaw 90°: q.y = sin 45°).
    expect(final.look.rotation[1]).toBeCloseTo(Math.SQRT1_2, 3);
    // h: the look override is set, read back and in the renderer's view (both threads).
    expect(values['lookSet']).toBe(true);
    expect(values['lookBad']).toBe(false);
    expect(values['lookMissing']).toBe(false);
    expect(values['look']).toEqual({ emissive: '#ff2000', emissiveIntensity: 2, tint: '#80ff80' });
    expect(looks).toEqual({ 'lamp-0001': { emissive: '#ff2000', emissiveIntensity: 2, tint: '#80ff80' } });
    // i: one cue for the signal, one for the door's enter event (not the row filtered to another object).
    const plays = h.audioCommands.filter((c: Any) => c.op === 'play').map((c: Any) => [c.assetId, c.volume]);
    expect(plays.filter(([a]: Any) => a === 'cue-open').length).toBe(1);
    expect(plays.filter(([a]: Any) => a === 'cue-enter')).toEqual([['cue-enter', 0.5]]);
    expect(plays.some(([a]: Any) => a === 'cue-never')).toBe(false);
    digests[mode] = h.digests.slice(0, 460);
    if (digests['single'] !== undefined && digests['worker'] !== undefined) expect(digests['worker']).toEqual(digests['single']);
  }, 120_000);
});
