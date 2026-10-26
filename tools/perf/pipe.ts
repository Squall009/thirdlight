/**
 * The pipe scene: a 3D level where the player walks into a pipe, the game
 * locks the player and a stretch of the level to a plane and turns the
 * camera to a side view, the player plays the side-view stretch (a
 * block-built floor, a pit crossed on a moving platform, one-way platforms
 * up onto a wall), and leaves through a second pipe back into free 3D.
 *
 * Everything that switches is the game's own script (`PIPE_SCRIPT`): the
 * engine gives the primitives (`ctx.character.setPlane`,
 * `ctx.physics.setPlane`, `ctx.camera.activate`), the triggers send the
 * signals. Built on the 3D starter template through the commands, so the
 * scene is what a user makes in the editor; `pipe-run.ts` exports it and
 * plays it in a real browser.
 *
 * World layout (metres; the starter's block ground covers x, z −12…12 with
 * its top at y = 0, the player starts at the origin): the stretch runs from
 * x = −12 to −56 along z = 0, the plane of the side view, 4 m deep; past the
 * exit pipe a 16 × 16 m block yard is free 3D ground again.
 */
import type { BehaviorPlan } from './generate';
import type { PerfBackend } from './backend';
import { publishBehaviorVia } from './build';
import { fireSystem } from './village';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The stretch's plane: normal along world Z, at z = 0. */
export const PIPE_PLANE = { axis: 'z', origin: 0 } as const;

/** Where things are (world x unless named), shared by the builder and the browser driver. */
export const PIPE_LAYOUT = {
  /** The entry pipe's mouth (its trigger) and the exit pipe's. */
  entryX: -10.5,
  exitX: -54,
  /** The pit the moving platform crosses: floor ends at `pitStart`, starts again at `pitEnd`. */
  pitStart: -26,
  pitEnd: -32,
  /** The platform: 2 m wide, centred at `liftFrom` at rest, carried to `liftTo` once the player is on it. */
  liftFrom: -27,
  liftTo: -31,
  /** One-way platforms (x from, x to, top y): the player jumps up through the first, then the second, onto the wall. */
  oneWay: [
    [-41, -44, 1],
    [-45, -48, 2],
  ],
  /** The wall the second platform leads onto (x from, x to, top y). */
  wall: [-48, -50, 2],
  /** The 3D yard past the exit: x −72…−56, z −8…8. */
  yard: { x: [-72, -56], z: [-8, 8] },
} as const;

/** The side view's blend in and out (s): long enough to read as a move, short enough not to lag the play. */
export const SIDE_BLEND_S = 0.6;

/**
 * The game's script, on its own object: on the entry trigger's signal it locks the player and every object
 * tagged `section` to the plane and makes the side camera live; on the exit trigger's it frees them and lets
 * the follow camera take the view back. Both at a step boundary, in the same step.
 */
export const PIPE_SCRIPT = `import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  side_camera: property.entityRef(null, { tooltip: 'The side-view camera' }),
  depth: property.number(0, { tooltip: 'Where the side-view plane lies along world Z (m)' }),
  entry_fx: property.string('', { tooltip: 'The effect played at the entry pipe as the player goes in' }),
};

interface State { side: boolean }

export default {
  instantiate(): State {
    return { side: false };
  },
  step(state: State, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    const camera = ctx.properties.side_camera as string;
    if (!state.side && ctx.signals.on('pipe-in')) {
      state.side = true;
      const plane = { axis: 'z' as const, origin: ctx.properties.depth as number };
      ctx.character.setPlane(null, plane);
      for (const id of ctx.tags.query(ctx.tags.mask('section'))) ctx.physics.setPlane?.(id, plane);
      ctx.camera?.activate(camera, { blend: 'eased', blendTime: ${SIDE_BLEND_S} });
      const fx = ctx.properties.entry_fx as string;
      if (fx !== '') ctx.effects?.play(fx, { position: [${PIPE_LAYOUT.entryX}, 1, 0] });
    } else if (state.side && ctx.signals.on('pipe-out')) {
      state.side = false;
      ctx.character.setPlane(null, null);
      for (const id of ctx.tags.query(ctx.tags.mask('section'))) ctx.physics.setPlane?.(id, null);
      ctx.camera?.deactivate(camera, { blend: 'eased', blendTime: ${SIDE_BLEND_S} });
    }
  },
};
`;

export const PIPE_BEHAVIOR: BehaviorPlan = {
  behaviorId: 'pipe-switch',
  displayName: 'Pipe switch',
  ownedTransforms: [],
  declaration: {
    properties: [
      { key: 'side_camera', label: 'Side camera', type: 'entityRef', default: null },
      { key: 'depth', label: 'Depth', type: 'number', default: 0 },
      { key: 'entry_fx', label: 'Entry effect', type: 'string', default: '' },
    ],
  },
  source: PIPE_SCRIPT,
};

const PIPE_GREEN = '#2f9e44';

/** The entry's puff: a one-second one-shot of two GPU systems (sparks and smoke). */
const PIPE_PUFF = {
  effectId: 'pipe-puff',
  name: 'Pipe puff',
  duration: 1,
  loop: false,
  seed: 5,
  bounds: { center: [0, 1, 0], size: [3, 4, 3] },
  systems: [fireSystem('sparks', 'Sparks', 64, 48, '#ffb050', [{ type: 'output.billboard', data: { blend: 'additive' } }]), fireSystem('smoke', 'Smoke', 48, 30, '#404040', [{ type: 'output.billboard', data: { blend: 'alpha' } }])],
};
const SECTION_GREY = '#c9b79c';
/** Section boxes per createEntities request. */
const SECTION_BATCH = 100;

/** The ids the driver and the measurement read. */
export interface PipeScene {
  player: string;
  followCamera: string;
  sideCamera: string;
  lift: string;
}

/** A pipe mouth at `x`: two posts and a lintel (solid), the trigger between them sending `signal`. */
async function pipeMouth(cmd: Cmd, name: string, x: number, signal: string): Promise<void> {
  const solid = async (part: string, at: [number, number, number], size: [number, number, number]): Promise<void> => {
    await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: `${name} ${part}`, static: true, transform: { position: at }, box: { size, material: { color: PIPE_GREEN } }, components: { collider: { shape: { type: 'box', hx: size[0] / 2, hy: size[1] / 2, hz: size[2] / 2 } } } });
  };
  await solid('left', [x, 1.3, -1.6], [1.6, 2.6, 0.4]);
  await solid('right', [x, 1.3, 1.6], [1.6, 2.6, 0.4]);
  await solid('top', [x, 2.8, 0], [1.6, 0.4, 3.6]);
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: `${name} trigger`, transform: { position: [x, 1.1, 0] }, components: { trigger: { size: [1, 2.2, 2.8], signal } } });
}

/** Build the pipe scene on the 3D starter in `projectId` (a new project); `sectionExtra` more section objects (a larger level section switched in the same step). */
export async function buildPipeScene(be: PerfBackend, projectId: string, opts: { sectionExtra?: number } = {}): Promise<PipeScene> {
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Pipe test', template: 'starter-3d' });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  const cmd: Cmd = (op, args) => p.command(op, args);
  const listed = (await p.query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const player = listed.find((e) => e.components['controller'] !== undefined)?.id;
  const followCamera = listed.find((e) => (e.components['virtualCamera'] as { rig?: string } | undefined)?.rig === 'follow')?.id;
  if (player === undefined || followCamera === undefined) throw new Error('pipe: the 3D starter has no player or follow camera');
  // A brisk walk: the stretch is crossed in about half a minute.
  await cmd('setComponent', { entityId: player, component: 'controller', value: { ...(listed.find((e) => e.id === player)!.components['controller'] as object), walkSpeed: 4 } });
  await cmd('setTags', { tags: [{ name: 'section' }] });

  // The stretch and the yard: one block layer (cells of 1 m) from x = −72 to −12, z = −8 to 8, top at y = 0.
  const L = PIPE_LAYOUT;
  const x0 = L.yard.x[0];
  const z0 = L.yard.z[0];
  const blocks = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Stretch blocks', transform: { position: [x0, -1, z0] }, components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [-12 - x0, 6, L.yard.z[1] - z0] }, kitId: 'basic-kit' } } }))['createdId']);
  const cx = (x: number): number => x - x0;
  const cz = (z: number): number => z - z0;
  const fill = (xa: number, xb: number, y0: number, y1: number, za: number, zb: number, block: string): Record<string, unknown> => ({ kind: 'fill', box: [cx(Math.min(xa, xb)), y0, cz(za), cx(Math.max(xa, xb)), y1, cz(zb)], cell: { block } });
  await cmd('editBlocks', {
    entityId: blocks,
    edits: [
      fill(-56, L.pitEnd, 0, 1, -2, 2, 'basic-ground'),
      fill(L.pitStart, -12, 0, 1, -2, 2, 'basic-ground'),
      fill(L.yard.x[0], L.yard.x[1], 0, 1, L.yard.z[0], L.yard.z[1], 'basic-ground'),
      fill(L.wall[0], L.wall[1], 1, 1 + L.wall[2], -2, 2, 'basic-wall'),
    ],
  });

  // The level section locked with the player: the moving platform and the one-way platforms.
  const lift = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Pit platform', tags: ['section'], transform: { position: [L.liftFrom, -0.25, 0] }, box: { size: [2, 0.5, 2], material: { color: SECTION_GREY } }, components: { collider: { shape: { type: 'box', hx: 1, hy: 0.25, hz: 1 } }, mover: { waypoints: [[L.liftTo - L.liftFrom, 0, 0]], speed: 2, mode: 'once', startOn: 'ride' } } }))['createdId']);
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Platform start', transform: { position: [L.liftFrom, 1, 0] }, components: { trigger: { size: [1.6, 2, 2], signal: 'ride', once: true } } });
  for (const [i, [a, b, top]] of L.oneWay.entries()) {
    const w = Math.abs(b - a);
    await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: `One-way ${i + 1}`, static: true, tags: ['section'], transform: { position: [(a + b) / 2, top - 0.1, 0] }, box: { size: [w, 0.2, 2], material: { color: SECTION_GREY } }, components: { collider: { shape: { type: 'box', hx: w / 2, hy: 0.1, hz: 1 }, oneWay: true } } });
  }

  // A larger section: small static boxes high above the stretch (out of the walk wherever the lock puts them).
  const extra = opts.sectionExtra ?? 0;
  for (let from = 0; from < extra; from += SECTION_BATCH) {
    const entities = Array.from({ length: Math.min(SECTION_BATCH, extra - from) }, (_, k) => {
      const i = from + k;
      const at: [number, number, number] = [L.entryX - 2 - (i % 30) * ((L.entryX - L.exitX - 4) / 30), 6 + Math.floor(i / 30) * 0.6, -1 - (i % 3)];
      return { kind: 'box', name: `Section box ${i + 1}`, static: true, tags: ['section'], transform: { position: at }, box: { size: [0.4, 0.4, 0.4], material: { color: SECTION_GREY } }, components: { collider: { shape: { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 } } } };
    });
    await cmd('createEntities', { sceneId: 'scene-main', entities });
  }

  await pipeMouth(cmd, 'Entry pipe', L.entryX, 'pipe-in');
  await pipeMouth(cmd, 'Exit pipe', L.exitX, 'pipe-out');

  // The side view: off at the start, above the follow camera's priority once the script activates it.
  const sideCamera = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Side camera', transform: { position: [0, 3, 14] }, components: { virtualCamera: { rig: 'follow', target: player, targetOffset: [0, 1.5, 0], distance: 14, yaw: 0, pitch: 6, damping: 0.15, collision: false, enabled: false, priority: 20 } } }))['createdId']);

  // A puff at the entry as the player goes in: an effect first shown at the switch, named by the script's setting.
  await cmd('setEffect', { effect: PIPE_PUFF });

  await publishBehaviorVia(be, p, cmd, PIPE_BEHAVIOR);
  const director = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Pipe switch', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setBehaviorProperties', { entityId: director, behaviorId: PIPE_BEHAVIOR.behaviorId, values: { side_camera: sideCamera, depth: PIPE_PLANE.origin, entry_fx: PIPE_PUFF.effectId } });
  return { player, followCamera, sideCamera, lift };
}
