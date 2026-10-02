/**
 * `ctx.audio` as scripts reach it: the mixer's calls with their arguments
 * checked there, and — for a script on an object — every sound, stinger and
 * music track it starts owned by that object, its scene or nothing (the
 * play's `owner` option). The owner is resolved when the sound starts, so a
 * sound keeps the scene it was started in even if its object moves on.
 */
import { ownerModeOf, type AudioMixer, type AudioOwner, type AudioOwnerMode } from './audio-mixer';
import type { AudioMusicOptions, AudioPlayOptions, AudioStingerOptions, BehaviorAudio } from './types';

/** `ctx.audio` for modules (sounds owned by nothing) and `owned(entityId)` for a script on that object. */
export interface ScriptAudioControl {
  readonly control: BehaviorAudio;
  owned(entityId: string): BehaviorAudio;
}

/**
 * `sceneOf` names the loaded scene an object belongs to (undefined: none, a
 * spawned copy — whose `scene` sounds then go with the copy).
 */
export function createScriptAudio(a: AudioMixer, sceneOf: (entityId: string) => string | undefined): ScriptAudioControl {
  const ownerOf = (entityId: string | null, mode: AudioOwnerMode): AudioOwner | null => {
    if (entityId === null || mode === 'none') return null;
    if (mode === 'scene') {
      const sceneId = sceneOf(entityId);
      if (sceneId !== undefined) return Object.freeze({ sceneId });
    }
    return Object.freeze({ entityId });
  };
  const build = (entityId: string | null): BehaviorAudio =>
    Object.freeze({
      play: (assetId: string, options?: AudioPlayOptions): number => a.play(assetId, options, undefined, ownerOf(entityId, ownerModeOf(options))),
      stop: (handle: number, fadeSeconds?: number): void => a.stop(handle, fadeSeconds),
      fade: (handle: number, to: number, seconds: number): void => a.fade(handle, to, seconds),
      setVolume: (handle: number, volume: number): void => a.setVolume(handle, volume),
      setPitch: (handle: number, pitch: number): void => a.setPitch(handle, pitch),
      setLoop: (handle: number, loop: boolean): void => a.setLoop(handle, loop),
      playing: (handle: number): boolean => a.playing(handle),
      volumeOf: (handle: number): number => a.volumeOf(handle),
      finished: (handle: number): boolean => a.finished(handle),
      events: () => a.events(),
      music: (assetId: string | null, fadeSeconds?: number, options?: AudioMusicOptions): void => a.music(assetId, fadeSeconds, ownerOf(entityId, ownerModeOf(options))),
      releaseMusic: (fadeSeconds?: number): void => a.releaseMusic(fadeSeconds),
      stinger: (assetId: string, options?: AudioStingerOptions): number => a.stinger(assetId, options, ownerOf(entityId, ownerModeOf(options))),
      duck: (level: number, seconds?: number): void => a.duck(level, seconds),
      unduck: (seconds?: number): void => a.unduck(seconds),
      musicState: () => a.musicState(),
      setBusVolume: (bus: 'sfx' | 'music' | 'voice' | 'ui', volume: number, seconds?: number): void => a.setBusVolume(bus, volume, seconds),
      busVolume: (bus: 'sfx' | 'music' | 'voice' | 'ui'): number => a.busVolume(bus),
      stopAll: (bus?: 'sfx' | 'music' | 'voice' | 'ui', fadeSeconds?: number): number => a.stopAll(bus, fadeSeconds),
    });
  return Object.freeze({ control: build(null), owned: (entityId: string) => build(typeof entityId === 'string' && entityId.length > 0 ? entityId : null) });
}
