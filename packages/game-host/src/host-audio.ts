/**
 * The game host's sound: what it plays each frame and what it has the
 * audio owner load ahead.
 *
 * Each frame it runs the simulation's audio commands (scripts, event cues,
 * dialogue voices, timelines), places the listener and positional voices,
 * and keeps the audio sources' loops going. What is loaded ahead, and for
 * how long, follows the files' load settings (see audio-loading.ts):
 *
 * - a scene's files marked to preload are held by the scene (`scene:<id>`)
 *   from when it is loaded until it unloads; the project-wide blocks' (event
 *   cues, timelines, the shell) for the whole play (`project`);
 * - a file played without being preloaded is kept from its first play for
 *   the scenes loaded then (the owner's scope);
 * - a running conversation's next lines' voices, on every path a few lines
 *   deep, are held by the conversation (`dialogue:<n>`), and the lines that
 *   may come next decoded, so a line's voice starts with the line.
 *
 * Nothing is read when the game mounts: the start scenes' and the project's
 * files are read after it, while the first frames draw.
 */
import { dialogueVoicesAhead, type Runtime, type RuntimeDialogueData } from '@thirdlight/runtime';

import type { AudioSpatialLike, GameAudioOwner } from './audio';

/** One audio file a scene or the project names, with its preload setting. */
export interface AudioRow {
  readonly assetId: string;
  readonly preload: boolean;
}

export interface HostAudioConfig {
  readonly audio: GameAudioOwner;
  readonly snapshot: { readonly scene: { readonly entities: readonly { readonly id: string; readonly components?: unknown }[] }; readonly dialogue?: RuntimeDialogueData };
  /** Audio sources in the panner model (the project's `audio_spatial`). */
  readonly panner: boolean;
  /** The audio files a scene names (its dependency list; absent: the build lists none per scene). */
  readonly sceneAudio?: (sceneId: string) => Promise<readonly AudioRow[]>;
  /** The audio files the project-wide blocks name (held for the whole play when preloaded). */
  readonly projectAudio?: () => Promise<readonly AudioRow[]>;
  /** One entity's interpolated transform into `out`. */
  readonly readTransform: (rt: Runtime, id: string, out: { position: number[]; rotation: number[]; scale: number[] }) => boolean;
  readonly live: () => boolean;
}

export interface HostAudio {
  /** The game mounted: the project's preloaded files are read (in the background). */
  start(): void;
  /** Once per frame, after the step: commands, listener, loops, scenes loaded, dialogue read ahead. */
  frame(rt: Runtime): void;
  /** The audio sources' live loops (observation). */
  hasLoops(): boolean;
  /** Stop what this host started and let go of what it held. */
  dispose(): void;
}

type Transform = { position: number[]; rotation: number[]; scale: number[] };
const at = (): Transform => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

export function createHostAudio(config: HostAudioConfig): HostAudio {
  const audio = config.audio;
  const playerAt = at();
  const sourceAt = at();
  const spatialAt = at();
  const listenerAt = at();
  let cameraEntityId: string | null | undefined;
  /** The character (the first controller entity; null: none) — the legacy audio-source model hears from it. */
  let characterId: string | null | undefined;

  /** The loaded audio sources (recomputed when the scene set changes). */
  let sourcesRevision = -1;
  let sources: { id: string; assetId: string; volume: number; range: number; spatial: AudioSpatialLike }[] = [];
  const liveLoops = new Set<string>();

  /** The scenes whose preloaded files are held (scene id → its holder). */
  const heldScenes = new Set<string>();
  const sceneHolder = (sceneId: string): string => `scene:${sceneId}`;

  /** The conversation's read-ahead: where it was, and the holder of what it read. */
  let dialogueAt = '';
  let dialogueSerial = 0;
  let dialogueHolder: string | null = null;

  const scenesChanged = (loaded: readonly string[]): void => {
    const now = new Set(loaded);
    for (const id of [...heldScenes]) {
      if (now.has(id)) continue;
      heldScenes.delete(id);
      audio.releaseAudio?.(sceneHolder(id));
    }
    for (const id of loaded) {
      if (heldScenes.has(id)) continue;
      heldScenes.add(id);
      const holder = sceneHolder(id);
      void config.sceneAudio?.(id).then(
        (rows) => {
          // Unloaded meanwhile: nothing is held for it.
          if (!config.live() || !heldScenes.has(id)) return;
          for (const r of rows) if (r.preload) audio.holdAudio?.(r.assetId, holder);
        },
        () => undefined,
      );
    }
    // A sound first played now is kept while one of these scenes is loaded.
    audio.setAudioScope?.(loaded.map(sceneHolder));
  };

  const serviceAudioSources = (rt: Runtime): void => {
    if (audio.setLoop === undefined) return;
    const set = rt.sceneSet?.();
    const revision = set?.revision ?? 0;
    if (revision !== sourcesRevision) {
      sourcesRevision = revision;
      const loaded = set !== undefined && set.batches.length > 0 ? set.batches.flatMap((b) => b.entities) : config.snapshot.scene.entities;
      // A spawned copy's audio source plays too.
      const entities = [...loaded, ...((set?.spawned ?? []) as unknown as typeof loaded)];
      sources = [];
      for (const e of entities) {
        const a = ((e.components ?? {}) as unknown as { audioSource?: { assetId: string; volume: number; range: number; distanceModel?: AudioSpatialLike['distanceModel']; refDistance?: number; rolloff?: number } }).audioSource;
        // The panner model's distance fade — the range is its max distance; absent fields keep the
        // legacy curve's shape (linear from a quarter of the range).
        if (a !== undefined) sources.push({ id: e.id, assetId: a.assetId, volume: a.volume, range: a.range, spatial: { distanceModel: a.distanceModel ?? 'linear', refDistance: Math.min(a.range, a.refDistance ?? a.range / 4), maxDistance: a.range, rolloff: a.rolloff ?? 1 } });
      }
    }
    if (sources.length === 0 && liveLoops.size === 0) return;
    // Only the character and the sources are read (no per-frame copy of every transform).
    characterId ??= config.snapshot.scene.entities.find((e) => ((e.components ?? {}) as Record<string, unknown>)['controller'] !== undefined)?.id ?? null;
    const player = characterId !== null && config.readTransform(rt, characterId, playerAt) ? playerAt : undefined;
    const seen = new Set<string>();
    // A switched-off object's audio source is silent (it plays again when switched on).
    const off = rt.inactiveEntities?.();
    for (const s of sources) {
      if (off !== undefined && off.size > 0 && off.has(s.id)) continue;
      if (!config.readTransform(rt, s.id, sourceAt)) continue;
      const t = sourceAt;
      if (config.panner && audio.setSpatialLoop !== undefined) {
        // A panner per source; the listener is the active camera (spatialFrame).
        audio.setSpatialLoop(s.id, s.assetId, s.volume, t.position, s.spatial);
        seen.add(s.id);
        liveLoops.add(s.id);
        continue;
      }
      const dx = player !== undefined ? Math.abs(t.position[0]! - player.position[0]!) : 0;
      const near = s.range / 4;
      const gain = s.volume * Math.max(0, Math.min(1, 1 - (dx - near) / Math.max(1e-6, s.range - near)));
      audio.setLoop(s.id, s.assetId, gain);
      seen.add(s.id);
      liveLoops.add(s.id);
    }
    for (const id of [...liveLoops]) {
      if (seen.has(id)) continue;
      audio.setLoop(id, null, 0);
      liveLoops.delete(id);
    }
  };

  /** The listener: the active camera — the resolved virtual camera, else the scene camera. */
  const listenerOf = (rt: Runtime): { position: readonly number[]; rotation: readonly number[] } | null => {
    if (rt.readCameraView?.(listenerAt.position, listenerAt.rotation) != null) return listenerAt;
    cameraEntityId ??= config.snapshot.scene.entities.find((e) => ((e.components ?? {}) as Record<string, unknown>)['camera'] !== undefined)?.id ?? null;
    if (cameraEntityId !== null && config.readTransform(rt, cameraEntityId, listenerAt)) return listenerAt;
    return null;
  };

  /** The scenes loaded changed: their preloaded files are held, those of scenes gone let go. */
  let scenesRevision = -1;
  const serviceScenes = (rt: Runtime): void => {
    const set = rt.sceneSet?.();
    if (set === undefined || set.revision === scenesRevision) return;
    scenesRevision = set.revision;
    if (set.batches.length > 0) scenesChanged(set.batches.map((b) => b.sceneId));
  };

  /** Script sounds: execute the simulation's audio commands (the owner loads each file by its load type). */
  const serviceScriptAudio = (rt: Runtime): void => {
    const commands = rt.takeAudioRequests?.() ?? [];
    for (const c of commands) {
      if (audio.command !== undefined) audio.command(c);
      else if (c.op === 'play') audio.playSound?.(c.assetId, c.volume);
    }
    if (audio.spatialFrame !== undefined) audio.spatialFrame(listenerOf(rt), (entityId) => (config.readTransform(rt, entityId, spatialAt) ? spatialAt.position : null));
  };

  /** A running conversation's next voices are held; they move on with it and go when it ends. */
  const serviceDialogue = (rt: Runtime): void => {
    const data = config.snapshot.dialogue;
    if (data === undefined || audio.holdAudio === undefined) return;
    const d = (rt.uiView?.().model as { dialogue?: { active?: unknown; dialogueId?: unknown; node?: unknown } } | undefined)?.dialogue;
    const active = d !== undefined && d.active === true && typeof d.dialogueId === 'string' && typeof d.node === 'string';
    const where = active ? `${d.dialogueId as string}/${d.node as string}` : '';
    if (where === dialogueAt) return;
    dialogueAt = where;
    const before = dialogueHolder;
    dialogueHolder = null;
    if (active) {
      dialogueSerial += 1;
      dialogueHolder = `dialogue:${dialogueSerial}`;
      // Held under the new holder before the old one lets go: the voices still ahead are kept, not read again.
      // The lines that may come next are decoded too, so their voices start with them.
      for (const v of dialogueVoicesAhead(data, d.dialogueId as string, d.node as string)) audio.holdAudio(v.voice, dialogueHolder, v.depth === 0);
    }
    if (before !== null) audio.releaseAudio?.(before);
  };

  return {
    start() {
      void config.projectAudio?.().then(
        (rows) => {
          if (!config.live()) return;
          for (const r of rows) if (r.preload) audio.holdAudio?.(r.assetId, 'project');
        },
        () => undefined,
      );
    },
    frame(rt) {
      serviceScenes(rt);
      serviceScriptAudio(rt);
      serviceAudioSources(rt);
      serviceDialogue(rt);
    },
    hasLoops() {
      return liveLoops.size > 0;
    },
    dispose() {
      // What this host started on the wrapper-owned audio owner stops with
      // it — the loops of audio sources — so a new composition on the same
      // owner (a new Play snapshot) does not keep the old one's loops playing.
      if (audio.setLoop !== undefined) {
        for (const id of liveLoops) {
          try {
            audio.setLoop(id, null, 0);
          } catch {
            /* a closed context: nothing plays */
          }
        }
      }
      liveLoops.clear();
      // And the scripts' sounds, music hold, duck and mix.
      try {
        audio.command?.({ op: 'reset', stepIndex: 0 });
      } catch {
        /* a closed context: nothing plays */
      }
      for (const id of heldScenes) audio.releaseAudio?.(sceneHolder(id));
      heldScenes.clear();
      if (dialogueHolder !== null) audio.releaseAudio?.(dialogueHolder);
      dialogueHolder = null;
      audio.releaseAudio?.('project');
    },
  };
}
