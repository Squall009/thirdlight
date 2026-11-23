/**
 * The host's follow-ups of a command for the props standing in structures'
 * openings (a door leaf, a pane: a child object of the structure with a
 * `voxelPortal`), written in the command's own transaction (`applyFollows`:
 * one revision, one undo step with the command, for the editor and MCP
 * alike).
 *
 * An opening names its prop (`openings[].prop`, the prop object's id); the
 * prop stands in the opening as a child of the structure, in the
 * structure's own frame, so it follows a move, a turn and a regenerate by
 * itself. What a command can change besides:
 * - **An opening moved or resized** (its edge, place, storey, sill, width or
 *   height): its prop keeps where it stood relative to the opening's frame
 *   (`followOpening`): its transform is written with the command.
 * - **A prop object deleted**: the opening that named it is left without a
 *   prop (an open hole); the hole stays until the opening is removed.
 * - **A new `voxelPortal` child of a structure standing inside an opening
 *   without a prop** (the structure mode's prop choice is that one
 *   `createEntity`): the opening names it.
 * - **A copy** (a pasted structure with its children): an opening naming a
 *   prop that is not the structure's own child names the child with a
 *   portal standing in it instead, or none.
 * - **An opening removed, or its prop cleared, while its prop still stands**:
 *   the structure commands send the prop's deletion with the new definition
 *   as its follow-up ({@link queueStructureFollow}), so the prop goes in the
 *   same step.
 *
 * Nothing here reads a prop's model: whether a prop still fits its opening
 * after a resize is the structure mode's to show (a prop that no longer fits
 * is kept, never deleted silently).
 */
import type { ComponentFollow, SceneDocument } from '@thirdlight/commands';
import { followOpening, openingFrame, VOXEL_SIZE_M, OPENING_PROP_FIT_TOLERANCE_M, type OpeningFrame, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';

interface Ent {
  readonly id: string;
  readonly parentId?: string | null;
  readonly components: Record<string, unknown>;
}

type Transform = { position: number[]; rotation: number[]; scale: number[] };

/** Follow-ups the structure commands queued for a request (by request id), taken by the command's run. */
const queued = new Map<string, ComponentFollow[]>();

/** A follow-up the next run of request `requestId` writes with its command (the structure commands' rewritten op). */
export function queueStructureFollow(requestId: string, follow: ComponentFollow): void {
  const list = queued.get(requestId) ?? [];
  list.push(follow);
  queued.set(requestId, list);
}

/** Drops what was queued for a request that did not run. */
export function dropStructureFollows(requestId: string): void {
  queued.delete(requestId);
}

const defOf = (c: unknown): StructureDefinition | null => {
  const v = c as Partial<StructureDefinition> | undefined;
  return v === undefined || !Array.isArray(v.footprint) || !Array.isArray(v.openings) ? null : (v as StructureDefinition);
};

/** Whether a point (the structure's frame, metres) stands inside an opening's frame: across its width, from its sill up its height, within the wall's thickness. */
export function standsInOpening(p: readonly number[], f: OpeningFrame): boolean {
  const t = OPENING_PROP_FIT_TOLERANCE_M;
  const dx = p[0]! - f.position[0];
  const dz = p[2]! - f.position[2];
  const c = Math.cos(f.yawRad);
  const s = Math.sin(f.yawRad);
  // Into the frame: R(−yaw).
  const along = c * dx - s * dz;
  const through = s * dx + c * dz;
  const up = p[1]! - f.position[1];
  return Math.abs(along) <= f.size[0] / 2 + t && up >= -t && up <= f.size[1] + t && Math.abs(through) <= VOXEL_SIZE_M / 2 + t;
}

const sameFrame = (a: OpeningFrame | null, b: OpeningFrame | null): boolean =>
  a !== null && b !== null && a.yawRad === b.yawRad && a.position.every((v, i) => v === b.position[i]) && a.size.every((v, i) => v === b.size[i]);

/**
 * The follow-ups of a command from the scene before it to the scene after it (and any the structure commands queued
 * for its request): transforms of props whose openings moved, structures whose openings' `prop` changed.
 */
export function planStructurePropFollows(before: SceneDocument, after: SceneDocument, requestId: string): ComponentFollow[] {
  const own = queued.get(requestId) ?? [];
  queued.delete(requestId);
  const was = new Map((before.entities as unknown as Ent[]).map((e) => [e.id, e]));
  const now = new Map((after.entities as unknown as Ent[]).map((e) => [e.id, e]));
  const follows: ComponentFollow[] = [];
  const children = new Map<string, Ent[]>();
  for (const e of now.values()) {
    if (e.parentId === undefined || e.parentId === null || e.components['voxelPortal'] === undefined) continue;
    (children.get(e.parentId) ?? children.set(e.parentId, []).get(e.parentId)!).push(e);
  }
  for (const s of now.values()) {
    const comp = s.components['voxelStructure'] as Record<string, unknown> | undefined;
    const def = defOf(comp);
    if (comp === undefined || def === null) continue;
    const prev = defOf(was.get(s.id)?.components['voxelStructure']);
    const prevOpening = new Map((prev?.openings ?? []).map((o) => [o.id, o]));
    const mine = children.get(s.id) ?? [];
    const named = new Set(def.openings.flatMap((o) => (o.prop !== undefined ? [o.prop] : [])));
    let changed = false;
    const openings: StructureOpening[] = def.openings.map((o) => {
      const frame = openingFrame(def, o);
      let prop = o.prop;
      const child = prop === undefined ? undefined : now.get(prop);
      if (prop !== undefined && (child === undefined || child.parentId !== s.id)) {
        // Gone, or another structure's (a copy names its source's prop): the child standing in it, else none.
        const stand = frame === null ? undefined : mine.find((c) => !named.has(c.id) && standsInOpening(((c.components['transform'] as Transform | undefined)?.position ?? [0, 0, 0]), frame));
        prop = stand?.id;
      } else if (prop === undefined && frame !== null) {
        // A new portal child standing in an opening without a prop.
        const stand = mine.find((c) => !was.has(c.id) && !named.has(c.id) && standsInOpening(((c.components['transform'] as Transform | undefined)?.position ?? [0, 0, 0]), frame));
        prop = stand?.id;
      }
      if (prop !== undefined) named.add(prop);
      // The opening moved or resized: its prop keeps its place relative to it.
      const before = prevOpening.get(o.id);
      const p = prop === undefined ? undefined : now.get(prop);
      if (before !== undefined && prev !== null && p !== undefined && p.parentId === s.id && prop === before.prop) {
        const from = openingFrame(prev, before);
        const t = p.components['transform'] as Transform | undefined;
        const tWas = was.get(p.id)?.components['transform'] as Transform | undefined;
        const untouched = t !== undefined && tWas !== undefined && JSON.stringify(t) === JSON.stringify(tWas);
        if (from !== null && frame !== null && !sameFrame(from, frame) && untouched) {
          const moved = followOpening(t, from, frame);
          follows.push({ entityId: p.id, component: 'transform', restore: t, next: { position: moved.position, rotation: moved.rotation, scale: [...t.scale] } });
        }
      }
      if (prop === o.prop) return o;
      changed = true;
      const { prop: _p, ...rest } = o;
      return prop === undefined ? rest : { ...rest, prop };
    });
    if (changed && !own.some((f) => f.entityId === s.id && f.component === 'voxelStructure')) follows.push({ entityId: s.id, component: 'voxelStructure', restore: comp, next: { ...comp, openings } });
  }
  return [...own, ...follows];
}
