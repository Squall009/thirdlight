/**
 * Asset tile thumbnails: one small offscreen renderer draws a model (or one
 * piece of it) from a three-quarter front view on a transparent background.
 * The PNG goes to the backend's thumbnail cache, so the next editor just
 * downloads it. Renders run one at a time.
 *
 * Phase 17.1: the renderer comes from the three-adapter factory with the
 * editor's backend choice (a thumbnail waits until WebGPURenderer is ready).
 *
 * Browser-only (three.js + WebGL/WebGPU).
 */
import * as THREE from 'three';
import { createRenderer, isNodeRenderer, type PreparedVisualResource, type RendererHandle, type VertexColorMode } from '@thirdlight/three-adapter';

import { editorRendererChoice } from './renderer-choice';

/** Thumbnail edge in pixels (tiles show it at half size on HiDPI screens). */
export const THUMBNAIL_SIZE = 128;

export interface ThumbnailSource {
  /** The cached PNG, or null when none is cached. */
  read(digest: string, piece: string | null): Promise<Blob | null>;
  store(digest: string, piece: string | null, png: Blob): Promise<void>;
  /** The loaded asset (null when it cannot be loaded). */
  prepared(assetId: string): Promise<PreparedVisualResource | null>;
  vertexColorsFor(assetId: string): VertexColorMode;
}

interface Job {
  assetId: string;
  digest: string;
  piece: string | null;
  resolve: (url: string | null) => void;
}

/** Resolve when the browser is idle (or after a short pause where idle callbacks are missing). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 30);
  });
}

/** A PNG data URL as a Blob (null when it is not one). */
function dataUrlBlob(url: string): Blob | null {
  const prefix = 'data:image/png;base64,';
  if (!url.startsWith(prefix)) return null;
  const bin = atob(url.slice(prefix.length));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export class ThumbnailRenderer {
  private renderer: RendererHandle | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  private readonly queue: Job[] = [];
  private running = false;
  private readonly urls = new Map<string, Promise<string | null>>();
  private disposed = false;

  constructor(private readonly source: ThumbnailSource) {
    this.scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x40362c, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    this.scene.add(key);
  }

  /** An object URL for the thumbnail of one asset version (and piece): cached, else rendered and stored. */
  url(assetId: string, digest: string, piece: string | null): Promise<string | null> {
    const k = `${digest}|${piece ?? ''}`;
    let p = this.urls.get(k);
    if (p === undefined) {
      p = this.load(assetId, digest, piece);
      this.urls.set(k, p);
    }
    return p;
  }

  private async load(assetId: string, digest: string, piece: string | null): Promise<string | null> {
    try {
      const cached = await this.source.read(digest, piece);
      if (cached !== null) return URL.createObjectURL(cached);
    } catch {
      /* render instead */
    }
    return new Promise((resolve) => {
      this.queue.push({ assetId, digest, piece, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
        // Previews are background work: let input and the editor's own frames run first.
        await idle();
        if (this.disposed) {
          job.resolve(null);
          continue;
        }
        let blob: Blob | null = null;
        try {
          blob = await this.render(job.assetId, job.piece);
          if (blob !== null) await this.source.store(job.digest, job.piece, blob).catch(() => undefined);
        } catch {
          blob = null;
        }
        job.resolve(blob === null ? null : URL.createObjectURL(blob));
      }
    } finally {
      this.running = false;
    }
  }

  /** Render one model (or piece) to a PNG. */
  async render(assetId: string, piece: string | null): Promise<Blob | null> {
    const resource = await this.source.prepared(assetId);
    if (resource === null || this.disposed) return null;
    const created = resource.createInstance({ ...(piece !== null ? { piece } : {}), vertexColors: this.source.vertexColorsFor(assetId) });
    if (!created.ok) return null;
    const instance = created.instance;
    try {
      if (this.renderer === null) {
        const canvas = document.createElement('canvas');
        canvas.width = THUMBNAIL_SIZE;
        canvas.height = THUMBNAIL_SIZE;
        const choice = editorRendererChoice();
        // A transparent background: the tile's own colour shows around the model.
        this.renderer = createRenderer({ canvas, preference: choice.preference, source: choice.source, alpha: true, antialias: true, preserveDrawingBuffer: true, clearColor: 0x000000, clearAlpha: 0, loseContextOnDispose: true });
      }
      if (!(await this.renderer.whenReady()) || this.disposed) return null;
      const renderer = this.renderer.current();
      if (renderer === null) return null;
      renderer.setPixelRatio(1);
      renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);
      this.scene.add(instance.root);
      instance.root.updateMatrixWorld(true);
      const box = resource.bounds(piece);
      if (box.isEmpty()) box.setFromObject(instance.root);
      if (box.isEmpty()) return null;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const dir = new THREE.Vector3(0.55, 0.45, 1).normalize();
      const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
      this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
      this.camera.near = Math.max(0.001, distance - sphere.radius * 2);
      this.camera.far = distance + sphere.radius * 2;
      this.camera.lookAt(sphere.center);
      this.camera.updateProjectionMatrix();
      renderer.render(this.scene, this.camera);
      const canvas = renderer.domElement;
      // WebGPURenderer keeps no drawing buffer: the PNG is read in the same task as the render.
      if (isNodeRenderer(renderer)) return dataUrlBlob(canvas.toDataURL('image/png'));
      return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    } finally {
      this.scene.remove(instance.root);
      instance.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.urls.values()) void p.then((u) => u !== null && URL.revokeObjectURL(u));
    this.urls.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }
}
