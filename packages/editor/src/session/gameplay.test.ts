/**
 * M3 gameplay authoring planning tests (packet 56).
 *
 * The pure planning layer decides WHAT command to issue (or `noop`); the
 * backend remains the sole authority. These tests pin the planning semantics
 * against the contract tables (commands.md §8.10/§8.11/§8.14; authoring.md
 * §A3.2/§A3.4; project-model §23.3/§23.4 bounds).
 */
import { describe, it, expect } from 'vitest';
import type { ProjectedEntity } from './projection';
import {
  GAMEPLAY_SETTINGS_KEYS,
  parseSettingsDraft,
  planSetSettings,
  parseGameConfigForm,
  validateGameConfigReferences,
  planSetGameConfig,
  planCreateZone,
  planEditZone,
  parseCameraFollowForm,
  planSetCameraFollow,
  DEFAULT_ZONE_SIZE,
  DEFAULT_CHECKPOINT_ACTIVATION,
  MIN_ZONE_SPAN_UI,
  type GameConfigDraft,
  type GameConfigLike,
  type ZoneRole,
} from './gameplay';

function entity(id: string, extra: Partial<ProjectedEntity> = {}): ProjectedEntity {
  return {
    id,
    name: id,
    parentId: null,
    kind: 'entity',
    active: true,
    locked: false,
    static: false,
    tags: 0,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    components: {},
    ...extra,
  };
}

const DRAFT: GameConfigDraft = {
  title: 'Demo',
  objective: 'Reach the goal.',
  instructions: 'Arrows to move, space to jump.',
  playerId: 'box-0001',
  cameraId: 'cam-main',
  spawnId: 'spawn-0001',
  level: { minX: -10, maxX: 10, minY: -4, maxY: 8 },
  killY: -6,
};

function fullConfig(patch: Partial<GameConfigLike> = {}): GameConfigLike {
  return {
    configVersion: 1,
    title: DRAFT.title,
    objective: DRAFT.objective,
    instructions: DRAFT.instructions,
    playerId: DRAFT.playerId,
    cameraId: DRAFT.cameraId,
    spawnId: DRAFT.spawnId,
    level: { ...DRAFT.level! },
    killY: DRAFT.killY!,
    cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('parseSettingsDraft — the six-key registry (commands.md §8.11)', () => {
  it('accepts in-range values for every key', () => {
    const raw: Record<string, string> = {};
    for (const spec of GAMEPLAY_SETTINGS_KEYS) raw[spec.key] = String(spec.default);
    const res = parseSettingsDraft(raw, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.values).toEqual(
      Object.fromEntries(GAMEPLAY_SETTINGS_KEYS.map((s) => [s.key, s.default])),
    );
  });

  it('rejects non-finite and out-of-range values (exclusive bounds included)', () => {
    expect(parseSettingsDraft({ run_speed: 'abc' }, null).ok).toBe(false);
    const out: Array<[string, string]> = [
      ['gravity_y', '-100.5'], // < -100
      ['gravity_y', '0'], // > -1
      ['run_speed', '0'], // exclusive min
      ['run_speed', '51'], // > 50
      ['jump_velocity', '51'],
      ['max_fall_speed', '0'], // exclusive max
      ['max_fall_speed', '-101'],
      ['max_slope_climb_deg', '90'],
      ['min_slope_slide_deg', '-0.1'],
    ];
    for (const [key, value] of out) {
      const res = parseSettingsDraft({ [key]: value }, null);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.map((e) => e.key)).toContain(key);
    }
  });

  it('enforces the cross-field rule against the resulting values (current map, then defaults)', () => {
    // Both touched: slide > climb.
    expect(parseSettingsDraft({ min_slope_slide_deg: '50', max_slope_climb_deg: '45' }, null).ok).toBe(false);
    // Only slide touched; the current climb is lower.
    expect(parseSettingsDraft({ min_slope_slide_deg: '50' }, { max_slope_climb_deg: 40 }).ok).toBe(false);
    // Only slide touched; the current climb is higher (the default 45 too).
    expect(parseSettingsDraft({ min_slope_slide_deg: '40' }, { max_slope_climb_deg: 40 }).ok).toBe(true);
    // Only climb touched; below the default slide (30).
    expect(parseSettingsDraft({ max_slope_climb_deg: '20' }, null).ok).toBe(false);
  });

  it('untouched keys are never parsed or submitted', () => {
    const res = parseSettingsDraft({ run_speed: '6' }, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.values).toEqual({ run_speed: 6 });
    const plan = planSetSettings(res.values, { run_speed: 4 });
    expect(plan).toEqual({ kind: 'commit', args: { settings: { run_speed: 6 } } });
  });
});

describe('planSetSettings — partial semantics (present replaces, absent unchanged)', () => {
  it('is a noop when the draft equals the current map', () => {
    expect(planSetSettings({ run_speed: 4 }, { run_speed: 4 })).toEqual({ kind: 'noop' });
  });
  it('submits only the changed keys against an unknown baseline (null)', () => {
    expect(planSetSettings({ jump_velocity: 7, run_speed: 5 }, null)).toEqual({
      kind: 'commit',
      args: { settings: { jump_velocity: 7, run_speed: 5 } },
    });
  });
});

// ---------------------------------------------------------------------------
// Game config form parsing
// ---------------------------------------------------------------------------

describe('parseGameConfigForm — string bounds / IDs / level rules (§23.4)', () => {
  const form = {
    title: 'Demo',
    objective: 'Reach the goal.',
    instructions: 'Arrows to move, space to jump.',
    playerId: 'box-0001',
    cameraId: 'cam-main',
    spawnId: 'spawn-0001',
    minX: '-10',
    maxX: '10',
    minY: '-4',
    maxY: '8',
    killY: '-6',
  };

  it('accepts a well-formed form', () => {
    const res = parseGameConfigForm(form);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.draft).toEqual(DRAFT);
  });

  it('enforces the string bounds (title 64 / objective 160 / instructions 320)', () => {
    expect(parseGameConfigForm({ ...form, title: 'x'.repeat(65) }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, objective: 'x'.repeat(161) }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, instructions: 'x'.repeat(321) }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, title: '' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, title: 'bad\u0000title' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, title: 'x'.repeat(64) }).ok).toBe(true);
  });

  it('enforces the ID syntax on the three references', () => {
    expect(parseGameConfigForm({ ...form, playerId: 'Box_0001' }).ok).toBe(false); // uppercase
    expect(parseGameConfigForm({ ...form, cameraId: '' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, spawnId: '-spawn' }).ok).toBe(false); // leading '-'
  });

  it('enforces finite level numbers, |v| <= 1e6, minX < maxX, minY < maxY, killY < maxY', () => {
    expect(parseGameConfigForm({ ...form, minX: 'abc' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, maxX: '1e7' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, minX: '5', maxX: '5' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, minY: '8', maxY: '8' }).ok).toBe(false);
    expect(parseGameConfigForm({ ...form, killY: '8' }).ok).toBe(false); // not strictly below maxY
    expect(parseGameConfigForm({ ...form, killY: '7.999' }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Game config references (the §23.8 step-8 role rules, mirrored)
// ---------------------------------------------------------------------------

describe('validateGameConfigReferences — the role rules against the scene', () => {
  const scene: ProjectedEntity[] = [
    entity('box-0001', { controller: true }),
    entity('cam-main', { kind: 'camera', cameraFollow: { deadZone: { x: 0.3, y: 0.3 }, smoothing: 0.5, bounds: { minX: -10, maxX: 10, minY: -4, maxY: 8 } } }),
    entity('spawn-0001', { playerSpawn: true }),
    entity('zone-0001', { gameZone: { role: 'goal', size: [2, 2] } }),
  ];

  it('passes on a complete scene', () => {
    expect(validateGameConfigReferences(DRAFT, scene)).toEqual([]);
  });

  it('flags a missing controller / a non-controller player / more than one controller', () => {
    // The player reference is missing → the reference error precedes the role rule.
    expect(validateGameConfigReferences(DRAFT, scene.filter((e) => e.id !== 'box-0001'))).toContain('playerId must name an existing entity');
    expect(
      validateGameConfigReferences(DRAFT, scene.map((e) => (e.id === 'box-0001' ? entity('box-0001') : e))),
    ).toContain('playerId must name the entity carrying the controller component');
    // The player entity is a controller, but a second controller exists too.
    const extra = [entity('box-0009', { controller: true })];
    expect(validateGameConfigReferences(DRAFT, [...scene, ...extra])).toContain('the scene must carry exactly one controller entity');
  });

  it('flags a camera without cameraFollow', () => {
    const noCf = scene.map((e) => (e.id === 'cam-main' ? entity('cam-main', { kind: 'camera' }) : e));
    expect(validateGameConfigReferences(DRAFT, noCf)).toContain('the camera entity must carry cameraFollow while the game config is present');
  });

  it('flags a non-spawn start reference and a missing goal', () => {
    expect(validateGameConfigReferences({ ...DRAFT, spawnId: 'box-0001' }, scene)).toContain('spawnId must name an entity carrying playerSpawn');
    expect(validateGameConfigReferences(DRAFT, scene.filter((e) => e.id !== 'zone-0001'))).toContain('the scene needs at least one goal zone');
  });

  it('flags more than one checkpoint', () => {
    const twoCp = [
      ...scene,
      entity('zone-0002', { gameZone: { role: 'checkpoint', size: [1.5, 1.5], safeSpawnId: 'spawn-0001', activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: null } } }),
      entity('zone-0003', { gameZone: { role: 'checkpoint', size: [1.5, 1.5], safeSpawnId: 'spawn-0001', activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: null } } }),
    ];
    expect(validateGameConfigReferences(DRAFT, twoCp)).toContain('the scene may carry at most one checkpoint zone');
  });
});

// ---------------------------------------------------------------------------
// setGameConfig planning (authoring.md §A3.4)
// ---------------------------------------------------------------------------

describe('planSetGameConfig — create is complete, edit is changed-fields-only', () => {
  it('create (no current block) sends the complete canonical block with null cues', () => {
    const plan = planSetGameConfig(DRAFT, null);
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    expect(plan.args.game).toEqual({
      configVersion: 1,
      title: DRAFT.title,
      objective: DRAFT.objective,
      instructions: DRAFT.instructions,
      playerId: DRAFT.playerId,
      cameraId: DRAFT.cameraId,
      spawnId: DRAFT.spawnId,
      level: { ...DRAFT.level },
      killY: DRAFT.killY,
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    });
  });

  it('an edit sends only the changed top-level fields', () => {
    const current = fullConfig();
    const plan = planSetGameConfig({ ...DRAFT, title: 'New title', killY: -7 }, current);
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    expect(plan.args.game).toEqual({ title: 'New title', killY: -7 });
  });

  it('level replaces whole when any bound changes', () => {
    const plan = planSetGameConfig({ ...DRAFT, level: { minX: -10, maxX: 12, minY: -4, maxY: 8 } }, fullConfig());
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    expect(plan.args.game).toEqual({ level: { minX: -10, maxX: 12, minY: -4, maxY: 8 } });
  });

  it('is a noop when the draft equals the current block on every 56 field', () => {
    expect(planSetGameConfig(DRAFT, fullConfig())).toEqual({ kind: 'noop' });
  });

  it('never touches the cues field (the media panel owns it)', () => {
    const current = fullConfig({ cues: { start: 'asset-abc', jump: null, checkpoint: null, death: null, goal: null } });
    const plan = planSetGameConfig({ ...DRAFT, title: 'T2' }, current);
    if (plan.kind !== 'commit') throw new Error('expected a commit');
    expect(plan.args.game).not.toHaveProperty('cues');
  });
});

// ---------------------------------------------------------------------------
// Zone creation + editing (authoring.md §A3.1/§A3.2)
// ---------------------------------------------------------------------------

describe('planCreateZone — the createEntity args with components.gameZone', () => {
  it('creates a root group with a unit-scale identity transform (zone_transform_unsupported cannot trigger)', () => {
    const res = planCreateZone({ role: 'hazard', size: [2, 1], position: [1, 2, 0] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args).toEqual({
      kind: 'group',
      name: 'zone-hazard',
      transform: { position: [1, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { gameZone: { role: 'hazard', size: [2, 1] } },
    });
  });

  it('a checkpoint requires the safeSpawnId in the same value and carries the default activation', () => {
    expect(planCreateZone({ role: 'checkpoint', size: [1.5, 1.5], position: [0, 0, 0] }).ok).toBe(false);
    const res = planCreateZone({ role: 'checkpoint', size: [1.5, 1.5], position: [0, 0, 0], safeSpawnId: 'spawn-0001' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args.components.gameZone).toEqual({
      role: 'checkpoint',
      size: [1.5, 1.5],
      safeSpawnId: 'spawn-0001',
      activation: { ...DEFAULT_CHECKPOINT_ACTIVATION },
    });
  });

  it('rejects sizes outside (0, 1e6]', () => {
    expect(planCreateZone({ role: 'goal', size: [0, 2], position: [0, 0, 0] }).ok).toBe(false);
    expect(planCreateZone({ role: 'goal', size: [1e7, 2], position: [0, 0, 0] }).ok).toBe(false);
    expect(planCreateZone({ role: 'goal', size: [1e6, 2], position: [0, 0, 0] }).ok).toBe(true);
  });
});

describe('planEditZone — partial edits, the checkpoint field rules, the two-step switch', () => {
  const hazard = { role: 'hazard' as ZoneRole, size: [2, 1] as [number, number] };
  const checkpoint = {
    role: 'checkpoint' as ZoneRole,
    size: [1.5, 1.5] as [number, number],
    safeSpawnId: 'spawn-0001',
    activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: null },
  };

  it('is a noop when nothing changes', () => {
    expect(planEditZone('zone-0001', hazard, { role: 'hazard', size: [2, 1] })).toEqual({ kind: 'noop' });
  });

  it('a size edit sends the partial { size }', () => {
    const plan = planEditZone('zone-0001', hazard, { size: [3, 1] });
    expect(plan.kind).toBe('edit');
    if (plan.kind !== 'edit') return;
    expect(plan.steps).toEqual([{ op: 'setComponent', entityId: 'zone-0001', args: { entityId: 'zone-0001', component: 'gameZone', value: { size: [3, 1] } } }]);
  });

  it('a switch TO checkpoint carries safeSpawnId + activation in the same value (size unchanged ⇒ not sent)', () => {
    const plan = planEditZone('zone-0001', hazard, { role: 'checkpoint', safeSpawnId: 'spawn-0002' });
    expect(plan.kind).toBe('edit');
    if (plan.kind !== 'edit') return;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.args.value).toEqual({
      role: 'checkpoint',
      safeSpawnId: 'spawn-0002',
      activation: { ...DEFAULT_CHECKPOINT_ACTIVATION },
    });
  });

  it('a switch AWAY from checkpoint is the two-step remove-then-re-add (one edit cannot drop the checkpoint fields)', () => {
    const plan = planEditZone('zone-0001', checkpoint, { role: 'goal' });
    expect(plan.kind).toBe('edit');
    if (plan.kind !== 'edit') return;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.args.value).toBeNull(); // remove
    expect(plan.steps[1]!.args.value).toEqual({ role: 'goal', size: [1.5, 1.5] }); // re-add
  });

  it('a new safe-spawn reference on an existing checkpoint replaces it (partial value)', () => {
    const plan = planEditZone('zone-0001', checkpoint, { safeSpawnId: 'spawn-0002' });
    expect(plan.kind).toBe('edit');
    if (plan.kind !== 'edit') return;
    expect(plan.steps[0]!.args.value).toEqual({ safeSpawnId: 'spawn-0002', activation: checkpoint.activation });
  });

  it('a reference "change" on a non-checkpoint role is a noop (the field is not carried)', () => {
    expect(planEditZone('zone-0001', hazard, { safeSpawnId: 'spawn-0001' })).toEqual({ kind: 'noop' });
  });

  it('an unplannable checkpoint switch (no reference) is a noop (the UI preflights first)', () => {
    const plan = planEditZone('zone-0001', hazard, { role: 'checkpoint' });
    expect(plan).toEqual({ kind: 'noop' });
  });
});

// ---------------------------------------------------------------------------
// Camera follow (authoring.md row 12)
// ---------------------------------------------------------------------------

describe('parseCameraFollowForm + planSetCameraFollow', () => {
  const form = { deadZoneX: '0.3', deadZoneY: '0.4', smoothing: '0.5', minX: '-10', maxX: '10', minY: '-4', maxY: '8' };
  const draft = { deadZone: { x: 0.3, y: 0.4 }, smoothing: 0.5, bounds: { minX: -10, maxX: 10, minY: -4, maxY: 8 } };

  it('accepts a well-formed form', () => {
    const res = parseCameraFollowForm(form);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.draft).toEqual(draft);
  });

  it('enforces the §23.3.3 bounds (deadZone 0..1e6, smoothing 0..1, span >= 1e-6)', () => {
    expect(parseCameraFollowForm({ ...form, deadZoneX: '-0.1' }).ok).toBe(false);
    expect(parseCameraFollowForm({ ...form, smoothing: '1.5' }).ok).toBe(false);
    expect(parseCameraFollowForm({ ...form, minX: '10', maxX: '10' }).ok).toBe(false);
    expect(parseCameraFollowForm({ ...form, minX: '-1e7' }).ok).toBe(false);
  });

  it('an add sends the complete value; an edit sends the changed fields only', () => {
    expect(planSetCameraFollow('cam-main', null, draft)).toEqual({
      kind: 'commit',
      args: { entityId: 'cam-main', component: 'cameraFollow', value: { deadZone: { x: 0.3, y: 0.4 }, smoothing: 0.5, bounds: { minX: -10, maxX: 10, minY: -4, maxY: 8 } } },
    });
    const current = { deadZone: { x: 0.3, y: 0.4 }, smoothing: 0.5, bounds: { minX: -10, maxX: 10, minY: -4, maxY: 8 } };
    expect(planSetCameraFollow('cam-main', current, draft)).toEqual({ kind: 'noop' });
    expect(planSetCameraFollow('cam-main', current, { ...draft, smoothing: 0.7 })).toEqual({
      kind: 'commit',
      args: { entityId: 'cam-main', component: 'cameraFollow', value: { smoothing: 0.7 } },
    });
    const full = planSetCameraFollow('cam-main', current, { ...draft, bounds: { minX: -12, maxX: 10, minY: -4, maxY: 8 } });
    expect(full.kind).toBe('commit');
    if (full.kind !== 'commit') return;
    expect(full.args).toMatchObject({
      value: { bounds: { minX: -12, maxX: 10, minY: -4, maxY: 8 } },
    });
  });
});

describe('zone tool defaults (the placement fallbacks)', () => {
  it('every role has a positive default size within the §23.3.1 bound', () => {
    for (const role of ['hazard', 'checkpoint', 'goal'] as ZoneRole[]) {
      const [w, h] = DEFAULT_ZONE_SIZE[role];
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1e6);
      expect(h).toBeLessThanOrEqual(1e6);
    }
    expect(MIN_ZONE_SPAN_UI).toBeGreaterThan(0);
  });
});