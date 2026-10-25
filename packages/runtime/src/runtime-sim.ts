/**
 * The simulation state every part of the runtime reads and the step loop
 * advances: the module set, the loaded entities in draw order, their
 * transforms (the step before, the step now, the last committed one), the
 * step count and which module runs in which phase now.
 *
 * One object, owned by the runtime and handed to each of its parts, so a part
 * reads the state the step loop has now (the maps are replaced on a reset or
 * a no-op step) without a getter per field.
 */
import { TransformMirror } from './step-buffers';
import { clipMessage } from './errors';
import type { PhysicsPort3D } from './ports';
import type { IntentSet } from './intents';
import type {
  GameplaySettings,
  RuntimeStateName,
  SimEntityData,
  SimState,
  SimulationModule,
  SimulationPhase,
  SimulationPhaseModule,
  StepContext,
  TransformState,
} from './types';

export interface ModuleEntry {
  id: string;
  /** The declared phases; `['transform']` for an accepted M1 module. */
  phases: readonly SimulationPhase[];
  phased: boolean;
  instance: SimulationModule | SimulationPhaseModule;
  owners: readonly string[];
  /** The reused state view and step context per phase. */
  views?: Map<SimulationPhase, PhaseViews>;
  /** `owners` as a set (remade when `owners` is replaced). */
  ownerSet?: ReadonlySet<string>;
  ownerSetSource?: readonly string[];
}

/** One module's reused views for one phase. */
export interface PhaseViews {
  state: SimState;
  /** The step context (phased modules). */
  ctx: StepContext | null;
  /** The intents view the module's current call sees. */
  intents: IntentSet | null;
}

/** A module's owners as a set, remade only when the owners list is replaced. */
export function ownerSetOf(entry: ModuleEntry): ReadonlySet<string> {
  if (entry.ownerSet === undefined || entry.ownerSetSource !== entry.owners) {
    entry.ownerSet = new Set(entry.owners);
    entry.ownerSetSource = entry.owners;
  }
  return entry.ownerSet;
}

export function messageOf(e: unknown): string {
  // Duck-typed: an artifact executed in another realm (the Node `vm` test host)
  // throws an Error that is not `instanceof` this realm's Error.
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    const m = (e as { message: string }).message;
    if (m !== '') return clipMessage(m);
  }
  if (e instanceof Error) return clipMessage(e.message !== '' ? e.message : 'Error');
  try {
    const s = JSON.stringify(e);
    if (typeof s === 'string' && s.length > 0) return clipMessage(s);
  } catch {
    /* non-serializable — fall through */
  }
  return clipMessage(String(e));
}

export function cloneTransform(t: TransformState): TransformState {
  return {
    position: [t.position[0], t.position[1], t.position[2]],
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  };
}

export function cloneCurr(curr: Map<string, TransformState>): Map<string, TransformState> {
  const out = new Map<string, TransformState>();
  for (const [id, t] of curr) out.set(id, cloneTransform(t));
  return out;
}

export class RuntimeSim {
  stateName: RuntimeStateName = 'instantiated';
  readonly hz: number;
  readonly dt: number;
  readonly settings: GameplaySettings;
  /**
   * The physics port (absent: a game without physics). With it the runtime
   * runs the character phase (`PlayerControllers.runPhysics3D`) and commits
   * the full position.
   */
  readonly physics3d?: PhysicsPort3D;
  entries: ModuleEntry[];
  order: readonly string[];
  entities: Map<string, SimEntityData>;
  entityCount: number;
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
  /** The last fully committed step's transforms (fail-stop rendering). */
  committed: Map<string, TransformState> | null = null;
  /**
   * The step's backup (`prev` after the step) alternates between
   * two reused copies, and the committed state is a third, so a steady step
   * allocates no transform objects.
   */
  readonly stepMirrors: readonly [TransformMirror, TransformMirror] = [new TransformMirror(), new TransformMirror()];
  readonly committedMirror = new TransformMirror();
  /** Bumped whenever transforms are added to or removed from `curr` (the mirrors' shape key). */
  currShape = 0;
  stepIndex = 0;
  simTime = 0;
  /** The phase and module running now (what a fail-stop names). */
  currentPhase?: SimulationPhase;
  currentModuleId?: string;
  /** The step's pre-step transforms (what `get('transform')` reads during the step). */
  stepStart: Map<string, TransformState> | null = null;

  constructor(a: {
    hz: number;
    settings: GameplaySettings;
    physics3d?: PhysicsPort3D;
    entries: ModuleEntry[];
    order: string[];
    entities: Map<string, SimEntityData>;
    prev: Map<string, TransformState>;
    curr: Map<string, TransformState>;
  }) {
    this.hz = a.hz;
    this.dt = 1 / a.hz;
    this.settings = a.settings;
    if (a.physics3d !== undefined) this.physics3d = a.physics3d;
    this.entries = a.entries;
    this.order = a.order;
    this.entities = a.entities;
    this.entityCount = a.order.length;
    this.prev = a.prev;
    this.curr = a.curr;
    // The state committed at the end of the last fully completed step.
    // Initialized to the instantiate-time state so a fail-stop during the
    // 12-step settle pre-roll (before any step completes) renders only the
    // committed initial state — never the abandoned step's transform.
    this.committedMirror.copyFrom(a.curr, this.currShape);
    this.committed = this.committedMirror.map;
  }

  /** The reused step buffer `prev` does not hold (the pre-step copy goes into it). */
  spareMirror(): TransformMirror {
    return this.stepMirrors[this.stepMirrors[0].map === this.prev ? 1 : 0];
  }

  /** An entity's parent (null: a root; undefined: not loaded). */
  parentOf(id: string): string | null | undefined {
    return this.entities.get(id)?.parentId ?? (this.entities.has(id) ? null : undefined);
  }

  /** An entity's world position and rotation, composed up its parents from the step's transforms (false: not loaded). */
  worldTransformOf(id: string, position: number[], rotation: number[]): boolean {
    const t = this.curr.get(id);
    if (t === undefined) return false;
    let px = t.position[0], py = t.position[1], pz = t.position[2];
    let qx = t.rotation[0], qy = t.rotation[1], qz = t.rotation[2], qw = t.rotation[3];
    let parent = this.entities.get(id)?.parentId ?? null;
    for (let depth = 0; parent !== null && depth < 64; depth += 1) {
      const pt = this.curr.get(parent);
      if (pt === undefined) break;
      // p := parentPos + parentRot · (parentScale ⊙ p); q := parentRot · q
      const sx = px * pt.scale[0], sy = py * pt.scale[1], sz = pz * pt.scale[2];
      const [ax, ay, az, aw] = pt.rotation;
      const tx = 2 * (ay * sz - az * sy), ty = 2 * (az * sx - ax * sz), tz = 2 * (ax * sy - ay * sx);
      px = pt.position[0] + sx + aw * tx + (ay * tz - az * ty);
      py = pt.position[1] + sy + aw * ty + (az * tx - ax * tz);
      pz = pt.position[2] + sz + aw * tz + (ax * ty - ay * tx);
      const nx = aw * qx + ax * qw + ay * qz - az * qy;
      const ny = aw * qy - ax * qz + ay * qw + az * qx;
      const nz = aw * qz + ax * qy - ay * qx + az * qw;
      const nw = aw * qw - ax * qx - ay * qy - az * qz;
      qx = nx;
      qy = ny;
      qz = nz;
      qw = nw;
      parent = this.entities.get(parent)?.parentId ?? null;
    }
    position[0] = px;
    position[1] = py;
    position[2] = pz;
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    rotation[0] = qx / len;
    rotation[1] = qy / len;
    rotation[2] = qz / len;
    rotation[3] = qw / len;
    return true;
  }
}
