/**
 * The light volume's settings at a level (voxel-light-volume.ts reads them each frame; its tier's, project-model's
 * `LIGHTING_TIER_SETTINGS`), and the page flag that lays values over them for a comparison
 * (`?voxelVolume=followWindow:8,outerSettle:4`: one build, two settings, measured in turn; never a product setting).
 */
import { levelLighting, type QualityLevelConfig, type VoxelLightVolumeSettings } from '@thirdlight/project-model';
import { pageSearch } from './renderer-factory';

/** What the volume's update does at a level: its tier's (project-model `VoxelLightVolumeSettings`), a switch as 0 or 1. */
export type VolumeSettings = { readonly [K in keyof VoxelLightVolumeSettings]: number };

/** A tier's settings as the volume reads them (its switches as 0 or 1). */
export function volumeSettingsOf(v: VoxelLightVolumeSettings): VolumeSettings {
  return { ...v, reachCoarse: v.reachCoarse ? 1 : 0, enabled: v.enabled ? 1 : 0 };
}

/** The page flag naming values laid over the settings. */
export const VOLUME_SETTINGS_URL_PARAM = 'voxelVolume';

/** `base` with the values a flag (`key:value,…`; unknown keys and negative values ignored; a follow window of 0 restarts on every step of the light, as a jump) names laid over it. */
export function volumeSettingsWithFlag(base: VolumeSettings, flag: string | null): VolumeSettings {
  if (flag === null || flag === '') return base;
  const out: Record<string, number> = { ...(base as unknown as Record<string, number>) };
  for (const part of flag.split(',')) {
    const [k, v] = part.split(':');
    const n = Number(v);
    if (k !== undefined && k in out && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out as unknown as VolumeSettings;
}

/** The page's flag (read once by the volume). */
export function volumeSettingsFlag(): string | null {
  return new URLSearchParams(pageSearch()).get(VOLUME_SETTINGS_URL_PARAM);
}

/** A flag's ms for the live light's share (`liveMs`) or its share while refining (`idleMs`), or null: the budget table's. */
export function volumeShareFromFlag(flag: string | null, key: 'liveMs' | 'idleMs'): number | null {
  for (const part of (flag ?? '').split(',')) {
    const [k, v] = part.split(':');
    const n = Number(v);
    if (k === key && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The settings a volume runs with at a level: the tier's, with the page's flag (read once) laid over them. */
export class VolumeTuning {
  private readonly flag = volumeSettingsFlag();

  at(level: QualityLevelConfig | null): VolumeSettings {
    return volumeSettingsWithFlag(volumeSettingsOf(levelLighting(level ?? { lighting: 'low' }).voxelLightVolume), this.flag);
  }

  /** The update's GPU ms a frame: the live light's share (`table`, the budget's) or the flag's, and the same while it only refines. */
  share(key: 'liveMs' | 'idleMs', table: number): number {
    return volumeShareFromFlag(this.flag, key) ?? table;
  }
}
