/**
 * Phase 15.1: the generic Inspector against the real descriptor registry and
 * the real command layer, on a neutral v4 fixture (a camera, two lights, two
 * boxes, an empty object):
 *
 * - every descriptor field (components and content blocks, nested) has a
 *   widget;
 * - every component "+ Add component" offers without a choice is added with
 *   its descriptor value, and every preset too — one `setComponent` each;
 * - every editable field of every added component (top level and one nested
 *   object deep) is edited through the Inspector's `componentPatch` — one
 *   command, accepted — and one undo restores the component exactly;
 * - removing each component is one command and one undo brings it back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DESCRIPTORS, validateContentV4, validateSceneV4, type FieldDescriptor, type ObjectFieldDescriptor } from '@thirdlight/project-model';
import { applyMutation, createCommandState, type CommandState, type ContentDocument } from '@thirdlight/commands';
import { addEntries, componentPatch, firstReference, normalize, seedsOf, visibleFields, widgetFor, type FieldPath } from '@thirdlight/editor/descriptor-fields';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type State = CommandState<Any>;

const DIR = join(__dirname, '..', '..', '..', 'fixtures', 'commands', 'scenarios', '01-retry-lost-ack', 'disk-before');

function fresh(): State {
  const sceneFile = JSON.parse(readFileSync(join(DIR, 'scenes', 'scene-main.json'), 'utf8')) as { scene: unknown };
  const contentFile = JSON.parse(readFileSync(join(DIR, 'content.json'), 'utf8')) as { revision: number; content: unknown };
  const scene = validateSceneV4(sceneFile.scene);
  const content = validateContentV4(contentFile.content);
  if (!scene.ok || !content.ok) throw new Error('fixture invalid');
  return createCommandState({ ...scene.normalized, revision: Math.max(scene.normalized.revision, contentFile.revision) }, content.normalized as unknown as ContentDocument) as State;
}

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Any } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: 'demo-0003', expectedRevision: state.scene.revision, requestId: `req-${(0x15f00000 + counter).toString(16).padStart(32, '0')}`, args });
  return { ok: out.ok, state: (out as { state?: State }).state ?? state, result: out.result };
}
function must(state: State, op: string, args: Record<string, unknown>, what: string): State {
  const r = run(state, op, args);
  expect(r.ok, `${what}: ${JSON.stringify(r.result)}`).toBe(true);
  return r.state;
}
const componentsOf = (s: State, id: string): Record<string, unknown> => s.scene.entities.find((e: Any) => e.id === id)!.components;

/** A different valid value for a field, or undefined when it has no simple one (references, lists, maps). */
function nudge(f: FieldDescriptor, current: unknown): unknown {
  switch (f.type) {
    case 'number':
    case 'int': {
      if (f.type === 'int' && f.values !== undefined && f.values.length > 1) {
        // A choice of numbers (the step rate): another allowed value.
        const now = current ?? f.default;
        return f.values.find((v) => v !== now);
      }
      const step = f.type === 'int' ? 1 : f.step ?? 0.1;
      const c = typeof current === 'number' ? current : typeof f.default === 'number' ? f.default : f.min ?? 0;
      let n = c + step;
      if (f.max !== undefined && (n > f.max || (f.type === 'number' && f.maxExclusive === true && n >= f.max))) n = c - step;
      if (f.min !== undefined && n < f.min) n = f.min;
      if (f.type === 'number' && f.nonZero === true && n === 0) n = step;
      return Number(n.toFixed(6));
    }
    case 'bool':
      return !(current ?? f.default ?? false);
    case 'enum': {
      const now = current ?? f.default;
      return f.options.find((o) => o.value !== now)?.value;
    }
    case 'color':
      return current === '#123456' ? '#654321' : '#123456';
    case 'vec2':
    case 'vec3': {
      const n = f.type === 'vec2' ? 2 : 3;
      const c = Array.isArray(current) ? (current as number[]) : Array.isArray(f.default) ? (f.default as number[]) : new Array(n).fill(0);
      const step = f.step ?? 0.1;
      return c.map((v, i) => {
        if (i !== 0) return v;
        let x = v + step;
        if (f.max !== undefined && x > f.max) x = v - step;
        return Number(x.toFixed(6));
      });
    }
    case 'signal':
    case 'string':
      return f.format === 'counter' || f.format === 'identifier' || f.type === 'signal' ? 'edited_value' : 'Edited value';
    default:
      return undefined;
  }
}

describe('the generic Inspector over the real registry', () => {
  it('has a widget for every field of every component and content block', () => {
    const seen = new Set<string>();
    const walk = (f: FieldDescriptor): void => {
      const w = widgetFor(f);
      expect(w, `${f.key} (${f.type})`).toBeTruthy();
      seen.add(w);
      if (f.type === 'object') f.fields.forEach(walk);
      if (f.type === 'list') walk(f.item);
      if (f.type === 'map') walk(f.value);
    };
    for (const c of DESCRIPTORS.components) walk(c.value);
    for (const b of DESCRIPTORS.content) walk(b.value);
    for (const w of ['number', 'int', 'bool', 'enum', 'vector', 'euler', 'color', 'asset', 'entity', 'scene', 'ref', 'signal', 'text', 'multiline', 'object', 'list', 'map', 'readonly']) expect(seen, w).toContain(w);
  });

  it('adds every menu component (and preset) with its descriptor value, edits each field in one undoable command, removes it', () => {
    const entries = [
      ...addEntries(DESCRIPTORS, new Set(['transform'])).filter((e) => e.enabled && e.pick.length === 0),
      // Camera follow belongs on the camera (added to the fixture's camera below).
      ...addEntries(DESCRIPTORS, new Set(['transform', 'camera'])).filter((e) => e.enabled && e.component === 'cameraFollow'),
    ];
    const needs = (name: string): string | undefined => DESCRIPTORS.components.find((c) => c.name === name)?.requiresAnyOf?.components.find((x) => x !== 'model' && x !== 'instances');
    const edited: string[] = [];
    expect(entries.length).toBeGreaterThan(15);
    for (const entry of entries) {
      let s = fresh();
      // Room for any light type and a camera anywhere: the fixture's own lights and camera go.
      for (const id of ['light-0001', 'light-0002']) s = must(s, 'deleteEntity', { entityId: id }, `delete ${id}`);
      if (entry.component === 'camera') s = must(s, 'setComponent', { entityId: 'cam-main', component: 'camera', value: null }, 'remove the fixture camera');
      // A spawn a checkpoint zone can name.
      s = must(s, 'createEntity', { kind: 'group', name: 'Spawn', components: { playerSpawn: {} } }, 'create a spawn');
      let target: string;
      if (entry.component === 'cameraFollow') target = 'cam-main';
      else {
        const created = run(s, 'createEntity', { kind: 'group', name: entry.label });
        expect(created.ok).toBe(true);
        s = created.state;
        target = String(created.result.createdId);
        const pre = needs(entry.component);
        if (pre !== undefined && pre !== 'camera') s = must(s, 'setComponent', { entityId: target, component: pre, value: addValueOf(pre) }, `${entry.label}: add ${pre}`);
      }
      s = must(s, 'setComponent', { entityId: target, component: entry.component, value: entry.value as Record<string, unknown> }, `add ${entry.label}`);

      // Every editable field: one command, accepted; one undo restores the component.
      const desc = DESCRIPTORS.components.find((c) => c.name === entry.component)!.value as ObjectFieldDescriptor;
      const paths: FieldPath[] = [];
      const value0 = componentsOf(s, target)[entry.component] as Record<string, unknown>;
      for (const f of visibleFields({ desc, value: value0 })) {
        if (f.readOnly === true) continue;
        if (f.type === 'object') {
          // An absent optional object (the player's capsule, camera bounds) is created by editing one of its fields.
          for (const g of visibleFields({ desc: f, value: (value0[f.key] ?? {}) as Record<string, unknown>, parent: { desc, value: value0 } })) if (g.readOnly !== true) paths.push([f.key, g.key]);
        } else paths.push([f.key]);
      }
      for (const path of paths) {
        const before = componentsOf(s, target)[entry.component] as Record<string, unknown>;
        let f: FieldDescriptor | undefined = desc;
        let cur: unknown = before;
        for (const p of path) {
          f = (f as ObjectFieldDescriptor).fields.filter((x) => x.key === p).find((x) => visibleFields({ desc: f as ObjectFieldDescriptor, value: (cur ?? {}) as Record<string, unknown> }).includes(x));
          cur = (cur as Record<string, unknown> | undefined)?.[String(p)];
        }
        if (f === undefined) continue;
        const next = nudge(f, cur);
        if (next === undefined) continue;
        const pickers = { assets: [], scenes: [], refs: {}, entities: s.scene.entities.map((e: Any) => ({ id: e.id, name: e.name ?? e.id, components: Object.keys(e.components) })) };
        const patch = componentPatch(desc, before, path, next, { seeds: seedsOf(DESCRIPTORS.components.find((c) => c.name === entry.component)!), pick: (g) => firstReference(g, pickers) });
        if (patch === null) continue;
        const r = run(s, 'setComponent', { entityId: target, component: entry.component, value: patch });
        expect(r.ok, `${entry.label} ${path.join('/')} = ${JSON.stringify(next)} → ${JSON.stringify(patch)}: ${JSON.stringify(r.result.error ?? r.result)}`).toBe(true);
        edited.push(`${entry.component}.${path.join('.')}`);
        const undone = must(r.state, 'undo', {}, `undo ${entry.label} ${path.join('/')}`);
        expect(componentsOf(undone, target)[entry.component], `${entry.label} ${path.join('/')} undo`).toEqual(before);
      }

      // Remove: one command; one undo brings it back.
      const kept = componentsOf(s, target)[entry.component];
      const removed = must(s, 'setComponent', { entityId: target, component: entry.component, value: null }, `remove ${entry.label}`);
      expect(componentsOf(removed, target)[entry.component]).toBeUndefined();
      const back = must(removed, 'undo', {}, `undo remove ${entry.label}`);
      expect(componentsOf(back, target)[entry.component]).toEqual(kept);
    }
    // The edits reached the fields a designer tunes.
    for (const k of ['box.size', 'camera.fovY', 'camera.near', 'camera.far', 'light.type', 'light.intensity', 'trigger.shape', 'enemy.patrol', 'controller.capsule.radius', 'fogVolume.density', 'cameraFollow.deadZone.x', 'gameZone.role'])
      expect(edited, k).toContain(k);
  });
});

describe('content blocks edited from their descriptors (15.3 fields included)', () => {
  it('edits every settings field in one setSettings each, undoable', () => {
    const desc = DESCRIPTORS.content.find((b) => b.key === 'settings')!.value as ObjectFieldDescriptor;
    const s = fresh();
    const edited: string[] = [];
    for (const f of desc.fields) {
      const next = nudge(f, (s.content as Any).settings?.[f.key]);
      expect(next, f.key).not.toBeUndefined();
      const r = run(s, 'setSettings', { settings: { [f.key]: next } });
      expect(r.ok, `${f.key} = ${JSON.stringify(next)}: ${JSON.stringify(r.result.error ?? r.result)}`).toBe(true);
      expect((r.state.content as Any).settings[f.key], f.key).toBe(next);
      const undone = must(r.state, 'undo', {}, `undo ${f.key}`);
      expect((undone.content as Any).settings, `${f.key} undo`).toEqual((s.content as Any).settings);
      edited.push(f.key);
    }
    for (const k of ['gravity_y', 'fixed_step_hz', 'audio_voices', 'music_fade_s', 'animation_crossfade_s']) expect(edited, k).toContain(k);
  });

  it('edits every number field of the v4 game block (session timing included) in one setGameConfig each', () => {
    const desc = DESCRIPTORS.content.find((b) => b.key === 'game')!.value as ObjectFieldDescriptor;
    let s = fresh();
    // A complete block: the descriptor's starting values and a player, the camera and a spawn.
    s = must(s, 'createEntity', { kind: 'group', name: 'Spawn', components: { playerSpawn: {} } }, 'create a spawn');
    const spawnId = String(s.scene.entities.find((e: Any) => e.components.playerSpawn !== undefined).id);
    const player = run(s, 'createEntity', { kind: 'group', name: 'Player', components: { controller: {} } });
    expect(player.ok, JSON.stringify(player.result)).toBe(true);
    s = player.state;
    const playerId = String(player.result.createdId);
    s = must(s, 'setComponent', { entityId: 'cam-main', component: 'cameraFollow', value: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } }, 'camera follow');
    let game = (s.content as Any).game;
    if (game === null || game === undefined) {
      const block = normalize(desc, { playerId, cameraId: 'cam-main', spawnId });
      const created = run(s, 'setGameConfig', { game: block });
      expect(created.ok, JSON.stringify(created.result.error ?? created.result)).toBe(true);
      s = created.state;
      game = (s.content as Any).game;
    }
    const edited: string[] = [];
    for (const f of visibleFields({ desc, value: game })) {
      if (f.readOnly === true || (f.type !== 'number' && f.type !== 'int')) continue;
      const before = (s.content as Any).game;
      const patch = componentPatch(desc, before, [f.key], nudge(f, before[f.key]), {});
      expect(patch, f.key).not.toBeNull();
      const r = run(s, 'setGameConfig', { game: patch });
      expect(r.ok, `${f.key}: ${JSON.stringify(r.result.error ?? r.result)}`).toBe(true);
      const undone = must(r.state, 'undo', {}, `undo ${f.key}`);
      expect((undone.content as Any).game, `${f.key} undo`).toEqual(before);
      edited.push(f.key);
    }
    for (const k of ['respawnDelay', 'dropThroughTime', 'settleTime']) expect(edited, k).toContain(k);
  });
});

function addValueOf(name: string): Record<string, unknown> {
  const add = DESCRIPTORS.components.find((c) => c.name === name)!.add;
  return add.kind === 'menu' || add.kind === 'pick' ? (JSON.parse(JSON.stringify(add.value)) as Record<string, unknown>) : {};
}
