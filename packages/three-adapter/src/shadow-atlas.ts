/**
 * The shadow atlas's plan: which shadowed local lights get a tile of the one
 * shared depth texture, how large, and which tiles are drawn this frame
 * (`shadow-atlas-draw.ts` draws them; the light loop samples a light's tile
 * through the matrix and rectangle in its record). Pure: no GPU.
 *
 * - **A memory budget, not a count.** The atlas is a square of a quality
 *   level's side (`shadowAtlas`); lights are ranked by how large they are on
 *   screen (their reach over their distance from the eye, {@link shadowRank})
 *   and served best first. A light the atlas has no room for draws
 *   unshadowed; no number of lights is a limit.
 * - **Tile sizes** follow the rank, powers of two from
 *   {@link SPOT_TILE_MIN} to {@link SPOT_TILE_MAX} for a spot (its own map
 *   was the ceiling), {@link FACE_TILE_MIN} to {@link FACE_TILE_MAX} a face
 *   for a light seen through several faces (a point light's six, an area
 *   light's five), never past the atlas; a light that does not fit at its
 *   size takes smaller tiles before none. A light's faces are one grant:
 *   all of them or none, all the same size, so it is never half shadowed. Tiles come from a quadtree (buddy)
 *   allocator: a freed tile merges with its free siblings, so the atlas does
 *   not fragment into slivers.
 * - **No thrash.** A light keeps its tile's size until its rank has asked
 *   for another for {@link ATLAS_HOLD_FRAMES} frames; a resized light keeps
 *   sampling its old tile until the new one is drawn. A host drawing on
 *   demand draws those frames (`moving`), so a still view ends with each
 *   light's tile at the size its rank asks for, unless there was no room.
 * - **No pop.** A light gaining a tile fades its shadow in over
 *   {@link ATLAS_FADE_SECONDS} (over frames, however long since the last:
 *   {@link ATLAS_FADE_STEP_MAX}); one losing its tile to a better-ranked light
 *   fades it out over the same time before the tile is given away (it keeps
 *   sampling its own, still valid, depth meanwhile). Shadows also fade out
 *   with distance from the eye (from 3/4 of {@link LOCAL_SHADOW_DISTANCE}).
 *   A light out of view (or in a room no portal shows) loses its tile at
 *   once: nothing it lights is seen.
 * - **Redraws.** A tile is drawn when it is new or resized, and when its
 *   light moved, the static casters changed or something moved within its
 *   reach (the caller's `dirty`). At most {@link ATLAS_REDRAW_SHARE} of the
 *   atlas's texels are drawn a frame, best rank first (always at least one
 *   tile); a dirty tile left over keeps last frame's depth one frame more.
 *   A light with faces counts all its faces' texels.
 */

/** Metres from the eye at which a local light's shadow has faded out (from 3/4 of it on). */
export const LOCAL_SHADOW_DISTANCE = 40;
/** A spot light's tile: the smallest and the largest side (texels; the largest was its own shadow map's). */
export const SPOT_TILE_MIN = 128;
export const SPOT_TILE_MAX = 1024;
/** A face of a light seen through several (a point light's six): the smallest and the largest side (the largest was a point light's own map's). */
export const FACE_TILE_MIN = 64;
export const FACE_TILE_MAX = 512;
/** Frames a light's rank must ask for another tile size before it gets it. */
export const ATLAS_HOLD_FRAMES = 30;
/** Seconds a shadow takes to fade in on a new tile, and out when the tile is given away. */
export const ATLAS_FADE_SECONDS = 0.25;
/**
 * The most a frame advances a fade by (s). A host drawing on demand draws again only while something moves, so
 * the first frame after an idle spell or a skipped precompile has a long time step: taken whole, it ends a fade
 * at once (the shadow pops in) and no later frame comes to show the atlas settled.
 */
export const ATLAS_FADE_STEP_MAX = 1 / 30;
/** The share of the atlas's texels drawn a frame at most. */
export const ATLAS_REDRAW_SHARE = 0.25;
/** The reach a light without a range is ranked with (m). */
export const UNBOUNDED_SHADOW_REACH = 20;

/**
 * A shadowed light's rank for the view: its reach over its distance from the
 * eye (how large its light is on screen), 0 when it is not seen or its
 * shadow has faded out with distance; and that fade (1 near, 0 at
 * {@link LOCAL_SHADOW_DISTANCE}).
 */
export function shadowRank(reach: number, distance: number, seen: boolean): { rank: number; fade: number } {
  const fade = 1 - smoothstep(distance, LOCAL_SHADOW_DISTANCE * 0.75, LOCAL_SHADOW_DISTANCE);
  return { rank: seen && fade > 0 ? reach / Math.max(distance, 1) : 0, fade };
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The tile side a rank asks for: the largest at a reach half the distance or nearer, halving as the light shrinks on screen. */
export function tileSizeFor(rank: number, side: number, min = SPOT_TILE_MIN, max = SPOT_TILE_MAX): number {
  const top = Math.min(max, side);
  const want = top * Math.min(1, 2 * rank);
  let s = top;
  while (s > min && s / 2 >= want) s /= 2;
  return Math.max(Math.min(min, side), s);
}

/** A square tile of the atlas (texels from the top left). */
export interface AtlasTile {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * Power-of-two square tiles of a square atlas: a quadtree's free blocks per
 * level, split on demand and merged back when all four children are free.
 */
export class QuadAllocator {
  /** Free blocks per level (level 0: the whole atlas), by their index in that level's grid. */
  private readonly free: Set<number>[] = [];
  private readonly levels: number;

  constructor(
    readonly side: number,
    readonly min: number,
  ) {
    this.levels = Math.max(1, Math.round(Math.log2(side / Math.min(min, side))) + 1);
    for (let l = 0; l < this.levels; l += 1) this.free.push(new Set());
    this.free[0]!.add(0);
  }

  /** A free tile of `size` (a power of two, `min` to `side`), or null. */
  alloc(size: number): AtlasTile | null {
    const level = this.levelOf(size);
    if (level < 0) return null;
    let l = level;
    while (l >= 0 && this.free[l]!.size === 0) l -= 1;
    if (l < 0) return null;
    // The lowest index first (tiles pack towards the top left).
    let index = Math.min(...this.free[l]!);
    this.free[l]!.delete(index);
    // Split down: keep the first child, free the other three.
    while (l < level) {
      const n = 1 << l;
      const x = index % n;
      const y = Math.floor(index / n);
      l += 1;
      const m = 1 << l;
      const c = 2 * x + 2 * y * m;
      this.free[l]!.add(c + 1);
      this.free[l]!.add(c + m);
      this.free[l]!.add(c + m + 1);
      index = c;
    }
    const n = 1 << level;
    return { x: (index % n) * size, y: Math.floor(index / n) * size, size };
  }

  /** Give a tile back (merging free siblings up the tree). */
  release(t: AtlasTile): void {
    let l = this.levelOf(t.size);
    if (l < 0) return;
    let n = 1 << l;
    let index = t.x / t.size + (t.y / t.size) * n;
    while (l > 0) {
      const x = index % n;
      const y = Math.floor(index / n);
      const bx = x - (x % 2);
      const by = y - (y % 2);
      const siblings = [bx + by * n, bx + 1 + by * n, bx + (by + 1) * n, bx + 1 + (by + 1) * n].filter((s) => s !== index);
      if (!siblings.every((s) => this.free[l]!.has(s))) break;
      for (const s of siblings) this.free[l]!.delete(s);
      l -= 1;
      n = 1 << l;
      index = bx / 2 + (by / 2) * n;
    }
    this.free[l]!.add(index);
  }

  /** Texels in free blocks. */
  freeTexels(): number {
    let t = 0;
    for (let l = 0; l < this.levels; l += 1) t += this.free[l]!.size * (this.side >> l) ** 2;
    return t;
  }

  private levelOf(size: number): number {
    if (size > this.side || size < this.min) return -1;
    const l = Math.round(Math.log2(this.side / size));
    return l < this.levels && this.side >> l === size ? l : -1;
  }
}

/** One shadowed light's wish this frame. */
export interface AtlasRequest {
  /** The light (any object that stays the same for it). */
  readonly key: object;
  /** {@link shadowRank}'s rank and fade. */
  readonly rank: number;
  readonly fade: number;
  /** What its tile shows can have changed (it moved, the static casters changed, something moved in its reach). */
  readonly dirty: boolean;
  /** The views its shadow takes (absent: 1, a spot's; a point light's 6), each a tile of {@link FACE_TILE_MIN}–{@link FACE_TILE_MAX}. */
  readonly faces?: number;
}

/** What a light has of the atlas this frame. */
export interface AtlasGrant {
  /** The tiles it samples, one a face (null: unshadowed). */
  readonly tiles: readonly AtlasTile[] | null;
  /** Its shadow's strength (0–1: the fades). */
  readonly intensity: number;
  /** The tiles to draw this frame (its sampled ones, or those it is moving to), or null. */
  readonly draw: readonly AtlasTile[] | null;
}

interface Held {
  /** Its tiles, one a face, all one size. */
  tile: AtlasTile[] | null;
  /** Tiles it moves to once drawn (a resize). */
  next: AtlasTile[] | null;
  readonly faces: number;
  /** Its sampled tile holds its depth. */
  drawn: boolean;
  dirty: boolean;
  /** Frames its rank has asked for another size, the size it asks for, and one it found no room for (0: none). */
  asking: number;
  wants: number;
  denied: number;
  /** The fade in (0–1) and whether it is giving its tile away. */
  shown: number;
  leaving: boolean;
  rank: number;
}

export interface ShadowAtlasDiagnostics {
  /** The atlas's side (texels). */
  readonly side: number;
  /** Shadowed lights handed in, those with a tile, those seen but without one. */
  readonly lights: number;
  readonly tiled: number;
  readonly waiting: number;
  /** Tiles and texels drawn this frame, and the share of the atlas in tiles. */
  readonly drawn: number;
  readonly drawnTexels: number;
  readonly used: number;
}

/** The allocator's smallest block: the smallest tile of either kind. */
const SMALLEST_TILE = Math.min(SPOT_TILE_MIN, FACE_TILE_MIN);

function texelsOf(tiles: readonly AtlasTile[] | null): number {
  return tiles === null ? 0 : tiles.length * tiles[0]!.size ** 2;
}

export class ShadowAtlasPlan {
  private alloc: QuadAllocator;
  private readonly held = new Map<object, Held>();
  private readonly grants = new Map<object, AtlasGrant>();
  private last: ShadowAtlasDiagnostics;
  /** A tile was given away this frame: the light waiting for it takes it next frame. */
  private freed = false;

  constructor(side: number) {
    this.alloc = new QuadAllocator(side, Math.min(SMALLEST_TILE, side));
    this.last = { side, lights: 0, tiled: 0, waiting: 0, drawn: 0, drawnTexels: 0, used: 0 };
  }

  get side(): number {
    return this.alloc.side;
  }

  /** Every tile given up (a new atlas texture, of `side`: each is drawn again). */
  reset(side: number): void {
    this.alloc = new QuadAllocator(side, Math.min(SMALLEST_TILE, side));
    this.held.clear();
  }

  /** The frame's plan for `requests` (`dt`: seconds since the last one). */
  update(requests: readonly AtlasRequest[], dt: number): ReadonlyMap<object, AtlasGrant> {
    const side = this.alloc.side;
    const step = Math.min(Math.max(0, dt), ATLAS_FADE_STEP_MAX) / ATLAS_FADE_SECONDS;
    this.freed = false;
    const wanted = new Map<object, AtlasRequest>();
    for (const r of requests) if (r.rank > 0) wanted.set(r.key, r);
    // Gone, out of view or faded out with distance: the tile goes now (nothing it lights is seen).
    for (const [key, h] of this.held) if (!wanted.has(key)) this.drop(key, h);
    const ranked = [...wanted.values()].sort((a, b) => b.rank - a.rank);
    for (const r of ranked) {
      let h = this.held.get(r.key);
      const faces = Math.max(1, r.faces ?? 1);
      if (h !== undefined && h.faces !== faces) {
        // Another kind of light under the same key: its tiles go, it asks again.
        this.drop(r.key, h);
        h = undefined;
      }
      if (h === undefined) this.held.set(r.key, (h = { tile: null, next: null, faces, drawn: false, dirty: true, asking: 0, wants: 0, denied: 0, shown: 0, leaving: false, rank: r.rank }));
      h.rank = r.rank;
      h.dirty ||= r.dirty;
      const size = faces > 1 ? tileSizeFor(r.rank, side, FACE_TILE_MIN, FACE_TILE_MAX) : tileSizeFor(r.rank, side);
      if (h.tile === null) {
        h.tile = this.take(size, faces);
        h.drawn = false;
        h.asking = 0;
        if (h.tile === null) this.makeRoom(r.rank);
        continue;
      }
      if (h.leaving || h.next !== null) continue;
      const held = h.tile[0]!.size;
      h.wants = size;
      h.asking = size !== held ? h.asking + 1 : 0;
      if (size === held) h.denied = 0;
      if (h.asking >= ATLAS_HOLD_FRAMES) {
        h.asking = 0;
        // Its new size if there is room (smaller, if that is all there is, but never smaller than asked when shrinking).
        h.next = size < held ? this.take(size, faces, size) : this.take(size, faces, held * 2);
        if (h.next === null) h.denied = size;
      }
    }
    // Redraws: new and resized tiles and dirty ones, best rank first, within the frame's share of texels.
    const budget = side * side * ATLAS_REDRAW_SHARE;
    let spent = 0;
    let drawn = 0;
    const draws = new Map<object, AtlasTile[]>();
    for (const r of ranked) {
      const h = this.held.get(r.key)!;
      const t = h.next ?? h.tile;
      if (t === null || (h.next === null && h.drawn && !h.dirty)) continue;
      const texels = t.length * t[0]!.size ** 2;
      if (drawn > 0 && spent + texels > budget) continue;
      spent += texels;
      drawn += 1;
      draws.set(r.key, t);
    }
    this.grants.clear();
    let tiled = 0;
    let waiting = 0;
    for (const r of ranked) {
      const h = this.held.get(r.key)!;
      const draw = draws.get(r.key) ?? null;
      if (draw !== null) {
        if (h.next !== null && draw === h.next) {
          for (const t of h.tile!) this.alloc.release(t);
          h.tile = h.next;
          h.next = null;
        }
        h.drawn = true;
        h.dirty = false;
      }
      if (h.tile === null) waiting += 1;
      else tiled += 1;
      // Fades: in while it holds a drawn tile, out while it gives the tile away (then the tile goes).
      if (h.leaving) h.shown = Math.max(0, h.shown - step);
      else if (h.tile !== null && h.drawn) h.shown = Math.min(1, h.shown + step);
      const shown = h.tile !== null && h.drawn ? h.shown : 0;
      this.grants.set(r.key, { tiles: shown > 0 ? h.tile : null, intensity: shown * r.fade, draw });
      if (h.leaving && h.shown <= 0) {
        this.drop(r.key, h, false);
        this.freed = true;
      }
    }
    let used = 0;
    for (const h of this.held.values()) used += texelsOf(h.tile) + texelsOf(h.next);
    this.last = { side, lights: requests.length, tiled, waiting, drawn, drawnTexels: spent, used: used / (side * side) };
    return this.grants;
  }

  diagnostics(): ShadowAtlasDiagnostics {
    return this.last;
  }

  /**
   * Whether a later frame changes what this one drew: a shadow fading, a tile waiting to be drawn or given away, a
   * light asking for another size (unless the last try found no room: then it tries again only on frames drawn for
   * something else, and a still view stops drawing).
   */
  moving(): boolean {
    if (this.freed) return true;
    for (const h of this.held.values()) if (h.leaving || (h.tile !== null && (!h.drawn || h.shown < 1)) || h.next !== null || (h.tile !== null && h.dirty) || (h.asking > 0 && h.wants !== h.denied)) return true;
    return false;
  }

  /** `faces` tiles of `size`, else of the largest smaller size there is room for (down to the smallest; `floor`: no smaller than that). */
  private take(size: number, faces: number, floor = 0): AtlasTile[] | null {
    const min = Math.max(floor, Math.min(faces > 1 ? FACE_TILE_MIN : SPOT_TILE_MIN, this.alloc.side));
    for (let s = size; s >= min; s /= 2) {
      const got: AtlasTile[] = [];
      for (let f = 0; f < faces; f += 1) {
        const t = this.alloc.alloc(s);
        if (t === null) break;
        got.push(t);
      }
      if (got.length === faces) return got;
      for (const t of got) this.alloc.release(t);
    }
    return null;
  }

  /** A light of `rank` found no room: the lowest-ranked light below it holding a tile starts giving it away. */
  private makeRoom(rank: number): void {
    let worst: Held | null = null;
    for (const h of this.held.values()) {
      if (h.leaving) return;
      if (h.tile !== null && h.rank < rank && (worst === null || h.rank < worst.rank)) worst = h;
    }
    if (worst !== null) worst.leaving = true;
  }

  private drop(key: object, h: Held, forget = true): void {
    for (const t of h.tile ?? []) this.alloc.release(t);
    for (const t of h.next ?? []) this.alloc.release(t);
    if (forget) this.held.delete(key);
    else {
      h.tile = null;
      h.next = null;
      h.drawn = false;
      h.dirty = true;
      h.leaving = false;
      h.shown = 0;
    }
  }
}
