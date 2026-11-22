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
 */
import { randomBytes } from 'node:crypto';
import type { MutationResult } from '@thirdlight/commands';
import { sceneStructures, structureDefinitionOf, structurePlacementOf, type VoxelStructureComponent } from '@thirdlight/project-model';
import { anchoredDefinition, StructureDefinitionError, type GridPlacement, type StructureDefinition } from '@thirdlight/voxel';
import type { WorkspaceService } from './types';
import type { AttachedStroke, TimelineStep, UndoTimeline } from './undo-timeline';
import type { StructureChange } from './voxel-structure-writes';
import type { VoxelCommandApplied, VoxelStepDirection, VoxelWorldError, VoxelWorlds } from './voxel-worlds';

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

  /** Whether a project envelope can change structures (else it runs as any command). */
  touches(projectId: string, env: Record<string, unknown>): boolean {
    if (BRINGING_OPS.has(String(env.op)) && JSON.stringify(env.args ?? null).includes('"voxelStructure"')) return true;
    return sceneStructures(this.scenes(projectId)).length > 0;
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
      if (!result.ok || result.duplicated) return { result, voxels: [], strokes: [], far: [] };
      const after = heldOf(this.scenes(projectId));
      await this.rememberFar(projectId, held);
      const written = await this.writeChanges(projectId, held, after, prepared.copies, result.requestId);
      if (!written.ok) {
        this.service.runCommand({ op: 'undo', projectId, requestId: `req-${randomBytes(16).toString('hex')}`, expectedRevision: result.revision, args: {} });
        this.service.dropRedoTail(projectId);
        return { result: { ok: false, op: result.op, projectId, requestId: result.requestId, error: written.error } as MutationResult, voxels: [], strokes: [], far: [] };
      }
      const far = await this.followFar(projectId, held, after);
      return { result, voxels: written.voxels, strokes: written.voxels.map((v) => ({ world: v.world, stroke: v.stroke })), far };
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
   * Regenerate all (R34): every structure an older generator wrote gets the generator's version through one
   * `setComponent` a scene (its objects in one transaction), and its voxels written again by this generator, the
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
      }
    }
    return { ok: true, env: { ...env, args }, copies };
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
