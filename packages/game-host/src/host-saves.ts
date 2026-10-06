/**
 * The game host's side of project saves: the save service over the page's
 * storage (IndexedDB slots, the settings document in localStorage, the
 * browser's storage manager), what observers and Play diagnostics see of
 * it, the game shell's save seam and the UI's slot pictures. Kept apart from
 * `host.ts` so the host only wires it in.
 */
import { ambientOcclusionOf, renderScaleOf, type Runtime, type SaveSchema, type SaveStorageInfo, type SettingsFieldValue } from '@thirdlight/runtime';

import type { ShellDeps } from './shell';
import { createProjectSaveService, memoryProjectSaveBackend, type DeviceStorage, type ProjectSaveBackend, type ProjectSaveService, type ProjectSlotObservation, type ThumbnailCapture } from './project-saves';
import type { SaveStorage } from './storage';

/** The project saves as observers see them (a project with a save schema). */
export interface ProjectSavesObservation extends SaveStorageInfo {
  readonly slotCount: number;
  readonly storage: 'indexeddb' | 'memory' | 'unavailable';
  /** Whether persistent storage was asked for (at the first save). */
  readonly persistAsked: boolean;
  /** The first 32 used slots. */
  readonly slots: readonly ProjectSlotObservation[];
  readonly settings: Readonly<Record<string, boolean | number | string>>;
}

export interface HostSavesConfig {
  readonly schema: SaveSchema;
  readonly runtime: Runtime;
  readonly namespace: string;
  readonly backend?: ProjectSaveBackend;
  readonly device?: DeviceStorage;
  readonly settingsStorage?: SaveStorage;
  readonly captureThumbnail: ThumbnailCapture;
  readonly pictureWaits: () => boolean;
  readonly setQuality?: (level: 'low' | 'medium' | 'high') => void;
  readonly setVolume?: (bus: 'music' | 'sfx' | 'ui', value: number) => void;
  /** Apply a player's frame-rate cap (30, 60, 120 or 'none'). */
  readonly setFrameRateCap?: (fps: string) => void;
  /** Apply a player's render settings (AO kind, render scale, dynamic resolution). */
  readonly setRenderSettings?: (settings: { readonly ambientOcclusion?: 'off' | 'ssao' | 'gtao'; readonly renderScale?: number; readonly dynamicResolution?: boolean }) => void;
  /** True once the host is gone (answers are dropped). */
  readonly disposed: () => boolean;
}

/** Start the save service of a mounted game (it reads the slot list at once). */
export function startHostSaves(c: HostSavesConfig): ProjectSaveService {
  const service = createProjectSaveService({
    schema: c.schema,
    backend: c.backend ?? memoryProjectSaveBackend(),
    namespace: c.namespace,
    queue: (event) => {
      if (c.disposed()) return;
      const r = c.runtime.queueSaveEvent?.(event);
      if (r !== undefined && !r.ok) console.warn('[game-host] save answer refused:', r.error.message);
    },
    ...(c.settingsStorage !== undefined ? { settingsStorage: c.settingsStorage } : {}),
    ...(c.device !== undefined ? { device: c.device } : {}),
    captureThumbnail: c.captureThumbnail,
    pictureWaits: c.pictureWaits,
    applyEngine: (binding, value) => {
      if (binding === 'quality') {
        if (value === 'low' || value === 'medium' || value === 'high') c.setQuality?.(value);
      } else if (binding === 'frameRateCap') {
        if (typeof value === 'string') c.setFrameRateCap?.(value);
      } else if (binding === 'ambientOcclusion') {
        const kind = ambientOcclusionOf(value);
        if (kind !== undefined) c.setRenderSettings?.({ ambientOcclusion: kind });
      } else if (binding === 'renderScale') {
        const scale = renderScaleOf(value);
        if (scale !== undefined) c.setRenderSettings?.({ renderScale: scale });
      } else if (binding === 'dynamicResolution') {
        if (typeof value === 'boolean') c.setRenderSettings?.({ dynamicResolution: value });
      } else if (typeof value === 'number') c.setVolume?.(binding, value);
    },
    log: (message) => console.warn(`[game-host] ${message}`),
  });
  void service.start();
  return service;
}

/** The observation of a game's saves (none without a save schema). */
export function savesObservation(service: ProjectSaveService | null, schema: SaveSchema | undefined, settingsNow: Readonly<Record<string, SettingsFieldValue>> | undefined): { saves?: ProjectSavesObservation } {
  if (service === null || schema === undefined) return {};
  return { saves: { slotCount: schema.slots, storage: service.storage, ...service.storageInfo(), persistAsked: service.persistAsked(), slots: service.slots().slice(0, 32), settings: { ...(settingsNow ?? service.settings()) } } };
}

/** The game shell's seam to the saves (null without a save schema). */
export function shellSaves(service: () => ProjectSaveService | null, schema: SaveSchema | undefined, rt: Runtime): ShellDeps['saves'] {
  if (service() === null || schema === undefined) return null;
  return {
    slotCount: schema.slots,
    slots: () => service()?.slots() ?? [],
    save: (slot, meta) => {
      const r = rt.requestSave?.(slot, meta);
      return r === undefined ? 'this runtime cannot save' : r.ok ? null : r.error.message;
    },
    load: (slot) => void service()?.loadSlot(slot),
  };
}

/** What the UI layer needs to show a slot's picture (an image widget's `saveSlot`). */
export function slotPictures(service: () => ProjectSaveService | null): {
  saveThumbnail: (slot: number) => { stamp: string; picture: () => Promise<string | null> } | null;
  saveThumbnailsKey: () => string;
} {
  return {
    saveThumbnail: (slot) => {
      const saves = service();
      const known = saves?.slots().find((s) => s.slot === slot);
      if (saves === null || known?.thumbnail === undefined) return null;
      return { stamp: `${known.savedAt}|${known.bytes}|${known.thumbnail.bytes}`, picture: () => saves.thumbnail(slot) };
    },
    saveThumbnailsKey: () => {
      const saves = service();
      return saves === null ? '' : saves.slots().map((s) => `${s.slot}:${s.savedAt}:${s.thumbnail?.bytes ?? 0}`).join(',');
    },
  };
}
