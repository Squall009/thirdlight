/**
 * Phase 14.6: animator override layers (validation and canonical form),
 * animation-only model assets (`clipsFor`), and the migration of the old
 * `modelAnimation` profile into an animator controller.
 */
import { describe, expect, it } from 'vitest';

import { canonicalAnimatorController, validateAnimatorController, type AnimatorController } from './animator';
import { glbClipDurations, migrateModelAnimations } from './animator-migrate';
import { validateContentV3, validateContentV4 } from './content';
import type { ModelErrorV2 } from './errors';
import type { ContentCatalogV4, SceneV4 } from './types-v3';

const SAMPLE_RAW = Object.values(
  import.meta.glob('../../../samples/beacon-reach/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
)[0] as string;
const SAMPLE = JSON.parse(SAMPLE_RAW) as { content: { assets: { assetId: string; kind: string; displayName: string }[] } };
const MODEL = SAMPLE.content.assets.find((a) => a.kind === 'model')!;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

const clip = (name: string) => ({ assetId: 'rig-0001', clip: name, duration: 1 });
function layered(layerExtra: Record<string, unknown> = {}): AnimatorController {
  return {
    controllerId: 'hero',
    name: 'Hero',
    parameters: [
      { name: 'speed', type: 'float', default: 0 },
      { name: 'attack', type: 'trigger' },
      { name: 'aim', type: 'float', default: 1 },
    ],
    states: [
      { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip('idle') }, speed: 1, loop: true },
      { id: 'run', name: 'Run', motion: { kind: 'clip', clip: clip('run') }, speed: 1, loop: true },
    ],
    transitions: [{ from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.1 }], duration: 0.1 }],
    entry: 'idle',
    events: [],
    layers: [
      {
        name: 'Upper body',
        mask: ['spine', 'arm_l', 'arm_r'],
        weight: 1,
        weightParameter: 'aim',
        states: [
          { id: 'none', name: 'None', motion: { kind: 'empty' }, speed: 1, loop: true },
          { id: 'attack', name: 'Attack', motion: { kind: 'clip', clip: clip('attack') }, speed: 1, loop: false },
        ],
        transitions: [
          { from: 'none', to: 'attack', conditions: [{ parameter: 'attack', op: 'trigger' }], duration: 0.05 },
          { from: 'attack', to: 'none', conditions: [], duration: 0.1, exitTime: 1 },
        ],
        entry: 'none',
        ...layerExtra,
      } as never,
    ],
  };
}
const errorsOf = (c: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateAnimatorController(c, '', errors);
  return errors;
};

describe('animator override layers', () => {
  it('accepts a controller with an upper-body layer, and canonicalizes it field by field', () => {
    const c = layered();
    expect(errorsOf(c)).toEqual([]);
    const canon = canonicalAnimatorController(JSON.parse(JSON.stringify(c)) as AnimatorController);
    expect(canon.layers).toEqual(c.layers);
    // A controller without layers keeps its exact old form (no layers key).
    const { layers: _l, ...one } = c;
    expect(Object.keys(canonicalAnimatorController(one as AnimatorController))).not.toContain('layers');
  });

  it('refuses bad layers', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['a transition to another layer\'s state', { transitions: [{ from: 'none', to: 'run', conditions: [], duration: 0, exitTime: 1 }] }],
      ['an entry in another layer', { entry: 'idle' }],
      ['a state id used by the base layer', { states: [{ id: 'idle', name: 'x', motion: { kind: 'empty' }, speed: 1, loop: true }], transitions: [], entry: 'idle' }],
      ['a weight above 1', { weight: 1.5 }],
      ['a weight parameter that is not a float', { weightParameter: 'attack' }],
      ['a duplicate bone', { mask: ['spine', 'spine'] }],
      ['an empty bone name', { mask: [''] }],
      ['an unknown key', { blend: 'additive' }],
    ];
    for (const [why, extra] of cases) expect(errorsOf(layered(extra)).length, why).toBeGreaterThan(0);
    // Empty motion only in override layers.
    const base = layered();
    expect(errorsOf({ ...base, states: [...base.states, { id: 'rest', name: 'Rest', motion: { kind: 'empty' }, speed: 1, loop: true }] }).length).toBeGreaterThan(0);
    // At most three override layers; an empty list is refused (absent = none).
    const l = base.layers![0]!;
    const renamed = (n: number) => ({ ...l, states: l.states.map((s) => ({ ...s, id: `${s.id}-${n}` })), transitions: l.transitions.map((t) => ({ ...t, from: `${t.from}-${n}`, to: `${t.to}-${n}` })), entry: `${l.entry}-${n}` });
    expect(errorsOf({ ...base, layers: [renamed(1), renamed(2), renamed(3)] })).toEqual([]);
    expect(errorsOf({ ...base, layers: [renamed(1), renamed(2), renamed(3), renamed(4)] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...base, layers: [] }).length).toBeGreaterThan(0);
  });
});

const content = (assets: unknown[], extra: Record<string, unknown> = {}) => ({
  assets,
  prefabs: [],
  behaviors: [],
  settings: {},
  behaviorTrust: { entries: [] },
  game: null,
  scenes: [{ sceneId: 'scene-a', name: 'A' }],
  startScenes: ['scene-a'],
  ...extra,
});

describe('animation-only model assets (clipsFor)', () => {
  const rig = { ...MODEL };
  const anims = { ...MODEL, assetId: 'anims-0001', displayName: 'Anims', clipsFor: MODEL.assetId };

  it('a model may hold clips for another model\'s rig; the field survives canonicalization', () => {
    const r = validateContentV4(content([rig, anims]));
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (r.ok) expect((r.normalized.assets.find((a) => a.assetId === 'anims-0001') as { clipsFor?: string }).clipsFor).toBe(MODEL.assetId);
  });

  it('refuses itself, a missing rig, a chain of clips-only assets and v3 content', () => {
    expect(validateContentV4(content([rig, { ...anims, clipsFor: 'anims-0001' }])).ok).toBe(false);
    expect(validateContentV4(content([rig, { ...anims, clipsFor: 'nope-0001' }])).ok).toBe(false);
    expect(validateContentV4(content([{ ...rig, clipsFor: 'anims-0001' }, { ...anims }])).ok).toBe(false);
    expect(validateContentV4(content([rig, { ...anims, clipsFor: 7 }])).ok).toBe(false);
    const v3 = { ...content([rig, anims]) } as Record<string, unknown>;
    delete v3['scenes'];
    delete v3['startScenes'];
    expect(validateContentV3(v3).ok).toBe(false);
  });

  it('a controller may name the clips of an animation-only asset', () => {
    const c: AnimatorController = { ...layered(), controllerId: 'hero' };
    const withAnims = JSON.parse(JSON.stringify(c).replaceAll('rig-0001', MODEL.assetId)) as AnimatorController;
    withAnims.layers![0]!.states[1]!.motion = { kind: 'clip', clip: { assetId: 'anims-0001', clip: 'attack', duration: 1 } };
    const r = validateContentV4(content([rig, anims], { animators: [withAnims] }));
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    // A layer clip from an asset that is not in the project is refused.
    withAnims.layers![0]!.states[1]!.motion = { kind: 'clip', clip: { assetId: 'gone-0001', clip: 'attack', duration: 1 } };
    expect(validateContentV4(content([rig, anims], { animators: [withAnims] })).ok).toBe(false);
  });
});

/** A GLB whose animations have the given key times (one sampler each; `max` optional). */
function clipsGlb(clips: { name: string; times: number[]; withMax?: boolean }[]): Uint8Array {
  const floats: number[] = [];
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const animations: Record<string, unknown>[] = [];
  for (const c of clips) {
    const inOff = floats.length * 4;
    floats.push(...c.times);
    bufferViews.push({ buffer: 0, byteOffset: inOff, byteLength: c.times.length * 4 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: c.times.length, type: 'SCALAR', ...(c.withMax !== false ? { min: [c.times[0]], max: [c.times[c.times.length - 1]] } : {}) });
    const input = accessors.length - 1;
    const outOff = floats.length * 4;
    for (let i = 0; i < c.times.length; i++) floats.push(0, 0, 0);
    bufferViews.push({ buffer: 0, byteOffset: outOff, byteLength: c.times.length * 12 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: c.times.length, type: 'VEC3' });
    animations.push({ name: c.name, samplers: [{ input, output: accessors.length - 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] });
  }
  const bin = new Uint8Array(new Float32Array(floats).buffer);
  let json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'root' }], scenes: [{ nodes: [0] }], scene: 0, animations, accessors, bufferViews, buffers: [{ byteLength: bin.length }] }));
  const pad = (4 - (json.length % 4)) % 4;
  json = new Uint8Array([...json, ...new Array(pad).fill(0x20)]);
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  v.setUint32(20 + json.length, bin.length, true);
  v.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}

describe('the old modelAnimation profile becomes an animator', () => {
  it('reads clip lengths from a GLB (accessor max, else the last key)', () => {
    const glb = clipsGlb([
      { name: 'idle', times: [0, 2] },
      { name: 'run', times: [0, 0.25, 0.8], withMax: false },
    ]);
    expect(glbClipDurations(glb)).toEqual([
      { name: 'idle', duration: 2 },
      { name: 'run', duration: expect.closeTo(0.8, 6) as unknown as number },
    ]);
    expect(glbClipDurations(new Uint8Array(8))).toBeNull();
  });

  const roles = { idle: { clipIndex: 0, clipName: 'idle' }, run: { clipIndex: 1, clipName: 'run' }, airborne: { clipIndex: 2, clipName: 'jump' } };
  const binding = { assetId: MODEL.assetId, version: 1, roles };
  const scenes = (): SceneV4[] => [
    {
      schemaVersion: 4,
      sceneId: 'scene-a',
      revision: 1,
      entities: [
        { id: 'hero-0001', components: { transform: T, model: { asset: { assetId: MODEL.assetId } }, modelAnimation: binding } },
        { id: 'hero-0002', components: { transform: T, model: { asset: { assetId: MODEL.assetId } }, modelAnimation: binding } },
      ] as never,
    },
  ];
  const lengths: Record<string, number> = { idle: 2, run: 0.5, jump: 0.75 };

  it('makes one controller per distinct binding with the old rule and swaps the component', () => {
    const c = content([MODEL]) as unknown as ContentCatalogV4;
    const m = migrateModelAnimations(scenes(), c, (_a, _v, _i, name) => lengths[name] ?? null)!;
    expect(m.migrated).toBe(2);
    expect(m.content.animators).toHaveLength(1);
    const ctl = m.content.animators![0]!;
    expect(ctl.controllerId).toBe('idle-run-airborne-01');
    expect(ctl.states.map((s) => [s.id, s.motion.kind === 'clip' ? s.motion.clip.clip : '', s.motion.kind === 'clip' ? s.motion.clip.duration : 0, s.loop])).toEqual([
      ['idle', 'idle', 2, true],
      ['run', 'run', 0.5, true],
      ['airborne', 'jump', 0.75, true],
    ]);
    expect(ctl.transitions[0]).toEqual({ from: '*', to: 'airborne', conditions: [{ parameter: 'grounded', op: 'false' }], duration: 0.2 });
    for (const e of m.scenes[0]!.entities as unknown as { components: Record<string, unknown> }[]) {
      expect(e.components['modelAnimation']).toBeUndefined();
      expect(e.components['animator']).toEqual({ controller: 'idle-run-airborne-01' });
    }
    // The result validates (the component, the controller and its clips).
    expect(validateContentV4(m.content).ok).toBe(true);
    // Nothing to do: null.
    expect(migrateModelAnimations(m.scenes, m.content, () => 1)).toBeNull();
  });

  it('keeps an entity whose clip lengths cannot be read, or that already has an animator', () => {
    const c = content([MODEL]) as unknown as ContentCatalogV4;
    const m = migrateModelAnimations(scenes(), c, () => null)!;
    expect(m.migrated).toBe(0);
    expect(m.notes.join(' ')).toContain('could not be read');
    const s = scenes();
    (s[0]!.entities[0]!.components as Record<string, unknown>)['animator'] = { controller: 'other' };
    const n = migrateModelAnimations(s, c, (_a, _v, _i, name) => lengths[name] ?? null)!;
    expect(n.migrated).toBe(1);
    expect((n.scenes[0]!.entities[0]!.components as Record<string, unknown>)['modelAnimation']).toBeDefined();
  });
});
