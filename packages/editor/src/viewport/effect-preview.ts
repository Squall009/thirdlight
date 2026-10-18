/**
 * The Scene view's effect preview: the selected object's effect played in
 * the view (the Gizmos menu's toggle) by the same player Play uses, on the
 * view's renderer (WebGPU compute or the CPU executor). Its particles are
 * the view's own overlay; a finished one-shot starts again.
 *
 * Browser-only (three.js, the effects player).
 */
import { createEffectsPlayer, type EffectComponentLike, type EffectDefLike, type EffectsPlayer, type MaterialLibrary, type SceneAdapter } from '@thirdlight/three-adapter';
import * as THREE from 'three';

export interface EffectPreviewHost {
  /** Where the particles are drawn (the view's overlay group). */
  readonly overlay: THREE.Object3D;
  readonly camera: () => THREE.Camera;
  readonly canvas: () => HTMLElement;
  readonly adapter: () => SceneAdapter;
  readonly materialLibrary: () => MaterialLibrary;
  /** The view's renderer API now (the player's executor follows it). */
  readonly api: () => string | null;
  readonly requestRender: () => void;
}

export class EffectPreview {
  private player: EffectsPlayer | null = null;
  private target: { id: string; component: EffectComponentLike } | null = null;
  private attached: { id: string; obj: THREE.Object3D; key: string } | null = null;
  private renderer: unknown = null;
  private lastNow: number | null = null;
  /** The material holders the preview asked the library for (released with the preview). */
  private holders: { holders: Map<string, { mesh: THREE.Mesh; undo: () => void }>; placeholder: THREE.Material } | null = null;

  constructor(private readonly host: EffectPreviewHost) {}

  /** Release the preview (player, library holders, placeholder). */
  release(): void {
    this.player?.dispose();
    this.player = null;
    this.attached = null;
    this.renderer = null;
    this.target = null;
    const h = this.holders;
    this.holders = null;
    if (h !== null) {
      for (const { mesh, undo } of h.holders.values()) {
        undo();
        mesh.geometry.dispose();
      }
      h.holders.clear();
      h.placeholder.dispose();
    }
  }

  /**
   * Play the selected object's effect in the Scene view. Off (or no effect
   * on the selection): nothing plays.
   */
  set(on: boolean, defs: readonly EffectDefLike[], target: { id: string; component: EffectComponentLike } | null, loadTexture: ((assetId: string) => Promise<THREE.Texture | null>) | null): void {
    if (!on) {
      this.release();
      this.host.canvas().setAttribute('data-effects', JSON.stringify({ preview: false }));
      this.host.requestRender();
      return;
    }
    if (this.player === null) {
      const lib = this.host.materialLibrary;
      const holders = new Map<string, { mesh: THREE.Mesh; undo: () => void }>();
      const placeholder = new THREE.MeshBasicMaterial();
      this.holders = { holders, placeholder };
      this.player = createEffectsPlayer({
        // The particles are the view's own overlay (the game's effects play in Play).
        scene: this.host.overlay as never,
        defs,
        loadTexture: loadTexture ?? (async () => null),
        replayFinished: true,
        projectMaterial: (id) => {
          if (id === '') return null;
          let h = holders.get(id);
          if (h === undefined) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), placeholder);
            h = { mesh, undo: lib().apply(mesh, { '*': id }) };
            holders.set(id, h);
          }
          return h.mesh.material === placeholder ? null : (h.mesh.material as never);
        },
      });
    } else this.player.setDefs(defs);
    this.target = target;
    this.host.requestRender();
  }

  /** Attach the preview to the selected object (again when its node or component changed). */
  private syncTarget(): void {
    const p = this.player;
    if (p === null) return;
    const t = this.target;
    const obj = t !== null ? (this.host.adapter().entityObject?.(t.id, true) ?? null) : null;
    const key = t !== null ? JSON.stringify(t.component) : '';
    const a = this.attached;
    if (a !== null && (t === null || a.id !== t.id || a.obj !== obj || a.key !== key)) {
      p.detach(a.id);
      this.attached = null;
    }
    if (t !== null && obj !== null && this.attached === null) {
      // The preview plays whatever the component's start setting (a signal or script would start it in the game).
      p.attach(t.id, obj, { ...t.component, playOnStart: true }, true);
      this.attached = { id: t.id, obj, key };
    }
  }

  /** One preview step before a frame is drawn; true while something plays (the view keeps drawing). */
  step(renderer: unknown): boolean {
    const p = this.player;
    if (p === null || renderer === null) return false;
    if (this.renderer !== renderer) {
      p.setRenderer(renderer as never, this.host.api() === 'webgpu' ? 'webgpu' : 'webgl2');
      this.renderer = renderer;
      this.attached = null;
    }
    this.syncTarget();
    const now = performance.now();
    const dt = this.lastNow === null ? 0 : Math.max(0, (now - this.lastNow) / 1000);
    this.lastNow = now;
    p.update(dt, this.host.camera() as never);
    const d = p.diagnostics();
    this.host.canvas().setAttribute('data-effects', JSON.stringify({ preview: true, executor: d.executor, playing: d.playing, particles: d.particles }));
    return p.active;
  }

  /** The view's renderer is going: the executor is made again on the next one. */
  rendererGone(): void {
    this.renderer = null;
    this.attached = null;
  }

  /** The frame drew with nothing playing: the next step starts its clock again. */
  idle(): void {
    this.lastNow = null;
  }
}
