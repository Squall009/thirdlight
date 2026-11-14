/**
 * Ground cover from point sets as rows of the culled-instance table (WebGPU; the table: `occlusion-instances.ts`,
 * its copy sets: `copy-rows.ts`). One set per cover rule of a point source (a block layer, a model's upward faces,
 * architecture's floors): its places are the rule's point atlas's (`cover-points-gpu.ts`) points, block by block,
 * so a chunk's set arriving or leaving rewrites only its blocks. The table's compute pass picks every point as it
 * picks a stored copy: its level by the shared screen-size rule with hysteresis and a cross-fade, its thinning by
 * its threshold against the cover's share across the ground (`coverShareSteps`), its sphere against the frustum
 * (and the depth pyramid on that path); the draws are indirect, their arguments in the table's one buffer.
 *
 * A point's 16 bytes are expanded on the page into a copy's 16 floats as it arrives (place less the rule's sink,
 * threshold as the rank, turn, size): the draws then read copies exactly as stored copies' draws do (one program
 * per material and layout), and the pass reads two of the four vec4s a point. The expansion is
 * `coverPointAt` + `coverPointCopy`, the arithmetic the vertex stage of the WebGL 2 path runs.
 *
 * A set's places are the atlas's capacity: when the atlas grows the set is taken again at the new size. Free
 * places are written as copies of no size (never kept).
 *
 * The scene's table is found as copies sets find it: by the first draw of the rule's other path (its rings), which
 * offers the scene it draws in; from the next frame on the table draws the rule and the rings are dropped. Where
 * the scene has none (WebGL 2) the rings go on drawing.
 */
import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { coverPointAt, coverPointCopy, INTERACTOR_DEFAULTS, type CoverPointSet, type ScatterRule } from '@thirdlight/project-model';

import { CULLED_COPIES_KEY, INSTANCE_CULLER_KEY } from './attribute-instancing';
import type { CopyRowsMesh, CopyRowsSource } from './copy-rows';
import { COPY_ROW_KEY, COPY_ROWS_ATTRIBUTE, installCopyRows, rowsPlacement, type CopyRowDraw } from './copy-rows-draw';
import { COPY_ROW_FLOATS } from './copy-rows-rule';
import { COVER_DRAW_KEY, installCoverPlacement } from './cover-gpu';
import type { CoverPlan } from './cover-placement';
import { COVER_POINT_BLOCK, type CoverPointAtlas } from './cover-points-gpu';
import { disposeSharingGeometry } from './dispose';
import type { InstanceSetPlan } from './instancing';
import type { LodTuning } from './lod-switch';
import type { CopyCamera, CopyRowBinding, InstanceOcclusion } from './occlusion-instances';
import { STATIC_SHADOW_CAMERA_KEY, type CullView } from './view-cull';
import { vertexReachOf } from './vertex-reach';

const NO_STORAGE = new StorageBufferAttribute(new Uint32Array(4), 1);

/**
 * Point `i` of a chunk set as a copy's {@link COPY_ROW_FLOATS} floats at `o` of `out` (the source's frame): place
 * less the rule's sink and the point's threshold as its rank, its turn, its size thrice and no paint, its largest
 * scale; `set` null or `i` past its points: a copy of no size.
 */
export function writeCoverPointRow(set: CoverPointSet | null, i: number, rule: Pick<ScatterRule, 'align' | 'yaw' | 'scale' | 'sink'>, out: Float32Array, o: number): void {
  if (set === null || i >= set.count) {
    out.fill(0, o, o + COPY_ROW_FLOATS);
    out[o + 7] = 1;
    out[o + 15] = 1;
    return;
  }
  const p = coverPointAt(set, i);
  const c = coverPointCopy(p, rule);
  out[o] = p.x;
  out[o + 1] = p.y - (rule.sink ?? 0);
  out[o + 2] = p.z;
  out[o + 3] = p.threshold;
  out.set(c.rotation, o + 4);
  out[o + 8] = c.scale;
  out[o + 9] = c.scale;
  out[o + 10] = c.scale;
  out[o + 11] = 0;
  out[o + 12] = c.scale;
  out[o + 13] = 0;
  out[o + 14] = 0;
  out[o + 15] = 1;
}

/** One draw: a mesh of the rule's model at its level, reading its copies from the table. */
interface RowDraw {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly binding: CopyRowBinding;
  readonly row: CopyRowDraw;
  readonly part: InstanceSetPlan['parts'][number];
}

export interface CoverRowsOptions {
  readonly name: string;
  readonly rule: ScatterRule;
  readonly plan: CoverPlan;
  readonly model: InstanceSetPlan;
  readonly atlas: CoverPointAtlas;
  readonly tuning: LodTuning;
  readonly origin: readonly number[];
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  place(root: THREE.Object3D, shown: boolean): void;
  /** The table let the set go (its renderer went): the rule draws without it again. */
  released(): void;
}

/** What one rule's point-set rows report. */
export interface CoverRowsDiagnostics {
  /** Taken by the table; points its places hold (the atlas's capacity) and points held in chunk sets. */
  readonly active: boolean;
  readonly places: number;
  readonly draws: number;
}

/** One cover rule of a point source as rows of the scene's culled-instance table (see the module's header). */
export class CoverRows {
  readonly root = new THREE.Group();
  private readonly draws: RowDraw[] = [];
  private table: InstanceOcclusion | null = null;
  /** The scene's table as a draw of the rule's other path last found it (null: none found yet). */
  private host: InstanceOcclusion | null = null;
  private source: CopyRowsSource | null = null;
  private placed = false;
  private hidden = false;
  private view: CullView | null = null;
  private undress: (() => void) | null = null;
  private disposed = false;
  /** The farthest a model's point lies from its origin at scale 1 (most detailed level). */
  private readonly reach: number;

  constructor(private readonly o: CoverRowsOptions) {
    installCoverPlacement();
    installCopyRows();
    this.root.name = `cover-rows:${o.name}`;
    this.root.matrixAutoUpdate = false;
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const part of o.model.parts) {
      if (part.level !== 0) continue;
      const g = part.mesh.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      box.union(b.copy(g.boundingBox!).applyMatrix4(part.local));
    }
    this.reach = box.isEmpty() ? 0 : Math.max(...[box.min, box.max].flatMap((a) => [box.min, box.max].flatMap((c) => [box.min, box.max].map((e) => Math.hypot(a.x, c.y, e.z)))));
    for (const part of o.model.parts) this.makeDraw(part);
    this.setOrigin(o.origin);
    this.undress = o.dress?.(this.root, o.rule.asset.assetId) ?? null;
  }

  private makeDraw(part: InstanceSetPlan['parts'][number]): void {
    const source = part.mesh.geometry;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.name = source.name;
    for (const [n, a] of Object.entries(source.attributes)) geometry.setAttribute(n, a);
    if (source.index !== null) geometry.setIndex(source.index);
    for (const gr of source.groups) geometry.addGroup(gr.start, gr.count, gr.materialIndex);
    geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
    // Its own program (the marker keys it) reads the table's pools.
    geometry.setAttribute(COPY_ROWS_ATTRIBUTE, source.getAttribute('position'));
    geometry.instanceCount = 0;
    const mesh = new THREE.Mesh(geometry, part.mesh.material);
    mesh.name = `${this.root.name}:${part.mesh.name}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = this.o.rule.castShadow === true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    // Ground cover is not picked by rays (as its other draws).
    mesh.raycast = () => undefined;
    const binding: CopyRowBinding = { mode: 0, list: 0, row: null };
    const pools = { matrices: NO_STORAGE, slots: NO_STORAGE, lists: NO_STORAGE, visible: NO_STORAGE, counts: NO_STORAGE };
    const row: CopyRowDraw = {
      binding,
      local: part.local.clone(),
      bend: this.o.rule.bendAway ?? INTERACTOR_DEFAULTS.ruleBend,
      pools: () => {
        const t = this.table;
        if (t === null || binding.row === null) return null;
        pools.matrices = binding.row.matrices;
        pools.slots = binding.row.slots;
        pools.lists = binding.row.lists;
        const extra = t.copyBuffers();
        pools.visible = extra.state;
        pools.counts = extra.counts;
        return pools;
      },
    };
    mesh.userData[COVER_DRAW_KEY] = rowsPlacement;
    mesh.userData[COPY_ROW_KEY] = row;
    mesh.onBeforeRender = (_r, _scene, camera) => {
      if (this.table === null || binding.row === null) {
        geometry.indirect = null;
        geometry.instanceCount = 0;
        return;
      }
      this.table.drawCopies(binding.row, geometry, this.cameraKind(camera), binding);
    };
    this.root.add(mesh);
    this.draws.push({ mesh, geometry, binding, row, part });
  }

  /** Whether the table draws the rule (else its draws are hidden: the rule draws without it). */
  get active(): boolean {
    return this.table !== null;
  }

  setOrigin(origin: readonly number[]): void {
    this.root.matrix.makeTranslation(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    this.root.updateMatrixWorld(true);
  }

  /** A draw of the rule's other path is drawn in `scene`: its culled-instance table (if it has one) takes the rule next frame (true: one was found). */
  offer(scene: THREE.Object3D): boolean {
    if (this.host !== null || this.disposed) return false;
    const host = scene.userData[INSTANCE_CULLER_KEY] as Partial<InstanceOcclusion> | undefined;
    if (typeof host?.adoptCopies !== 'function') return false;
    this.host = host as InstanceOcclusion;
    return true;
  }

  /**
   * Once a frame: taken by the scene's table once one was offered (again at the atlas's size when it grew), in the
   * scene unless hidden. Returns whether the table draws the rule.
   */
  update(view: CullView, hidden: boolean): boolean {
    if (this.disposed) return false;
    this.view = view;
    this.hidden = hidden;
    if (this.host !== null && (this.table === null || this.source === null || this.source.count !== this.places())) this.adopt(this.host);
    const placed = this.table !== null && !hidden;
    if (this.placed !== placed) {
      this.placed = placed;
      this.o.place(this.root, placed);
    }
    for (const d of this.draws) d.mesh.visible = placed;
    return this.table !== null;
  }

  private places(): number {
    return this.o.atlas.capacity * COVER_POINT_BLOCK;
  }

  /** The table takes the rule (again, at a new size); refused (culling of copies off): the rings draw it. */
  private adopt(table: InstanceOcclusion): void {
    if (this.source !== null && this.table !== null) this.table.forgetCopies(this.source);
    const src = this.makeSource();
    if (!table.adoptCopies(src)) {
      this.unbind();
      this.host = null;
      return;
    }
    this.source = src;
    this.table = table;
    for (const d of this.draws) {
      d.binding.row = table.copySets.rowOf(src, d.mesh);
      d.mesh.userData[CULLED_COPIES_KEY] = d.binding.row;
    }
  }

  private unbind(): void {
    this.table = null;
    this.source = null;
    for (const d of this.draws) {
      d.binding.row = null;
      d.geometry.indirect = null;
      d.mesh.visible = false;
      delete d.mesh.userData[CULLED_COPIES_KEY];
    }
  }

  /** What the table reads of the rule (copy-rows.ts): its places are the atlas's points. */
  private makeSource(): CopyRowsSource {
    const self = this;
    const o = this.o;
    const atlas = o.atlas;
    const count = this.places();
    const groups = o.model.groups.map((g) => ({ distances: g.distances, culls: g.culls }));
    const meshes: CopyRowsMesh[] = this.draws.map((d) => ({ mesh: d.mesh, group: d.part.lod, level: d.part.lod >= 0 ? d.part.level : 0, near: false, staticAll: false }));
    const src: CopyRowsSource = {
      count,
      groups,
      meshes,
      get copiesVersion() {
        return atlas.version;
      },
      writeCopies: (target, at, since) => {
        const blocks = Math.min(atlas.capacity, count / COVER_POINT_BLOCK);
        const ranges: number[] = [];
        for (let b = 0; b < blocks; b += 1) {
          if (since !== undefined && atlas.versions[b]! <= since) continue;
          const e = atlas.owners[b] ?? null;
          const first = atlas.firsts[b]!;
          for (let k = 0; k < COVER_POINT_BLOCK; k += 1) writeCoverPointRow(e?.set ?? null, first + k, o.rule, target, (at + b * COVER_POINT_BLOCK + k) * COPY_ROW_FLOATS);
          const start = b * COVER_POINT_BLOCK;
          if (ranges.length > 0 && ranges[ranges.length - 1] === start) ranges[ranges.length - 1] = start + COVER_POINT_BLOCK;
          else ranges.push(start, start + COVER_POINT_BLOCK);
        }
        return since === undefined ? null : ranges;
      },
      get world() {
        return self.root.matrixWorld;
      },
      modelReach: this.reach,
      density: null,
      cover: o.plan.thinning,
      nearReach: null,
      blockLevels: () => null,
      tuning: o.tuning,
      vertexReach: () => {
        let r = 0;
        for (const d of self.draws) {
          const v = vertexReachOf(d.mesh);
          if (v === null) return null;
          r = Math.max(r, v);
        }
        return r;
      },
      shown: () => !self.disposed && self.placed && !self.hidden && atlas.entries.size > 0,
      released: () => {
        if (self.source !== src) return;
        // The table went (its renderer did): the rings draw the rule until a draw offers a scene with a table again.
        self.unbind();
        self.host = null;
        o.released();
      },
    };
    return src;
  }

  /** Which kind of camera a pass draws a row with: a cached static shadow map's, the view's, another's. */
  private cameraKind(camera: THREE.Camera): CopyCamera {
    if (camera.userData[STATIC_SHADOW_CAMERA_KEY] === true) return 'static';
    return this.view !== null && this.view.is(camera) ? 'view' : 'other';
  }

  meshes(): THREE.Mesh[] {
    return this.table === null ? [] : this.draws.map((d) => d.mesh);
  }

  diagnostics(): CoverRowsDiagnostics {
    return { active: this.table !== null, places: this.source?.count ?? 0, draws: this.table === null ? 0 : this.draws.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.table !== null && this.source !== null) this.table.forgetCopies(this.source);
    this.unbind();
    if (this.placed) this.o.place(this.root, false);
    this.placed = false;
    this.undress?.();
    for (const d of this.draws) {
      d.mesh.removeFromParent();
      disposeSharingGeometry(d.geometry, []);
    }
    this.draws.length = 0;
  }
}
