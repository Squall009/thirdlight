/**
 * What drives the runtime's own channels without a script: the sequencer
 * (`TimelineHost`: the transforms, cameras, animators, audio, effects,
 * visibility, signals, materials, modes, the environment, dialogue and the
 * characters its tracks key) and the event → cue table (the sounds of a
 * step's signals, trigger events and animator clip events).
 *
 * Both go through the same paths scripts use (a timeline's mode switch is
 * `ctx.modes.switch`'s), so a keyed change and a scripted one apply alike.
 */
import type { AnimatorSystem } from './animator-system';
import type { AudioMixer } from './audio-mixer';
import type { GameplayBlocks } from './blocks';
import type { RuntimeCharacters } from './runtime-characters';
import type { DialogueRunner } from './dialogue';
import type { EntityAccess } from './entity-access';
import type { EnvironmentDirector } from './environment-director';
import type { RuntimeMaterials } from './material-params';
import type { ModeState } from './modes';
import type { PresentationRequests } from './presentation-requests';
import type { RuntimeFaults } from './runtime-faults';
import type { RuntimeSim } from './runtime-sim';
import type { blockControls } from './script-controls';
import type { TimelineHost } from './timeline';
import type { RuntimeEventCue } from './types';
import type { RuntimeViews } from './views';

/** The parts the sequencer's tracks key. */
export interface TimelineParts {
  readonly sim: RuntimeSim;
  readonly faults: RuntimeFaults;
  readonly chars: RuntimeCharacters;
  readonly views: RuntimeViews;
  readonly animators: AnimatorSystem;
  readonly audio: AudioMixer;
  readonly presentation: PresentationRequests;
  readonly blocks: () => GameplayBlocks | null;
  readonly signals: ReturnType<typeof blockControls>['signals'];
  readonly materials: RuntimeMaterials;
  readonly entityAccess: EntityAccess;
  readonly modes: ModeState;
  readonly environment: EnvironmentDirector;
  readonly dialogue: DialogueRunner;
}

/** What the sequencer drives — the runtime's own channels. */
export function timelineHostOf(p: TimelineParts): TimelineHost {
  const { sim, chars, views, animators, audio } = p;
  const warn = (message: string): void => p.faults.log('thirdlight.runtime:timeline', 'warn', message);
  return {
    writeTransform: (id, pose) => {
      const t = sim.curr.get(id);
      // A player character turns with a rotation key (its controller too).
      if (t === undefined || chars.director.timelinePose(id, pose)) return t !== undefined;
      // A player controller's body moves with it (as a script's character_place does), onto its plane if it has one.
      const placed = sim.physics3d !== undefined && pose.position !== undefined ? chars.controllers.moveWithTimeline3D(id, pose.position) : null;
      if (placed !== null) pose = { ...pose, position: placed };
      // Its colliders (and its children's) follow it from the next step.
      chars.colliders.timelineMove(id);
      if (pose.position !== undefined) for (let k = 0; k < 3; k += 1) t.position[k] = pose.position[k]!;
      if (pose.rotation !== undefined) for (let k = 0; k < 4; k += 1) t.rotation[k] = pose.rotation[k]!;
      if (pose.scale !== undefined) for (let k = 0; k < 3; k += 1) t.scale[k] = pose.scale[k]!;
      return true;
    },
    cameraOverride: (id, blend) => void views.main.setTimelineOverride(id, blend ?? undefined),
    cameraProgress: (id, progress) => void views.main.set(id, { progress }),
    cameraActivate: (id) => void views.main.activate(id),
    animator: (id) => {
      const m = animators.machine(id);
      if (m === undefined) return null;
      return { set: (name, value) => m.set(name, value), trigger: (name) => m.trigger(name), play: (state, fade, layer) => m.play(state, fade, layer) };
    },
    audio: {
      music: (assetId, fade) => audio.music(assetId, fade),
      releaseMusic: (fade) => audio.releaseMusic(fade),
      stinger: (assetId, volume, maxLateMs) => audio.stinger(assetId, volume !== undefined || maxLateMs !== undefined ? { ...(volume !== undefined ? { volume } : {}), ...(maxLateMs !== undefined ? { maxLateMs } : {}) } : undefined),
      play: (assetId, options) => audio.play(assetId, options),
      stop: (handle, fade) => audio.stop(handle, fade),
      playing: (handle) => audio.playing(handle),
    },
    effects: {
      play: (effectId, options) => p.presentation.effects.play(effectId, options),
      stop: (handle) => p.presentation.effects.stop(handle),
    },
    setVisible: (id, visible) => {
      if (sim.curr.has(id)) p.blocks()?.setVisible(id, visible);
    },
    emitSignal: (name) => p.signals.emit(name),
    signaled: (name) => p.signals.on(name),
    setMaterial: (id, param, value, materialId) => p.materials.api.set(id, param, value, materialId),
    swapMaterials: (id, materials) => p.entityAccess.swapNow(id, materials),
    // The same path as ctx.modes.switch (applies at the next step boundary).
    switchMode: (modeId, transition) => p.modes.request(modeId, transition),
    // The environment track switches presets through ctx.environment's own path.
    environment: { apply: (presetId, blendSeconds) => p.environment.api.set(presetId, blendSeconds > 0 ? { blend: blendSeconds } : {}) },
    // The dialogue track runs a node through the dialogue runner and waits while it runs.
    ...(p.dialogue.enabled ? { dialogue: p.dialogue.timelinePort() } : {}),
    character: chars.director.timelinePort,
    warn,
  };
}

/**
 * Play the cue of every table row a signal or event of this step matches
 * (and last step's animator clip events, which scripts see this step) —
 * each row at most once per step, in table order, through the audio intent
 * log (the host plays it; the simulation never reads it back).
 */
export function playEventCues(cues: readonly RuntimeEventCue[], blocks: GameplayBlocks | null, animators: AnimatorSystem, audio: AudioMixer): void {
  const log = blocks?.takeCueLog() ?? null;
  const clips = animators.events;
  if (log === null && clips.length === 0) return;
  for (const c of cues) {
    let hit = false;
    if (c.on === 'signal') hit = log !== null && log.signals.includes(c.name);
    else {
      hit = log !== null && log.events.some((e) => e.name === c.name && (c.entity === undefined || e.entity === c.entity));
      if (!hit) hit = clips.some((e) => e.name === c.name && (c.entity === undefined || e.entityId === c.entity));
    }
    if (hit) audio.play(c.assetId, { volume: c.volume ?? 1, ...(c.bus !== undefined ? { bus: c.bus } : {}), ...(c.maxLateMs !== undefined ? { maxLateMs: c.maxLateMs } : {}) });
  }
}
