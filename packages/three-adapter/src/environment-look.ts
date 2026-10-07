/**
 * The look a game is drawn with: the project environment, the active
 * scene's look laid over it, and a running blend of environment presets
 * (the game's `ctx.environment`, or the editor's preview of one) — put on
 * the environment renderer (sky, fog, post), the scene lights, the lightmap
 * multiplier and the materials' scene globals (wind, wetness).
 *
 * The adapter owns the renderer, the lights and the lightmaps; this keeps
 * which look they show and applies it only when it changed.
 */
import { blendEnvironment, blendEnvironmentOver, blendTouchesLights, type EnvironmentBlendView } from '@thirdlight/runtime';

import { layerEnvironment, environmentHasLook, type EnvironmentLayerLike, type EnvironmentLike, type EnvironmentRenderer } from './environment';
import type { LightmapSet } from './lightmaps';
import type { MaterialLibrary, WindLike } from './material-library';
import type { SceneLights } from './lights-shadows';

export type PresetOf = Parameters<typeof blendEnvironment>[1] extends ReadonlyMap<string, infer P> ? P : never;

/** A key no blend state has: the look is applied again on the next frame. */
export const ENV_STALE = '\u0000stale';

/** The scenes' looks (absent: the environment's value is the whole look). */
export interface SceneLooksLike {
  readonly start: string | null;
  look(sceneId: string): EnvironmentLayerLike | null;
}

export interface EnvironmentLookDeps {
  readonly sceneLooks: SceneLooksLike | null;
  /** The running game's blend state (null: none). */
  readBlend(): EnvironmentBlendView | null;
  renderer(): EnvironmentRenderer | null;
  lights(): SceneLights;
  lightmaps(): LightmapSet | null;
  materials: MaterialLibrary | null;
  /** The wind when the active scene's look sets none. */
  readonly defaultWind: WindLike | null;
}

export class EnvironmentLook {
  /** The project environment (an editing host replaces it). */
  value: EnvironmentLike | null;
  readonly presets = new Map<string, PresetOf>();
  /** Tag name (lowercase) → bit, for presets that name lights by tag. */
  readonly tagBits = new Map<string, number>();
  /** The editor's preview of a blend (null: the running game's). */
  preview: EnvironmentBlendView | null = null;
  /** A blend (not the plain look) is on the renderer and lights. */
  blendActive = false;
  /** The blend state last applied (its key). */
  appliedKey = '';
  /** The scene whose look is laid over the project environment now, and that look (null: none). */
  private layerScene: string | null;
  private layer: EnvironmentLayerLike | null;

  constructor(private readonly deps: EnvironmentLookDeps, value: EnvironmentLike | null, tags: readonly { bit: number; name: string }[]) {
    this.value = value;
    this.layerScene = deps.sceneLooks?.start ?? null;
    this.layer = this.layerScene !== null ? (deps.sceneLooks?.look(this.layerScene) ?? null) : null;
    this.readPresets();
    for (const t of tags) this.tagBits.set(t.name.toLowerCase(), t.bit);
    this.setWetness(this.plainWetness());
  }

  readPresets(): void {
    this.presets.clear();
    for (const p of (this.value?.presets ?? []) as unknown as readonly PresetOf[]) this.presets.set(p.presetId, p);
  }

  /** What the renderer draws: the project environment with the layered look over it (null when nothing is drawn, as without an environment). */
  effective(): EnvironmentLike | null {
    const v = layerEnvironment(this.value, this.layer);
    return environmentHasLook(v) ? v : null;
  }

  /** A new project environment: the renderer, the presets and the materials' wetness follow (the blend at the next apply). */
  setValue(value: EnvironmentLike | null): void {
    this.value = value;
    this.readPresets();
    this.appliedKey = ENV_STALE;
    if (!this.blendActive) this.setWetness(this.plainWetness());
  }

  /**
   * Draw the environment blend — the look (sky, fog, post) on the
   * environment renderer, the lights' colours/intensities/directions, the
   * lightmap multiplier, the materials' wetness. Only when the blend or the
   * light set changed; back to the authored look when the blend ends (a new
   * run).
   */
  apply(): void {
    const view = this.preview ?? this.deps.readBlend();
    this.followActiveScene(view);
    // Only the active scene's look, no preset: the look is drawn as it is (no blend).
    const fading = view?.scene !== undefined && view.scene.from !== null && view.scene.weight < 1;
    const plain = view === null || (!fading && view.weights.length === 1 && view.weights[0]![0] === '' && Object.keys(view.overrides).length === 0);
    const lights = this.deps.lights();
    const key = plain ? '' : `${JSON.stringify(view.weights)}|${JSON.stringify(view.overrides)}|${JSON.stringify(view.scene ?? null)}|${lights.revision}|${JSON.stringify(this.layer)}`;
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    if (plain) {
      if (!this.blendActive) return;
      this.blendActive = false;
      this.deps.renderer()?.setBlend(null);
      lights.restore();
      this.deps.lightmaps()?.setLook(1, '#ffffff');
      this.setWetness(this.plainWetness());
      return;
    }
    this.blendActive = true;
    const base = layerEnvironment(this.value, this.layer) ?? {};
    // While the active scene's look blends in, every key resolves over both scenes' looks.
    const from = fading ? (layerEnvironment(this.value, this.deps.sceneLooks?.look(view.scene!.from!) ?? null) ?? {}) : null;
    const look = from === null ? blendEnvironment(base as never, this.presets, view) : blendEnvironmentOver([[from as never, 1 - view.scene!.weight], [base as never, view.scene!.weight]], this.presets, view);
    this.deps.renderer()?.setBlend(look as never);
    this.deps.lightmaps()?.setLook(look.lightmap.intensity, look.lightmap.tint);
    this.setWetness(look.wetness);
    if (!blendTouchesLights(base as never, this.presets, view)) {
      lights.restore();
      return;
    }
    lights.applyBlend(base as never, this.presets, view);
  }

  /**
   * The active scene's look laid over the project environment: a new active
   * scene (the view names it) replaces the layer, the drawn environment, the
   * wind and the wetness at once; its blend from the look before is `apply`'s.
   */
  private followActiveScene(view: EnvironmentBlendView | null): void {
    const looks = this.deps.sceneLooks;
    if (looks === null) return;
    const active = view?.scene?.active ?? looks.start;
    if (active === this.layerScene || active === null) return;
    this.layerScene = active;
    this.layer = looks.look(active);
    this.deps.renderer()?.set(this.effective());
    this.deps.materials?.setWind(((this.layer?.wind as WindLike | undefined) ?? this.deps.defaultWind ?? null) as WindLike | null);
    if (!this.blendActive) this.setWetness(this.plainWetness());
  }

  /** The look's own wetness (no blend). */
  private plainWetness(): number {
    return (layerEnvironment(this.value, this.layer) as { wetness?: number } | null)?.wetness ?? 0;
  }

  private setWetness(wetness: number): void {
    this.deps.materials?.setWetness(wetness);
  }
}
