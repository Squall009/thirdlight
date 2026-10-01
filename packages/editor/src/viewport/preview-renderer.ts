/**
 * The preview pane's renderer — the one place the editor draws an item on its
 * own (a material on a shape, an effect, a model with its animator or clips).
 *
 * One renderer on one canvas for as long as the pane shows (the editor's
 * backend choice, the three-adapter factory), one stage (scene, orbit camera,
 * key and fill light, a grid, the active scene's look through the same
 * environment renderer as the Scene view) and one material library, lent in
 * turn to whatever subject the open editor asks for. Switching subjects
 * releases the old one's objects and keeps the renderer, so moving between
 * editors never piles up GPU contexts (browsers drop the oldest past ~16 —
 * possibly the Scene view's).
 *
 * The canvas publishes what tests read independently of the subjects' own
 * bookkeeping: frames drawn, the subject shown, the backend, and the
 * renderer's live resource counts after each frame (`data-memory`).
 *
 * Browser-only (a canvas, WebGPU or WebGL 2 through three's WebGPURenderer).
 */
import {
  createEnvironmentRenderer,
  createMaterialLibrary,
  createRenderer,
  rendererMemory,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type MaterialLibrary,
  type RendererHandle,
  type RendererInfo,
  type WindLike,
} from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { disposeOrbitControls } from './controls';
import { editorRendererChoice } from './renderer-choice';

export type PreviewRendererLike = NonNullable<ReturnType<RendererHandle['current']>>;

/** The look a preview draws through (null: a neutral backdrop). */
export type PreviewEnvironment = (EnvironmentLike & { wind?: WindLike }) | null;

/** What a subject gets from the stage while it is shown. */
export interface PreviewStage {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** The stage's material library (the project's graph materials, compiled like the Scene view's). */
  readonly library: MaterialLibrary;
  /** The renderer once ready (null while starting or after a lost context). */
  renderer(): PreviewRendererLike | null;
  /** Bumps when a new renderer object replaced the old one (rebuild what holds it). */
  generation(): number;
  info(): RendererInfo;
  /** The look the stage draws through now (its wind moves effects). */
  environment(): PreviewEnvironment;
  /** Point the camera at a box from a direction (fills the view). */
  frame(box: THREE.Box3, direction?: THREE.Vector3, fill?: number): void;
  /** Show or hide the floor grid (4 m at the origin). */
  setGrid(on: boolean): void;
}

/**
 * One thing the pane shows. `attach` puts its objects in the stage, `update`
 * runs before each frame, `afterRender` gets the CPU time
 * of the frame's draw, `environmentChanged` the new look, `dispose` takes
 * everything it added back out and frees it.
 */
export interface PreviewSubject {
  /** What tests read on the canvas (`data-subject`). */
  readonly key: string;
  attach(stage: PreviewStage): void;
  update?(stage: PreviewStage, now: number): void;
  afterRender?(stage: PreviewStage, drawCpuMs: number, now: number): void;
  environmentChanged?(stage: PreviewStage): void;
  dispose(): void;
}

export interface PreviewRendererOptions {
  /** A texture asset's texture (the editor's decoded bytes, shared with the Scene view). */
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
}

interface Ledger {
  /** Renderers alive now, made and released since the page loaded. */
  open: number;
  opened: number;
  closed: number;
  /** Subjects shown and released. */
  shown: number;
  released: number;
  /**
   * The renderer's resource counts right after the last release, before the
   * next subject attached: an empty stage. Subjects that free their objects
   * leave these the same from one switch to the next (tests compare them).
   */
  idle: Record<string, number> | null;
}
const ledger: Ledger = { open: 0, opened: 0, closed: 0, shown: 0, released: 0, idle: null };
function publishLedger(): void {
  try {
    document.documentElement.setAttribute('data-tl-previews', JSON.stringify(ledger));
  } catch {
    /* diagnostics only */
  }
}

/** How often the canvas's diagnostics attributes are refreshed (ms). */
const DIAGNOSTICS_INTERVAL_MS = 200;

export class PreviewRenderer implements PreviewStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500);
  readonly library: MaterialLibrary;
  private readonly handle: RendererHandle;
  private readonly orbit: OrbitControls;
  private readonly key = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly fill = new THREE.AmbientLight(0xa0b0c8, 0.6);
  private readonly grid = new THREE.GridHelper(4, 8, 0x3a4050, 0x262a34);
  private environmentRenderer: EnvironmentRenderer | null = null;
  private environmentGeneration = -1;
  private environmentValue: PreviewEnvironment = null;
  private subject: PreviewSubject | null = null;
  private raf = 0;
  private sizedFor = -1;
  private frames = 0;
  private lastDiagnostics = 0;
  private readonly start = performance.now();
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: PreviewRendererOptions,
  ) {
    const choice = editorRendererChoice();
    // The canvas is never drawn to again after dispose (the pane mounts a new one): its WebGL context goes then.
    // Timestamp queries where the device has them: the effect subject reports its GPU cost with them.
    this.handle = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: true, clearColor: 0x000000, clearAlpha: 1, loseContextOnDispose: true, trackTimestamp: true });
    this.library = createMaterialLibrary({ loadTexture: options.loadTexture });
    this.scene.background = new THREE.Color(0x1b1e26);
    this.key.position.set(3, 5, 4);
    this.scene.add(this.key, this.fill, this.grid);
    this.grid.visible = false;
    this.camera.position.set(0, 0.4, 3.2);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.update();
    ledger.open += 1;
    ledger.opened += 1;
    publishLedger();
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  renderer(): PreviewRendererLike | null {
    return this.handle.ready() ? this.handle.current() : null;
  }

  generation(): number {
    return this.handle.generation();
  }

  info(): RendererInfo {
    return this.handle.info();
  }

  environment(): PreviewEnvironment {
    return this.environmentValue;
  }

  frameCount(): number {
    return this.frames;
  }

  /** The subject shown now (null: the empty stage). */
  shown(): PreviewSubject | null {
    return this.subject;
  }

  /** Show a subject in place of the current one (null: none). The old one is released first. */
  show(subject: PreviewSubject | null): void {
    if (this.disposed) {
      subject?.dispose();
      return;
    }
    if (this.subject === subject) return;
    this.release();
    this.grid.visible = false;
    this.subject = subject;
    if (subject !== null) {
      ledger.shown += 1;
      publishLedger();
      subject.attach(this);
    }
    this.canvas.dataset['subject'] = subject?.key ?? '';
  }

  /** The active scene's look (null: a neutral backdrop); its wind moves the library's materials. */
  setEnvironment(env: PreviewEnvironment): void {
    this.environmentValue = env;
    this.library.setWind(env?.wind ?? null);
    this.environmentRenderer?.set(env);
    this.subject?.environmentChanged?.(this);
  }

  setGrid(on: boolean): void {
    this.grid.visible = on;
  }

  frame(box: THREE.Box3, direction: THREE.Vector3 = new THREE.Vector3(0, 0.25, 1), fill = 1): void {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2);
    const distance = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * fill;
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction.clone().normalize(), distance);
    this.camera.near = distance / 200;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private release(): void {
    const old = this.subject;
    if (old === null) return;
    this.subject = null;
    old.dispose();
    ledger.released += 1;
    const r = this.renderer();
    if (r !== null) {
      const m = rendererMemory(r);
      ledger.idle = { geometries: m.geometries, attributes: m.attributes, indexAttributes: m.indexAttributes, storageAttributes: m.storageAttributes, textures: m.textures };
    }
    publishLedger();
  }

  private draw(): void {
    if (this.disposed) return;
    const r = this.renderer();
    // Nothing to draw into while the pane is hidden (an editor without a preview is in front).
    if (r === null || this.canvas.clientWidth === 0 || this.canvas.clientHeight === 0) return;
    this.resize(r);
    const now = performance.now();
    this.library.tick((now - this.start) / 1000);
    const env = this.ensureEnvironment(r);
    const s = this.subject;
    s?.update?.(this, now);
    const t0 = performance.now();
    if (env !== null) env.render(this.camera);
    else r.render(this.scene, this.camera);
    const drawMs = performance.now() - t0;
    this.frames += 1;
    s?.afterRender?.(this, drawMs, now);
    if (now - this.lastDiagnostics >= DIAGNOSTICS_INTERVAL_MS) {
      this.lastDiagnostics = now;
      const c = this.canvas;
      c.dataset['frames'] = String(this.frames);
      c.setAttribute('data-memory', JSON.stringify(rendererMemory(r)));
    }
  }

  private ensureEnvironment(r: PreviewRendererLike): EnvironmentRenderer | null {
    if (this.environmentValue === null) return null;
    if (this.environmentRenderer !== null && this.environmentGeneration === this.handle.generation()) return this.environmentRenderer;
    this.environmentRenderer?.dispose();
    this.environmentGeneration = this.handle.generation();
    const env = createEnvironmentRenderer(r, this.scene, { loadTexture: this.options.loadTexture });
    env.resize(Math.max(1, this.canvas.clientWidth), Math.max(1, this.canvas.clientHeight));
    env.setKeyLightDirection([-3, -5, -4]);
    env.set(this.environmentValue);
    this.environmentRenderer = env;
    return env;
  }

  private resize(r: PreviewRendererLike): void {
    if (this.sizedFor !== this.handle.generation()) {
      this.sizedFor = this.handle.generation();
      r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    r.setSize(w, h, false);
    this.environmentRenderer?.resize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    disposeOrbitControls(this.orbit);
    this.environmentRenderer?.dispose();
    this.environmentRenderer = null;
    this.library.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.handle.dispose();
    ledger.open -= 1;
    ledger.closed += 1;
    publishLedger();
  }
}
