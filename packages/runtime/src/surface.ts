/**
 * The ground as scripts read it (`ctx.surface`): height, normal, slope and
 * material layer weights at a world point from whichever block layer or
 * terrain is there (`surface-query.ts` picks and samples; the backend's
 * `querySurface` reads the same way), for footsteps, effects and placing
 * things. `ctx.grid` keeps its cell queries.
 *
 * Block layers are read as the simulation holds them (every cell, kits as
 * shown, paint carried with the cells). Terrains are read from the tiles the
 * page decoded and handed over (heights and holes for collision, their
 * layer weights and paint for this): a tile not handed over yet — or let go
 * by world streaming — has no ground here, as it has no collider. What a
 * terrain answers is made from the tiles held when asked: the tiles change
 * only between steps, so a step's answers are the same in every run that
 * received the same tiles.
 *
 * Pure simulation state: the same answers on the page and in the worker.
 */
import { SurfaceRuleSet, TerrainField, flatTerrainTile, surfaceAt, terrainFlatStep, terrainTileKey, type BlockGridReader, type BlockLayerComponent, type BlockType, type EntityV3, type SurfaceAt, type SurfaceSource, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import type { TerrainColliders } from './terrain-collision';

/** The ground at a point as scripts see it. */
export interface SurfaceInfo {
  /** What answered: `'blocks'` (a block layer) or `'terrain'`, and that object's id. */
  readonly source: 'blocks' | 'terrain';
  readonly object: string;
  /** World height of the ground (metres), and the point on it. */
  readonly height: number;
  readonly point: readonly [number, number, number];
  /** Unit normal. */
  readonly normal: readonly [number, number, number];
  /** Degrees from level. */
  readonly slope: number;
  /** The material layers showing there, strongest first, and their weights (0–1, summing to 1). */
  readonly layers: readonly number[];
  readonly weights: readonly number[];
  /** Painted wetness 0–1 (block paint; 0 on terrain). */
  readonly wetness: number;
  /** On a block layer: the cell whose top it is (`ctx.grid.get`/`meta` read it) and its block type. */
  readonly cell?: readonly [number, number, number];
  readonly block?: string;
}

/**
 * The ground of the loaded scenes' block layers and terrains, whichever is
 * there (the highest ground at or below the point; a block layer on a tie).
 */
export interface BehaviorSurface {
  /**
   * The ground at or below a world position (a point inside blocks gives their top), or null where no block layer or loaded terrain tile has ground (a hole, off the level).
   * @graphPure
   * @graphNode Surface at
   */
  at(position: readonly [number, number, number]): SurfaceInfo | null;
  /**
   * The highest ground at world x, z, or null where there is none.
   * @graphPure
   * @graphNode Top surface
   */
  top(x: number, z: number): SurfaceInfo | null;
}

/** A block layer as the grid holds it (what the query reads of it). */
export interface SurfaceLayerView {
  readonly entityId: string;
  readonly component: BlockLayerComponent;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly shown: BlockGridReader;
  anchorOf(x: number, y: number, z: number): readonly [number, number, number] | null;
}

interface HeldTerrain {
  readonly component: TerrainComponent;
  readonly origin: readonly [number, number, number];
  field: TerrainField | null;
  version: number;
}

const vec = (v: readonly number[]): readonly [number, number, number] => Object.freeze([v[0]!, v[1]!, v[2]!] as [number, number, number]);

export class RuntimeSurface {
  private readonly terrains = new Map<string, HeldTerrain>();
  /** Each layer's material rules, by the rules list they were made from. */
  private readonly ruleSets = new WeakMap<object, SurfaceRuleSet>();
  readonly api: BehaviorSurface;

  constructor(
    private readonly layers: () => Iterable<SurfaceLayerView>,
    private readonly types: ReadonlyMap<string, BlockType>,
    private readonly tiles: TerrainColliders,
  ) {
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    this.api = Object.freeze({
      at: (position: readonly [number, number, number]): SurfaceInfo | null => {
        if (!Array.isArray(position) || position.length !== 3 || !position.every(finite)) return null;
        return this.query(position[0]!, position[1]!, position[2]!);
      },
      top: (x: number, z: number): SurfaceInfo | null => (finite(x) && finite(z) ? this.query(x, Infinity, z) : null),
    });
  }

  /** The terrains of entities that carry `terrain` (collision or not: scenery has ground too). */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const c = (e.components as { terrain?: TerrainComponent }).terrain;
      if (c === undefined || this.terrains.has(e.id)) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      this.terrains.set(e.id, { component: c, origin: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], field: null, version: -1 });
    }
  }

  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) this.terrains.delete(id);
  }

  /** A terrain's field over the tiles held now (made again only when they changed). */
  private fieldOf(t: HeldTerrain): TerrainField {
    const version = this.tiles.tileVersion;
    if (t.field !== null && t.version === version) return t.field;
    const c = t.component;
    const held = new Map<string, TerrainTile>();
    let flat: TerrainTile | null = null;
    for (const ref of c.tiles) {
      const key = terrainTileKey(ref.x, ref.z);
      if (ref.data === undefined) {
        // One flat tile shared by every tile without data.
        flat ??= flatTerrainTile(c.tileSamples, terrainFlatStep(c.heightRange));
        held.set(key, flat);
        continue;
      }
      const tile = this.tiles.tileOf(ref.data);
      if (tile !== undefined && tile.samples === c.tileSamples) held.set(key, tile as TerrainTile);
    }
    t.field = new TerrainField(c, t.origin, held);
    t.version = version;
    return t.field;
  }

  private rulesOf(comp: BlockLayerComponent): SurfaceRuleSet | undefined {
    const rules = comp.rules;
    if (rules === undefined || rules.length === 0) return undefined;
    let set = this.ruleSets.get(rules);
    if (set === undefined) {
      set = new SurfaceRuleSet(rules);
      this.ruleSets.set(rules, set);
    }
    return set;
  }

  private query(x: number, y: number, z: number): SurfaceInfo | null {
    const sources: SurfaceSource[] = [];
    for (const l of this.layers()) {
      const o = l.origin;
      sources.push({ kind: 'blocks', id: l.entityId, grid: l.shown, types: this.types, origin: [o.x, o.y, o.z], topSubdivision: l.component.topSubdivision ?? 1, wallPaint: l.component.wallPaint === true, ...(this.rulesOf(l.component) !== undefined ? { rules: this.rulesOf(l.component)! } : {}), anchorOf: (cx, cy, cz) => l.anchorOf(cx, cy, cz) });
    }
    for (const [id, t] of this.terrains) sources.push({ kind: 'terrain', id, field: this.fieldOf(t) });
    const s = surfaceAt(sources, x, y, z);
    return s === null ? null : freezeSurface(s);
  }
}

function freezeSurface(s: SurfaceAt): SurfaceInfo {
  return Object.freeze({
    source: s.source,
    object: s.object,
    height: s.height,
    point: vec(s.point),
    normal: vec(s.normal),
    slope: s.slope,
    layers: Object.freeze([...s.layers]),
    weights: Object.freeze([...s.weights]),
    wetness: s.wetness,
    ...(s.cell !== undefined ? { cell: vec(s.cell) } : {}),
    ...(s.block !== undefined ? { block: s.block } : {}),
  });
}
