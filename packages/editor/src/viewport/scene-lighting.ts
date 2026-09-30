/**
 * The Scene view's lighting: the editor rig (a fixed key and fill) or the
 * game's own lighting — the scene's lights (spot cookies included), the
 * project environment (sky, fog, fog volumes, post) and an environment preset
 * blend previewed with the runtime's own blend maths.
 *
 * The textures it draws with (cookies, the sky and its faces, the grading
 * LUT) are held in the Scene view's resource manager, the one its models and
 * materials use (scene-assets.ts): a light holds its cookie while it is in
 * the view, the environment holds what it names while it names it, and a
 * texture nothing holds any more is freed. A texture is decoded once however
 * many users draw with it; each user draws with a copy of its own sampling.
 *
 * Browser-only (three.js). The viewport owns one and calls it on every sync,
 * frame and renderer change.
 */
import * as THREE from 'three';
import { createEnvironmentRenderer, selectSceneLights, textureHolds, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike, type RendererHandle, type SceneLightKind, type TextureHolds } from '@thirdlight/three-adapter';
import { blendEnvironment, blendLight, type EnvironmentBlendView, type EnvironmentLightValues, type ResourceManager } from '@thirdlight/runtime';
import type { EnvironmentPreset } from '@thirdlight/project-model';

import type { ProjectedEntity } from '../session/projection';

export interface SceneLightingHost {
  readonly scene: THREE.Scene;
  /** The renderer now (it is replaced on a backend change). */
  rendererHandle(): RendererHandle;
  /** The view's size in CSS px. */
  size(): { width: number; height: number };
  /** An entity's drawn node (lights hang off it). */
  objectOf(entityId: string): THREE.Object3D | undefined;
  /** Whether an entity is active in the hierarchy (an inactive light is off). */
  active(entityId: string): boolean;
  /** Lights a bake holds (not realtime in the view). */
  bakedLight(entityId: string): boolean;
  /** Take the lightmapped copies off and put them back (the lighting mode decides whether they show). */
  reapplyLightmaps(): void;
  requestRender(): void;
  render(): void;
}

type HeldLight = { key: string; light: THREE.Light; parent: THREE.Object3D };

export class SceneLighting {
  private readonly host: SceneLightingHost;
  private readonly editorLights: THREE.Light[] = [];
  private mode: 'editor' | 'game' = 'editor';
  private chosen = false;
  private readonly sceneLights = new Map<string, HeldLight>();
  /** Each spot light's cookie (its own copy of the decoded texture, which the light holds). */
  private readonly cookies = new Map<THREE.SpotLight, THREE.Texture>();
  private holds: TextureHolds | null = null;
  /** The environment's textures are held under one holder per environment renderer. */
  private envSerial = 0;
  private envHolder = 'environment:0';
  /** The texture ids the environment names (a change makes a new environment renderer). */
  private envTexturesKey = '';
  private environment: EnvironmentRenderer | null = null;
  /** The renderer generation the environment renderer was built for. */
  private environmentGeneration = 0;
  private environmentValue: EnvironmentLike | null = null;
  /** The scene's directional light direction (the procedural sky's sun). */
  private keyLightDirection: readonly [number, number, number] | null = null;
  /** The preset blend the Scene view previews (null: the authored look). */
  private envPreview: EnvironmentBlendView | null = null;
  private envPreviewTags = new Map<string, number>();
  private lightTags = new Map<string, number>();
  private envLightsTouched = false;
  private fogVolumeData = new Map<string, NonNullable<ProjectedEntity['fogVolume']>>();
  /** An environment was set (none is drawn before). */
  private environmentSet = false;
  private disposed = false;

  constructor(host: SceneLightingHost) {
    this.host = host;
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(5, 10, 7);
    host.scene.add(key);
    const fill = new THREE.AmbientLight(0x8899bb, 0.6);
    host.scene.add(fill);
    this.editorLights.push(key, fill);
  }

  /** Where textures are decoded and held (the Scene view's manager) and how. Null: no textures. */
  setTextures(resources: ResourceManager | null, loadTexture: ((assetId: string) => Promise<THREE.Texture | null>) | null): void {
    this.holds = resources !== null && loadTexture !== null ? textureHolds(resources, loadTexture) : null;
  }

  // ---- The lighting mode -------------------------------------------------

  /**
   * "editor" lighting is a fixed key + fill; "game" lighting uses the
   * scene's own lights (what Play shows). Automatic until chosen: game
   * lighting as soon as the scene has a light.
   */
  setMode(mode: 'editor' | 'game'): void {
    this.mode = mode;
    this.chosen = true;
    this.applyMode();
  }

  get game(): boolean {
    return this.mode === 'game';
  }

  getMode(): 'editor' | 'game' {
    return this.mode;
  }

  private applyMode(): void {
    this.host.reapplyLightmaps();
    this.environment?.setBlend(null);
    this.environment?.set(this.mode === 'game' ? this.environmentValue : null);
    this.applyEnvironmentPreview();
    this.environment?.setQuality(this.editorQuality());
    this.showLights();
    this.host.render();
  }

  private showLights(): void {
    for (const l of this.editorLights) l.visible = this.mode === 'editor';
    for (const { light } of this.sceneLights.values()) light.visible = this.mode === 'game' && light.userData['tlActive'] !== false && light.userData['tlSwitchedOn'] !== false;
  }

  // ---- The scene's lights ----------------------------------------------

  /** Drop a scene light, its cookie copy and its hold on the decoded cookie. */
  private dropLight(have: HeldLight): void {
    have.parent.remove(have.light);
    if (have.light instanceof THREE.SpotLight || have.light instanceof THREE.DirectionalLight) have.parent.remove(have.light.target);
    if (have.light instanceof THREE.SpotLight) {
      const cookie = this.cookies.get(have.light);
      if (cookie !== undefined) {
        this.cookies.delete(have.light);
        have.light.map = null;
        cookie.dispose();
      }
      this.holds?.releaseHolder(`cookie:${have.light.uuid}`);
    }
    have.light.dispose();
  }

  /** Every scene light again (the bakes changed which ones are realtime). */
  dropAll(): void {
    for (const [id, have] of [...this.sceneLights]) {
      this.dropLight(have);
      this.sceneLights.delete(id);
    }
  }

  /** A spot light's cookie, drawn in the Scene view as in Play (three's SpotLight.map, a copy of the held texture). */
  private loadCookie(light: THREE.SpotLight, assetId: string): void {
    const holds = this.holds;
    if (holds === null) return;
    const holder = `cookie:${light.uuid}`;
    void holds.get(assetId, holder).then(
      (decoded) => {
        if (decoded === null) return;
        const live = [...this.sceneLights.values()].some((h) => h.light === light);
        if (!live || this.disposed) {
          holds.releaseHolder(holder);
          return;
        }
        const tex = decoded.clone();
        tex.flipY = false; // as the game decodes it
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        light.map = tex;
        this.cookies.set(light, tex);
        this.host.requestRender();
      },
      () => undefined,
    );
  }

  /** The scene lights of the entities shown (with game lighting), and what the environment reads from them. */
  sync(entities: readonly ProjectedEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      const l = e.light;
      // A light a bake holds is not realtime (ambient/hemisphere stay for dynamic objects).
      if (l === undefined || (l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && this.host.bakedLight(e.id))) continue;
      seen.add(e.id);
      const key = JSON.stringify(l);
      const group = this.host.objectOf(e.id);
      if (group === undefined) continue;
      let have = this.sceneLights.get(e.id);
      if (have !== undefined && have.key !== key) {
        this.dropLight(have);
        this.sceneLights.delete(e.id);
        have = undefined;
      }
      if (have === undefined) {
        const made = makeSceneLight(l);
        // Directional/ambient/hemisphere lights ignore the entity transform (as in Play); point/spot follow it.
        const parent = l.type === 'point' || l.type === 'spot' ? group : this.host.scene;
        parent.add(made);
        if (made instanceof THREE.SpotLight || made instanceof THREE.DirectionalLight) parent.add(made.target);
        have = { key, light: made, parent };
        this.sceneLights.set(e.id, have);
        if (made instanceof THREE.SpotLight && l.type === 'spot' && l.cookie !== undefined) this.loadCookie(made, l.cookie);
      }
      have.light.userData['tlActive'] = this.host.active(e.id);
    }
    for (const [id, have] of [...this.sceneLights]) {
      if (seen.has(id)) continue;
      this.dropLight(have);
      this.sceneLights.delete(id);
    }
    // With several scenes open, the lights Play would have on with them loaded in that order
    // (the last open scene's directional, ambient and hemisphere light; point and spot lights within the budget).
    const sceneRank = new Map<string, number>();
    for (const e of entities) if (e.sceneId !== undefined && !sceneRank.has(e.sceneId)) sceneRank.set(e.sceneId, sceneRank.size);
    const byId = new Map(entities.map((e) => [e.id, e]));
    let order = 0;
    const picked = selectSceneLights([...this.sceneLights].map(([id]) => {
      const e = byId.get(id);
      return { id, kind: (e?.light?.type ?? 'point') as SceneLightKind, rank: e?.sceneId !== undefined ? (sceneRank.get(e.sceneId) ?? -1) : -1, order: order++ };
    }));
    for (const [id, have] of this.sceneLights) have.light.userData['tlSwitchedOn'] = picked.active.has(id);
    // A preset preview applies to the lights as they are now.
    this.lightTags = new Map(entities.filter((e) => e.light !== undefined).map((e) => [e.id, e.tags]));
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    // The sun of a procedural sky sits opposite the scene's directional light.
    const key = (picked.directional !== null ? byId.get(picked.directional) : undefined) ?? entities.find((e) => e.light?.type === 'directional' && e.light.direction !== undefined);
    this.keyLightDirection = key?.light?.direction ?? null;
    this.environment?.setKeyLightDirection(this.keyLightDirection);
    this.fogVolumeData = new Map(entities.filter((e) => e.fogVolume !== undefined).map((e) => [e.id, e.fogVolume!]));
    const modeBefore = this.mode;
    if (!this.chosen) this.mode = this.sceneLights.size > 0 ? 'game' : 'editor';
    if (modeBefore !== this.mode) this.applyMode();
    else this.showLights();
  }

  /** How many cookies are drawn (tests and the view's diagnostics). */
  get cookieCount(): number {
    return this.cookies.size;
  }

  // ---- The environment --------------------------------------------------

  /** The environment renderer for the current renderer (rebuilt when the renderer was replaced). */
  ensureEnvironment(): EnvironmentRenderer | null {
    const handle = this.host.rendererHandle();
    const renderer = handle.current();
    if (this.holds === null || renderer === null || !this.environmentSet) return null;
    if (this.environment !== null && this.environmentGeneration === handle.generation()) return this.environment;
    this.environment?.dispose();
    this.environmentGeneration = handle.generation();
    const holds = this.holds;
    const holder = this.envHolder;
    const env = createEnvironmentRenderer(renderer, this.host.scene, { loadTexture: (id) => holds.get(id, holder), onChange: () => this.host.requestRender() });
    const { width, height } = this.host.size();
    env.resize(width, height);
    env.setKeyLightDirection(this.keyLightDirection);
    env.set(this.mode === 'game' ? this.environmentValue : null);
    env.setQuality(this.editorQuality());
    this.environment = env;
    // A preset preview carries over to a new renderer.
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    return env;
  }

  /** The renderer is being replaced: its environment renderer goes with it. */
  dropEnvironment(): void {
    this.environment?.dispose();
    this.environment = null;
  }

  /**
   * The project environment (sky, fog, fog volumes, post) in the Scene view —
   * with game lighting only (the editor rig shows the plain view).
   */
  setEnvironment(value: EnvironmentLike | null): void {
    this.environmentValue = value;
    this.environmentSet = true;
    // Another set of textures: a new environment renderer holds them (its cache starts empty), and the
    // textures only the old one named are let go (freed unless something else holds them).
    const texturesKey = JSON.stringify(environmentTextureIds(value));
    if (texturesKey !== this.envTexturesKey) {
      this.envTexturesKey = texturesKey;
      const before = this.envHolder;
      this.envSerial += 1;
      this.envHolder = `environment:${this.envSerial}`;
      this.dropEnvironment();
      this.holds?.releaseHolder(before);
    }
    // Built for the current renderer (null while WebGPURenderer initialises; the first frame builds it).
    const env = this.ensureEnvironment();
    env?.set(this.mode === 'game' ? value : null);
    env?.setQuality(this.editorQuality());
    // A previewed blend follows edited presets.
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    this.host.requestRender();
  }

  /**
   * Show an environment preset blend (weights by preset id; '' = the base
   * look) in the Scene view with game lighting: the look, and the scene
   * lights the presets set — the runtime's own blend maths (what Play draws).
   * Null: back to the authored look. `tagBits`: the project's tag registry
   * (name → bit) for presets that name lights by tag.
   */
  previewEnvironmentBlend(view: { weights: readonly (readonly [string, number])[]; overrides?: EnvironmentBlendView['overrides'] } | null, tagBits?: ReadonlyMap<string, number>): void {
    this.envPreview = view === null ? null : { weights: view.weights, overrides: view.overrides ?? {}, target: null, progress: 1 };
    if (tagBits !== undefined) this.envPreviewTags = new Map([...tagBits].map(([k, v]) => [k.toLowerCase(), v]));
    this.applyEnvironmentPreview();
    this.host.requestRender();
  }

  /** The previewed blend (tests, the panel). */
  environmentPreview(): EnvironmentBlendView | null {
    return this.envPreview;
  }

  private applyEnvironmentPreview(): void {
    const view = this.envPreview;
    const presets = new Map(((this.environmentValue?.presets ?? []) as unknown as readonly EnvironmentPreset[]).map((p) => [p.presetId, p]));
    const base = (this.environmentValue ?? {}) as Parameters<typeof blendEnvironment>[0];
    if (view === null || this.mode !== 'game') this.environment?.setBlend(null);
    else this.environment?.setBlend(blendEnvironment(base, presets, view) as never);
    // The lights: blended values, or back to what the scene authored.
    if (view === null && !this.envLightsTouched) return;
    this.envLightsTouched = view !== null;
    for (const [id, have] of this.sceneLights) {
      const l = JSON.parse(have.key) as { type: string; color: string; intensity: number; direction?: number[]; groundColor?: string };
      const d = l.direction ?? (l.type === 'spot' || l.type === 'directional' ? [0, -1, 0] : undefined);
      const authored: EnvironmentLightValues = { color: l.color, intensity: l.intensity, ...(d !== undefined ? { direction: [d[0]!, d[1]!, d[2]!] as [number, number, number] } : {}), ...(l.type === 'hemisphere' ? { groundColor: l.groundColor ?? '#444444' } : {}) };
      const v = view === null ? authored : blendLight(authored, { id, tags: this.lightTags.get(id) ?? 0, type: l.type }, this.envPreviewTags, base, presets, view);
      have.light.color.set(v.color);
      have.light.intensity = v.intensity;
      if (v.groundColor !== undefined && have.light instanceof THREE.HemisphereLight) have.light.groundColor.set(v.groundColor);
      if (v.direction !== undefined) {
        const [x, y, z] = v.direction;
        if (have.light instanceof THREE.SpotLight) have.light.target.position.set(x, y, z);
        else if (have.light instanceof THREE.DirectionalLight) have.light.position.set(-x * 20, -y * 20, -z * 20);
      }
    }
  }

  /**
   * With the editor rig (no project look) the Scene view still draws at the
   * project's quality level — MSAA is the level's choice (low: none); null in
   * game lighting (the environment's own level applies) or when the project
   * sets none.
   */
  editorQuality(): 'low' | 'medium' | 'high' | null {
    return this.mode === 'editor' ? (this.environmentValue?.quality ?? null) : null;
  }

  /** The fog volumes where their objects are now (the environment draws them each frame). */
  fogVolumesNow(): FogVolumeLike[] {
    const out: FogVolumeLike[] = [];
    const p = new THREE.Vector3();
    for (const [id, fv] of this.fogVolumeData) {
      const obj = this.host.objectOf(id);
      if (obj === undefined || !this.host.active(id)) continue;
      obj.getWorldPosition(p);
      out.push({ center: [p.x, p.y, p.z], size: fv.size, density: fv.density, color: fv.color, ...(fv.falloff !== undefined ? { falloff: fv.falloff } : {}), ...(fv.heightFalloff !== undefined ? { heightFalloff: fv.heightFalloff } : {}) });
    }
    return out;
  }

  resize(width: number, height: number): void {
    this.environment?.resize(width, height);
  }

  dispose(): void {
    this.disposed = true;
    for (const have of this.sceneLights.values()) this.dropLight(have);
    this.sceneLights.clear();
    this.dropEnvironment();
    this.holds?.releaseHolder(this.envHolder);
  }
}

/** The texture assets an environment names (a sky, its faces, the grading LUT: any string could be one). */
function environmentTextureIds(value: EnvironmentLike | null): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  const sky = (value as { sky?: unknown } | null)?.sky;
  const post = (value as { post?: { grading?: unknown } } | null)?.post;
  walk(sky);
  walk(post?.grading);
  return [...out].sort();
}

/** The three.js light for an authored light (the editor's "game lighting"). */
function makeSceneLight(l: NonNullable<ProjectedEntity['light']>): THREE.Light {
  const colour = new THREE.Color(l.color);
  switch (l.type) {
    case 'ambient':
      return new THREE.AmbientLight(colour, l.intensity);
    case 'hemisphere':
      return new THREE.HemisphereLight(colour, new THREE.Color(l.groundColor ?? '#444444'), l.intensity);
    case 'point':
      return new THREE.PointLight(colour, l.intensity, l.range ?? 0, l.decay ?? 2);
    case 'spot': {
      const s = new THREE.SpotLight(colour, l.intensity, l.range ?? 0, THREE.MathUtils.degToRad(l.angle ?? 30), l.penumbra ?? 0.2, l.decay ?? 2);
      // At its entity's origin (three starts a SpotLight at (0, 1, 0)), shining along `direction`.
      s.position.set(0, 0, 0);
      const d = l.direction ?? [0, -1, 0];
      s.target.position.set(d[0], d[1], d[2]);
      return s;
    }
    default: {
      const d = l.direction ?? [0, -1, 0];
      const dl = new THREE.DirectionalLight(colour, l.intensity);
      dl.position.set(-d[0] * 20, -d[1] * 20, -d[2] * 20);
      return dl;
    }
  }
}
