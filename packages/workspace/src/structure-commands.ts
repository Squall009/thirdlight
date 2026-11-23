/**
 * Structures through the commands: a project command that makes, changes,
 * copies or deletes a `voxelStructure` object writes its voxels in the
 * backend, and the scene edit and the voxel writes are one step on the
 * project's one undo line (undo-timeline.ts).
 *
 * Before the project command runs, a structure it brings in is completed
 * here, in the command's own arguments (so the history holds what was
 * applied): a new structure gets the next free grid id of its world
 * (VoxelWorlds.nextGridId), its definition anchored (cell 0 at the minimum
 * corner of all it writes, `anchoredDefinition`: once, when it is made) and
 * the generator's version; a changed definition gets the generator's
 * version (the voxels are written by it); a pasted copy gets a new grid and
 * remembers the grid it was copied from. A definition the generator refuses
 * is refused before anything is applied, naming the field.
 *
 * After it, the structures of every scene are compared with before, by
 * (world, grid): a new one is written (or its source's voxels and overrides
 * copied), a changed definition regenerated (overrides kept by the fit rule,
 * misfits answered), a removed one's grid emptied. Each world's changes are
 * one stroke (VoxelWorlds.writeStructures), attached to the project entry;
 * when a write is refused, the strokes made and the project command are
 * taken back and the command is refused with the voxels' reason.
 *
 * A structure moved or turned rewrites no voxel: the far field under it
 * (where it stood and where it stands) is built again once the step is done,
 * forward or by undo and redo.
 *
 * Water bodies go the same way, after the structures (ground, buildings,
 * water): a command that makes, changes, moves or deletes a `waterBody`
 * object, or writes or moves a structure inside a body's reach, writes the
 * water as its own stroke a world (voxel-water.ts), attached to the same
 * project entry.
 */
import { randomBytes } from 'node:crypto';
import type { MutationResult } from '@thirdlight/commands';
import { sceneStructures, sceneWaterBodies, structureDefinitionOf, structurePlacementOf, type SceneWaterBody, type VoxelStructureComponent } from '@thirdlight/project-model';
import { anchoredDefinition, StructureDefinitionError, type CellBox, type GridPlacement, type StructureDefinition } from '@thirdlight/voxel';
import type { WorkspaceService } from './types';
import type { AttachedStroke, TimelineStep, UndoTimeline } from './undo-timeline';
import { dropStructureFollows, queueStructureFollow } from './structure-prop-follows';
import type { StructureChange } from './voxel-structure-writes';
import type { VoxelCommandApplied, VoxelStepDirection, VoxelWorldError, VoxelWorlds } from './voxel-worlds';
import { gridBoxInWorld, type WaterChange } from './voxel-water';
import { scenesHoldVoxelSplines, writeSplineChanges } from './spline-commands';

/** The ops whose arguments can bring a structure into a scene. */
const BRINGING_OPS: ReadonlySet<string> = new Set(['createEntity', 'createEntities', 'pasteEntities', 'setComponent']);

/** A structure as a scene holds it, by (world, grid). */
interface Held {
  readonly sceneId: string | null;
  readonly entityId: string;
  readonly component: VoxelStructureComponent;
  readonly place: GridPlacement | null;
  /** The definition's own fields as JSON (what a regenerate compares). */
  readonly def: string;
}

const keyOf = (world: string, grid: number): string => `${world}\u0000${grid}`;

function heldOf(scenes: readonly unknown[]): Map<string, Held> {
  const out = new Map<string, Held>();
  for (const s of sceneStructures(scenes)) {
    const c = s.component;
    const key = keyOf(c.world, c.grid);
    if (out.has(key)) continue;
    out.set(key, { sceneId: s.sceneId, entityId: s.entityId, component: c, place: s.transform === null ? null : structurePlacementOf(c.grid, s.transform), def: JSON.stringify(structureDefinitionOf(c as unknown as Record<string, unknown>)) });
  }
  return out;
}

const samePlace = (a: GridPlacement | null, b: GridPlacement | null): boolean => (a === null || b === null ? a === b : a.position.every((v, i) => v === b.position[i]) && a.yawRad === b.yawRad);

/** The structure ops' arguments, as the backend reads them (it composes the project command they run). */
export type StructureOpArgs = {
  op: 'regenerateStructures';
  /**
   * None: every structure object of the project whose voxels an older building generator wrote gets the
   * generator's version and its voxels written again by it (hand edits kept by the fit rule), the scene edit and
   * the voxels one undo step. The objects' scene: one at a time (several scenes are refused, naming how many).
   */
  args: Record<string, never>;
};

/** What a structure command answers beside the project result. */
export interface StructureCommandOutcome {
  readonly result: MutationResult;
  /** Each world's stroke (the voxels written), in world name order. */
  readonly voxels: readonly VoxelCommandApplied[];
  readonly strokes: readonly AttachedStroke[];
  /** The far field built again under structures moved, made or deleted (by world). */
  readonly far: ReadonlyArray<{ readonly world: string; readonly far: VoxelCommandApplied['far'] }>;
}

type Refusal = { ok: false; error: { code: string; cls: 'validation' | 'conflict' | 'not_found' | 'internal'; message: string; path?: string } };

const refusal = (code: string, cls: Refusal['error']['cls'], message: string, path?: string): Refusal => ({ ok: false, error: { code, cls, message, ...(path !== undefined ? { path } : {}) } });

export class StructureCommands {
  /** Per project and world, the world chunks each grid was last seen over (what the far field builds again when it goes or moves). */
  private readonly farSeen = new Map<string, Map<number, Array<readonly [number, number, number]>>>();

  constructor(
    private readonly service: Pick<WorkspaceService, 'runCommand' | 'readCapturedV3' | 'dropRedoTail'>,
    private readonly worlds: VoxelWorlds,
    private readonly timeline: UndoTimeline,
  ) {}

  private scenes(projectId: string): readonly unknown[] {
    const captured = this.service.readCapturedV3(projectId);
    return captured.ok ? [captured.read.scene, ...(captured.read.scenes ?? [])] : [];
  }

  /** Structures whose voxels an older generator wrote (the regenerate-all step is due for them). */
  outdated(projectId: string): Array<{ entityId: string; world: string; grid: number; generator: number }> {
    return sceneStructures(this.scenes(projectId))
      .filter((s) => s.component.generator < this.worlds.generator.version)
      .map((s) => ({ entityId: s.entityId, world: s.component.world, grid: s.component.grid, generator: s.component.generator }));
  }

  /** Whether a project envelope can change structures or water bodies (else it runs as any command). */
  touches(projectId: string, env: Record<string, unknown>): boolean {
    const args = BRINGING_OPS.has(String(env.op)) ? JSON.stringify(env.args ?? null) : '';
    if (args.includes('"voxelStructure"') || args.includes('"waterBody"') || args.includes('"voxels"')) return true;
    const scenes = this.scenes(projectId);
    return sceneStructures(scenes).length > 0 || sceneWaterBodies(scenes).length > 0 || scenesHoldVoxelSplines(scenes);
  }

  /**
   * A project mutation that may change structures: completed, applied, and its voxels written, as one step on the
   * line. A refusal of the structure part takes the project command back and answers why.
   */
  command(projectId: string, env: Record<string, unknown>): Promise<StructureCommandOutcome> {
    return this.timeline.structureCommand(projectId, async () => {
      const before = this.scenes(projectId);
      const held = heldOf(before);
      const prepared = await this.prepare(projectId, env, held);
      if (!prepared.ok) return { result: { ok: false, op: String(env.op), error: prepared.error } as MutationResult, voxels: [], strokes: [], far: [] };
      const result = this.service.runCommand(prepared.env);
      if (typeof env.requestId === 'string') dropStructureFollows(env.requestId);
      if (!result.ok || result.duplicated) return { result, voxels: [], strokes: [], far: [] };
      const scenesAfter = this.scenes(projectId);
      const after = heldOf(scenesAfter);
      await this.rememberFar(projectId, held);
      const written = await this.writeChanges(projectId, held, after, prepared.copies, result.requestId);
      // Ground, then buildings, then the splines' roads and rivers, then water: the bodies the command changed, and those round what it wrote.
      const splined = written.ok ? await writeSplineChanges(this.worlds, projectId, before, scenesAfter) : null;
      const wet = written.ok && splined?.ok === true ? await this.writeWater(projectId, before, scenesAfter, held, after, splined.boxes) : null;
      if (!written.ok || (splined !== null && !splined.ok) || (wet !== null && !wet.ok)) {
        const made = [...(written.ok ? written.voxels : []), ...(splined?.ok === true ? splined.voxels : [])];
        for (const done of made.reverse()) await this.worlds.step(projectId, done.world, 'undo', done.stroke, null);
        this.service.runCommand({ op: 'undo', projectId, requestId: `req-${randomBytes(16).toString('hex')}`, expectedRevision: result.revision, args: {} });
        this.service.dropRedoTail(projectId);
        const error = !written.ok ? written.error : splined !== null && !splined.ok ? splined.error : (wet as { ok: false; error: VoxelWorldError }).error;
        return { result: { ok: false, op: result.op, projectId, requestId: result.requestId, error } as MutationResult, voxels: [], strokes: [], far: [] };
      }
      const voxels = [...written.voxels, ...(splined?.ok === true ? splined.voxels : []), ...(wet?.ok === true ? wet.voxels : [])];
      const far = await this.followFar(projectId, held, after);
      return { result, voxels, strokes: voxels.map((v) => ({ world: v.world, stroke: v.stroke })), far };
    });
  }

  /** `undo` / `redo` on the line, then the far field under the structures the step moved, made or deleted. */
  async step(projectId: string, op: VoxelStepDirection, env: Record<string, unknown>): Promise<TimelineStep & { readonly far?: StructureCommandOutcome['far'] }> {
    const held = heldOf(this.scenes(projectId));
    await this.rememberFar(projectId, held);
    const step = await this.timeline.step(projectId, op, env);
    if (held.size === 0 && step.kind !== 'project') return step;
    const far = await this.followFar(projectId, held, heldOf(this.scenes(projectId)));
    return far.length > 0 ? { ...step, far } : step;
  }

  /**
   * Regenerate all (no structure stays pinned to an older generator): every structure an older generator wrote
   * gets the generator's version through one `setComponent` a scene (its objects in one transaction), and its voxels written again by this generator, the
   * scene edit and the voxels one step. Nothing outdated: `no_change`.
   */
  async regenerateAll(projectId: string, env: Record<string, unknown>): Promise<StructureCommandOutcome> {
    const outdated = sceneStructures(this.scenes(projectId)).filter((s) => s.component.generator < this.worlds.generator.version);
    const fail = (code: string, message: string): StructureCommandOutcome => ({ result: { ok: false, op: 'regenerateStructures', error: { code, cls: 'validation', message } } as unknown as MutationResult, voxels: [], strokes: [], far: [] });
    if (outdated.length === 0) return fail('no_change', `every structure is written by building generator ${this.worlds.generator.version}: nothing to regenerate`);
    const scenesOf = new Set(outdated.map((s) => s.sceneId));
    if (scenesOf.size > 1) return fail('invalid_args', `structures to regenerate are in ${scenesOf.size} scenes: send regenerateStructures with each scene's sceneId (one step a scene)`);
    const [first, ...rest] = outdated;
    const value = { generator: this.worlds.generator.version };
    const args: Record<string, unknown> = { entityId: first!.entityId, component: 'voxelStructure', value, ...(rest.length > 0 ? { entityIds: rest.map((s) => s.entityId) } : {}) };
    return this.command(projectId, { ...env, op: 'setComponent', args });
  }

  /** The envelope with its structures completed, and the copies' sources; or why it is refused. */
  private async prepare(projectId: string, env: Record<string, unknown>, held: ReadonlyMap<string, Held>): Promise<{ ok: true; env: Record<string, unknown>; copies: Map<string, number> } | Refusal> {
    const copies = new Map<string, number>();
    const op = String(env.op);
    if (!BRINGING_OPS.has(op) || typeof env.args !== 'object' || env.args === null) return { ok: true, env, copies };
    const args = structuredClone(env.args) as Record<string, unknown>;
    const gen = this.worlds.generator;
    const fresh = async (value: Record<string, unknown>, path: string): Promise<Record<string, unknown> | Refusal> => {
      const world = value['world'];
      if (typeof world !== 'string') return refusal('invalid_args', 'validation', 'a new structure names its voxel world (world)', `${path}/world`);
      let def: StructureDefinition;
      try {
        def = anchoredDefinition(gen.canonical({ ...structureDefinitionOf(value), generator: gen.version }));
      } catch (e) {
        if (e instanceof StructureDefinitionError) return refusal('invalid_structure', 'validation', e.message, `${path}${e.path}`);
        throw e;
      }
      const grid = await this.worlds.nextGridId(projectId, world);
      if (typeof grid !== 'number') return refusal(grid.error.code, grid.error.cls, grid.error.message, `${path}/world`);
      return { world, grid, ...def };
    };
    const intoStructure = async (components: unknown, path: string, paste: boolean): Promise<Refusal | null> => {
      if (typeof components !== 'object' || components === null) return null;
      const c = components as Record<string, unknown>;
      const v = c['voxelStructure'];
      if (typeof v !== 'object' || v === null) return null;
      const value = v as Record<string, unknown>;
      if (paste && typeof value['world'] === 'string' && typeof value['grid'] === 'number') {
        // A copy: a new grid, the voxels and overrides of the one it was copied from.
        const grid = await this.worlds.nextGridId(projectId, value['world']);
        if (typeof grid !== 'number') return refusal(grid.error.code, grid.error.cls, grid.error.message, `${path}/voxelStructure/world`);
        copies.set(keyOf(value['world'], grid), value['grid']);
        c['voxelStructure'] = { ...value, grid };
        return null;
      }
      const made = await fresh(value, `${path}/voxelStructure`);
      if ('ok' in made) return made as Refusal;
      c['voxelStructure'] = made;
      return null;
    };
    if (op === 'createEntity' || op === 'createEntities') {
      const walk = async (a: Record<string, unknown>, path: string): Promise<Refusal | null> => {
        const bad = await intoStructure(a['components'], `${path}/components`, false);
        if (bad !== null) return bad;
        const children = Array.isArray(a['children']) ? (a['children'] as Record<string, unknown>[]) : [];
        for (const [i, ch] of children.entries()) {
          const b = await walk(ch, `${path}/children/${i}`);
          if (b !== null) return b;
        }
        return null;
      };
      const list = op === 'createEntity' ? [args] : Array.isArray(args['entities']) ? (args['entities'] as Record<string, unknown>[]) : [];
      for (const [i, a] of list.entries()) {
        const bad = await walk(a, op === 'createEntity' ? '/args' : `/args/entities/${i}`);
        if (bad !== null) return bad;
      }
    } else if (op === 'pasteEntities') {
      const list = Array.isArray(args['entities']) ? (args['entities'] as Record<string, unknown>[]) : [];
      for (const [i, e] of list.entries()) {
        const bad = await intoStructure(e['components'], `/args/entities/${i}/components`, true);
        if (bad !== null) return bad;
      }
    } else if (args['component'] === 'voxelStructure') {
      const ids = [args['entityId'], ...(Array.isArray(args['entityIds']) ? args['entityIds'] : [])];
      const values = Array.isArray(args['values']) ? (args['values'] as unknown[]) : null;
      const byEntity = new Map([...held.values()].map((h) => [h.entityId, h]));
      for (const [i, id] of ids.entries()) {
        const own = i > 0 && values !== null;
        const path = own ? `/args/values/${i - 1}` : '/args/value';
        const value = (own ? values![i - 1] : args['value']) as Record<string, unknown> | null;
        if (value === null || typeof value !== 'object') continue;
        const current = typeof id === 'string' ? byEntity.get(id) : undefined;
        let next: Record<string, unknown>;
        if (current === undefined) {
          const made = await fresh(value, path);
          if ('ok' in made) return made as Refusal;
          next = made;
        } else {
          for (const k of ['world', 'grid'] as const) {
            if (value[k] !== undefined && value[k] !== current.component[k]) return refusal('invalid_args', 'validation', `a structure's ${k} is fixed: it owns grid ${current.component.grid} of world "${current.component.world}" (copy it, or make a new structure)`, `${path}/${k}`);
          }
          const merged = { ...structureDefinitionOf(current.component as unknown as Record<string, unknown>), ...structureDefinitionOf(value), generator: gen.version };
          try {
            gen.canonical(merged);
          } catch (e) {
            if (e instanceof StructureDefinitionError) return refusal('invalid_structure', 'validation', e.message, `${path}${e.path}`);
            throw e;
          }
          // Any change of the definition is written by this generator: the version follows it.
          next = { ...value, generator: gen.version };
        }
        if (own) values![i - 1] = next;
        else args['value'] = next;
        // An opening removed (or its prop cleared) while its prop stands: the prop goes with it, in the same step.
        if (current !== undefined && ids.length === 1) {
          const gone = this.orphanedProps(projectId, current, next);
          if (gone.length > 0 && typeof env.requestId === 'string') {
            queueStructureFollow(env.requestId, { entityId: current.entityId, component: 'voxelStructure', restore: current.component, next: { ...current.component, ...next } });
            const [first, ...rest] = gone;
            return { ok: true, env: { ...env, op: 'deleteEntity', args: { entityId: first, ...(rest.length > 0 ? { entityIds: rest } : {}) } }, copies };
          }
        }
      }
    }
    return { ok: true, env: { ...env, args }, copies };
  }

  /** The prop objects (the structure's children) its openings name now and no longer name with `next`'s openings. */
  private orphanedProps(projectId: string, current: Held, next: Record<string, unknown>): string[] {
    if (!Array.isArray(next['openings'])) return [];
    const kept = new Set((next['openings'] as Array<{ prop?: unknown }>).flatMap((o) => (typeof o?.prop === 'string' ? [o.prop] : [])));
    const children = new Set<string>();
    for (const sc of this.scenes(projectId)) {
      for (const e of ((sc as { entities?: Array<{ id?: unknown; parentId?: unknown }> }).entities ?? [])) if (e.parentId === current.entityId && typeof e.id === 'string') children.add(e.id);
    }
    return [...new Set(current.component.openings.flatMap((o) => (o.prop !== undefined && !kept.has(o.prop) && children.has(o.prop) ? [o.prop] : [])))];
  }

  /** The voxels of what the command changed, a stroke a world; or the refusal (every stroke made taken back). */
  private async writeChanges(projectId: string, before: ReadonlyMap<string, Held>, after: ReadonlyMap<string, Held>, copies: ReadonlyMap<string, number>, requestId: string): Promise<{ ok: true; voxels: VoxelCommandApplied[] } | { ok: false; error: VoxelWorldError }> {
    const gen = this.worlds.generator;
    const byWorld = new Map<string, StructureChange[]>();
    const add = (world: string, ch: StructureChange): void => void (byWorld.get(world) ?? byWorld.set(world, []).get(world)!).push(ch);
    const scenes = this.scenes(projectId);
    for (const [key, h] of after) {
      const was = before.get(key);
      if (was !== undefined && was.def === h.def) continue;
      // A structure stands in the scene of its world's object.
      const scene = scenes.find((s) => ((s as { sceneId?: string }).sceneId ?? null) === h.sceneId) as { entities?: Array<{ components?: { voxelWorld?: { world?: unknown } } }> } | undefined;
      if (!(scene?.entities ?? []).some((e) => e.components?.voxelWorld?.world === h.component.world)) {
        return { ok: false, error: { code: 'reference_missing', cls: 'validation', message: `structure ${h.entityId} names voxel world "${h.component.world}", which no voxelWorld object of its scene names: a structure stands in the scene of its world`, path: '/components/voxelStructure/world' } };
      }
      const from = copies.get(key);
      if (was === undefined && from !== undefined && (await this.gridListed(projectId, h.component.world, from))) {
        add(h.component.world, { kind: 'copy', grid: h.component.grid, from });
        continue;
      }
      let definition: StructureDefinition;
      let previous: StructureDefinition | null = null;
      try {
        definition = gen.canonical(structureDefinitionOf(h.component as unknown as Record<string, unknown>));
        if (was !== undefined) previous = gen.canonical({ ...JSON.parse(was.def), generator: Math.min(gen.version, was.component.generator) });
      } catch (e) {
        if (e instanceof StructureDefinitionError) return { ok: false, error: { code: 'invalid_structure', cls: 'validation', message: e.message, path: `/components/voxelStructure${e.path}` } };
        throw e;
      }
      add(h.component.world, { kind: 'write', grid: h.component.grid, definition, previous });
    }
    for (const [key, h] of before) if (!after.has(key)) add(h.component.world, { kind: 'delete', grid: h.component.grid });
    const voxels: VoxelCommandApplied[] = [];
    for (const world of [...byWorld.keys()].sort()) {
      const r = await this.worlds.writeStructures(projectId, world, byWorld.get(world)!, null);
      if (r.ok) {
        voxels.push(r);
        continue;
      }
      if (r.error.code === 'no_change') continue;
      for (const done of voxels.reverse()) await this.worlds.step(projectId, done.world, 'undo', done.stroke, null);
      void requestId;
      return { ok: false, error: r.error };
    }
    return { ok: true, voxels };
  }

  /**
   * The command's water, a stroke a world after its structures': each body it made, changed, moved or deleted, and
   * the bodies round the structures it made, changed, moved or deleted (their world cells before and after). A body
   * whose scene holds no `voxelWorld` object naming its world is refused, as a structure is.
   */
  private async writeWater(projectId: string, scenesBefore: readonly unknown[], scenes: readonly unknown[], before: ReadonlyMap<string, Held>, after: ReadonlyMap<string, Held>, splines: ReadonlyMap<string, CellBox[]>): Promise<{ ok: true; voxels: VoxelCommandApplied[] } | { ok: false; error: VoxelWorldError }> {
    const was = new Map(sceneWaterBodies(scenesBefore).map((b) => [b.entityId, b]));
    const now = new Map(sceneWaterBodies(scenes).map((b) => [b.entityId, b]));
    const same = (a: SceneWaterBody, b: SceneWaterBody): boolean => JSON.stringify([a.body, a.seed]) === JSON.stringify([b.body, b.seed]);
    const changes = new Map<string, WaterChange[]>();
    const add = (world: string, ch: WaterChange): void => void (changes.get(world) ?? changes.set(world, []).get(world)!).push(ch);
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      const a = was.get(id) ?? null;
      const b = now.get(id) ?? null;
      if (a !== null && b !== null && same(a, b)) continue;
      if (b !== null) {
        const scene = scenes.find((s) => ((s as { sceneId?: string }).sceneId ?? null) === b.sceneId) as { entities?: Array<{ components?: { voxelWorld?: { world?: unknown } } }> } | undefined;
        if (!(scene?.entities ?? []).some((e) => e.components?.voxelWorld?.world === b.body.world)) {
          return { ok: false, error: { code: 'reference_missing', cls: 'validation', message: `water body ${b.entityId} names voxel world "${b.body.world}", which no voxelWorld object of its scene names: a body stands in the scene of its world`, path: '/components/waterBody/world' } };
        }
      }
      for (const world of new Set([a?.body.world, b?.body.world].filter((x): x is string => x !== undefined))) add(world, { before: a, after: b });
    }
    // The world cells under every structure the command wrote or moved, where it stood and where it stands.
    const boxes = new Map<string, CellBox[]>();
    const gen = this.worlds.generator;
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(key);
      const y = after.get(key);
      if (x !== undefined && y !== undefined && samePlace(x.place, y.place) && x.def === y.def) continue;
      for (const h of [x, y]) {
        if (h === undefined || h.place === null) continue;
        let cells: CellBox;
        try {
          cells = gen.box(gen.canonical(structureDefinitionOf(h.component as unknown as Record<string, unknown>)));
        } catch {
          continue;
        }
        (boxes.get(h.component.world) ?? boxes.set(h.component.world, []).get(h.component.world)!).push(gridBoxInWorld(cells, h.place));
      }
    }
    // And the world cells the splines changed.
    for (const [world, b] of splines) (boxes.get(world) ?? boxes.set(world, []).get(world)!).push(...b);
    const voxels: VoxelCommandApplied[] = [];
    const bodiesIn = (world: string): boolean => [...now.values()].some((b) => b.body.world === world);
    for (const world of [...new Set([...changes.keys(), ...boxes.keys()])].sort()) {
      const ch = changes.get(world) ?? [];
      const bx = bodiesIn(world) ? (boxes.get(world) ?? []) : [];
      if (ch.length === 0 && bx.length === 0) continue;
      const r = await this.worlds.writeWater(projectId, world, ch, bx, null);
      if (r.ok) {
        voxels.push(r);
        continue;
      }
      if (r.error.code === 'no_change') continue;
      for (const done of voxels.reverse()) await this.worlds.step(projectId, done.world, 'undo', done.stroke, null);
      return { ok: false, error: r.error };
    }
    return { ok: true, voxels };
  }

  private async gridListed(projectId: string, world: string, grid: number): Promise<boolean> {
    const info = await this.worlds.info(projectId, world);
    return info.ok && info.manifest.grids.some((g) => g.id === grid);
  }

  /**
   * The world chunks every placed structure lies over now, for those not seen yet (read from their files before a
   * step may empty them): what the far field builds again once a structure goes or moves.
   */
  private async rememberFar(projectId: string, held: ReadonlyMap<string, Held>): Promise<void> {
    const byWorld = new Map<string, GridPlacement[]>();
    for (const h of held.values()) {
      const seen = this.farSeen.get(`${projectId}\u0000${h.component.world}`);
      if (h.place === null || seen?.has(h.component.grid) === true) continue;
      (byWorld.get(h.component.world) ?? byWorld.set(h.component.world, []).get(h.component.world)!).push(h.place);
    }
    for (const [world, places] of byWorld) {
      const got = await this.worlds.gridFarChunks(projectId, world, places);
      if (got.size === 0) continue;
      const key = `${projectId}\u0000${world}`;
      const seen = this.farSeen.get(key) ?? this.farSeen.set(key, new Map()).get(key)!;
      for (const [g, chunks] of got) seen.set(g, chunks);
    }
  }

  /**
   * The far field under every structure whose place, definition or presence changed between `before` and `after`,
   * built again: the chunks it was last seen over and the chunks it lies over now.
   */
  private async followFar(projectId: string, before: ReadonlyMap<string, Held>, after: ReadonlyMap<string, Held>): Promise<Array<{ world: string; far: VoxelCommandApplied['far'] }>> {
    const changed = new Map<string, Set<number>>();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key);
      const b = after.get(key);
      if (a !== undefined && b !== undefined && samePlace(a.place, b.place) && a.def === b.def) continue;
      const h = (b ?? a)!;
      (changed.get(h.component.world) ?? changed.set(h.component.world, new Set()).get(h.component.world)!).add(h.component.grid);
    }
    const out: Array<{ world: string; far: VoxelCommandApplied['far'] }> = [];
    for (const [world, grids] of changed) {
      const seenKey = `${projectId}\u0000${world}`;
      const seen = this.farSeen.get(seenKey) ?? this.farSeen.set(seenKey, new Map()).get(seenKey)!;
      const places = [...grids].flatMap((g) => {
        const p = after.get(keyOf(world, g))?.place;
        return p === undefined || p === null ? [] : [p];
      });
      const now = await this.worlds.gridFarChunks(projectId, world, places);
      const chunks: Array<readonly [number, number, number]> = [];
      for (const g of grids) {
        chunks.push(...(seen.get(g) ?? []), ...(now.get(g) ?? []));
        const n = now.get(g);
        if (n !== undefined) seen.set(g, n);
        else seen.delete(g);
      }
      if (chunks.length > 0) out.push({ world, far: await this.worlds.farFollow(projectId, world, chunks) });
    }
    return out;
  }
}
