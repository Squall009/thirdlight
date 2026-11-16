/**
 * The sun past its shadow map on voxel worlds: each column round the camera
 * gets a shade line, the height below which its points cannot see the sun
 * over what stands toward it, marched in compute over the sun heights
 * (`@thirdlight/voxel` sun-heights.ts: the near window from the worlds' sky
 * heights, 0.5 m columns over 512 m; the far window from the far field's
 * drawn bricks, 4 m columns over 4 km); a lit point reads its column's line.
 *
 * - **One term for every receiver.** The key light's shadow node is wrapped
 *   ({@link sunShadowed}): every material the sun lights takes it, the voxel
 *   surfaces, kit pieces, props and the far field's one shade alike (that
 *   shade gives the hit as its shadow position and its normal, so it is lit
 *   at what the pixel shows). Each column keeps two lines: one from every
 *   caster, one from those past the key light's map along the ray (farther
 *   across than its near plane reaches). Inside the map's square a point
 *   takes the map times the far line (a mountain kilometres toward the sun);
 *   past it, the whole line; across the square's edge the two are blended, so
 *   the map's shadows fade into the line's with no step.
 * - **The field** ({@link SunField}) is kept by the voxel draws: one storage
 *   buffer of tops and one of shade lines (the near window's columns, then
 *   the far window's, 32-bit metres, wrapped by tile so a move writes only
 *   what enters), made a light of the scene ({@link SunFieldLight}) so lit
 *   programs are built again with it once and find it among their lights. A
 *   world's sky heights arrive with the draw batches; the far field's nodes
 *   give their tops as they are drawn and taken away. The lines are marched
 *   a tile row of each window a frame, while anything changed (tops, the
 *   windows' place, the sun) in the last full pass: a change shows within
 *   that many frames. The frame's work (the march's row with the uploads it
 *   carries, then tiles composed) runs within the lighting preparation
 *   slice; one piece goes whatever the slice says (the row, or a tile in its
 *   place when the last frame composed none), so both move on.
 * - **At speed** (the camera faster than the streamer's level-0 speed,
 *   `STREAM_DETAIL_SPEED`, until it stayed slower for the streamer's stop
 *   time, `STREAM_STOPPED_MS`) the near window stays where it was: no level 0
 *   is built there, so the sky heights it would read ahead are unknown, and
 *   moving it would only clear and compose tiles the camera leaves within a
 *   second. While held it reads as no window (its tops are kept for later):
 *   the march skips its columns and lit points read the far window's lines
 *   (4 m columns); once the camera slows, the window comes to it, composes
 *   nearest first and its lines are marched again.
 * - **Quality.** The march's sample count is the tier's (`voxelSunSteps`; 0
 *   off); the GPU measurement's hide skips the march and the reads.
 *
 * WebGPU only: the voxel draws make no field on WebGL 2, whose programs keep
 * the plain shadow node.
 */
import * as THREE from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { composeSkyTile, FarSunTops, STREAM_DETAIL_SPEED, STREAM_STOPPED_MS, SUN_FAR_CELL_M, SUN_HEIGHT_NO_TOP, SUN_HEIGHT_NONE, SUN_HEIGHT_UNKNOWN, SUN_MARCH_FIRST_M, SUN_MARCH_REACH_M, SUN_MIN_RISE, SUN_NORMAL_OFFSET, SUN_WINDOW_TEXELS, SunHeightWindow, sunLit, sunMarchT, sunShadeAt, sunShadeOf, type FarBricks, type FarTopsPlace, type SkyColumns, type SunColumn } from '@thirdlight/voxel';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';

import type { N } from './effects-tsl';
import { TSL_SCALAR_OPS } from './field-ops';
import { untransformedTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { Fn, If, Loop, abs, exp2, float, floatBitsToUint, instanceIndex, int, ivec2, log2, max, min, mix, sqrt, normalWorldGeometry, positionWorld, renderGroup, select, smoothstep, step, storage, textureStore, uint, uniform, uvec2, varying, vec2, vec3, vec4 } = TSL;

/** A material's own world normal for the march (`material.userData[SUN_FIELD_NORMAL_KEY]`; absent: the geometry's, three's `normalWorldGeometry`). */
export const SUN_FIELD_NORMAL_KEY = 'tlSunFieldNormal';

/** Where across the map's half side (its edge at 1) the map hands over to the march: from the first, wholly by the second. */
export const SUN_MAP_FADE: readonly [number, number] = [0.8, 0.96];

/** The sun heights round the camera on the GPU, and the march over them. */
export class SunField {
  readonly near: SunHeightWindow;
  readonly far: FarSunTops;
  /** The near window's columns' tops, then the far window's (metres, a tile a run: sun-heights.ts `sunTileOffset`): read by the march pass. */
  readonly buffer: THREE.StorageBufferAttribute;
  private readonly heights: N;
  /**
   * Each column's two shade lines (red: from every caster, green: from those past the map; metres), the near
   * window's columns at x 0 … T − 1 beside the far window's, a column at its world index modulo the window: written
   * in compute into one texture, copied row by row into the one lit programs read (a storage texture is not bound
   * for writing and reading in one pass).
   */
  private readonly shadeWrite: StorageTexture;
  private readonly shadeRead: StorageTexture;
  private readonly shade: N;
  /** Toward the sun (unit), and how far across the far line's casters start (metres). */
  readonly sun: N = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  readonly farFrom: N = uniform(0).setGroup(renderGroup);
  /** The tile row the next march pass writes. */
  private readonly row: N = uniform(0);
  private rowNow = 0;
  /** Rows still to march before the lines hold everything changed (0: nothing to do). */
  private rowsLeft = 0;
  private readonly sunWas = new THREE.Vector3();
  private pass: N | null = null;
  /** Each window: its world corner (x, z), a column's width, and 1 once it holds anything. */
  readonly nearRect: N = uniform(new THREE.Vector4(0, 0, 1, 0)).setGroup(renderGroup);
  readonly farRect: N = uniform(new THREE.Vector4(0, 0, 1, 0)).setGroup(renderGroup);
  /** The highest top either window holds: a ray over it is out. */
  readonly topMax: N = uniform(0).setGroup(renderGroup);
  /** Samples a march takes (0: the march is skipped). */
  readonly steps: N = uniform(0).setGroup(renderGroup);
  private stepsWanted = 0;
  private hidden = false;
  private made = false;
  /** The camera's ground point and time at the last follow (the speed the near window is held at). */
  private readonly last = { x: NaN, z: NaN, t: NaN };
  private nearHeld = false;
  /** Since when the camera has been under the level-0 speed while the near window is held (NaN: it has not). */
  private slowSince = NaN;
  /** The last frame composed no tile while tiles waited (the next one composes one, whatever the slice says). */
  private starved = false;
  /** Tiles composed and uploaded, and the far nodes' tops made, since made; the ms the last frame's work took. */
  readonly stats = { nearTiles: 0, farTiles: 0, uploads: 0, farNodes: 0, rows: 0, frameMs: 0, farTopsMs: 0, heldFrames: 0 };

  constructor(
    edge: number,
    private readonly voxelM: number,
    private readonly skies: () => Iterable<SkyColumns>,
  ) {
    const T2 = SUN_WINDOW_TEXELS * SUN_WINDOW_TEXELS;
    const data = new Float32Array(2 * T2);
    this.near = new SunHeightWindow(voxelM, SUN_WINDOW_TEXELS, edge, data.subarray(0, T2));
    this.far = new FarSunTops(edge, voxelM, SUN_FAR_CELL_M, data.subarray(T2));
    this.buffer = new THREE.StorageBufferAttribute(data, 1);
    this.buffer.name = 'voxel sun heights';
    this.heights = storage(this.buffer, 'float', 2 * T2).toReadOnly();
    const make = (name: string): StorageTexture => {
      const t = new StorageTexture(2 * SUN_WINDOW_TEXELS, SUN_WINDOW_TEXELS);
      t.type = THREE.FloatType;
      t.format = THREE.RGFormat;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.name = name;
      return t;
    };
    this.shadeWrite = make('voxel sun shade lines (marched)');
    this.shadeRead = make('voxel sun shade lines');
    this.shade = untransformedTexture(this.shadeRead);
  }

  /** GPU and page bytes (the buffer on both sides, the far nodes' tops). */
  get bytes(): number {
    // The tops on both sides, the two line textures (8 bytes a column each), the far nodes' tops.
    return this.buffer.array.byteLength * (this.made ? 2 : 1) + (this.made ? 2 * 2 * SUN_WINDOW_TEXELS * SUN_WINDOW_TEXELS * 8 : 0) + this.far.bytes;
  }

  /** The tier's samples a march (0: off). */
  setSteps(n: number): void {
    this.stepsWanted = Math.max(0, Math.floor(n));
    const was = this.steps.value as number;
    this.steps.value = this.hidden ? 0 : this.stepsWanted;
    if (this.steps.value !== was && this.stepsWanted > 0) this.dirty();
  }

  /** The GPU measurement's hide: the march skipped while hidden. */
  hide(h: boolean): void {
    this.hidden = h;
    this.steps.value = h ? 0 : this.stepsWanted;
  }

  /** Whether marches run now. */
  get on(): boolean {
    return (this.steps.value as number) > 0;
  }

  /**
   * Both windows centred on the camera's ground point (x, z), the sun along `dir` (the way the key light shines,
   * unit), the far line's casters from `farFrom` metres across; `now` (ms) times the camera's speed: past the
   * streamer's level-0 speed the near window stays where it is (the module comment).
   */
  follow(x: number, z: number, dir: THREE.Vector3, farFrom: number, now = performance.now()): void {
    const l = this.last;
    const dt = (now - l.t) / 1000;
    // A second follow in the same instant (another pass of the frame) keeps what the first one found.
    const held = this.nearHeld;
    // Held at once past the speed; let go once the camera stayed under it for the streamer's stop time: a frame that
    // shows the same pose as the last (the camera is posed by the simulation's steps) is not a stop.
    if (dt > 0) {
      if (Math.hypot(x - l.x, z - l.z) / dt > STREAM_DETAIL_SPEED * this.voxelM && !Number.isNaN(this.near.tileX)) {
        this.nearHeld = true;
        this.slowSince = NaN;
      } else if (this.nearHeld) {
        if (Number.isNaN(this.slowSince)) this.slowSince = now;
        if (now - this.slowSince >= STREAM_STOPPED_MS) {
          this.nearHeld = false;
          this.slowSince = NaN;
        }
      }
    }
    if (dt > 0 || Number.isNaN(l.t)) {
      l.x = x;
      l.z = z;
      l.t = now;
      if (this.nearHeld) this.stats.heldFrames++;
    }
    const nearMoved = !this.nearHeld && this.near.follow(x, z);
    // Held or let go, the near window's lines are marched again: unknown while held, its columns once let go.
    if (this.far.window.follow(x, z) || nearMoved || held !== this.nearHeld) this.dirty();
    const sun = this.sun.value as THREE.Vector3;
    sun.copy(dir).negate();
    this.farFrom.value = farFrom;
    // A sun turned by more than a hundredth of a degree marches the lines again (a sweeping sun keeps them marching).
    if (sun.dot(this.sunWas) < Math.cos((0.01 * Math.PI) / 180)) {
      this.sunWas.copy(sun);
      this.dirty();
    }
    this.rects();
  }

  /** The lines are marched again, every row (a change to tops, the windows' place or the sun). */
  private dirty(): void {
    this.rowsLeft = SUN_WINDOW_TEXELS / this.near.tile;
  }

  /** Whether the near window stays where it is for the camera's speed. */
  get held(): boolean {
    return this.nearHeld;
  }

  /** Rows of the lines still to march. */
  get marching(): number {
    return this.rowsLeft;
  }

  /** Sky heights of these chunk columns changed (a batch brought them). */
  skyChanged(columns: Iterable<{ readonly cx: number; readonly cz: number }>): void {
    for (const c of columns) this.near.mark(c.cx, c.cz);
  }

  /** A far node drawn with these bricks (again: replaced). */
  farAdded(key: string, at: FarTopsPlace, bricks: FarBricks): void {
    const t0 = performance.now();
    this.far.add(key, at, bricks);
    this.stats.farNodes++;
    this.stats.farTopsMs += performance.now() - t0;
  }

  /** A far node no longer drawn. */
  farRemoved(key: string): void {
    this.far.remove(key);
  }

  /** Tiles waiting (near, far). */
  get waiting(): readonly [number, number] {
    return [this.near.waiting, this.far.window.waiting];
  }

  /**
   * The frame's share while the march is on, within `more()` (the slice): a row of the lines marched while anything
   * changed (its dispatch uploads the tops changed since), then tiles composed (near ones first, none while the near
   * window is held), what they changed set to go up with the next row. One piece goes whatever the slice says: the
   * row, or, when the last frame composed no tile while tiles waited, a tile in its place (never both): both move on.
   */
  frame(more: () => boolean, renderer: SunFieldRenderer | null): void {
    if (Number.isNaN(this.near.tileX)) return;
    const t0 = performance.now();
    // Nothing is composed while the march is off (the tiles wait, marked, for it to come on).
    if ((this.steps.value as number) === 0) return;
    // One piece goes whatever the slice says: the row, or a tile in its place when the last frame composed none.
    let did = false;
    if (renderer !== null && this.rowsLeft > 0 && this.made && !this.starved) {
      this.march(renderer);
      did = true;
    }
    // A tile not composed yet reads as unknown, never as another place's.
    const force = !did;
    let composed = 0;
    const go = (): boolean => (force && composed === 0) || more();
    if (!this.nearHeld) {
      for (let t = go() ? this.near.next() : null; t !== null; t = go() ? this.near.next() : null) {
        composeSkyTile(this.near, t[0], t[1], this.skies(), this.voxelM);
        this.stats.nearTiles++;
        composed++;
      }
    }
    while (go() && this.far.composeNext()) {
      this.stats.farTiles++;
      composed++;
    }
    this.starved = composed === 0 && (this.far.window.waiting > 0 || (!this.nearHeld && this.near.waiting > 0));
    const T2 = SUN_WINDOW_TEXELS * SUN_WINDOW_TEXELS;
    let runs = 0;
    for (const [w, base] of [[this.near, 0], [this.far.window, T2]] as const) {
      for (const c of w.takeChanged()) {
        this.buffer.addUpdateRange(base + c.offset, c.count);
        runs++;
      }
    }
    // The first upload is the whole buffer (three sends it with its first use either way).
    if (!this.made) this.buffer.clearUpdateRanges();
    if (runs > 0 || !this.made) {
      this.buffer.needsUpdate = true;
      this.stats.uploads += Math.max(1, runs);
      this.dirty();
    }
    this.made = true;
    this.rects();
    this.stats.frameMs = performance.now() - t0;
  }

  /** One tile row of each window marched (round and round while anything changed), into the texture lit programs read. */
  private march(renderer: SunFieldRenderer): void {
    const tile = this.near.tile;
    this.row.value = this.rowNow;
    void renderer.compute((this.pass ??= this.marchPass()));
    // The row's texels into the texture lit programs read (its slot row in both windows).
    const box = scratchBox.set(scratchFrom.set(0, this.rowNow * tile, 0), scratchTo.set(2 * SUN_WINDOW_TEXELS, (this.rowNow + 1) * tile, 1));
    renderer.copyTextureToTexture(this.shadeWrite, this.shadeRead, box, scratchAt.set(0, this.rowNow * tile, 0));
    this.rowNow = (this.rowNow + 1) % (SUN_WINDOW_TEXELS / tile);
    this.rowsLeft--;
    this.stats.rows++;
  }

  private rects(): void {
    const set = (u: N, w: SunHeightWindow, shown: boolean): void => {
      const [x, z] = Number.isNaN(w.tileX) ? [0, 0] : w.origin;
      (u.value as THREE.Vector4).set(x, z, w.cellM, shown && this.made && !Number.isNaN(w.tileX) ? 1 : 0);
    };
    set(this.nearRect, this.near, !this.nearHeld);
    set(this.farRect, this.far.window, true);
    this.topMax.value = Math.max(this.near.topMax, this.far.window.topMax);
  }

  /**
   * The CPU reference's shade lines at world point `p` from the windows as composed here (a check of what the
   * compute pass writes; nearest columns): the near and far tops there and the lines, and whether a point at `p`'s
   * height sees the sun over the whole line.
   */
  probe(p: readonly number[]): { readonly near: number; readonly far: number; readonly all: number; readonly farLine: number; readonly lit: number } {
    const column = (x: number, z: number): SunColumn => {
      const n = this.near.topAt(x, z);
      return n > SUN_HEIGHT_NONE * 0.5 + SUN_HEIGHT_UNKNOWN * 0.5 ? { top: n, cellM: this.near.cellM } : { top: this.far.window.topAt(x, z), cellM: this.far.window.cellM };
    };
    const c = column(p[0]!, p[2]!);
    const x = (Math.floor(p[0]! / c.cellM) + 0.5) * c.cellM;
    const z = (Math.floor(p[2]! / c.cellM) + 0.5) * c.cellM;
    const sun = (this.sun.value as THREE.Vector3).toArray();
    const v = sunShadeAt(column, x, z, sun, { steps: Math.max(1, this.stepsWanted), topMax: Math.max(this.near.topMax, this.far.window.topMax), farFrom: this.farFrom.value as number, ops: CPU_SCALAR_OPS });
    return { near: this.near.topAt(p[0]!, p[2]!), far: this.far.window.topAt(p[0]!, p[2]!), all: v.all, farLine: v.far, lit: sunLit(CPU_SCALAR_OPS, p[1]! + c.cellM * SUN_NORMAL_OFFSET, v.all, c.cellM) };
  }

  /** World column (i, j) of a window (`rect`, tiles of `tile`) in its data (sun-heights.ts `sunTileOffset`): its offset, and whether the window holds it. */
  private place(rect: N, tile: number, i: N, j: N): { inside: N; at: N } {
    const T = SUN_WINDOW_TEXELS;
    const i0 = rect.x.div(rect.z).round();
    const j0 = rect.y.div(rect.z).round();
    const inside = rect.w.greaterThan(0.5).and(i.greaterThanEqual(i0)).and(j.greaterThanEqual(j0)).and(i.lessThan(i0.add(T))).and(j.lessThan(j0.add(T)));
    const tiles = T / tile;
    const tx = i.div(tile).floor();
    const tz = j.div(tile).floor();
    const sx = tx.sub(tx.div(tiles).floor().mul(tiles));
    const sz = tz.sub(tz.div(tiles).floor().mul(tiles));
    const at = sz.mul(tiles).add(sx).mul(tile * tile).add(j.sub(tz.mul(tile)).mul(tile)).add(i.sub(tx.mul(tile)));
    return { inside, at: select(inside, at, float(0)) };
  }

  /** The top of world column (i, j) of a window (`base` its data's start), unknown outside it. */
  private top(rect: N, base: number, tile: number, i: N, j: N): N {
    const o = this.place(rect, tile, i, j);
    return select(o.inside, this.heights.element(int(o.at).add(base)), float(SUN_HEIGHT_UNKNOWN));
  }

  /**
   * The top under world point `xz` (vec2) and the window's column width: the near window where it knows the column,
   * else the far. `nearest`: the column's own top; else, in the near window, the four nearest tops blended (or the
   * highest of them where one is not a top), so a march's samples see a smooth ground.
   */
  column(xz: N, nearest: boolean): { top: N; cellM: N } {
    const T = SUN_WINDOW_TEXELS;
    const read = (rect: N, base: number, tile: number, i: N, j: N): N => this.top(rect, base, tile, i, j);
    const top = float(SUN_HEIGHT_UNKNOWN).toVar();
    const cellM = this.farRect.z.toVar();
    const own = read(this.nearRect, 0, this.near.tile, xz.x.div(this.nearRect.z).floor(), xz.y.div(this.nearRect.z).floor()).toVar();
    If(own.greaterThan(SUN_HEIGHT_NONE * 0.5 + SUN_HEIGHT_UNKNOWN * 0.5), () => {
      cellM.assign(this.nearRect.z);
      if (nearest) {
        top.assign(own);
        return;
      }
      const g = xz.div(this.nearRect.z).sub(0.5);
      const i = g.x.floor();
      const j = g.y.floor();
      const f = g.sub(vec2(i, j));
      const t = [read(this.nearRect, 0, this.near.tile, i, j), read(this.nearRect, 0, this.near.tile, i.add(1), j), read(this.nearRect, 0, this.near.tile, i, j.add(1)), read(this.nearRect, 0, this.near.tile, i.add(1), j.add(1))].map((v) => v.toVar());
      const tops = t[0]!.greaterThan(SUN_HEIGHT_NO_TOP).and(t[1]!.greaterThan(SUN_HEIGHT_NO_TOP)).and(t[2]!.greaterThan(SUN_HEIGHT_NO_TOP)).and(t[3]!.greaterThan(SUN_HEIGHT_NO_TOP));
      top.assign(select(tops, mix(mix(t[0]!, t[1]!, f.x), mix(t[2]!, t[3]!, f.x), f.y), max(max(t[0]!, t[1]!), max(t[2]!, t[3]!))));
    }).Else(() => {
      top.assign(read(this.farRect, T * T, this.far.window.tile, xz.x.div(this.farRect.z).floor(), xz.y.div(this.farRect.z).floor()));
    });
    return { top, cellM };
  }

  /**
   * The march pass: one invocation a column of one tile row of each window (the row in {@link row}), its shade
   * lines from its own top and the samples toward the sun (as sun-heights.ts `sunShadeAt`, the tops read by
   * {@link column}).
   */
  private marchPass(): N {
    const T = SUN_WINDOW_TEXELS;
    const o = TSL_SCALAR_OPS;
    const tile = this.near.tile;
    const tiles = T / tile;
    const rowColumns = tiles * tile * tile;
    return Fn(() => {
      const k = instanceIndex;
      const far = k.greaterThanEqual(rowColumns);
      const rem = k.mod(rowColumns);
      const sx = float(rem.div(tile * tile));
      const local = rem.mod(tile * tile);
      const li = float(local.mod(tile));
      const lj = float(local.div(tile));
      const rect = select(far, this.farRect, this.nearRect);
      const sz = this.row;
      // The window's first tile, and the world tile its slot (sx, sz) holds now.
      const t0x = rect.x.div(rect.z.mul(tile)).round();
      const t0z = rect.y.div(rect.z.mul(tile)).round();
      const tx = t0x.add(sx.sub(t0x).sub(sx.sub(t0x).div(tiles).floor().mul(tiles)));
      const tz = t0z.add(sz.sub(t0z).sub(sz.sub(t0z).div(tiles).floor().mul(tiles)));
      const centre = vec2(tx.mul(tile).add(li).add(0.5), tz.mul(tile).add(lj).add(0.5)).mul(rect.z).toVar();
      const ownNear = this.top(this.nearRect, 0, tile, tx.mul(tile).add(li), tz.mul(tile).add(lj)).toVar();
      // A near column its window does not know reads as unknown (a lit point there reads the far window).
      const known = far.or(ownNear.greaterThan(SUN_HEIGHT_NONE * 0.5 + SUN_HEIGHT_UNKNOWN * 0.5));
      const own = this.column(centre, true).top.toVar();
      const all = select(known, select(own.greaterThan(SUN_HEIGHT_NO_TOP), own, float(SUN_HEIGHT_NONE)), float(SUN_HEIGHT_UNKNOWN)).toVar();
      const farLine = select(known, float(SUN_HEIGHT_NONE), float(SUN_HEIGHT_UNKNOWN)).toVar();
      const sun = this.sun;
      const across = vec2(sun.x, sun.z).length();
      If(known.and(sun.y.greaterThan(SUN_MIN_RISE)).and(across.greaterThan(1e-3)), () => {
        const slope = sun.y.div(across);
        const dir = vec2(sun.x, sun.z).div(across);
        const d0 = float(SUN_MARCH_FIRST_M);
        const d1 = max(d0, min(float(SUN_MARCH_REACH_M), this.topMax.sub(max(own, -1e4)).div(slope)));
        const steps = int(this.steps);
        const grow = exp2(log2(d1.div(d0)).div(float(steps))).toVar();
        const d = d0.mul(sqrt(grow)).toVar();
        Loop({ start: int(0), end: steps, type: 'int', condition: '<', name: 'k' }, () => {
          const c = this.column(centre.add(dir.mul(d)), false);
          const shade = select(c.top.greaterThan(SUN_HEIGHT_NO_TOP), sunShadeOf(o, c.top, d, slope), float(SUN_HEIGHT_NONE)).toVar();
          all.assign(max(all, shade));
          farLine.assign(max(farLine, select(d.greaterThanEqual(this.farFrom), shade, float(SUN_HEIGHT_NONE))));
          d.assign(sunMarchT(o, d, grow));
        });
      });
      // Its texel: the slot's place in its window (the column's world index modulo the window), the far window to the right.
      const x = sx.mul(tile).add(li).add(select(far, float(T), float(0)));
      const y = sz.mul(tile).add(lj);
      textureStore(this.shadeWrite, uvec2(uint(x), uint(y)), vec4(all, farLine, 0, 0));
    })().compute(2 * rowColumns, [64]);
  }

  /** The two shade lines of world column (i, j) of a window (`far`: the far one); unknown outside it. */
  private line(far: boolean, i: N, j: N): N {
    const T = SUN_WINDOW_TEXELS;
    const rect = far ? this.farRect : this.nearRect;
    const i0 = rect.x.div(rect.z).round();
    const j0 = rect.y.div(rect.z).round();
    const inside = rect.w.greaterThan(0.5).and(i.greaterThanEqual(i0)).and(j.greaterThanEqual(j0)).and(i.lessThan(i0.add(T))).and(j.lessThan(j0.add(T)));
    const x = i.sub(i.div(T).floor().mul(T)).add(far ? T : 0);
    const y = j.sub(j.div(T).floor().mul(T));
    return select(inside, this.shade.load(ivec2(int(x), int(y))).xy, vec2(SUN_HEIGHT_UNKNOWN, SUN_HEIGHT_UNKNOWN));
  }

  /**
   * How much of the sun a point `p` (normal `n`) sees over its column's shade lines: `all` over every caster's,
   * `past` over those past the key light's map. The near window's line where it knows the column, else the far's.
   */
  lit(p: N, n: N): { all: N; past: N } {
    const known = (l: N): N => l.x.greaterThan(SUN_HEIGHT_NONE * 0.5 + SUN_HEIGHT_UNKNOWN * 0.5);
    const at = (q: N): { line: N; cellM: N } => {
      const nl = this.line(false, q.x.div(this.nearRect.z).floor(), q.z.div(this.nearRect.z).floor());
      const k = known(nl);
      const fl = this.line(true, q.x.div(this.farRect.z).floor(), q.z.div(this.farRect.z).floor());
      return { line: select(k, nl, fl), cellM: select(k, this.nearRect.z, this.farRect.z) };
    };
    // Off its own column's top by its normal, by the column's width there.
    const s = p.add(n.mul(at(p).cellM.mul(SUN_NORMAL_OFFSET))).toVar();
    const c = at(s);
    const o = TSL_SCALAR_OPS;
    const none = c.line.x.lessThan(SUN_HEIGHT_NONE * 0.5 + SUN_HEIGHT_UNKNOWN * 0.5);
    return { all: select(none, float(1), sunLit(o, s.y, c.line.x, c.cellM)), past: select(none, float(1), sunLit(o, s.y, c.line.y, c.cellM)) };
  }

  dispose(): void {
    this.shadeWrite.dispose();
    this.shadeRead.dispose();
  }
}

/** The field as a light of the scene: lit programs find it among their lights (and are built again when it comes). */
export class SunFieldLight extends THREE.Light {
  readonly isSunField = true;
  constructor(readonly field: SunField) {
    super(0xffffff, 0);
    this.name = 'voxel sun field';
  }
}

/** Its light node lights nothing: the key light's shadow reads the field. */
class SunFieldNode extends (THREE.LightingNode as unknown as new () => { [k: string]: unknown }) {
  static get type(): string {
    return 'SunFieldNode';
  }

  constructor(readonly light: SunFieldLight) {
    super();
  }

  setup(): void {}
}

/** Teach a renderer the sun field's light. */
export function registerSunField(): void {
  SunFieldLight.registerNode(SunFieldNode as never);
}

/** The sun field among a build's lights (null: none). */
function sunFieldOf(builder: N): SunField | null {
  const lights = (builder.lightsNode?.getLights?.() ?? []) as THREE.Light[];
  for (const l of lights) if ((l as Partial<SunFieldLight>).isSunField === true) return (l as SunFieldLight).field;
  return null;
}

/** The key light's shadow node with the field's march over it, and the map's square it hands over at. */
class SunShadowedNode extends (THREE.Node as unknown as new (type?: string | null) => { [k: string]: unknown }) {
  static get type(): string {
    return 'SunShadowedNode';
  }

  /** The key light's square: its centre, its two axes (the light's camera's) and half side. */
  readonly centre: N = uniform(new THREE.Vector3()).setGroup(renderGroup);
  readonly right: N = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  readonly up: N = uniform(new THREE.Vector3(0, 0, 1)).setGroup(renderGroup);
  /** 0 until the square is known: the march alone then. */
  readonly half: N = uniform(0).setGroup(renderGroup);

  constructor(readonly inner: N) {
    super();
  }

  /** The map's own type (three's shadow node, a colour; a float where a build's shadow is one value). */
  getNodeType(builder: N): string {
    return this.inner.getNodeType(builder);
  }

  setup(builder: N): N {
    const field = sunFieldOf(builder);
    if (field === null || builder.renderer?.backend?.isWebGPUBackend !== true) return this.inner;
    const m = builder.material ?? {};
    const own = m.userData?.[SUN_FIELD_NORMAL_KEY] as N | undefined;
    const p: N = m.receivedShadowPositionNode ?? builder.context.shadowPositionWorld ?? positionWorld;
    // Plain expressions here (no branch, no variable): a program may read the key light's shadow more than once, and
    // statements would be written only where it is read first. The reads are a function of their own.
    const at = vec3(p);
    // Read at each vertex and carried to the pixels, except where a material places its points itself (the far
    // field's one shade, which reads at each pixel): with the read in their fragment stage the voxel draws flickered
    // frame to frame in the Play test, the values unused or not (D-row in the audit; the vertex stage binds few
    // textures). A line's edge is then as fine as the near mesh's vertices.
    const v = own !== undefined ? this.litFor(field)(at, vec3(own)) : varying(this.litInline(field, positionWorld, normalWorldGeometry), 'tlSunLit');
    const rel = at.sub(this.centre);
    const edge = max(abs(rel.dot(this.right)), abs(rel.dot(this.up))).div(max(this.half, 1e-6));
    // The hand-over's weight: 0 well inside the square, 1 past it (and everywhere before the square is known).
    const w = mix(float(1), smoothstep(SUN_MAP_FADE[0], SUN_MAP_FADE[1], edge), step(1e-6, this.half));
    return mix(this.inner.mul(v.y), v.x, w);
  }

  /** The field's read written in place (the vertex stage's: built there once, for the varying that carries it). */
  private litInline(field: SunField, p: N, n: N): N {
    return Fn(() => {
      const r = vec2(1, 1).toVar();
      If(field.steps.greaterThan(0.5), () => {
        const v = field.lit(vec3(p), vec3(n).normalize());
        r.assign(vec2(v.all, v.past));
      });
      return r;
    })();
  }

  /**
   * The field's read as a function of one program (vec2: over every caster's line, over those past the map's). Made
   * again for each program: a function's code names the uniforms and buffers as that program does.
   */
  private litFor(field: SunField): (p: N, n: N) => N {
    const fn = Fn(([p, n]: N[]) => {
      const r = vec2(1, 1).toVar();
      // A point whose place is not a finite number (some draws' edge pixels give one) reads nothing: the map alone
      // tests such a place out of its frustum, the field would answer not a number. Tested on the bits (a compiler
      // may take x == x as always true).
      const bad = (v: N): N => floatBitsToUint(v).bitAnd(0x7f800000).equal(0x7f800000);
      const finite = bad(p!.x).or(bad(p!.y)).or(bad(p!.z)).not();
      If(field.steps.greaterThan(0.5).and(finite), () => {
        // A receiver whose normal is not at hand (zero, or not a number) is offset straight up.
        const nn = vec3(n!).toVar();
        const unit = select(bad(nn.x).or(bad(nn.y)).or(bad(nn.z)).or(nn.length().lessThan(0.5)), vec3(0, 1, 0), nn.normalize());
        const v = field.lit(p!, unit);
        r.assign(vec2(v.all, v.past));
      });
      return r;
    }).setLayout({ name: 'tlSunLit', type: 'vec2', inputs: [{ name: 'p', type: 'vec3' }, { name: 'n', type: 'vec3' }] });
    return (p, n) => fn(p, n);
  }

  /** The key light's square this frame: its centre, the direction it shines (unit), half side and the light's distance before the centre. */
  follow(centre: THREE.Vector3, dir: THREE.Vector3, half: number, distance: number): void {
    (this.centre.value as THREE.Vector3).copy(centre);
    this.half.value = half;
    // The square's axes as the light's camera sees it (three's lookAt from the light toward its target, up +y).
    const m = scratch.lookAt(lightAt.copy(centre).addScaledVector(dir, -distance), centre, worldUp);
    (this.right.value as THREE.Vector3).setFromMatrixColumn(m, 0);
    (this.up.value as THREE.Vector3).setFromMatrixColumn(m, 1);
  }
}

const scratch = new THREE.Matrix4();
const scratchFrom = new THREE.Vector3();
const scratchTo = new THREE.Vector3();
const scratchAt = new THREE.Vector3();
const scratchBox = new THREE.Box3();

/** What the field's frame asks of the renderer: its compute pass, and a region of a texture copied into another. */
export interface SunFieldRenderer {
  compute(n: N): unknown;
  copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: THREE.Box3 | null, at: THREE.Vector3 | null): void;
}
const lightAt = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

/** What the key light's shadow becomes: the node to give `light.shadow.shadowNode` and its square's follow. */
export interface SunShadowed {
  readonly node: N;
  follow(centre: THREE.Vector3, dir: THREE.Vector3, half: number, distance: number): void;
}

/** The key light's shadow node `inner` with the sun field's march where a build's lights hold a field. */
export function sunShadowed(inner: N): SunShadowed {
  const s = new SunShadowedNode(TSL.nodeObject(inner));
  return { node: TSL.nodeObject(s), follow: (c, d, h, dist) => s.follow(c, d, h, dist) };
}

/** What the key light's follow tells the field each frame (the scene's shadow link holds it). */
export interface SunFieldFollow {
  follow(x: number, z: number, dir: THREE.Vector3, farFrom: number): void;
}

/** What a page's voxel draws keep of the sun field: the field, its light in the scene, and what they registered. */
export class SunFieldHost {
  readonly field: SunField;
  private readonly light: SunFieldLight;
  private readonly offs: Array<() => void> = [];
  /** A page hook turned the march off (a comparison; false: the tier's). */
  private off = false;
  private tierSteps = 0;

  constructor(
    scene: THREE.Object3D,
    private readonly link: { sunField?: SunFieldFollow | null },
    edge: number,
    voxelM: number,
    skies: () => Iterable<SkyColumns>,
    register: { hide(apply: (hidden: boolean) => void): () => void; bytes(read: () => number): () => void },
  ) {
    this.field = new SunField(edge, voxelM, skies);
    this.light = new SunFieldLight(this.field);
    scene.add(this.light);
    link.sunField = this.field;
    this.offs.push(register.hide((h) => this.field.hide(h)), register.bytes(() => this.field.bytes));
  }

  /** The tier's samples a march (`voxelSunSteps`), read each frame. */
  setTier(steps: number): void {
    this.tierSteps = steps;
    this.apply();
  }

  /** Off, or back to the tier's (a page hook's comparison). */
  setOff(off: boolean): void {
    this.off = off;
    this.apply();
  }

  /** The samples marches take when shown (0: off). */
  get steps(): number {
    return this.off ? 0 : this.tierSteps;
  }

  private apply(): void {
    this.field.setSteps(this.steps);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.light.removeFromParent();
    if (this.link.sunField === this.field) this.link.sunField = null;
    this.field.dispose();
  }
}
