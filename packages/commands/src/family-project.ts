/**
 * Project-wide records: materials, looks, scene planes, light bakes,
 * animators, input, layers, the save schema, modes, behaviour groups, the
 * event cues and the shell. Each op's step and the undo and redo of what it
 * records.
 */

import type { OpFamily } from './op-table-types';
import type { AnimatorController, EnvironmentConfig, InputConfig, LightingBake, MaterialDef, SceneEnvironment } from '@thirdlight/project-model';
import { contentOf } from './content-ops';
import { applyDeleteAnimator, applyDeleteMaterial, applySetAnimator, applySetEnvironment, applySetInput, applySetLighting, applySetMaterial, withAnimator, withEnvironment, withInput, withLighting, withMaterial } from './material-ops';
import { applySetScenePlane } from './scene-plane-ops';
import { applySetCollisionLayers, applySetLightLayers, withCollisionLayers, withLightLayers } from './layer-ops';
import { applySetSaveSchema, withSaveSchema } from './save-schema-ops';
import { applySetBehaviorGroups, applySetEventCues, applySetModes, applySetShell, behaviorGroupsOf, eventCuesOf, modesOf, shellOf, withBehaviorGroups, withEventCues, withModes, withShell } from './mode-ops';
import { bumped, finish, sceneLookTo, scenePlaneTo } from './history-steps';
import { deepClone } from './ops';
import type { ChangeData } from './types';

export const projectFamily = {
  ops: {
    setMaterial: { apply: (input, args) => applySetMaterial(input, args as { material: MaterialDef; assign?: { entityId: string } }), records: [['setMaterial', 'setMaterial']] },
    deleteMaterial: { apply: (input, args) => applyDeleteMaterial(input, args), records: [['setMaterial', 'setMaterial']] },
    setEnvironment: { apply: (input, args) => applySetEnvironment(input, args), records: [['setEnvironment', 'setEnvironment']] },
    setScenePlane: { apply: (input, args) => applySetScenePlane(input, args), records: [['setScenePlane', 'setScenePlane']] },
    setLighting: { apply: (input, args) => applySetLighting(input, args), records: [['setLighting', 'setLighting']] },
    setAnimator: { apply: (input, args) => applySetAnimator(input, args), records: [['setAnimator', 'setAnimator']] },
    deleteAnimator: { apply: (input, args) => applyDeleteAnimator(input, args), records: [['setAnimator', 'setAnimator']] },
    setInput: { apply: (input, args) => applySetInput(input, args), records: [['setInput', 'setInput']] },
    setCollisionLayers: { apply: (input, args) => applySetCollisionLayers(input, args), records: [['setCollisionLayers', 'setCollisionLayers']] },
    setLightLayers: { apply: (input, args) => applySetLightLayers(input, args), records: [['setLightLayers', 'setLightLayers']] },
    setSaveSchema: { apply: (input, args) => applySetSaveSchema(input, args), records: [['setSaveSchema', 'setSaveSchema']] },
    // The game modes (the whole list).
    setModes: { apply: (input, args) => applySetModes(input, args), records: [['setModes', 'setModes']] },
    setBehaviorGroups: { apply: (input, args) => applySetBehaviorGroups(input, args), records: [['setBehaviorGroups', 'setBehaviorGroups']] },
    // The event → cue table (the whole list).
    setEventCues: { apply: (input, args) => applySetEventCues(input, args), records: [['setEventCues', 'setEventCues']] },
    // The game shell (the whole block; null removes it).
    setShell: { apply: (input, args) => applySetShell(input, args), records: [['setShell', 'setShell']] },
  },
  undo: {
    setMaterial: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const now = ((content as { materials?: MaterialDef[] }).materials ?? []).find((m) => m.materialId === inv.materialId);
      const change: ChangeData = { type: 'setMaterial', materialId: inv.materialId, previous: now !== undefined ? deepClone(now) : null, next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withMaterial(content, inv.materialId, inv.restore), change, entry.requestId);
    },
    setScenePlane: (state, entry, inv) => {
      return scenePlaneTo(state, inv.sceneId, inv.restore, entry.requestId);
    },
    setEnvironment: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // One scene's look (the history entry routed the undo to that scene).
      if (inv.sceneId !== undefined) return sceneLookTo(state, inv.sceneId, inv.restore as SceneEnvironment | null, entry.requestId);
      const before = (content as { environment?: EnvironmentConfig }).environment ?? null;
      const change: ChangeData = { type: 'setEnvironment', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withEnvironment(content, inv.restore as EnvironmentConfig | null), change, entry.requestId);
    },
    setModes: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // The game modes back to what they were.
      const before = modesOf(content);
      const change: ChangeData = { type: 'setModes', previous: deepClone(before), next: deepClone(inv.restore) };
      return finish(state, bumped(scene), withModes(content, inv.restore), change, entry.requestId);
    },
    setBehaviorGroups: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = behaviorGroupsOf(content);
      const change: ChangeData = { type: 'setBehaviorGroups', previous: [...before], next: [...inv.restore] };
      return finish(state, bumped(scene), withBehaviorGroups(content, inv.restore), change, entry.requestId);
    },
    setShell: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // The game shell back to what it was.
      const before = shellOf(content);
      const change: ChangeData = { type: 'setShell', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withShell(content, inv.restore), change, entry.requestId);
    },
    setEventCues: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // The event → cue table back to what it was.
      const before = eventCuesOf(content);
      const change: ChangeData = { type: 'setEventCues', previous: deepClone(before), next: deepClone(inv.restore) };
      return finish(state, bumped(scene), withEventCues(content, inv.restore), change, entry.requestId);
    },
    setSaveSchema: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { saveSchema?: import('@thirdlight/project-model').SaveSchema }).saveSchema ?? null;
      const change: ChangeData = { type: 'setSaveSchema', previous: before === null ? null : structuredClone(before), next: inv.restore === null ? null : structuredClone(inv.restore) };
      return finish(state, bumped(scene), withSaveSchema(content, inv.restore), change, entry.requestId);
    },
    setCollisionLayers: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { collisionLayers?: string[] }).collisionLayers ?? [];
      const change: ChangeData = { type: 'setCollisionLayers', previous: [...before], next: [...inv.restore] };
      return finish(state, bumped(scene), withCollisionLayers(content, inv.restore), change, entry.requestId);
    },
    setLightLayers: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { lightLayers?: string[] }).lightLayers ?? [];
      const change: ChangeData = { type: 'setLightLayers', previous: [...before], next: [...inv.restore] };
      return finish(state, bumped(scene), withLightLayers(content, inv.restore), change, entry.requestId);
    },
    setInput: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { input?: InputConfig }).input ?? null;
      const change: ChangeData = { type: 'setInput', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withInput(content, inv.restore), change, entry.requestId);
    },
    setAnimator: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const now = ((content as { animators?: AnimatorController[] }).animators ?? []).find((c) => c.controllerId === inv.controllerId);
      const change: ChangeData = { type: 'setAnimator', controllerId: inv.controllerId, previous: now !== undefined ? deepClone(now) : null, next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withAnimator(content, inv.controllerId, inv.restore), change, entry.requestId);
    },
    setLighting: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = ((content as { lighting?: Record<string, LightingBake> }).lighting ?? {})[inv.sceneId] ?? null;
      const change: ChangeData = { type: 'setLighting', sceneId: inv.sceneId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withLighting(content, inv.sceneId, inv.restore), change, entry.requestId);
    },
  },
  redo: {
    setMaterial: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const now = ((content as { materials?: MaterialDef[] }).materials ?? []).find((m) => m.materialId === f.materialId);
      const change: ChangeData = { type: 'setMaterial', materialId: f.materialId, previous: now !== undefined ? deepClone(now) : null, next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withMaterial(content, f.materialId, f.next), change, entry.requestId);
    },
    setScenePlane: (state, entry, f) => {
      return scenePlaneTo(state, f.sceneId, f.next, entry.requestId);
    },
    setEnvironment: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      if (f.sceneId !== undefined) return sceneLookTo(state, f.sceneId, f.next as SceneEnvironment | null, entry.requestId);
      const before = (content as { environment?: EnvironmentConfig }).environment ?? null;
      const change: ChangeData = { type: 'setEnvironment', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withEnvironment(content, f.next as EnvironmentConfig | null), change, entry.requestId);
    },
    setModes: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = modesOf(content);
      const change: ChangeData = { type: 'setModes', previous: deepClone(before), next: deepClone(f.next) };
      return finish(state, bumped(scene), withModes(content, f.next), change, entry.requestId);
    },
    setBehaviorGroups: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = behaviorGroupsOf(content);
      const change: ChangeData = { type: 'setBehaviorGroups', previous: [...before], next: [...f.next] };
      return finish(state, bumped(scene), withBehaviorGroups(content, f.next), change, entry.requestId);
    },
    setShell: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = shellOf(content);
      const change: ChangeData = { type: 'setShell', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withShell(content, f.next), change, entry.requestId);
    },
    setEventCues: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = eventCuesOf(content);
      const change: ChangeData = { type: 'setEventCues', previous: deepClone(before), next: deepClone(f.next) };
      return finish(state, bumped(scene), withEventCues(content, f.next), change, entry.requestId);
    },
    setSaveSchema: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { saveSchema?: import('@thirdlight/project-model').SaveSchema }).saveSchema ?? null;
      const change: ChangeData = { type: 'setSaveSchema', previous: before === null ? null : structuredClone(before), next: f.next === null ? null : structuredClone(f.next) };
      return finish(state, bumped(scene), withSaveSchema(content, f.next), change, entry.requestId);
    },
    setCollisionLayers: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { collisionLayers?: string[] }).collisionLayers ?? [];
      const change: ChangeData = { type: 'setCollisionLayers', previous: [...before], next: [...f.next] };
      return finish(state, bumped(scene), withCollisionLayers(content, f.next), change, entry.requestId);
    },
    setLightLayers: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { lightLayers?: string[] }).lightLayers ?? [];
      const change: ChangeData = { type: 'setLightLayers', previous: [...before], next: [...f.next] };
      return finish(state, bumped(scene), withLightLayers(content, f.next), change, entry.requestId);
    },
    setInput: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = (content as { input?: InputConfig }).input ?? null;
      const change: ChangeData = { type: 'setInput', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withInput(content, f.next), change, entry.requestId);
    },
    setAnimator: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const now = ((content as { animators?: AnimatorController[] }).animators ?? []).find((c) => c.controllerId === f.controllerId);
      const change: ChangeData = { type: 'setAnimator', controllerId: f.controllerId, previous: now !== undefined ? deepClone(now) : null, next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withAnimator(content, f.controllerId, f.next), change, entry.requestId);
    },
    setLighting: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = ((content as { lighting?: Record<string, LightingBake> }).lighting ?? {})[f.sceneId] ?? null;
      const change: ChangeData = { type: 'setLighting', sceneId: f.sceneId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withLighting(content, f.sceneId, f.next), change, entry.requestId);
    },
  },
} satisfies OpFamily;
