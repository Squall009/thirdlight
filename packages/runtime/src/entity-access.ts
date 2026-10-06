/**
 * Generic component access — `ctx.entity(ref).get` and
 * `.set`, relaxed transform ownership and the runtime behavior of every
 * field the descriptors mark `runtimeWritable`.
 *
 * - `get(component)` is a read-only snapshot of the component's
 *   script-readable fields as they stood at the start of the step (writes of
 *   this step are applied at its end; a transform is the step-start one).
 * - `set(component, patch)` is checked at once against the descriptors
 *   (project-model `checkScriptPatch`) and what only the runtime knows (a
 *   physics body, the camera, a static object…); a refused write returns the
 *   problem naming the field (and is noted in diagnostics once per step and
 *   field). An accepted one is queued and applied at the end of the step in
 *   call order: script order, the same in the page and the worker, so replays
 *   stay identical. Two writes of one field in a step: the later wins and the
 *   conflict is reported in diagnostics (`entity_write`, reason `conflict`).
 * - Relaxed ownership: any script may write the transform of an object that
 *   is neither a physics body nor the camera (nor static, nor posed every
 *   step by its mover, patrol, socket or facing). Physics bodies keep their
 *   dedicated intents (`character_place`).
 *
 * The writable fields and what they do:
 * - `object.active` — off: the object and its children are not drawn (their
 *   lights and effects neither), collide with nothing (their colliders leave
 *   the physics world), fire no trigger or switch and do not tick (scripts,
 *   movers, patrols, hitboxes, collectibles, animators, facing, audio
 *   sources). On again: all of it comes back where the object is now.
 * - `object.visible` — the object (with its children) is drawn or not
 *   (`ctx.game.setVisible`'s state).
 * - `transform.position/rotation/scale` — the object's local transform.
 * - `light.color/intensity/range` — the realized light's values (range: point
 *   and spot lights; environment presets blend over the written values).
 * - `light.lightMask/shadowCasterMask` — the light layers it lights and whose
 *   objects cast its shadow.
 * - `mover.speed/active` — its travel speed, and whether it moves (a held
 *   mover stays where it is, solid).
 * - `materialParams` — parameter values of the graph materials the object
 *   wears (`null`: back to the authored value), as `ctx.materials.set`.
 * - `materials` — which project material a slot wears (`{slot: materialId}`,
 *   `null`: back to the authored one), on a model, a box or an instance set;
 *   any material the game ships. The renderer puts it on once it has loaded.
 *
 * A new run puts every written field back as authored. Pure simulation
 * state: no I/O, no three.js.
 */
import { MAX_MATERIAL_SLOTS, SCRIPT_OBJECT_COMPONENT, checkScriptPatch, scriptComponentAccess, scriptSnapshot, validateMaterialMapping, type EntityV3, type ModelErrorV2, type ScriptWriteCode } from '@thirdlight/project-model';
import { clipMessage } from './errors';
import type { MaterialParamValue, RuntimeMaterials } from './material-params';
import type { DiagnosticErrorEntry, TransformState } from './types';

/**
 * Engine limit: accepted `set` calls per step (every script together), a
 * runtime budget against a runaway loop: four writes to every entity of a
 * full scene (16,384).
 */
export const MAX_ENTITY_WRITES_PER_STEP = 65_536;

/** Why a write was refused: the descriptor check's codes and the runtime's. */
export type EntityWriteCode =
  | ScriptWriteCode
  | 'entity_unknown'
  | 'component_missing'
  | 'entity_physics'
  | 'entity_camera'
  | 'entity_character'
  | 'entity_static'
  | 'entity_driven'
  | 'material_parameter'
  | 'material_unknown'
  | 'write_limit';

/** What `set` answers: queued (`ok`), or refused with the field and why. */
export interface EntityWriteResult {
  readonly ok: boolean;
  /** The refused field (`light.type`), or the component ('' when queued). */
  readonly field: string;
  /** Why it was refused ('' when queued). */
  readonly code: EntityWriteCode | '';
  readonly message: string;
}

/**
 * `ctx.entity(ref)` — one loaded object, by id (an `entityRef`
 * property's value, a spawned copy's id, `ctx.entityId`…).
 */
export interface BehaviorEntityHandle {
  /**
   * A read-only snapshot of a component's script-readable fields as they stood at the start of the step
   * (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the
   * object has no such component (`'materialParams'`: when it wears no graph material with public parameters).
   * A component scripts cannot read throws.
   * @graphPure
   * @graphNode Get component
   */
  get(component: string): Readonly<Record<string, unknown>> | null;
  /**
   * Write fields of a component, applied at the end of the step (in script order; a later write of the
   * same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`,
   * transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light
   * `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: value } }),
   * `materials` ({ slot: materialId | null } on a model, box or instance set: shown once the material has loaded).
   * Any other field is refused: the result names it (nothing of a refused patch is written).
   * @graphNode Set component
   */
  set(component: string, patch: Readonly<Record<string, unknown>>): EntityWriteResult;
}

/** The runtime side of `ctx.entity` (the behavior host passes the writing script). */
export interface BehaviorEntityControl {
  handle(writer: string, ref: unknown): BehaviorEntityHandle | null;
}

/** A thrown misuse of `ctx.entity` (the behavior host turns it into the script's error). */
export class EntityAccessError extends Error {
  readonly reason = 'behavior_entity_invalid';
  constructor(message: string) {
    super(clipMessage(message));
    this.name = 'EntityAccessError';
  }
}

/** The light fields scripts write (what the renderer applies over the authored light). */
export interface LightOverride {
  readonly color?: string;
  readonly intensity?: number;
  readonly range?: number;
  /** The light layers it lights and whose objects cast its shadow (bit masks, project-model light-layers.ts). */
  readonly lightMask?: number;
  readonly shadowCasterMask?: number;
}

/** A save document's record of the written fields (components section, `fields`). */
export type EntityFieldsSave = Readonly<Record<string, {
  readonly active?: false;
  readonly visible?: boolean;
  readonly light?: LightOverride;
  readonly mover?: { readonly speed?: number; readonly active?: boolean };
  readonly materials?: Readonly<Record<string, string>>;
}>>;

/** What the runtime gives the access (read at the moment of use). */
export interface EntityAccessHost {
  /** The loaded object's document (resolved components), or undefined. */
  doc(id: string): EntityV3 | undefined;
  /** The object's transform at the start of this step (falls back to now). */
  stepStartTransform(id: string): TransformState | undefined;
  /** The live transforms (`set('transform')` writes them at the end of the step). */
  readonly curr: Map<string, TransformState>;
  /** The loaded objects in document order (children after parents). */
  order(): readonly string[];
  parentOf(id: string): string | undefined;
  readonly controllerIds: readonly string[];
  /** A collider or controller (a physics body; transform writes are refused). */
  isPhysicsBody(id: string): boolean;
  /** An owned transform intent wrote this object's transform this step. */
  transformIntentWrote(id: string): boolean;
  hiddenAtStepStart(id: string): boolean;
  setVisible(id: string, visible: boolean): void;
  /** The object survives scene changes (effective: its own flag or a kept parent). */
  isKept(id: string): boolean;
  /** Why the object's keep flag cannot be written now (null: it can). */
  keepProblem(id: string, keep: boolean): string | null;
  /** Keep (or stop keeping) the object and everything under it. */
  setKept(id: string, keep: boolean): void;
  moverState(id: string): { speed: number; active: boolean } | null;
  setMover(id: string, patch: { speed?: number; active?: boolean }): void;
  readonly materials: RuntimeMaterials;
  /** Every project material the game ships (null: the host does not say; a swap is then refused). */
  materialIds(): ReadonlySet<string> | null;
  /** An object's material swap changed (its slots over its authored mapping; null: none). */
  materialsSwapped(id: string, swap: Readonly<Record<string, string>> | null): void;
  /** The effective switched-off set changed: `off` newly off, `on` newly on (the runtime updates physics, blocks, rendering). */
  inactiveChanged(off: readonly string[], on: readonly string[]): void;
  record(entry: DiagnosticErrorEntry): void;
  stepIndex(): number;
}

interface QueuedWrite {
  readonly writer: string;
  readonly id: string;
  readonly component: string;
  readonly fields: readonly (readonly [string, unknown])[];
}

const DRIVEN = ['mover', 'patrol', 'socketAttach', 'faceMovement'] as const;
/** The most handles kept (script × object pairs; past it the cache starts over). */
const MAX_CACHED_HANDLES = 4096;
const NO_SET: ReadonlySet<string> = new Set();

export class EntityAccess {
  private queue: QueuedWrite[] = [];
  private queuedStep = -1;
  private noted = new Set<string>();
  private notedStep = -1;
  /** Objects a script switched off, and the effective set (with their children). */
  private readonly selfInactive = new Set<string>();
  private inactiveSet: ReadonlySet<string> = NO_SET;
  private readonly lights = new Map<string, LightOverride>();
  private readonly visibleWrites = new Map<string, boolean>();
  private readonly moverWrites = new Map<string, { speed?: number; active?: boolean }>();
  /** The material swaps scripts and timelines made (slot → material, over the authored mapping). */
  private readonly swaps = new Map<string, Readonly<Record<string, string>>>();
  /** The handles made (see `control.handle`). */
  private readonly handles = new Map<string, BehaviorEntityHandle>();
  applied = 0;
  refused = 0;
  conflicts = 0;
  readonly control: BehaviorEntityControl;

  constructor(private readonly host: EntityAccessHost) {
    const access = this;
    this.control = Object.freeze({
      handle(writer: string, ref: unknown): BehaviorEntityHandle | null {
        if (ref === null || ref === undefined || ref === '') return null;
        if (typeof ref !== 'string') throw new EntityAccessError(`ctx.entity(ref) takes an object id (a text), got ${typeof ref}`);
        if (access.host.doc(ref) === undefined) return null;
        // A handle holds no step state: one per script and object (a script asking every step allocates nothing).
        const key = `${writer}\u0000${ref}`;
        let h = access.handles.get(key);
        if (h === undefined) {
          if (access.handles.size >= MAX_CACHED_HANDLES) access.handles.clear();
          h = Object.freeze({
            get: (component: string) => access.get(ref, component),
            set: (component: string, patch: Readonly<Record<string, unknown>>) => access.set(writer, ref, component, patch),
          });
          access.handles.set(key, h);
        }
        return h;
      },
    });
  }

  // ---- reads --------------------------------------------------------------------------------

  /** Objects switched off (with their children). */
  inactive(): ReadonlySet<string> {
    return this.inactiveSet;
  }

  /** The material swaps made, by object (slot → material over the authored mapping). */
  materialSwaps(): ReadonlyMap<string, Readonly<Record<string, string>>> {
    return this.swaps;
  }

  /**
   * A swap applied now (a timeline key): checked as a script's write, then
   * put on at once. The problem when refused (null: swapped).
   */
  swapNow(id: string, patch: unknown): string | null {
    const doc = this.host.doc(id);
    if (doc === undefined) return `object "${id}" is not loaded`;
    if (!wearsMaterials(doc)) return `object "${id}" has no model, box or instance set to wear materials`;
    const problem = this.swapProblem(id, doc, patch);
    if (problem !== null) return problem.message;
    this.applySwap(id, patch as Readonly<Record<string, string | null>>);
    return null;
  }

  /** The light values scripts wrote, by object. */
  lightOverrides(): ReadonlyMap<string, LightOverride> {
    return this.lights;
  }

  private get(id: string, component: unknown): Readonly<Record<string, unknown>> | null {
    if (typeof component !== 'string' || scriptComponentAccess(component) === null) {
      throw new EntityAccessError(`ctx.entity("${id}").get(${JSON.stringify(component)?.slice(0, 64) ?? String(component)}): not a component scripts can read`);
    }
    const doc = this.host.doc(id);
    if (doc === undefined) return null;
    const c = doc.components as unknown as Readonly<Record<string, unknown>>;
    switch (component) {
      case SCRIPT_OBJECT_COMPONENT:
        return scriptSnapshot(component, this.objectValue(doc));
      case 'transform': {
        const t = this.host.stepStartTransform(id);
        return t === undefined ? null : scriptSnapshot(component, { position: t.position, rotation: t.rotation, scale: t.scale });
      }
      case 'materialParams':
        return this.host.materials.scriptSnapshot(id);
      case 'materials': {
        const authored = c['materials'] as Readonly<Record<string, string>> | undefined;
        const swap = this.swaps.get(id);
        if (authored === undefined && swap === undefined) return null;
        return scriptSnapshot(component, { ...(authored ?? {}), ...(swap ?? {}) });
      }
      case 'light': {
        const l = c['light'] as Readonly<Record<string, unknown>> | undefined;
        return l === undefined ? null : scriptSnapshot(component, { ...l, ...(this.lights.get(id) ?? {}) });
      }
      case 'mover': {
        const m = c['mover'] as Readonly<Record<string, unknown>> | undefined;
        if (m === undefined) return null;
        const now = this.host.moverState(id);
        return scriptSnapshot(component, { ...m, ...(now !== null ? { speed: now.speed, active: now.active } : {}) });
      }
      default: {
        const v = c[component] as Readonly<Record<string, unknown>> | undefined;
        return v === undefined ? null : scriptSnapshot(component, v);
      }
    }
  }

  private objectValue(doc: EntityV3): Record<string, unknown> {
    const d = doc as EntityV3 & { static?: boolean; tags?: number };
    return {
      id: doc.id,
      ...(doc.name !== undefined ? { name: doc.name } : {}),
      parentId: doc.parentId ?? null,
      active: !this.selfInactive.has(doc.id),
      visible: !this.host.hiddenAtStepStart(doc.id),
      static: d.static === true,
      keepLoaded: this.host.isKept(doc.id),
      tags: d.tags ?? 0,
    };
  }

  // ---- writes -------------------------------------------------------------------------------

  private refuse(writer: string, field: string, code: EntityWriteCode, message: string): EntityWriteResult {
    this.refused += 1;
    const step = this.host.stepIndex();
    if (this.notedStep !== step) {
      this.notedStep = step;
      this.noted.clear();
    }
    const key = `${writer}\u0000${field}\u0000${code}`;
    if (!this.noted.has(key)) {
      this.noted.add(key);
      this.host.record({ code: 'entity_write', reason: 'refused', detail: code, message: clipMessage(`${writer}: ${message}`), stepIndex: step });
    }
    return Object.freeze({ ok: false, field, code, message: clipMessage(message) });
  }

  private set(writer: string, id: string, component: unknown, patch: unknown): EntityWriteResult {
    const name = typeof component === 'string' ? component : String(component);
    const doc = this.host.doc(id);
    if (doc === undefined) return this.refuse(writer, name, 'entity_unknown', `object "${id}" is not loaded`);
    const c = doc.components as unknown as Readonly<Record<string, unknown>>;
    if (scriptComponentAccess(name) === null) return this.refuse(writer, name, 'component_unknown', `"${name}" is not a component scripts can use`);
    let current: Readonly<Record<string, unknown>>;
    if (name === SCRIPT_OBJECT_COMPONENT) current = this.objectValue(doc);
    else if (name === 'materialParams') current = {};
    else if (name === 'materials') {
      if (!wearsMaterials(doc)) return this.refuse(writer, name, 'component_missing', `object "${id}" has no model, box or instance set to wear materials`);
      current = {};
    } else {
      const v = c[name] as Readonly<Record<string, unknown>> | undefined;
      if (v === undefined) return this.refuse(writer, name, 'component_missing', `object "${id}" has no ${name}`);
      current = name === 'light' ? { ...v, ...(this.lights.get(id) ?? {}) } : v;
    }
    const checked = checkScriptPatch(name, current, patch);
    if (!checked.ok) return this.refuse(writer, checked.problem.field, checked.problem.code, `object "${id}": ${checked.problem.message}`);
    const problem = this.runtimeProblem(id, doc, name, checked.fields);
    if (problem !== null) return this.refuse(writer, problem.field, problem.code, `object "${id}": ${problem.message}`);
    const step = this.host.stepIndex();
    if (this.queuedStep !== step) {
      this.queuedStep = step;
      this.queue = [];
    }
    if (this.queue.length >= MAX_ENTITY_WRITES_PER_STEP) return this.refuse(writer, name, 'write_limit', `at most ${MAX_ENTITY_WRITES_PER_STEP} component writes per step`);
    this.queue.push({ writer, id, component: name, fields: checked.fields });
    return OK;
  }

  /** What only the runtime knows about a checked write (null: it may). */
  private runtimeProblem(id: string, doc: EntityV3, component: string, fields: readonly (readonly [string, unknown])[]): { field: string; code: EntityWriteCode; message: string } | null {
    const c = doc.components as unknown as Readonly<Record<string, unknown>>;
    const isStatic = (doc as { static?: boolean }).static === true;
    if (component === SCRIPT_OBJECT_COMPONENT) {
      for (const [key] of fields) {
        const field = `object.${key}`;
        if (isStatic && key !== 'keepLoaded') return { field, code: 'entity_static', message: `${field}: a static object is batched and baked once (clear its Static flag to switch it at run time)` };
        if (key === 'active') {
          const holds = this.subtreeHolds(id);
          if (holds === 'character') return { field, code: 'entity_character', message: `${field}: the character (or an object above it) stays active (character_enable switches its controller off)` };
        }
        if (key === 'keepLoaded') {
          const value = fields.find(([k]) => k === 'keepLoaded')?.[1] === true;
          const why = this.host.keepProblem(id, value);
          if (why !== null) return { field, code: 'field_value', message: `${field}: ${why}` };
        }
      }
      return null;
    }
    if (component === 'transform') {
      const field = `transform.${fields[0]![0]}`;
      if (this.host.isPhysicsBody(id)) return { field, code: 'entity_physics', message: `${field}: a physics body moves through physics (character_place, a mover, or a script that owns it)` };
      if (isStatic) return { field, code: 'entity_static', message: `${field}: a static object never moves` };
      const driver = DRIVEN.find((k) => c[k] !== undefined);
      if (driver !== undefined) return { field, code: 'entity_driven', message: `${field}: its ${driver} poses it every step` };
      return null;
    }
    if (component === 'light') {
      const mode = (c['light'] as { mode?: unknown } | undefined)?.mode;
      if (mode === 'baked') return { field: `light.${fields[0]![0]}`, code: 'entity_static', message: 'a baked light is part of the lightmaps (only realtime and mixed lights change at run time)' };
      return null;
    }
    if (component === 'materialParams') {
      const map = fields[0]![1] as Readonly<Record<string, unknown>>;
      let any = false;
      for (const [materialId, params] of Object.entries(map)) {
        const field = `materialParams.${materialId}`;
        if (typeof params !== 'object' || params === null || Array.isArray(params)) return { field, code: 'field_value', message: `${field} must be an object: parameter → value` };
        for (const [param, value] of Object.entries(params as Record<string, unknown>)) {
          const problem = this.host.materials.scriptProblem(id, materialId, param, value);
          if (problem !== null) return { field: `${field}.${param}`, code: 'material_parameter', message: problem };
          any = true;
        }
      }
      if (!any) return { field: 'materialParams', code: 'patch_invalid', message: 'set("materialParams", patch) names no parameter' };
      return null;
    }
    if (component === 'materials') return this.swapProblem(id, doc, fields[0]![1]);
    return null;
  }

  /** Why a swap patch ({ slot: materialId | null }) cannot be put on this object (null: it can). */
  private swapProblem(id: string, doc: EntityV3, patch: unknown): { field: string; code: EntityWriteCode; message: string } | null {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { field: 'materials', code: 'patch_invalid', message: 'set("materials", patch) takes { slot: materialId | null }' };
    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length === 0) return { field: 'materials', code: 'patch_invalid', message: 'set("materials", patch) names no slot' };
    const known = this.host.materialIds();
    const merged: Record<string, string> = { ...(((doc.components as unknown as Record<string, unknown>)['materials'] as Record<string, string> | undefined) ?? {}), ...(this.swaps.get(id) ?? {}) };
    for (const [slot, value] of entries) {
      const field = `materials.${slot}`;
      if (value === null) continue;
      if (typeof value !== 'string') return { field, code: 'field_value', message: `${field} must be a material id or null` };
      if (known === null || !known.has(value)) return { field, code: 'material_unknown', message: `${field}: "${value.slice(0, 64)}" is not a material this game ships (give it an address or a label, or use it on an object or a timeline)` };
      merged[slot] = value;
    }
    const errors: ModelErrorV2[] = [];
    if (Object.keys(merged).length > 0) validateMaterialMapping(merged, 'materials', errors);
    if (errors.length > 0) return { field: errors[0]!.path.replace(/\//g, '.'), code: 'field_value', message: errors[0]!.message };
    if (Object.keys(merged).length > MAX_MATERIAL_SLOTS) return { field: 'materials', code: 'field_value', message: `an object wears at most ${MAX_MATERIAL_SLOTS} slots` };
    return null;
  }

  /** Put a checked swap patch on (null slots go back to the authored material). */
  private applySwap(id: string, patch: Readonly<Record<string, string | null>>): void {
    const next: Record<string, string> = { ...(this.swaps.get(id) ?? {}) };
    for (const [slot, value] of Object.entries(patch)) {
      if (value === null) delete next[slot];
      else next[slot] = value;
    }
    if (Object.keys(next).length === 0) this.swaps.delete(id);
    else this.swaps.set(id, Object.freeze(next));
    this.host.materialsSwapped(id, this.swaps.get(id) ?? null);
  }

  /** Whether the object or one below it is a player character (it stays active). */
  private subtreeHolds(id: string): 'character' | null {
    for (const player of this.host.controllerIds) {
      let cur: string | undefined = player;
      for (let guard = 0; cur !== undefined && guard < 64; guard++) {
        if (cur === id) return 'character';
        cur = this.host.parentOf(cur);
      }
    }
    return null;
  }

  /** The end of the step: every queued write in order (later writes of a field win; conflicts reported). */
  applyQueued(): void {
    if (this.queue.length === 0 || this.queuedStep !== this.host.stepIndex()) {
      this.queue = [];
      return;
    }
    const queue = this.queue;
    this.queue = [];
    const writers = new Map<string, string>();
    let activeChanged = false;
    const step = this.host.stepIndex();
    for (const w of queue) {
      if (this.host.doc(w.id) === undefined) continue; // gone in the step (a destroyed copy)
      for (const [key, value] of w.fields) {
        const leaves = w.component === 'materialParams' ? Object.entries(value as Record<string, Record<string, unknown>>).flatMap(([m, ps]) => Object.keys(ps).map((p) => `materialParams.${m}.${p}`)) : w.component === 'materials' ? Object.keys(value as Record<string, unknown>).map((slot) => `materials.${slot}`) : [`${w.component}.${key}`];
        for (const field of leaves) {
          const slot = `${w.id}\u0000${field}`;
          const before = writers.get(slot) ?? (w.component === 'transform' && this.host.transformIntentWrote(w.id) ? 'an owned transform intent' : undefined);
          if (before !== undefined) {
            this.conflicts += 1;
            this.host.record({ code: 'entity_write', reason: 'conflict', detail: field, message: clipMessage(`object "${w.id}" ${field}: written by ${before}, then by ${w.writer} in one step (the later write wins)`), stepIndex: step });
          }
          writers.set(slot, w.writer);
        }
      }
      this.applied += 1;
      if (this.applyOne(w)) activeChanged = true;
    }
    if (activeChanged) this.refreshInactive();
  }

  /** One write's runtime behavior. True when an object was switched on or off. */
  private applyOne(w: QueuedWrite): boolean {
    let active = false;
    switch (w.component) {
      case SCRIPT_OBJECT_COMPONENT:
        for (const [key, value] of w.fields) {
          if (key === 'active') {
            const was = !this.selfInactive.has(w.id);
            if (value === false) this.selfInactive.add(w.id);
            else this.selfInactive.delete(w.id);
            if (was !== (value !== false)) active = true;
          } else if (key === 'visible') {
            this.host.setVisible(w.id, value === true);
            this.visibleWrites.set(w.id, value === true);
          } else if (key === 'keepLoaded') {
            this.host.setKept(w.id, value === true);
          }
        }
        return active;
      case 'transform': {
        const t = this.host.curr.get(w.id);
        if (t === undefined) return false;
        for (const [key, value] of w.fields) {
          const v = value as readonly number[];
          const target = key === 'position' ? t.position : key === 'rotation' ? t.rotation : t.scale;
          for (let i = 0; i < target.length; i += 1) (target as number[])[i] = v[i]!;
        }
        return false;
      }
      case 'light': {
        const next: Record<string, unknown> = { ...(this.lights.get(w.id) ?? {}) };
        for (const [key, value] of w.fields) next[key] = value;
        this.lights.set(w.id, Object.freeze(next) as LightOverride);
        return false;
      }
      case 'mover': {
        const patch: { speed?: number; active?: boolean } = {};
        for (const [key, value] of w.fields) {
          if (key === 'speed') patch.speed = value as number;
          else if (key === 'active') patch.active = value as boolean;
        }
        this.host.setMover(w.id, patch);
        this.moverWrites.set(w.id, { ...(this.moverWrites.get(w.id) ?? {}), ...patch });
        return false;
      }
      case 'materials':
        this.applySwap(w.id, w.fields[0]![1] as Readonly<Record<string, string | null>>);
        return false;
      case 'materialParams': {
        const map = w.fields[0]![1] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        for (const [materialId, params] of Object.entries(map)) for (const [param, value] of Object.entries(params)) this.host.materials.scriptApply(w.id, materialId, param, value as MaterialParamValue | null);
        return false;
      }
      default:
        return false;
    }
  }

  /** Recompute the effective switched-off set (with children) and tell the runtime what changed. */
  private refreshInactive(): void {
    const prev = this.inactiveSet;
    let next: Set<string>;
    if (this.selfInactive.size === 0) next = new Set();
    else {
      next = new Set();
      for (const id of this.host.order()) {
        let cur: string | undefined = id;
        for (let guard = 0; cur !== undefined && guard < 64; guard++) {
          if (this.selfInactive.has(cur)) {
            next.add(id);
            break;
          }
          cur = this.host.parentOf(cur);
        }
      }
    }
    const off = [...next].filter((id) => !prev.has(id));
    const on = [...prev].filter((id) => !next.has(id));
    this.inactiveSet = next.size === 0 ? NO_SET : next;
    if (off.length > 0 || on.length > 0) this.host.inactiveChanged(off, on);
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Objects entered the game (a loaded scene, a spawned copy): children of switched-off objects are off too. */
  added(): void {
    if (this.selfInactive.size > 0) this.refreshInactive();
  }

  /** Objects left the game: their writes go with them (they are not in the physics world any more). */
  removed(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.selfInactive.delete(id);
      this.lights.delete(id);
      this.visibleWrites.delete(id);
      this.moverWrites.delete(id);
      this.swaps.delete(id);
    }
    if (this.inactiveSet.size > 0) {
      const next = new Set([...this.inactiveSet].filter((id) => !ids.has(id)));
      this.inactiveSet = next.size === 0 ? NO_SET : next;
      // The leavers' colliders already left with them: only the remaining set is re-read.
      this.host.inactiveChanged([], []);
    }
    this.queue = this.queue.filter((w) => !ids.has(w.id));
  }

  /** A new run: every written field back as authored (the switched-off objects come back). */
  reset(): void {
    this.queue = [];
    this.selfInactive.clear();
    this.refreshInactive();
    this.lights.clear();
    this.visibleWrites.clear();
    this.moverWrites.clear();
    this.clearSwaps();
  }

  /** Every swap goes (the objects wear their authored materials again). */
  private clearSwaps(): void {
    const ids = [...this.swaps.keys()];
    this.swaps.clear();
    for (const id of ids) this.host.materialsSwapped(id, null);
  }

  // ---- digest and saves ----------------------------------------------------------------------

  /** The written fields as digest text (null while none is written: every other digest is unchanged). */
  digestText(): string | null {
    if (this.selfInactive.size === 0 && this.lights.size === 0 && this.moverWrites.size === 0 && this.visibleWrites.size === 0 && this.swaps.size === 0) return null;
    return JSON.stringify(this.saveState());
  }

  /** The written fields for a save document (components section, `fields`), sorted by object. */
  saveState(): EntityFieldsSave {
    const ids = new Set([...this.selfInactive, ...this.lights.keys(), ...this.visibleWrites.keys(), ...this.moverWrites.keys(), ...this.swaps.keys()]);
    const out: Record<string, { active?: false; visible?: boolean; light?: LightOverride; mover?: { speed?: number; active?: boolean }; materials?: Readonly<Record<string, string>> }> = {};
    for (const id of [...ids].sort()) {
      const light = this.lights.get(id);
      const mover = this.moverWrites.get(id);
      const visible = this.visibleWrites.get(id);
      const swap = this.swaps.get(id);
      out[id] = {
        ...(this.selfInactive.has(id) ? { active: false as const } : {}),
        ...(visible !== undefined ? { visible } : {}),
        ...(light !== undefined ? { light: { ...light } } : {}),
        ...(mover !== undefined ? { mover: { ...mover } } : {}),
        ...(swap !== undefined ? { materials: { ...swap } } : {}),
      };
    }
    return out;
  }

  /** Why a saved `fields` record cannot be restored in this game (null: it can). */
  checkState(v: unknown): string | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'the components section\'s fields map objects to their written fields';
    for (const [id, rec] of Object.entries(v as Record<string, unknown>)) {
      const doc = this.host.doc(id);
      if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return `fields of "${id.slice(0, 64)}" is not an object`;
      const r = rec as Record<string, unknown>;
      for (const k of Object.keys(r)) if (k !== 'active' && k !== 'visible' && k !== 'light' && k !== 'mover' && k !== 'materials') return `fields of "${id.slice(0, 64)}": unknown "${k.slice(0, 32)}"`;
      if (doc === undefined) return `the save writes fields of "${id.slice(0, 64)}", which is not in this game`;
      const c = doc.components as unknown as Record<string, Record<string, unknown> | undefined>;
      if (r['active'] !== undefined && r['active'] !== false) return `fields of "${id.slice(0, 64)}": active is false or absent`;
      if (r['visible'] !== undefined && typeof r['visible'] !== 'boolean') return `fields of "${id.slice(0, 64)}": visible is true or false`;
      if (r['materials'] !== undefined) {
        if (!wearsMaterials(doc)) return `the save swaps the materials of "${id.slice(0, 64)}", which wears none`;
        const problem = this.swapProblem(id, doc, r['materials']);
        if (problem !== null) return `fields of "${id.slice(0, 64)}": ${problem.message}`;
      }
      for (const comp of ['light', 'mover'] as const) {
        if (r[comp] === undefined) continue;
        const cur = c[comp];
        if (cur === undefined) return `the save writes the ${comp} of "${id.slice(0, 64)}", which has none`;
        const checked = checkScriptPatch(comp, cur, r[comp]);
        if (!checked.ok) return `fields of "${id.slice(0, 64)}": ${checked.problem.message}`;
      }
    }
    return null;
  }

  /** Restore saved written fields (checked with `checkState`) over the authored ones. */
  restoreState(v: EntityFieldsSave | undefined): void {
    this.reset();
    for (const [id, r] of Object.entries(v ?? {})) {
      if (this.host.doc(id) === undefined) continue;
      if (r.active === false) this.selfInactive.add(id);
      if (r.visible !== undefined) {
        this.host.setVisible(id, r.visible);
        this.visibleWrites.set(id, r.visible);
      }
      if (r.light !== undefined) this.lights.set(id, Object.freeze({ ...r.light }));
      if (r.mover !== undefined) {
        this.host.setMover(id, r.mover);
        this.moverWrites.set(id, { ...r.mover });
      }
      if (r.materials !== undefined) this.applySwap(id, r.materials);
    }
    this.refreshInactive();
  }
}

const OK: EntityWriteResult = Object.freeze({ ok: true, field: '', code: '', message: '' });

/** Whether the object has something that wears materials (a model, a box or an instance set). */
function wearsMaterials(doc: EntityV3): boolean {
  const c = doc.components as unknown as Record<string, unknown>;
  return c['model'] !== undefined || c['box'] !== undefined || c['instances'] !== undefined;
}
