/**
 * Phase 23.12 (E9): graph-material parameters set per object while the game
 * runs — the script API `ctx.materials`, the values as simulation state and
 * the changes the renderer applies.
 *
 * A graph material (phase 18) declares exposed parameters; objects override
 * the public ones as authoring data (the `materialParams` component). Here a
 * script sets them per object at run time: float, vec2–4, colour, a texture
 * (an asset in the game's closure), and (new in this phase) the cells of a
 * `data` parameter — a small RGBA8 grid (at most 64 × 64, project-model
 * `MATERIAL_DATA_MAX`) a Sample data node reads, so one mesh can show
 * per-cell state without an object per cell. The engine knows nothing about
 * what the cells mean.
 *
 * - An object's materials are its material mapping (the `materials`
 *   component over its model asset's default mapping), as the renderer
 *   resolves them; a call names a parameter key and applies it to every graph
 *   material the object wears that declares it as public (or to one material
 *   when `materialId` is given). Private parameters stay the material's own.
 * - Values are simulation state: writes apply in call order, reads see them at
 *   once, a new run starts from the authored values, and the step digest
 *   includes them (only while any is set, so every other digest is unchanged).
 *   The page and the simulation worker run the same code on the same data.
 * - The renderer gets per-parameter diffs (`takeRenderChanges`, through the
 *   worker frame like the block-layer chunks): the latest value of each
 *   changed parameter, a cleared one, or a data parameter's whole grid (at
 *   most 16 KiB; three.js re-uploads a whole data texture on change anyway).
 * - Engine limit: 4,096 writes (set, setData, reset) per step.
 */
import { MATERIAL_DATA_MAX, type EntityV3 } from '@thirdlight/project-model';

/** The most parameter writes (set, setData, reset) per step (engine limit, as `ctx.grid`'s). */
export const MATERIAL_WRITES_PER_STEP = 4096;

/** The parameter types (project-model `MATERIAL_PARAMETER_TYPES`). */
export type RuntimeMaterialParameterType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'texture' | 'data';

/** One exposed parameter of a graph material, as the runtime validates script values against it. */
export interface RuntimeMaterialParameter {
  readonly key: string;
  readonly type: RuntimeMaterialParameterType;
  readonly default: number | readonly number[] | string;
  readonly min?: number;
  readonly max?: number;
  /** data: the grid's cells [width, height]. */
  readonly size?: readonly [number, number];
  readonly visibility?: 'public' | 'private';
}

/**
 * The graph materials' parameters, the model assets' default material
 * mappings and the texture assets of the game's closure — what the runtime
 * needs to resolve an object's materials and check script values (a snapshot
 * field; built from the manifest by {@link materialCatalogOf}).
 */
export interface RuntimeMaterialCatalog {
  readonly materials: readonly { readonly materialId: string; readonly parameters: readonly RuntimeMaterialParameter[] }[];
  /** A model asset's default material mapping (slot → materialId). */
  readonly assetMaterials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The texture assets a texture parameter may name (the game's closure). */
  readonly textures?: readonly string[];
}

/** A value a script sets: a number, 2–4 numbers, "#rrggbb" or a texture asset id ("" for none). */
export type MaterialParamValue = number | readonly number[] | string;

/**
 * One change the renderer applies (`takeMaterialChanges`): the latest value
 * of a parameter on an object's material, a parameter back to its authored
 * value (`clear`), or a data parameter's whole grid.
 */
export type MaterialRenderChange =
  | { readonly op: 'set'; readonly entityId: string; readonly materialId: string; readonly key: string; readonly type: Exclude<RuntimeMaterialParameterType, 'data'>; readonly value: MaterialParamValue }
  | { readonly op: 'clear'; readonly entityId: string; readonly materialId: string; readonly key: string }
  | { readonly op: 'data'; readonly entityId: string; readonly materialId: string; readonly key: string; readonly size: readonly [number, number]; readonly bytes: Uint8Array };

/** The coalescing key of a change (one pending change per object, material and parameter). */
export function materialChangeKey(c: { entityId: string; materialId: string; key: string }): string {
  return `${c.entityId}\u0000${c.materialId}\u0000${c.key}`;
}

/**
 * `ctx.materials` — graph-material parameters per object while the game runs.
 * `param` is a parameter key of the object's graph materials (public ones
 * only); `materialId` limits a call to one of its materials. Writes are
 * refused (`false`) for an object that wears no graph material with that
 * parameter, a value that does not fit the parameter (type, range, a texture
 * outside the game), or at the engine limit of 4,096 writes per step.
 */
export interface BehaviorMaterials {
  /**
   * Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused.
   * @graphNode Set material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  set(entityId: string, param: string, value: unknown, materialId?: string): boolean;
  /**
   * A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter).
   * @graphPure
   * @graphNode Material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  get(entityId: string, param: string, materialId?: string): unknown;
  /**
   * Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells.
   * @graphNode Reset material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  reset(entityId: string, param?: string, materialId?: string): boolean;
  /**
   * Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length).
   * @graphNode Write material data
   * @graphLabel param parameter
   * @graphLabel materialId material
   * @graphDefault w 1
   * @graphDefault h 1
   * @graphType bytes list
   */
  setData(entityId: string, param: string, x: number, y: number, w: number, h: number, bytes: readonly number[], materialId?: string): boolean;
  /**
   * One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell).
   * @graphPure
   * @graphNode Material data cell
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  getData(entityId: string, param: string, x: number, y: number, materialId?: string): number[] | null;
}

// ---- the catalogue from the manifest ----------------------------------------------------

const TYPES: readonly string[] = ['float', 'vec2', 'vec3', 'vec4', 'color', 'texture', 'data'];

/**
 * The catalogue from a manifest's (or content's) materials and asset rows:
 * graph materials with at least one public parameter, the model assets'
 * default mappings, the texture assets. Undefined when no graph material has
 * a public parameter (the snapshot then carries no catalogue).
 */
export function materialCatalogOf(
  materials: readonly { materialId: string; graph?: unknown; parameters?: readonly RuntimeMaterialParameter[] }[] | undefined,
  assets: readonly { assetId: string; kind?: string; materials?: Readonly<Record<string, string>> }[] | undefined,
): RuntimeMaterialCatalog | undefined {
  const graphs = (materials ?? []).filter((m) => m.graph !== undefined && (m.parameters ?? []).some((p) => p.visibility !== 'private'));
  if (graphs.length === 0) return undefined;
  const assetMaterials: Record<string, Record<string, string>> = {};
  const textures: string[] = [];
  for (const a of assets ?? []) {
    if (a.materials !== undefined && Object.keys(a.materials).length > 0) assetMaterials[a.assetId] = { ...a.materials };
    if (a.kind === 'texture') textures.push(a.assetId);
  }
  return {
    materials: graphs.map((m) => ({
      materialId: m.materialId,
      parameters: (m.parameters ?? []).map((p) => ({
        key: p.key,
        type: p.type,
        default: Array.isArray(p.default) ? [...p.default] : p.default,
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        ...(p.size !== undefined ? { size: [p.size[0], p.size[1]] as const } : {}),
        ...(p.visibility === 'private' ? { visibility: 'private' as const } : {}),
      })),
    })),
    ...(Object.keys(assetMaterials).length > 0 ? { assetMaterials } : {}),
    ...(textures.length > 0 ? { textures: textures.sort() } : {}),
  };
}

/** A catalogue's shape (a snapshot field): null when valid, else what is wrong. */
export function materialCatalogProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'materialCatalog must be an object';
  const c = v as Record<string, unknown>;
  for (const k of Object.keys(c)) if (k !== 'materials' && k !== 'assetMaterials' && k !== 'textures') return `unknown materialCatalog field "${k}"`;
  if (!Array.isArray(c['materials']) || c['materials'].length > 256) return 'materialCatalog.materials must be an array of at most 256 materials';
  for (const m of c['materials'] as unknown[]) {
    const r = m as { materialId?: unknown; parameters?: unknown };
    if (typeof r !== 'object' || r === null || typeof r.materialId !== 'string' || !Array.isArray(r.parameters) || r.parameters.length > 64) return 'a materialCatalog material is { materialId, parameters[≤64] }';
    for (const p of r.parameters as unknown[]) {
      const q = p as { key?: unknown; type?: unknown; size?: unknown };
      if (typeof q !== 'object' || q === null || typeof q.key !== 'string' || typeof q.type !== 'string' || !TYPES.includes(q.type)) return `a parameter of material "${r.materialId}" has no valid key/type`;
      if (q.type === 'data' && !(Array.isArray(q.size) && q.size.length === 2 && q.size.every((x) => Number.isInteger(x) && x >= 1 && x <= MATERIAL_DATA_MAX))) return `data parameter "${q.key}" of material "${r.materialId}" needs a size of 1-${MATERIAL_DATA_MAX} cells per side`;
    }
  }
  if (c['assetMaterials'] !== undefined && (typeof c['assetMaterials'] !== 'object' || c['assetMaterials'] === null || Array.isArray(c['assetMaterials']))) return 'materialCatalog.assetMaterials must be an object';
  if (c['textures'] !== undefined && (!Array.isArray(c['textures']) || !c['textures'].every((t) => typeof t === 'string'))) return 'materialCatalog.textures must be an array of asset ids';
  return null;
}

// ---- values ----------------------------------------------------------------------------

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const BOUND = 1e6;

/** A script value checked against a parameter (canonical: colours lower case, vectors copied), or undefined when it does not fit. */
function checkedValue(p: RuntimeMaterialParameter, v: unknown, textures: ReadonlySet<string>): MaterialParamValue | undefined {
  const inRange = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= BOUND && (p.min === undefined || x >= p.min) && (p.max === undefined || x <= p.max);
  switch (p.type) {
    case 'float':
      return inRange(v) ? v : undefined;
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const n = Number(p.type.slice(3));
      if (!Array.isArray(v) || v.length !== n || !v.every(inRange)) return undefined;
      return Object.freeze([...(v as number[])]);
    }
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : undefined;
    case 'texture':
      return typeof v === 'string' && (v === '' || textures.has(v)) ? v : undefined;
    default:
      return undefined;
  }
}

/** A data parameter's starting grid: every cell the default RGBA. */
function filledGrid(p: RuntimeMaterialParameter): Uint8Array {
  const [w, h] = p.size ?? [1, 1];
  const out = new Uint8Array(w * h * 4);
  const d = Array.isArray(p.default) ? (p.default as number[]) : [0, 0, 0, 0];
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = d[0] ?? 0;
    out[i * 4 + 1] = d[1] ?? 0;
    out[i * 4 + 2] = d[2] ?? 0;
    out[i * 4 + 3] = d[3] ?? 0;
  }
  return out;
}

/** 32-bit FNV-1a of bytes (the digest text of a data grid). */
function fnvBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i += 1) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Per object and material: the values scripts set and the data grids they wrote. */
interface MaterialState {
  readonly values: Map<string, MaterialParamValue>;
  readonly data: Map<string, Uint8Array>;
}

/**
 * The run's material parameters: which graph materials each loaded object
 * wears, the values scripts set, the pending renderer changes and the API.
 */
export class RuntimeMaterials {
  private readonly params = new Map<string, Map<string, RuntimeMaterialParameter>>();
  private readonly assetMaterials: Readonly<Record<string, Readonly<Record<string, string>>>>;
  private readonly textures: ReadonlySet<string>;
  /** Each loaded object's graph materials (in mapping order) and its authored overrides. */
  private readonly worn = new Map<string, { readonly materials: readonly string[]; readonly authored: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>();
  /** entityId → materialId → state. */
  private readonly state = new Map<string, Map<string, MaterialState>>();
  private readonly pending = new Map<string, { op: 'set' | 'clear' | 'data'; entityId: string; materialId: string; key: string }>();
  private writesStep = -1;
  private writes = 0;
  readonly api: BehaviorMaterials;

  constructor(catalog: RuntimeMaterialCatalog | undefined) {
    for (const m of catalog?.materials ?? []) this.params.set(m.materialId, new Map(m.parameters.map((p) => [p.key, p])));
    this.assetMaterials = catalog?.assetMaterials ?? {};
    this.textures = new Set(catalog?.textures ?? []);
    this.api = this.buildApi();
  }

  /** Objects entered the game (the start scenes, a loaded scene, a spawned copy). */
  addEntities(entities: readonly EntityV3[]): void {
    if (this.params.size === 0) return;
    for (const e of entities) {
      const c = e.components as { materials?: Record<string, string>; model?: { asset?: { assetId?: string } }; instances?: { asset?: { assetId?: string } }; materialParams?: Record<string, Record<string, unknown>> };
      const assetId = c.model?.asset?.assetId ?? c.instances?.asset?.assetId;
      const base = assetId !== undefined ? this.assetMaterials[assetId] : undefined;
      if (base === undefined && c.materials === undefined) continue;
      const mapping = { ...(base ?? {}), ...(c.materials ?? {}) };
      const materials: string[] = [];
      for (const id of Object.values(mapping)) if (this.params.has(id) && !materials.includes(id)) materials.push(id);
      if (materials.length === 0) continue;
      this.worn.set(e.id, { materials, authored: c.materialParams ?? {} });
    }
  }

  /** Objects left the game: their values go with them (the renderer drops their objects). */
  removeEntities(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.worn.delete(id);
      this.state.delete(id);
    }
    for (const [k, c] of [...this.pending]) if (ids.has(c.entityId)) this.pending.delete(k);
  }

  /** A step begins (the write limit counts per step). */
  beginStep(stepIndex: number): void {
    if (this.writesStep !== stepIndex) {
      this.writesStep = stepIndex;
      this.writes = 0;
    }
  }

  /** A new run: every object back to its authored values (the renderer is told). */
  reset(): void {
    for (const [entityId, byMaterial] of this.state) {
      for (const [materialId, s] of byMaterial) {
        for (const key of s.values.keys()) this.mark('clear', entityId, materialId, key);
        for (const key of s.data.keys()) this.mark('data', entityId, materialId, key);
      }
    }
    this.state.clear();
  }

  /** The changes since the last call (one per changed parameter). */
  takeRenderChanges(): MaterialRenderChange[] {
    if (this.pending.size === 0) return [];
    const out: MaterialRenderChange[] = [];
    for (const c of this.pending.values()) {
      const p = this.params.get(c.materialId)?.get(c.key);
      if (p === undefined) continue;
      if (c.op === 'clear') out.push({ op: 'clear', entityId: c.entityId, materialId: c.materialId, key: c.key });
      else if (c.op === 'data') {
        const grid = this.state.get(c.entityId)?.get(c.materialId)?.data.get(c.key) ?? filledGrid(p);
        out.push({ op: 'data', entityId: c.entityId, materialId: c.materialId, key: c.key, size: [p.size![0], p.size![1]], bytes: new Uint8Array(grid) });
      } else {
        const v = this.state.get(c.entityId)?.get(c.materialId)?.values.get(c.key);
        if (v !== undefined) out.push({ op: 'set', entityId: c.entityId, materialId: c.materialId, key: c.key, type: p.type as Exclude<RuntimeMaterialParameterType, 'data'>, value: v });
      }
    }
    this.pending.clear();
    return out;
  }

  /** The values scripts set, as digest text (null while none is set: the step digest stays as before). */
  digestText(): string | null {
    if (this.state.size === 0) return null;
    const rows: string[] = [];
    for (const [entityId, byMaterial] of this.state) {
      for (const [materialId, s] of byMaterial) {
        for (const [k, v] of s.values) rows.push(`${entityId}|${materialId}|${k}=${JSON.stringify(v)}`);
        for (const [k, b] of s.data) rows.push(`${entityId}|${materialId}|${k}#${fnvBytes(b)}`);
      }
    }
    return rows.sort().join('\n');
  }

  // ---- internals -------------------------------------------------------------------

  private mark(op: 'set' | 'clear' | 'data', entityId: string, materialId: string, key: string): void {
    const k = materialChangeKey({ entityId, materialId, key });
    this.pending.delete(k);
    this.pending.set(k, { op, entityId, materialId, key });
  }

  /** Counts one write; false at the per-step limit. */
  private write(): boolean {
    if (this.writes >= MATERIAL_WRITES_PER_STEP) return false;
    this.writes += 1;
    return true;
  }

  /** The object's graph materials that declare `param` as public (and are `materialId`, when given). */
  private targets(entityId: unknown, param: unknown, materialId: unknown): { materialId: string; p: RuntimeMaterialParameter }[] {
    if (typeof entityId !== 'string' || typeof param !== 'string') return [];
    const w = this.worn.get(entityId);
    if (w === undefined) return [];
    if (materialId !== undefined && materialId !== null && materialId !== '' && typeof materialId !== 'string') return [];
    const only = typeof materialId === 'string' && materialId !== '' ? materialId : null;
    const out: { materialId: string; p: RuntimeMaterialParameter }[] = [];
    for (const id of w.materials) {
      if (only !== null && id !== only) continue;
      const p = this.params.get(id)?.get(param);
      if (p !== undefined && p.visibility !== 'private') out.push({ materialId: id, p });
    }
    return out;
  }

  private stateOf(entityId: string, materialId: string): MaterialState {
    let byMaterial = this.state.get(entityId);
    if (byMaterial === undefined) this.state.set(entityId, (byMaterial = new Map()));
    let s = byMaterial.get(materialId);
    if (s === undefined) byMaterial.set(materialId, (s = { values: new Map(), data: new Map() }));
    return s;
  }

  private prune(entityId: string, materialId: string): void {
    const byMaterial = this.state.get(entityId);
    const s = byMaterial?.get(materialId);
    if (byMaterial === undefined || s === undefined || s.values.size > 0 || s.data.size > 0) return;
    byMaterial.delete(materialId);
    if (byMaterial.size === 0) this.state.delete(entityId);
  }

  private buildApi(): BehaviorMaterials {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const m = this;
    const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
    return Object.freeze({
      set(entityId: string, param: string, value: unknown, materialId?: string): boolean {
        const targets = m.targets(entityId, param, materialId).filter((t) => t.p.type !== 'data');
        if (targets.length === 0) return false;
        const checked = targets.map((t) => checkedValue(t.p, value, m.textures));
        if (checked.some((v) => v === undefined) || !m.write()) return false;
        targets.forEach((t, i) => {
          m.stateOf(entityId, t.materialId).values.set(param, checked[i]!);
          m.mark('set', entityId, t.materialId, param);
        });
        return true;
      },
      get(entityId: string, param: string, materialId?: string): unknown {
        const t = m.targets(entityId, param, materialId).find((x) => x.p.type !== 'data');
        if (t === undefined) return null;
        const v = m.state.get(entityId)?.get(t.materialId)?.values.get(param) ?? (m.worn.get(entityId)!.authored[t.materialId]?.[param] as MaterialParamValue | undefined) ?? t.p.default;
        return Array.isArray(v) ? [...v] : v;
      },
      reset(entityId: string, param?: string, materialId?: string): boolean {
        if (typeof entityId !== 'string') return false;
        const byMaterial = m.state.get(entityId);
        if (byMaterial === undefined) return m.worn.has(entityId) && (param === undefined || m.targets(entityId, param, materialId).length > 0);
        if (param !== undefined && typeof param !== 'string') return false;
        if (!m.write()) return false;
        const only = typeof materialId === 'string' && materialId !== '' ? materialId : null;
        let any = false;
        for (const [id, s] of [...byMaterial]) {
          if (only !== null && id !== only) continue;
          for (const key of [...s.values.keys()]) {
            if (param !== undefined && key !== param) continue;
            s.values.delete(key);
            m.mark('clear', entityId, id, key);
            any = true;
          }
          for (const key of [...s.data.keys()]) {
            if (param !== undefined && key !== param) continue;
            s.data.delete(key);
            m.mark('data', entityId, id, key);
            any = true;
          }
          m.prune(entityId, id);
        }
        return any || (param === undefined ? true : m.targets(entityId, param, materialId).length > 0);
      },
      setData(entityId: string, param: string, x: number, y: number, w: number, h: number, bytes: ArrayLike<number>, materialId?: string): boolean {
        const targets = m.targets(entityId, param, materialId).filter((t) => t.p.type === 'data');
        if (targets.length === 0 || !int(x) || !int(y) || !int(w) || !int(h) || w < 1 || h < 1 || x < 0 || y < 0) return false;
        if (bytes === null || typeof bytes !== 'object' || typeof (bytes as { length?: unknown }).length !== 'number' || bytes.length !== w * h * 4) return false;
        for (const t of targets) if (x + w > t.p.size![0] || y + h > t.p.size![1]) return false;
        for (let i = 0; i < bytes.length; i += 1) {
          const b = bytes[i];
          if (!int(b) || b < 0 || b > 255) return false;
        }
        if (!m.write()) return false;
        for (const t of targets) {
          const s = m.stateOf(entityId, t.materialId);
          let grid = s.data.get(param);
          if (grid === undefined) s.data.set(param, (grid = filledGrid(t.p)));
          const gw = t.p.size![0];
          for (let row = 0; row < h; row += 1) {
            for (let col = 0; col < w; col += 1) {
              const src = (row * w + col) * 4;
              const dst = ((y + row) * gw + (x + col)) * 4;
              grid[dst] = bytes[src]!;
              grid[dst + 1] = bytes[src + 1]!;
              grid[dst + 2] = bytes[src + 2]!;
              grid[dst + 3] = bytes[src + 3]!;
            }
          }
          m.mark('data', entityId, t.materialId, param);
        }
        return true;
      },
      getData(entityId: string, param: string, x: number, y: number, materialId?: string): number[] | null {
        const t = m.targets(entityId, param, materialId).find((q) => q.p.type === 'data');
        if (t === undefined || !int(x) || !int(y) || x < 0 || y < 0 || x >= t.p.size![0] || y >= t.p.size![1]) return null;
        const grid = m.state.get(entityId)?.get(t.materialId)?.data.get(param);
        if (grid === undefined) {
          const d = t.p.default as readonly number[];
          return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
        }
        const i = (y * t.p.size![0] + x) * 4;
        return [grid[i]!, grid[i + 1]!, grid[i + 2]!, grid[i + 3]!];
      },
    });
  }
}
