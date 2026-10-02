/**
 * The `socketAttach` component (v4 scenes) — the entity rides on
 * a named node (a bone or any node) of another entity's model, with a local
 * offset: equipment in a hand, a rider on a mount, a pilot in a cockpit, a
 * muzzle flash on a barrel.
 *
 * - `target`: the entity whose model carries the node (its `model`); its
 *   animator (when it has one) moves the node, the simulation resolves the
 *   attached entity's pose in every fixed step (so page, worker, export and
 *   replays agree).
 * - `node`: the node's name as the model file names it (the Inspector lists
 *   the target model's nodes).
 * - `position` / `rotation` / `scale`: the offset in the node's space
 *   (absent: none — the entity sits exactly on the node).
 * - `attached`: attached from the start (absent: true); false keeps the
 *   socket as data a script attaches later (`ctx.sockets.attach(id)`).
 *
 * Scripts attach and detach at run time (`ctx.sockets`); a detach keeps the
 * world pose (the entity stays where the node left it) or snaps back to the
 * entity's own transform.
 *
 * Pure: no I/O, no three.js.
 */
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';

export interface SocketAttachComponent {
  target: string;
  node: string;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  attached?: boolean;
}

export const SOCKET_ATTACH_FIELDS = ['target', 'node', 'position', 'rotation', 'scale', 'attached'] as const;

/**
 * Engine limits: node names as a GLB stores them (at most 128 characters);
 * offsets within 10 km of the node (a socket is on or near its model); a
 * scale 0.001–1000 per axis (a positive scale — the pose stays a rotation
 * and scale, never a mirror or a collapse).
 */
export const SOCKET_ATTACH_LIMITS = Object.freeze({ nodeName: 128, offset: 10_000, scaleMin: 0.001, scaleMax: 1000 });

const ENTITY_ID_RE = ID_RE;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec = (v: unknown, n: number, lo: number, hi: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => num(x, lo, hi));

export function validateSocketAttachComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a socketAttach component is an object { target, node, position?, rotation?, scale?, attached? }', value);
  for (const k of Object.keys(value)) {
    if (!(SOCKET_ATTACH_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, SOCKET_ATTACH_FIELDS.join(', '));
  }
  const target = value['target'];
  if (target === undefined) err(errors, 'field_missing', `${path}/target`, '"target" is required (the entity whose model carries the node)', undefined, 'target');
  else if (typeof target !== 'string' || !ENTITY_ID_RE.test(target)) err(errors, 'field_value', `${path}/target`, 'target names an entity (an entity id)', target);
  const node = value['node'];
  if (node === undefined) err(errors, 'field_missing', `${path}/node`, '"node" is required (a node or bone name of the target\'s model)', undefined, 'node');
  else if (typeof node !== 'string' || node.length === 0 || node.length > SOCKET_ATTACH_LIMITS.nodeName || /[\u0000-\u001f]/.test(node)) {
    err(errors, 'field_value', `${path}/node`, `node is a node name (1–${SOCKET_ATTACH_LIMITS.nodeName} characters, no control characters)`, node);
  }
  const L = SOCKET_ATTACH_LIMITS;
  if (value['position'] !== undefined && !vec(value['position'], 3, -L.offset, L.offset)) err(errors, 'field_value', `${path}/position`, `position is [x, y, z] metres in the node's space, each ±${L.offset}`, value['position']);
  const r = value['rotation'];
  if (r !== undefined) {
    if (!vec(r, 4, -1.0001, 1.0001)) err(errors, 'field_value', `${path}/rotation`, 'rotation is a quaternion [x, y, z, w]', r);
    else if (Math.abs(Math.hypot(...(r as number[])) - 1) > 1e-4) err(errors, 'field_value', `${path}/rotation`, 'rotation quaternion must have unit length within 1e-4', r);
  }
  if (value['scale'] !== undefined && !vec(value['scale'], 3, L.scaleMin, L.scaleMax)) err(errors, 'field_value', `${path}/scale`, `scale is [x, y, z], each ${L.scaleMin}–${L.scaleMax}`, value['scale']);
  if (value['attached'] !== undefined && typeof value['attached'] !== 'boolean') err(errors, 'field_type', `${path}/attached`, 'attached is true or false', value['attached']);
}

export function canonicalSocketAttach(c: SocketAttachComponent): SocketAttachComponent {
  return {
    target: c.target,
    node: c.node,
    ...(c.position !== undefined ? { position: [c.position[0], c.position[1], c.position[2]] as [number, number, number] } : {}),
    ...(c.rotation !== undefined ? { rotation: [c.rotation[0], c.rotation[1], c.rotation[2], c.rotation[3]] as [number, number, number, number] } : {}),
    ...(c.scale !== undefined ? { scale: [c.scale[0], c.scale[1], c.scale[2]] as [number, number, number] } : {}),
    ...(c.attached !== undefined ? { attached: c.attached } : {}),
  };
}

/** The components an attached entity cannot carry (physics bodies are posed by physics). */
export const SOCKET_ATTACH_CONFLICTS = ['collider', 'controller', 'mover'] as const;
