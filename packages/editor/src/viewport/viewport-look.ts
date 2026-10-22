/**
 * The Scene view's look: the lighting mode (the editor's key + fill rig, or
 * the scene's own lights, look and lightmaps as Play shows them), the
 * project environment and bakes, the preset-blend preview, and the project's
 * render settings (LOD tuning, ambient occlusion, occlusion culling,
 * architecture styles). Kept here so an adapter made again (another
 * renderer) is given them all.
 *
 * Browser-only (the scene adapter).
 */
import type { EnvironmentLike, LightingBakeLike, SceneAdapter } from '@thirdlight/three-adapter';
import { AMBIENT_OCCLUSION_DEFAULT, type ArchitectureGraphLike, type ArchitecturePreview, type EnvironmentBlendView, type OcclusionCulling } from '@thirdlight/runtime';
import type { ProjectedEntity } from '../session/projection';
import type { SceneSource } from './scene-source';

export interface ViewportLookHost {
  readonly adapter: () => SceneAdapter;
  readonly source: SceneSource;
  /** The last synced entities. */
  readonly projected: () => readonly ProjectedEntity[];
  readonly requestRender: () => void;
}

export type LightingMode = 'editor' | 'game';

export class ViewportLook {
  /** The project's LOD bias and hysteresis (null: the defaults). */
  private lodTuning: { bias: number; hysteresis: number } | null = null;
  private aoKind: 'off' | 'ssao' | 'gtao' = AMBIENT_OCCLUSION_DEFAULT;
  /** The project's occlusion culling (null: not set, the default). */
  private occlusionCulling: OcclusionCulling | null = null;
  /** The project environment, the bakes and the lighting mode as last set. */
  private environmentValue: EnvironmentLike | null = null;
  private environmentSet = false;
  private bakes: Readonly<Record<string, LightingBakeLike>> | null = null;
  /** Generated architecture's style and preset graphs. */
  private archStyles: readonly ArchitectureGraphLike[] | null = null;
  private lighting: { mode: LightingMode; chosen: boolean } = { mode: 'editor', chosen: false };
  private envPreview: EnvironmentBlendView | null = null;
  private envPreviewTags: ReadonlyMap<string, number> | undefined;
  /** The mode the adapter's look was last set for (null: not yet, or a new adapter). */
  private lookApplied: LightingMode | null = null;

  constructor(private readonly host: ViewportLookHost) {}

  /** What a new adapter is made with (the render settings and architecture as last set). */
  adapterOptions(): { lod?: { bias: number; hysteresis: number }; render: { ambientOcclusion: 'off' | 'ssao' | 'gtao'; fixedScale: true; occlusionCulling?: OcclusionCulling }; architectureStyles?: readonly ArchitectureGraphLike[] } {
    return {
      ...(this.lodTuning !== null ? { lod: this.lodTuning } : {}),
      // The project's AO kind; full resolution whatever the quality level's render scale (the Scene view is for editing).
      render: { ambientOcclusion: this.aoKind, fixedScale: true, ...(this.occlusionCulling !== null ? { occlusionCulling: this.occlusionCulling } : {}) },
      ...(this.archStyles !== null ? { architectureStyles: this.archStyles } : {}),
    };
  }

  /** A new adapter takes the look, the lighting mode and the environment again. */
  adapterReplaced(): void {
    this.lookApplied = null;
    this.applyLightingMode();
    if (this.environmentSet) this.setEnvironment(this.environmentValue);
  }

  get mode(): LightingMode {
    return this.lighting.mode;
  }

  /** The adapter's world, environment, bakes and block layers follow the current state (a new adapter, a lighting mode). */
  private applyLook(): void {
    const adapter = this.host.adapter();
    const game = this.lighting.mode === 'game';
    // The editor rig still draws at the project's quality level (the engine's low: no MSAA).
    const quality = this.environmentValue?.quality;
    const qualityLevels = this.environmentValue?.qualityLevels;
    adapter.setEnvironment?.(game ? this.environmentValue : quality !== undefined || qualityLevels !== undefined ? { ...(quality !== undefined ? { quality } : {}), ...(qualityLevels !== undefined ? { qualityLevels } : {}) } : null);
    adapter.setBakes?.(game ? this.bakes : null);
    adapter.previewEnvironmentBlend?.(game ? this.envPreview : null, this.envPreviewTags);
  }

  setLodTuning(tuning: { bias: number; hysteresis: number }): void {
    if (this.lodTuning !== null && this.lodTuning.bias === tuning.bias && this.lodTuning.hysteresis === tuning.hysteresis) return;
    this.lodTuning = tuning;
    this.host.adapter().setLodTuning?.(tuning);
    this.host.requestRender();
  }

  setAmbientOcclusion(kind: 'off' | 'ssao' | 'gtao'): void {
    if (kind === this.aoKind) return;
    this.aoKind = kind;
    this.host.adapter().setRenderSettings?.({ ambientOcclusion: kind }, 'project');
    this.host.requestRender();
  }

  setOcclusionCulling(mode: OcclusionCulling): void {
    if (mode === this.occlusionCulling) return;
    this.occlusionCulling = mode;
    this.host.adapter().setRenderSettings?.({ occlusionCulling: mode }, 'project');
    this.host.requestRender();
  }

  setArchitectureStyles(graphs: readonly ArchitectureGraphLike[]): void {
    this.archStyles = graphs;
    this.host.adapter().setArchitectureStyles?.(graphs);
    this.host.requestRender();
  }

  previewArchitecture(preview: ArchitecturePreview | null): number {
    const n = this.host.adapter().previewArchitecture?.(preview) ?? 0;
    this.host.requestRender();
    return n;
  }

  setLightmaps(bakes: Readonly<Record<string, LightingBakeLike>> | null): void {
    this.bakes = bakes;
    if (this.lighting.mode === 'game') this.host.adapter().setBakes?.(bakes);
    this.host.requestRender();
  }

  setLighting(mode: LightingMode): void {
    this.lighting = { mode, chosen: true };
    this.applyLightingMode();
  }

  /** Automatic until chosen: game lighting as soon as the scene has a light. */
  applyLightingMode(): void {
    const projected = this.host.projected();
    if (!this.lighting.chosen) this.lighting.mode = projected.some((e) => e.light !== undefined) ? 'game' : 'editor';
    const rig = this.lighting.mode === 'editor';
    if (rig === this.host.source.rigOn && this.lookApplied === this.lighting.mode) return;
    this.lookApplied = this.lighting.mode;
    this.host.source.setRig(rig, projected);
    this.applyLook();
    this.host.requestRender();
  }

  setEnvironment(value: EnvironmentLike | null): void {
    this.environmentValue = value;
    this.environmentSet = true;
    const quality = value?.quality;
    this.host.adapter().setEnvironment?.(this.lighting.mode === 'game' ? value : quality !== undefined ? { quality } : null);
    this.host.requestRender();
  }

  previewEnvironmentBlend(view: { weights: readonly (readonly [string, number])[]; overrides?: EnvironmentBlendView['overrides'] } | null, tagBits?: ReadonlyMap<string, number>): void {
    this.envPreview = view === null ? null : { weights: view.weights, overrides: view.overrides ?? {}, target: null, progress: 1 };
    if (tagBits !== undefined) this.envPreviewTags = tagBits;
    this.host.adapter().previewEnvironmentBlend?.(this.lighting.mode === 'game' ? this.envPreview : null, this.envPreviewTags);
    this.host.requestRender();
  }
}
