/**
 * The rooms bench data of `light-shots --rooms off|see-through|cut-away` (engine-owned test data, taken out after):
 * a box the see-through subject (a 0.6 m cube, "Bench subject"), placed at each room camera's room as its shot
 * starts, and the bench camera's occlusion set to the mode (`none`, `seeThrough`, `cutAway`; set back after). The
 * L-shaped room is built by the camera's behaviour with `ctx.voxels` (a runtime edit, never written to the world):
 * floating 24 m over the town inside one 16 m chunk, plaster, its notch a neighbour's hut of brick under its own roof,
 * so a cut-away by the room's bounds shows what it does to the neighbour.
 */
import { MAT } from './world-kit';
import { VOXEL_ROLE } from '@thirdlight/voxel';
import { SHOT_COMMAND } from './lighting-cameras';

export const ROOM_MODES = ['off', 'see-through', 'cut-away'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** The camera occlusion of each mode. */
const OCCLUSION: Readonly<Record<RoomMode, string>> = { off: 'none', 'see-through': 'seeThrough', 'cut-away': 'cutAway' };

export const BENCH_SUBJECT = 'Bench subject';
const SUBJECT_SIDE = 0.6;

/** The L-shaped room's two parts (open cells, metres: x0 y0 z0 x1 y1 z1), its shell, and the neighbour's hut in its notch. */
export const L_ROOM = Object.freeze({
  shell: [32.5, 23.5, -15.5, 41.5, 27.5, -6.5],
  parts: [[33, 24, -15, 41, 27, -11], [33, 24, -11, 37, 27, -7]],
  notch: [37.5, 24, -10.5, 41, 26.5, -7],
  notchRoof: [37.5, 27, -10.5, 41.5, 27.5, -6.5],
} as const);

/** Where the subject stands for each room camera's shot (its centre, metres): the room house's ground floor; the L room's arm. */
export const ROOM_SUBJECT_AT: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze({
  'house-above': [0, 0.5 + SUBJECT_SIDE / 2, 1],
  'lroom-above': [35, 24 + SUBJECT_SIDE / 2, -9],
});

export const L_ROOM_COMMAND = 'lroom_build';

/** The behaviour's part: the subject named as the see-through subject and placed at each room shot; the L room on its command. */
export function roomsBehaviour(subjectId: string, shots: ReadonlyArray<{ readonly command: string; readonly name: string }>): { head: string; intent: string } {
  const places = shots.filter((s) => ROOM_SUBJECT_AT[s.name] !== undefined).map((s) => ({ command: s.command, at: ROOM_SUBJECT_AT[s.name] }));
  const box = (b: readonly number[]): string => `{ min: [${b[0]}, ${b[1]}, ${b[2]}], max: [${b[3]}, ${b[4]}, ${b[5]}] }`;
  return {
    head: `const ROOM_SUBJECT = ${JSON.stringify(subjectId)};\nconst ROOM_PLACES = ${JSON.stringify(places)};`,
    intent: `
      if (!s.subjectNamed) s.subjectNamed = ctx.camera.setSeeThrough({ subjects: [ROOM_SUBJECT] });
      for (const call of ctx.debug.command('${SHOT_COMMAND}')) for (const p of ROOM_PLACES) if (p.command === call.at) ctx.entity(ROOM_SUBJECT)?.set('transform', { position: p.at });
      for (const _ of ctx.debug.command('${L_ROOM_COMMAND}')) {
        const r = [v.set(${box(L_ROOM.shell)}, { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }), ${L_ROOM.parts.map((p) => `v.dig(${box(p)})`).join(', ')}, v.dig(${box(L_ROOM.notch)}), v.set(${box(L_ROOM.notchRoof)}, { material: ${MAT.brick}, role: ${VOXEL_ROLE.wall} })];
        ctx.game.add(r.every((e: any) => e.ok) ? 'lroom_built' : 'lroom_refused', 1);
      }`,
  };
}

/** The subject made (where nothing draws it yet: under the room house) and the bench camera's occlusion set; the undo. */
export async function placeBenchRooms(mode: RoomMode, command: (op: string, args: Record<string, unknown>) => Promise<unknown>, scene: () => Array<{ id: string; name: string; components?: Record<string, unknown> }>): Promise<{ subject: string; undo: () => Promise<void> }> {
  for (const e of scene().filter((x) => x.name === BENCH_SUBJECT)) await command('deleteEntity', { entityId: e.id });
  await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: BENCH_SUBJECT, transform: { position: [...ROOM_SUBJECT_AT['house-above']!] }, box: { size: [SUBJECT_SIDE, SUBJECT_SIDE, SUBJECT_SIDE], material: { color: '#2050f0' } } });
  const subject = scene().find((x) => x.name === BENCH_SUBJECT)!.id;
  const cam = scene().find((x) => x.name === 'Perf far camera');
  const was = (cam?.components?.['virtualCamera'] ?? null) as Record<string, unknown> | null;
  if (cam !== undefined && was !== null) await command('setComponent', { entityId: cam.id, component: 'virtualCamera', value: { ...was, occlusion: OCCLUSION[mode] } });
  return {
    subject,
    undo: async () => {
      if (cam !== undefined && was !== null) await command('setComponent', { entityId: cam.id, component: 'virtualCamera', value: was }).catch((err: unknown) => console.error(`camera not set back: ${String(err)}`));
      for (const e of scene().filter((x) => x.name === BENCH_SUBJECT)) await command('deleteEntity', { entityId: e.id }).catch((err: unknown) => console.error(`subject not taken out: ${String(err)}`));
    },
  };
}

/** `--rooms MODE` (null: not asked). */
export function parseRoomsOption(argv: readonly string[]): RoomMode | null {
  const i = argv.indexOf('--rooms');
  if (i < 0) return null;
  const m = argv[i + 1] as RoomMode;
  if (!(ROOM_MODES as readonly string[]).includes(m)) throw new Error(`--rooms takes ${ROOM_MODES.join('|')}`);
  return m;
}
