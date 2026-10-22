/**
 * The adapter's environment: the look drawn (environment-look.ts: the
 * project environment, the active scene's look, a running preset blend) and
 * the environment renderer that draws it (sky, fog, post), made with the
 * renderer once something needs it, with its textures held for its life.
 *
 * Kept apart from the adapter so the environment's lifetime is owned in one place.
 */
import type * as THREE from 'three';
import type { EnvironmentBlendView, ResourceManager } from '@thirdlight/runtime';

import type { SceneAdapterOptions } from './adapter-types';
import { createEnvironmentRenderer, environmentTextureIds, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike } from './environment';
import { EnvironmentLook } from './environment-look';
import type { LightmapSet } from './lightmaps';
import type { SceneLights } from './lights-shadows';
import type { MaterialLibrary } from './material-library';
import type { ScenePasses } from './occlusion-passes';
import type { AnyRenderer } from './renderer-factory';
import { textureHolds, type TextureHolds } from './texture-holds';

/** What else asks for the environment renderer and is set on it each frame. */
export interface EnvironmentFrameHost {
  /** A quality level, the render settings or occlusion culling draw through the environment renderer. */
  needed(): boolean;
  /** The scene passes occlusion culling adds. */
  scenePasses(): ScenePasses | null;
  /** A new environment renderer takes the quality level's settings. */
  created(renderer: EnvironmentRenderer): void;
  /** The render settings, put on before every frame. */
  apply(renderer: EnvironmentRenderer): void;
  keyDirection(): readonly [number, number, number] | undefined;
  fogVolumes(): FogVolumeLike[];
}

export class AdapterEnvironment {
  readonly look: EnvironmentLook;
  /** The environment renderer (made with the renderer, when something needs it). */
  renderer: EnvironmentRenderer | null = null;
  /** The environment's textures (held while it exists). */
  private holds: TextureHolds | null = null;
  /** The size last handed to the environment renderer (it rebuilds its post stack on a change). */
  private size: [number, number] | null = null;
  /** The scenes' looks (absent: the environment's value is the whole look). */
  private readonly sceneLooks: NonNullable<SceneAdapterOptions['environment']>['scenes'] | null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly resources: ResourceManager,
    private readonly opts: SceneAdapterOptions,
    parts: { lights(): SceneLights; lightmaps(): LightmapSet | null; materials: MaterialLibrary | null },
  ) {
    this.sceneLooks = opts.environment?.scenes ?? null;
    this.look = new EnvironmentLook(
      {
        sceneLooks: this.sceneLooks,
        readBlend: () => (opts.runtime as { readEnvironmentBlend?: () => EnvironmentBlendView | null }).readEnvironmentBlend?.() ?? null,
        renderer: () => this.renderer,
        lights: parts.lights,
        lightmaps: parts.lightmaps,
        materials: parts.materials,
        defaultWind: opts.materials?.wind ?? null,
      },
      opts.environment?.value ?? null,
      (opts.snapshot as { tags?: readonly { bit: number; name: string }[] }).tags ?? [],
    );
  }

  /** The look drawn now (null: nothing, as without an environment). */
  effective(): EnvironmentLike | null {
    return this.look.effective();
  }

  /** The running blend (or its end) put on before the draw. */
  applyBlend(): void {
    this.look.apply();
  }

  /** The renderer was replaced (or the drawing-buffer size changes): what held the old one goes. */
  drop(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.size = null;
  }

  /** The post stack follows a new drawing-buffer size. */
  resized(): void {
    this.size = null;
  }

  /**
   * Before the draw: the environment renderer made when something needs it (a quality level also applies
   * without a project environment: a level without MSAA draws through a plain pass), then the frame's key
   * light, fog volumes and size set on it.
   */
  beforeFrame(renderer: AnyRenderer, w: number, h: number, host: EnvironmentFrameHost): void {
    const look = this.look;
    // With the scenes' looks given, only once there is something to draw (a look, presets, a blend):
    // a game whose scenes set no look renders as one without an environment.
    const wanted = this.opts.environment !== undefined && (this.sceneLooks === null || this.effective() !== null || look.presets.size > 0 || look.blendActive);
    if ((wanted || host.needed()) && this.renderer === null) {
      // The sky, its faces and the grading LUT are held for the environment's life. They are the same
      // decoded textures materials draw with (the environment builds its cube, equirect copy and LUT
      // from their images and never changes them), so a texture used by both is decoded once.
      const envTextures = textureHolds(this.resources, this.opts.environment?.loadTexture ?? (async () => null));
      const onChange = this.opts.onChange;
      // A sky image that arrives later is drawn by the next frame (a host drawing on demand is told).
      this.renderer = createEnvironmentRenderer(renderer, this.scene, { loadTexture: (id) => envTextures.get(id, 'environment'), scenePasses: () => host.scenePasses(), ...(onChange !== undefined ? { onChange } : {}) });
      this.holds = envTextures;
      this.renderer.set(this.effective());
      host.created(this.renderer);
      // A blend already running goes onto the new environment renderer.
      look.appliedKey = '';
      look.blendActive = false;
      this.applyBlend();
    }
    const env = this.renderer;
    if (env === null) return;
    host.apply(env);
    const keyDir = host.keyDirection();
    env.setKeyLightDirection(keyDir !== undefined ? [keyDir[0], keyDir[1], keyDir[2]] : null);
    env.setFogVolumes(host.fogVolumes());
    if (this.size === null || this.size[0] !== w || this.size[1] !== h) {
      this.size = [w, h];
      env.resize(w, h);
    }
  }

  /** A new project environment (an editing host's): other textures need a new environment renderer. */
  setValue(value: EnvironmentLike | null, project: (value: EnvironmentLike | null) => void): void {
    const texturesBefore = JSON.stringify(environmentTextureIds(this.look.value));
    this.look.setValue(value);
    // The quality level follows the project's first (it may set the renderer that is about to go).
    project(value);
    if (JSON.stringify(environmentTextureIds(value)) !== texturesBefore && this.renderer !== null) {
      // A new environment renderer holds them, and the ones only the old one named are let go.
      this.drop();
      this.holds?.releaseHolder('environment');
      this.holds = null;
    } else this.renderer?.set(this.effective());
  }

  dispose(): void {
    this.renderer?.dispose();
    this.holds?.releaseHolder('environment');
  }
}
