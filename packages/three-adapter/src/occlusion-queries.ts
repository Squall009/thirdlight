/**
 * Occlusion culling on WebGL 2: occlusion queries on boxes.
 *
 * WebGL 2 has no compute and no indirect draws, so what the depth hides is
 * asked of the GPU: a box round a draw is drawn (no colour, no depth written)
 * inside an `ANY_SAMPLES_PASSED_CONSERVATIVE` query, against the finished
 * frame's depth; its answer says whether any of the box passed the depth
 * test. The answer comes a frame or more later (WebGL 2 never answers in the
 * frame that asked), so a draw is hidden by what its box showed in the last
 * frames: the rules of occlusion-queries-rule.ts keep that conservative (two
 * answers in a row, recent enough; shown at the first that sees it) and the
 * boxes grow by the camera's motion over the answers' age, so what comes out
 * from behind a wall while the camera moves is asked before it shows.
 *
 * What is asked: the occludees of the registry worth a test (the depth
 * pyramid path's rule, `wholeTestOf`, for block and architecture chunks,
 * merged cells and models drawn alone; an instanced draw by the copies it has
 * in view, as one box round them, hidden whole), that the frustum, the rooms
 * and isolation left drawn. A hidden draw leaves the view through
 * `HIDDEN_BY_OCCLUSION`: shadow cameras and probes still draw it. A box the
 * eye is inside is never asked. A camera cut (a jump, a fast turn, another
 * camera or lens) forgets every answer: that frame draws everything.
 *
 * When: the boxes are drawn after the frame (`afterDraw`), into the scene
 * pass's target, so the depth they test against is the whole frame's. The
 * models' `_OCC` stand-ins are drawn into that depth first, there and only
 * there: ambient occlusion, fog, depth of field and transparent draws read
 * the scene's depth before, so it never holds a stand-in when they read it,
 * and the next frame clears it. The query render resolves nothing (its
 * colour is unchanged, a multisampled target's depth is never resolved). A
 * single-sampled target's depth attachment is its depth texture: the
 * stand-ins stay in it until the next frame's clear, also while a view that
 * draws on demand (the editor's) is idle. Nothing reads it in between: every
 * reader (ambient occlusion, fog, depth of field, transparent draws, the next
 * boxes) reads it inside a frame, after that frame's clear and draw.
 *
 * The queries are WebGL 2's own (pooled), begun and ended round each box's
 * draw by three's render-object function. three's `occlusionTest` makes and
 * deletes a query per object a frame and answers per render context once
 * every query of a render has its answer, with no way to tell which frame an
 * answer is about.
 */
import * as THREE from 'three';
import { occludeeClassOf, occlusionCameraCut, occlusionQueryMargin, OCCLUSION_MIN_COPIES_TRIANGLES } from '@thirdlight/runtime';

import type { InstanceViewDraw } from './attribute-instancing';
import { drawTrianglesOf, type Occludee } from './occludees';
import { isOccluderStandin, STANDIN_VIEW_KEY } from './occluders';
import type { ScenePasses } from './occlusion-passes';
import { hiddenByAnswers, queryAnswered, queryAsked, queryDue, queryForget, QueryRecord } from './occlusion-queries-rule';
import { TestView, wholeTestOf, culledWhole } from './occlusion-whole';
import { VIEW_CULL_KEY } from './view-cull';
import { HIDDEN_BY_OCCLUSION, hideFromView, occlusionMayTest } from './view-hidden';

type RenderObjectFunction = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: unknown, lightsNode: unknown, clippingContext: unknown, passId: unknown) => void;

/** What of the renderer (three's, on its WebGL 2 backend) the queries use. */
export interface QueryRenderer {
  autoClear: boolean;
  readonly info: { readonly render: { readonly drawCalls: number } };
  readonly backend: { readonly gl?: WebGL2RenderingContext; readonly state?: { setColorMask?(on: boolean): void } };
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getRenderObjectFunction(): RenderObjectFunction | null;
  setRenderObjectFunction(fn: RenderObjectFunction | null): void;
  renderObject: RenderObjectFunction;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/** Frames a draw may go without being worth a query before its record and box are dropped. */
const FORGET_FRAMES = 120;

/** One draw asked about: its record, its box and the last frame it was worth asking. */
interface Entry {
  readonly mesh: THREE.Mesh;
  readonly record: QueryRecord;
  readonly proxy: THREE.Mesh;
  stamp: number;
  /** An instanced draw's box over its copies in view, and the version of the copies it was made from. */
  copies: { version: number; count: number; box: Float64Array } | null;
}

/** A query drawn and not answered yet. */
interface Pending {
  readonly entry: Entry;
  readonly query: WebGLQuery;
  readonly seq: number;
  readonly frame: number;
  readonly wasHidden: boolean;
}

/** What the queries did, recently (the culler's diagnostics carry it). */
export interface QueryOcclusionDiagnostics {
  /** Draws worth a query in the last frame, and those hidden. */
  readonly candidates: number;
  readonly hidden: number;
  /** Queries drawn in the last frame, answers read in its update, queries waiting for their answer. */
  readonly asked: number;
  readonly answered: number;
  readonly pending: number;
  /** Queries whose box three did not draw (no answer), so far. */
  readonly lost: number;
  /** The age (frames) of the newest answer read, recently at most. */
  readonly ageFrames: number;
  /** Frames a draw was hidden while its box was seen, so far, and the longest run of them for one draw (the lateness bound's measure). */
  readonly late: number;
  readonly lateRunMax: number;
  /** Camera cuts that forgot every answer, so far. */
  readonly cuts: number;
  /** The query render's main-thread time in the last frame (stand-ins and boxes). */
  readonly drawMs: number;
}

const _view = new TestView();
const _corners = new Float64Array(6);
const _forward = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** The box of every proxy (a unit cube round the origin; each proxy's matrix places and scales it). */
let proxyGeometry: THREE.BoxGeometry | null = null;
/** No colour, no depth written, the depth tested; both faces (a box crossing the near plane still shows its far faces). */
let proxyMaterial: THREE.MeshBasicMaterial | null = null;

function proxyParts(): { geometry: THREE.BoxGeometry; material: THREE.MeshBasicMaterial } {
  proxyGeometry ??= new THREE.BoxGeometry(1, 1, 1);
  if (proxyMaterial === null) {
    proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
    proxyMaterial.name = 'tl-occlusion-query-box';
  }
  return { geometry: proxyGeometry, material: proxyMaterial };
}

/** Whether three's WebGL 2 renderer has what the queries need (its context). */
export function queryContextOf(renderer: unknown): WebGL2RenderingContext | null {
  const gl = (renderer as Partial<QueryRenderer> | null)?.backend?.gl;
  return gl !== undefined && typeof (gl as WebGL2RenderingContext).beginQuery === 'function' ? gl : null;
}

export class QueryOcclusion implements ScenePasses {
  /** The proxies' own scene (drawn by the query render only). */
  private readonly boxes = new THREE.Scene();
  private readonly entries = new Map<THREE.Mesh, Entry>();
  private pending: Pending[] = [];
  private readonly pool: WebGLQuery[] = [];
  private frame = 0;
  private slots = 0;
  /** The scene pass's target and camera of this frame's draw (null: the frame drew no scene pass). */
  private target: THREE.RenderTarget | null = null;
  private camera: THREE.Camera | null = null;
  /** The view as last asked: its camera, eye, forward direction, lens, and how far the eye moved in that frame. */
  private last: { camera: THREE.Camera; eye: THREE.Vector3; forward: THREE.Vector3; lens: [number, number]; step: number } | null = null;
  private step = 0;
  /** The stand-ins draw now (the query render's first draw). */
  drawing = false;
  private standinsDrawn = false;
  private asking: Pending[] = [];
  private readonly counts = { candidates: 0, hidden: 0, asked: 0, answered: 0, lost: 0, ageFrames: 0, late: 0, lateRunMax: 0, cuts: 0, drawMs: 0 };

  constructor(
    private readonly renderer: QueryRenderer,
    private readonly gl: WebGL2RenderingContext,
    /** The scene whose stand-ins draw into the queries' depth; its stand-in callback answers for them in the query render. */
    private readonly scene: THREE.Scene,
  ) {
    this.boxes.name = 'tl-occlusion-queries';
    this.boxes.matrixWorldAutoUpdate = false;
    this.boxes.userData[STANDIN_VIEW_KEY] = scene.userData[STANDIN_VIEW_KEY];
  }

  /** The scene pass's render: drawn as it is; its target is where the queries draw after the frame. */
  draw(render: (scene: THREE.Object3D, camera: THREE.Camera) => void, scene: THREE.Object3D, camera: THREE.Camera, target: THREE.RenderTarget): void {
    render(scene, camera);
    this.target = target;
    this.camera = camera;
  }

  view(): null {
    return null;
  }

  /**
   * Once a frame, after the view's culling (for the view's `camera`): the answers that came are read, the
   * draws worth asking are hidden or shown by their answers, and the boxes due a query are placed.
   */
  update(occludees: Iterable<Occludee>, camera: THREE.Camera | null): void {
    this.frame += 1;
    this.target = null;
    this.camera = null;
    this.readAnswers();
    let candidates = 0;
    let hidden = 0;
    if (camera === null) {
      this.showAll();
      this.last = null;
    } else {
      const cut = this.moved(camera);
      if (cut) {
        this.counts.cuts += 1;
        for (const e of this.entries.values()) this.forget(e);
      }
      _view.set(camera);
      const near = (camera as THREE.PerspectiveCamera).near ?? 0;
      for (const o of occludees) {
        const e = this.test(o, camera);
        if (e === null) continue;
        candidates += 1;
        // The box grown past the draw by the depth's margin and the camera's motion over the answers' age.
        _box.min.set(_corners[0]!, _corners[1]!, _corners[2]!);
        _box.max.set(_corners[3]!, _corners[4]!, _corners[5]!);
        _box.expandByScalar(occlusionQueryMargin(_box.distanceToPoint(_view.eye), this.step));
        // The eye inside it (or so near that the near plane cuts it): never asked, drawn.
        if (_box.distanceToPoint(_view.eye) <= near * 2) {
          this.forget(e);
          e.proxy.visible = false;
          continue;
        }
        const r = e.record;
        r.hidden = !cut && hiddenByAnswers(r, this.frame);
        hideFromView(e.mesh, HIDDEN_BY_OCCLUSION, r.hidden);
        if (r.hidden) hidden += 1;
        e.proxy.visible = queryDue(r, this.frame);
        if (e.proxy.visible) {
          _box.getCenter(_centre);
          _box.getSize(_size);
          e.proxy.matrixWorld.makeScale(_size.x, _size.y, _size.z).setPosition(_centre);
        }
      }
    }
    // Draws no longer worth asking (out of view, hidden otherwise, gone): drawn, and dropped after a while.
    for (const [mesh, e] of this.entries) {
      if (e.stamp === this.frame) continue;
      e.proxy.visible = false;
      if (e.record.hidden || e.record.lastFrame >= 0) this.forget(e);
      if (this.frame - e.stamp >= FORGET_FRAMES || mesh.parent === null) this.drop(e);
    }
    this.counts.candidates = candidates;
    this.counts.hidden = hidden;
  }

  /**
   * After the frame was drawn: the stand-ins and the boxes due are drawn into the scene pass's target, each box
   * in a query of its own. Nothing when this frame drew no scene pass.
   */
  afterDraw(): void {
    const target = this.target;
    const camera = this.camera;
    this.target = null;
    this.camera = null;
    this.counts.asked = 0;
    if (target === null || camera === null) return;
    const t0 = performance.now();
    const r = this.renderer;
    const saved = { target: r.getRenderTarget(), autoClear: r.autoClear, fn: r.getRenderObjectFunction(), resolveColor: target.resolveColorBuffer, resolveDepth: target.resolveDepthBuffer };
    this.asking = [];
    this.standinsDrawn = false;
    try {
      // Nothing resolved: the colour is unchanged, and the stand-ins' depth must not reach the depth texture.
      target.resolveColorBuffer = false;
      target.resolveDepthBuffer = false;
      r.setRenderTarget(target);
      r.autoClear = false;
      r.setRenderObjectFunction(this.ask);
      r.render(this.boxes, camera);
    } finally {
      this.drawing = false;
      // three's WebGL 2 clear sets the depth mask but not the colour mask: left off by these draws (no colour), the
      // next frame's first clear would keep the last picture's colour where nothing opaque covers it (glass drawn
      // over itself frame after frame).
      r.backend.state?.setColorMask?.(true);
      r.setRenderObjectFunction(saved.fn);
      r.autoClear = saved.autoClear;
      r.setRenderTarget(saved.target);
      target.resolveColorBuffer = saved.resolveColor;
      target.resolveDepthBuffer = saved.resolveDepth;
    }
    this.counts.asked = this.asking.length;
    for (const p of this.asking) this.pending.push(p);
    this.asking = [];
    this.counts.drawMs = performance.now() - t0;
  }

  /** The query render's draws: the stand-ins first (into the depth), then each box inside its query. */
  private readonly ask: RenderObjectFunction = (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
    const r = this.renderer;
    if (!this.standinsDrawn) {
      this.standinsDrawn = true;
      this.drawing = true;
      for (const o of this.scene.children) {
        if (!isOccluderStandin(o) || !o.visible || !camera.layers.test(o.layers)) continue;
        const m = o as THREE.Mesh;
        r.renderObject(m, scene, camera, m.geometry, m.material as THREE.Material, null, lightsNode, clippingContext, passId);
      }
      this.drawing = false;
    }
    const e = (object.userData as { tlQueryEntry?: Entry }).tlQueryEntry;
    if (e === undefined) {
      r.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
      return;
    }
    const gl = this.gl;
    const query = this.pool.pop() ?? gl.createQuery();
    const seq = queryAsked(e.record);
    const before = r.info.render.drawCalls;
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
    try {
      r.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
    } finally {
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    }
    // three drew nothing (the box's program still building): no answer will say anything.
    if (r.info.render.drawCalls === before) {
      this.counts.lost += 1;
      this.lose(query);
      return;
    }
    this.asking.push({ entry: e, query, seq, frame: this.frame, wasHidden: e.record.hidden });
  };

  /** The draws hidden now (two answers in a row saw nothing of their boxes). */
  *hidden(): IterableIterator<THREE.Mesh> {
    for (const e of this.entries.values()) if (e.record.hidden) yield e.mesh;
  }

  diagnostics(): QueryOcclusionDiagnostics {
    return { ...this.counts, pending: this.pending.length, drawMs: Math.round(this.counts.drawMs * 1000) / 1000 };
  }

  /** Every hidden draw shown, every answer forgotten, every box dropped (the path turned off). */
  clear(): void {
    for (const e of [...this.entries.values()]) this.drop(e);
    for (const p of this.pending) this.lose(p.query);
    this.pending = [];
    this.last = null;
  }

  dispose(): void {
    this.clear();
    for (const q of this.pool) this.gl.deleteQuery(q);
    this.pool.length = 0;
  }

  /** The answers that came: read in the order the queries were drawn, up to the first not answered yet. */
  private readAnswers(): void {
    const gl = this.gl;
    let read = 0;
    let age = -1;
    let i = 0;
    for (; i < this.pending.length; i += 1) {
      const p = this.pending[i]!;
      if (gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE) !== true) break;
      const passed = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
      this.pool.push(p.query);
      read += 1;
      age = Math.max(age, this.frame - p.frame);
      if (!this.entries.has(p.entry.mesh) || this.entries.get(p.entry.mesh) !== p.entry) continue;
      const effect = queryAnswered(p.entry.record, p.seq, p.frame, passed === 0, p.wasHidden);
      if (effect.late) {
        this.counts.late += 1;
        this.counts.lateRunMax = Math.max(this.counts.lateRunMax, p.entry.record.lateRun);
      }
    }
    if (i > 0) this.pending.splice(0, i);
    this.counts.answered = read;
    if (age >= 0) this.counts.ageFrames = age;
  }

  /** How the view moved since the last frame; true for a camera cut (forget every answer). */
  private moved(camera: THREE.Camera): boolean {
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    _forward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const p = camera.projectionMatrix.elements;
    const lens: [number, number] = [p[0]!, p[5]!];
    const last = this.last;
    let cut = true;
    let step = 0;
    this.step = 0;
    if (last !== null && last.camera === camera && Math.abs(last.lens[0] - lens[0]) <= 1e-6 * Math.abs(lens[0]) && Math.abs(last.lens[1] - lens[1]) <= 1e-6 * Math.abs(lens[1])) {
      step = eye.distanceTo(last.eye);
      cut = occlusionCameraCut(step, last.step, _forward.dot(last.forward));
      // The boxes grow by the larger of this frame's and the last frame's motion (a steady flight, a slowing one).
      if (!cut) this.step = Math.max(step, last.step);
    }
    this.last = { camera, eye, forward: _forward.clone(), lens, step: cut ? 0 : step };
    return cut;
  }

  /** `o`'s entry when it is worth a query this frame (its box in `_corners`), else null (and drawn). */
  private test(o: Occludee, camera: THREE.Camera): Entry | null {
    const m = o.object;
    if (o.kind === 'terrain') return null;
    // Hidden by the frustum's owner, a cut-away, the rooms or isolation: not asked. Hidden by occlusion only: still asked.
    if (!occlusionMayTest(m, camera)) return null;
    let copies: InstanceViewDraw | null = null;
    if (o.kind === 'instanced') {
      copies = (m.userData[VIEW_CULL_KEY] as { mesh?: unknown; viewDraw?: () => InstanceViewDraw | null } | undefined)?.viewDraw?.() ?? null;
      if (copies === null || copies.count * drawTrianglesOf(m.geometry) < OCCLUSION_MIN_COPIES_TRIANGLES) return null;
    } else if (!culledWhole(o.kind) && o.kind !== 'transparent') return null;
    else if (wholeTestOf(o, camera, _view, _corners) === null) return null;
    let e = this.entries.get(m);
    if (e === undefined) {
      e = this.make(m);
      this.entries.set(m, e);
    }
    if (copies !== null && !this.copiesBox(e, copies, m.geometry)) return null;
    e.stamp = this.frame;
    return e;
  }

  /** An instanced draw's box over its copies in view (made again when they changed), in `_corners`; false when not worth a query. */
  private copiesBox(e: Entry, copies: InstanceViewDraw, geometry: THREE.BufferGeometry): boolean {
    let c = e.copies;
    if (c === null || c.version !== copies.version || c.count !== copies.count) {
      c ??= { version: 0, count: 0, box: new Float64Array(6) };
      const b = c.box;
      b.fill(Number.POSITIVE_INFINITY, 0, 3);
      b.fill(Number.NEGATIVE_INFINITY, 3, 6);
      const s = copies.spheres;
      for (let at = 0; at < copies.count; at += 1) {
        const k = copies.order[at]! * 4;
        const rad = s[k + 3]!;
        if (!(rad >= 0)) continue;
        for (let a = 0; a < 3; a += 1) {
          b[a] = Math.min(b[a]!, s[k + a]! - rad);
          b[a + 3] = Math.max(b[a + 3]!, s[k + a]! + rad);
        }
      }
      c.version = copies.version;
      c.count = copies.count;
      e.copies = c;
    }
    _corners.set(c.box);
    if (!(_corners[0]! <= _corners[3]!)) return false;
    _box.min.set(_corners[0]!, _corners[1]!, _corners[2]!);
    _box.max.set(_corners[3]!, _corners[4]!, _corners[5]!);
    if (!_view.frustum.intersectsBox(_box)) return false;
    // Tested as one draw: not when it covers so much of the screen that it is never hidden whole (the runtime's rule).
    const sphere = _box.getBoundingSphere(new THREE.Sphere());
    const share = _view.tanHalf > 0 ? sphere.radius / (Math.max(1e-6, sphere.center.distanceTo(_view.eye)) * _view.tanHalf) : Number.POSITIVE_INFINITY;
    const triangles = copies.count * drawTrianglesOf(geometry);
    return occludeeClassOf({ kind: 'single', triangles, items: 1, screenShare: sphere.center.distanceTo(_view.eye) > sphere.radius ? share : Number.POSITIVE_INFINITY }) === 'whole';
  }

  private make(mesh: THREE.Mesh): Entry {
    const { geometry, material } = proxyParts();
    const proxy = new THREE.Mesh(geometry, material);
    proxy.name = 'tl-occlusion-query';
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = false;
    proxy.visible = false;
    proxy.raycast = () => undefined;
    const e: Entry = { mesh, record: new QueryRecord(this.slots++), proxy, stamp: this.frame, copies: null };
    proxy.userData['tlQueryEntry'] = e;
    this.boxes.add(proxy);
    return e;
  }

  private forget(e: Entry): void {
    queryForget(e.record);
    hideFromView(e.mesh, HIDDEN_BY_OCCLUSION, false);
  }

  private drop(e: Entry): void {
    this.forget(e);
    this.boxes.remove(e.proxy);
    this.entries.delete(e.mesh);
  }

  private showAll(): void {
    for (const e of this.entries.values()) {
      this.forget(e);
      e.proxy.visible = false;
    }
  }

  /** A query whose answer is not wanted (its box was not drawn, or the path stopped): deleted, not pooled (only an answered query is reused). */
  private lose(query: WebGLQuery): void {
    this.gl.deleteQuery(query);
  }
}
