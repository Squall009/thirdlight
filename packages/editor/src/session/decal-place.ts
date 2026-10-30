/**
 * The Scene view's Decal tool, as data: the tool's settings, the frame a
 * decal takes on a surface, the turn and size of a stamp, and the one
 * command a placement is.
 *
 * - A decal projects along its object's −Z with its image in the XY plane
 *   (+Y up), so a placement turns the object's +Z onto the surface normal.
 *   The image's top points up the slope on walls and slopes, and toward −Z
 *   on floors and ceilings (where "up the slope" has no direction), then
 *   turns by the tool's angle about the normal.
 * - A stamp (Shift+click) adds a random turn and size drawn from the seed
 *   and the stamp's number, so the same clicks with the same seed give the
 *   same decals.
 * - A placement is ONE `createEntity` carrying the decal component (one
 *   undo step), the command MCP sends for a decal too.
 *
 * Pure: no DOM, no three.js.
 */
import { mulberry32 } from '@thirdlight/shared';
import type { DecalComponent, DecalMode } from '@thirdlight/project-model';
import { DECAL_LIMITS, DECAL_MODES } from '@thirdlight/runtime';

type V3 = readonly [number, number, number];
export type Quat = [number, number, number, number];

/** The random part of a stamp: a turn of up to ± `turn` degrees about the normal, a size factor in [scaleMin, scaleMax]. */
export interface DecalStampSettings {
  turn: number;
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

export interface DecalToolSettings {
  /** The decal material placed (null: none chosen yet). */
  material: string | null;
  mode: DecalMode;
  /** [width, height, depth] in metres: the box a click places. */
  size: [number, number, number];
  /** Degrees about the normal a click turns the image by. */
  angle: number;
  stamp: DecalStampSettings;
}

export const DECAL_TOOL_DEFAULTS: DecalToolSettings = {
  material: null,
  mode: 'projected',
  size: [1, 1, 0.5],
  angle: 0,
  stamp: { turn: 180, scaleMin: 0.75, scaleMax: 1.25, seed: 1 },
};

/** The largest stamp size factor (a stamp is the tool's size give or take, not a different decal). */
export const DECAL_STAMP_SCALE_MAX = 10;

/** Why settings cannot place a decal (null: they can; a missing material is not checked here). */
export function decalToolSettingsError(s: DecalToolSettings): string | null {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!DECAL_MODES.includes(s.mode)) return `mode is ${DECAL_MODES.join(' or ')}`;
  if (!Array.isArray(s.size) || s.size.length !== 3 || !s.size.every((v) => finite(v) && v > 0 && v <= DECAL_LIMITS.sizeMax)) return `width, height and depth are metres above 0, at most ${DECAL_LIMITS.sizeMax}`;
  if (!finite(s.angle)) return 'the angle is a number of degrees';
  const st = s.stamp;
  if (!finite(st.turn) || st.turn < 0 || st.turn > 180) return 'the stamp turn is 0 to 180 degrees';
  if (!finite(st.scaleMin) || !finite(st.scaleMax) || st.scaleMin <= 0 || st.scaleMax < st.scaleMin || st.scaleMax > DECAL_STAMP_SCALE_MAX) return `the stamp sizes are factors above 0, min ≤ max ≤ ${DECAL_STAMP_SCALE_MAX}`;
  if (!Number.isInteger(st.seed) || st.seed < 0 || st.seed > 0xffffffff) return 'the seed is a whole number from 0';
  return null;
}

/** Past this |cos| between the normal and up, a surface counts as a floor or ceiling (the image's top then points to −Z). */
const LEVEL_COS = 0.999;

const norm = (v: V3): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The rotation of a decal on a surface of this normal (world), its image turned `angle` degrees about it. */
export function decalFrame(normal: V3, angle: number): Quat {
  const z = norm(normal);
  const level = Math.abs(z[1]) > LEVEL_COS;
  const ref: V3 = level ? [0, 0, -1] : [0, 1, 0];
  const d = ref[0] * z[0] + ref[1] * z[1] + ref[2] * z[2];
  const y0 = norm([ref[0] - d * z[0], ref[1] - d * z[1], ref[2] - d * z[2]]);
  const x0 = cross(y0, z);
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x: V3 = [x0[0] * c + y0[0] * s, x0[1] * c + y0[1] * s, x0[2] * c + y0[2] * s];
  const y = cross(z, x);
  return quatFromBasis(x, y, z);
}

/** The quaternion of the rotation whose columns are x, y, z (an orthonormal right-handed basis). */
function quatFromBasis(x: V3, y: V3, z: V3): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  // One sign for one rotation (w ≥ 0), so equal frames store equal numbers.
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** `rotation` turned `degrees` about its own Z (the decal's normal): what the turn handle stores. */
export function turnAboutNormal(rotation: readonly number[], degrees: number): Quat {
  const h = (degrees * Math.PI) / 360;
  const [bx, by, bz, bw] = [0, 0, Math.sin(h), Math.cos(h)];
  const [ax, ay, az, aw] = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
  const q: Quat = [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** The `index`-th stamp's extra turn (degrees) and size factor. */
export function decalStamp(stamp: DecalStampSettings, index: number): { turn: number; scale: number } {
  const rnd = mulberry32((stamp.seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const a = rnd();
  const b = rnd();
  return { turn: (a * 2 - 1) * stamp.turn, scale: stamp.scaleMin + b * (stamp.scaleMax - stamp.scaleMin) };
}

const mm = (v: number): number => Math.round(v * 1000) / 1000;
const fine = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The decal component a placement stores (absent fields keep the component's defaults). */
export function decalOf(s: DecalToolSettings, material: string, scale = 1): DecalComponent {
  const size: [number, number, number] = [mm(s.size[0] * scale), mm(s.size[1] * scale), mm(s.size[2])];
  return { size: size.map((v) => Math.min(DECAL_LIMITS.sizeMax, Math.max(0.001, v))) as [number, number, number], material, ...(s.mode !== 'projected' ? { mode: s.mode } : {}) };
}

/** Where and how a decal lands: its place, rotation and component (a stamp: `stamp` is its number). */
export function decalPlacement(s: DecalToolSettings, material: string, at: V3, normal: V3, stamp: number | null): { position: [number, number, number]; rotation: Quat; decal: DecalComponent } {
  const extra = stamp === null ? { turn: 0, scale: 1 } : decalStamp(s.stamp, stamp);
  const rotation = decalFrame(normal, s.angle + extra.turn).map(fine) as Quat;
  return { position: [mm(at[0]), mm(at[1]), mm(at[2])], rotation, decal: decalOf(s, material, extra.scale) };
}

/** The one command that places a decal (an object with the decal component in `sceneId`). */
export function decalPlaceCommand(sceneId: string | null, name: string, p: { position: readonly number[]; rotation: readonly number[]; decal: DecalComponent }): { op: 'createEntity'; args: Record<string, unknown> } {
  return {
    op: 'createEntity',
    args: { ...(sceneId !== null ? { sceneId } : {}), kind: 'group', name, transform: { position: [...p.position], rotation: [...p.rotation] }, components: { decal: p.decal } },
  };
}
