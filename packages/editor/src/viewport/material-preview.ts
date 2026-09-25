/**
 * Phase 18.2: the Material tab's live preview — one graph material on a
 * sphere, a plane, a cube or a model of the project, lit by a neutral key
 * light and drawn through the project environment (sky, image-based light,
 * fog, tone mapping and post, the same environment renderer as the Scene
 * view), with its own renderer (the editor's backend choice), its own
 * material library (the graph compiled to TSL like everywhere else) and an
 * orbit camera.
 *
 * Browser-only (a canvas, WebGPU or WebGL 2 through three's WebGPURenderer).
 */
import {
  createEnvironmentRenderer,
  createMaterialLibrary,
  createRenderer,
  disposeObjectTree,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type GraphProblem,
  type MaterialDefLike,
  type MaterialFunctionLike,
  type MaterialLibrary,
  type RendererHandle,
  type RendererInfo,
  type WindLike,
} from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeOrbitControls } from './controls';

import { editorRendererChoice } from './renderer-choice';

export type PreviewShape = 'sphere' | 'plane' | 'cube' | 'model';

export interface MaterialPreviewOptions {
  /** A texture asset's texture (the editor's decoded bytes). */
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
}

export class MaterialPreview {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  private readonly renderer: RendererHandle;
  private readonly orbit: OrbitControls;
  private readonly library: MaterialLibrary;
  private readonly key = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly fill = new THREE.AmbientLight(0xa0b0c8, 0.5);
  private readonly holder = new THREE.Group();
  private environment: EnvironmentRenderer | null = null;
  private environmentGeneration = -1;
  private environmentValue: EnvironmentLike | null = null;
  private undo: (() => void) | null = null;
  private materialId: string | null = null;
  private shapeObject: THREE.Object3D | null = null;
  private ownedGeometry: THREE.BufferGeometry | null = null;
  /** Phase 21.5: the primitive's own material (released with its shape). */
  private ownedMaterial: THREE.Material | null = null;
  private disposed = false;
  private raf = 0;
  private sizedFor = -1;
  private readonly start = performance.now();
  private frames = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: MaterialPreviewOptions,
  ) {
    const choice = editorRendererChoice();
    // Phase 21.5: the canvas is never reused (a tab mounts a new one): its WebGL context is released at
    // once instead of waiting for the collector (browsers drop the oldest contexts past ~16).
    this.renderer = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: true, clearColor: 0x000000, clearAlpha: 1, loseContextOnDispose: true });
    this.library = createMaterialLibrary({ loadTexture: options.loadTexture });
    this.scene.background = new THREE.Color(0x1b1e26);
    this.key.position.set(3, 5, 4);
    this.scene.add(this.key, this.fill, this.holder);
    this.camera.position.set(0, 0.4, 3.2);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0, 0);
    this.orbit.update();
    this.setShape('sphere');
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      const r = this.renderer.ready() ? this.renderer.current() : null;
      if (r === null) return;
      this.resize(r);
      this.library.tick((performance.now() - this.start) / 1000);
      const env = this.ensureEnvironment();
      if (env !== null) env.render(this.camera);
      else r.render(this.scene, this.camera);
      this.frames += 1;
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** The renderer's state (its backend once ready). */
  info(): RendererInfo {
    return this.renderer.info();
  }

  /** Frames drawn so far (tests wait for a few after a change). */
  frameCount(): number {
    return this.frames;
  }

  /** The project materials and functions, and which material the preview wears. */
  setMaterial(defs: readonly MaterialDefLike[], functions: readonly MaterialFunctionLike[], materialId: string): void {
    this.library.setMaterials(defs, functions);
    if (this.materialId !== materialId) {
      this.materialId = materialId;
      this.applyMaterial();
    }
  }

  /** The compile problems of the previewed graph (null until it compiled). */
  problems(): readonly GraphProblem[] | null {
    return this.materialId === null ? null : this.library.graphProblems(this.materialId);
  }

  /** The project environment (null: a neutral studio backdrop) and its wind. */
  setEnvironment(env: (EnvironmentLike & { wind?: WindLike }) | null): void {
    this.environmentValue = env;
    this.library.setWind(env?.wind ?? null);
    this.environment?.set(env);
  }

  /** A primitive, or a model's root (`model`; the caller keeps ownership of it). */
  setShape(shape: PreviewShape, model?: THREE.Object3D | null): void {
    // A React cleanup may reset the shape after the preview was disposed (effects clean up in order).
    if (this.disposed) return;
    this.undo?.();
    this.undo = null;
    if (this.shapeObject !== null) {
      this.holder.remove(this.shapeObject);
      // Phase 21.5: the primitive's render objects (it wore the library's material, which lives on).
      if (this.ownedGeometry !== null) disposeObjectTree(this.shapeObject);
    }
    this.ownedGeometry?.dispose();
    this.ownedGeometry = null;
    this.ownedMaterial?.dispose();
    this.ownedMaterial = null;
    let obj: THREE.Object3D;
    if (shape === 'model' && model !== undefined && model !== null) obj = model;
    else {
      const g = shape === 'plane' ? new THREE.PlaneGeometry(2, 2) : shape === 'cube' ? new THREE.BoxGeometry(1.3, 1.3, 1.3) : new THREE.SphereGeometry(0.9, 64, 32);
      if (shape === 'plane') g.rotateX(-Math.PI / 3);
      this.ownedGeometry = g;
      this.ownedMaterial = new THREE.MeshStandardMaterial({ color: 0xc8c8c8 });
      obj = new THREE.Mesh(g, this.ownedMaterial);
    }
    this.shapeObject = obj;
    this.holder.add(obj);
    this.frame(obj);
    this.applyMaterial();
  }

  private applyMaterial(): void {
    this.undo?.();
    this.undo = this.shapeObject !== null && this.materialId !== null ? this.library.apply(this.shapeObject, { '*': this.materialId }) : null;
  }

  private frame(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(0, 0.25, 1).normalize(), distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private ensureEnvironment(): EnvironmentRenderer | null {
    const r = this.renderer.current();
    if (r === null || this.environmentValue === null) return null;
    if (this.environment !== null && this.environmentGeneration === this.renderer.generation()) return this.environment;
    this.environment?.dispose();
    this.environmentGeneration = this.renderer.generation();
    const env = createEnvironmentRenderer(r, this.scene, { loadTexture: this.options.loadTexture });
    env.resize(Math.max(1, this.canvas.clientWidth), Math.max(1, this.canvas.clientHeight));
    env.setKeyLightDirection([-3, -5, -4]);
    env.set(this.environmentValue);
    this.environment = env;
    return env;
  }

  private resize(r: NonNullable<ReturnType<RendererHandle['current']>>): void {
    if (this.sizedFor !== this.renderer.generation()) {
      this.sizedFor = this.renderer.generation();
      r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    r.setSize(w, h, false);
    this.environment?.resize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.undo?.();
    this.undo = null;
    if (this.shapeObject !== null) {
      this.holder.remove(this.shapeObject);
      if (this.ownedGeometry !== null) disposeObjectTree(this.shapeObject);
    }
    this.shapeObject = null;
    disposeOrbitControls(this.orbit);
    this.environment?.dispose();
    this.environment = null;
    this.library.dispose();
    this.ownedGeometry?.dispose();
    this.ownedGeometry = null;
    this.ownedMaterial?.dispose();
    this.ownedMaterial = null;
    this.renderer.dispose();
  }
}
