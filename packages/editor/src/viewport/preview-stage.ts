/**
 * The asset preview stage: a separate small renderer + scene for previewing
 * an asset (model/material/animation) without touching the edited scene.
 *
 * Phase 17.1: the renderer comes from the three-adapter factory with the
 * editor's backend choice (frames wait until WebGPURenderer is ready).
 *
 * Browser-only: uses a canvas + WebGL/WebGPU via three.js.
 */
import { createRenderer, type RendererHandle } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { editorRendererChoice } from './renderer-choice';

export class PreviewStage {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly renderer: RendererHandle;
  private readonly orbit: OrbitControls;
  private readonly canvas: HTMLCanvasElement;
  private raf = 0;
  private sizedFor = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const choice = editorRendererChoice();
    // Opaque black where nothing is drawn (what WebGLRenderer cleared to); the scene background covers it.
    this.renderer = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: true, clearColor: 0x000000, clearAlpha: 1 });
    this.scene.background = new THREE.Color(0x1b1e26);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 5, 4);
    this.scene.add(key, new THREE.AmbientLight(0xa0b0c8, 0.7));
    this.scene.add(new THREE.GridHelper(4, 8, 0x333844, 0x23262f));
    this.camera.position.set(2, 1.5, 2.5);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.update();
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      const r = this.renderer.ready() ? this.renderer.current() : null;
      if (r === null) return;
      this.resize(r);
      r.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Point the camera at `obj` so it fills the view. */
  frame(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = new THREE.Vector3(1, 0.6, 1.2).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private resize(r: NonNullable<ReturnType<RendererHandle['current']>>): void {
    if (this.sizedFor !== this.renderer.generation()) {
      this.sizedFor = this.renderer.generation();
      r.setPixelRatio(window.devicePixelRatio);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.orbit.dispose();
    this.renderer.dispose();
  }
}
