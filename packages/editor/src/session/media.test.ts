/**
 * M3 media authoring planning tests (packet 57) — the pure session layer:
 * the drop validation (row 18/21), the cue pickers (row 5), the light
 * create/edit (rows 13/14), the surface values + presets (rows 15/16), the
 * model animation profile (row 17) and the checkpoint activation appearance
 * (row 11). Pure Node (no DOM, no clock, no Node built-ins — the boundary
 * row's `node: []` holds for tests too).
 */
import { describe, expect, it } from 'vitest';
import {
  ANIMATION_PROFILE_BYTES_MAX,
  LIGHT_DIRECTION_ABS_MAX,
  LIGHT_DIRECTION_MIN_NORM,
  LIGHT_INTENSITY_MAX,
  SURFACE_EMISSIVE_INTENSITY_MAX,
  SURFACE_METALNESS_MAX,
  SURFACE_PRESETS,
  SURFACE_PRESET_NAMES,
  SURFACE_ROUGHNESS_MAX,
  canonicalColor,
  lightCounts,
  parseLightForm,
  parseModelAnimationForm,
  parseSurfaceForm,
  planAnimatedReimport,
  planSetLight,
  planSetModelAnimation,
  planSetSurface,
  validateMediaDrop,
  type AnimationRoleKey,
  type LightForm,
  type SurfaceForm,
} from './media';
import type { ProjectedEntity } from './projection';

const STAGE_MAX = 33_554_432; // 32 MiB (the protocol's CONTENT_STAGE_MAX)

// ---------------------------------------------------------------------------
// validateMediaDrop (row 18/21)
// ---------------------------------------------------------------------------

describe('validateMediaDrop — the extension decides the kind before any network call', () => {
  it('accepts a .glb as a model with a trimmed display name', () => {
    const r = validateMediaDrop('Hero.glb', 1024);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('model');
      expect(r.displayName).toBe('Hero');
    }
  });

  it('accepts a .wav as audio (case-insensitive extension)', () => {
    const r = validateMediaDrop('Cue.WAV', 44);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('audio');
      expect(r.displayName).toBe('Cue');
    }
  });

  it('phase 23.9a: accepts .ttf/.otf/.woff2/.woff as a font', () => {
    for (const name of ['Title.ttf', 'Title.OTF', 'Title.woff2', 'Title.woff']) {
      const r = validateMediaDrop(name, 1000);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.kind).toBe('font');
        expect(r.displayName).toBe('Title');
      }
    }
  });

  it('refuses any other extension with an actionable message', () => {
    for (const name of ['hero.txt', 'hero.mp4', 'hero', 'wav.glb.txt']) {
      const r = validateMediaDrop(name, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('import_rejected');
    }
  });

  it('refuses an empty file', () => {
    const r = validateMediaDrop('empty.glb', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('import_rejected');
  });

  it('enforces the 32 MiB stage bound (exactly at the bound is allowed)', () => {
    expect(validateMediaDrop('ok.glb', STAGE_MAX).ok).toBe(true);
    const over = validateMediaDrop('over.wav', STAGE_MAX + 1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('stage_limits_exceeded');
  });

  it('truncates a very long display name', () => {
    const r = validateMediaDrop('a'.repeat(400) + '.glb', 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.displayName.length).toBeLessThanOrEqual(128);
  });
});

// ---------------------------------------------------------------------------
// planCueEdit (row 5) — the `setGameConfig` partial edit, `cues` replaces whole
// ---------------------------------------------------------------------------

describe('canonicalColor — #rrggbb to canonical lowercase', () => {
  it('lowercases and validates the exact shape', () => {
    expect(canonicalColor('#FF80a0')).toBe('#ff80a0');
    expect(canonicalColor('#12345')).toBeNull();
    expect(canonicalColor('#1234567')).toBeNull();
    expect(canonicalColor('123456')).toBeNull();
    expect(canonicalColor('#gg0000')).toBeNull();
  });
});

function lightForm(over: Partial<LightForm> = {}): LightForm {
  return {
    type: 'directional',
    color: '#ffffff',
    intensity: '2',
    directionX: '0.35',
    directionY: '-1',
    directionZ: '0.55',
    castShadow: false,
    ...over,
  };
}

describe('parseLightForm — the §23.3.4 table', () => {
  it('parses a directional light (castShadow carried)', () => {
    const r = parseLightForm(lightForm({ castShadow: true, color: '#F0E0D0' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ type: 'directional', color: '#f0e0d0', intensity: 2, direction: [0.35, -1, 0.55], castShadow: true });
    }
  });

  it('parses the intensity bounds inclusive (0 and 8)', () => {
    expect(parseLightForm(lightForm({ intensity: '0' })).ok).toBe(true);
    expect(parseLightForm(lightForm({ intensity: String(LIGHT_INTENSITY_MAX) })).ok).toBe(true);
  });

  it('refuses an intensity above the bound', () => {
    const r = parseLightForm(lightForm({ intensity: String(LIGHT_INTENSITY_MAX + 1) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('intensity'))).toBe(true);
  });

  it('an ambient light carries neither direction nor castShadow', () => {
    const r = parseLightForm(lightForm({ type: 'ambient', directionX: '', directionY: '', directionZ: '' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.type).toBe('ambient');
      expect(r.value.direction).toBeUndefined();
      expect(r.value.castShadow).toBeUndefined();
    }
  });

  it('refuses a zero-norm direction and a component over |v| <= 1', () => {
    const zero = parseLightForm(lightForm({ directionX: '0', directionY: '0', directionZ: '0' }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors.some((e) => e.includes(String(LIGHT_DIRECTION_MIN_NORM)))).toBe(true);
    const big = parseLightForm(lightForm({ directionX: String(LIGHT_DIRECTION_ABS_MAX + 0.5), directionY: '0', directionZ: '0' }));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.errors.some((e) => e.includes('|v| <= 1'))).toBe(true);
  });

  it('refuses a non-#hex color', () => {
    const r = parseLightForm(lightForm({ color: 'white' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('#rrggbb'))).toBe(true);
  });
});

describe('planSetLight — add = complete value, edit = changed fields, type switch = complete', () => {
  const current: { type: 'directional'; color: string; intensity: number; direction: [number, number, number]; castShadow: boolean } = {
    type: 'directional',
    color: '#ffffff',
    intensity: 2,
    direction: [0.35, -1, 0.55],
    castShadow: false,
  };

  it('adds the complete value for a missing light', () => {
    const r = planSetLight('light-0001', null, lightForm());
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.args.component).toBe('light');
      expect(Object.keys(r.args.value)).toEqual(['type', 'color', 'intensity', 'direction', 'castShadow']);
    }
  });

  it('sends the changed field only on a same-type edit', () => {
    const r = planSetLight('light-0001', current, lightForm({ intensity: '5' }));
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.args.value).toEqual({ intensity: 5 });
  });

  it('is a noop when nothing changed (or the form is invalid)', () => {
    expect(planSetLight('light-0001', current, lightForm()).kind).toBe('noop');
    expect(planSetLight('light-0001', current, lightForm({ intensity: '99' })).kind).toBe('noop');
  });

  it('a type switch sends the complete value', () => {
    const r = planSetLight('light-0001', current, lightForm({ type: 'ambient' }));
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.args.value.type).toBe('ambient');
      expect(r.args.value.direction).toBeUndefined();
    }
  });

  it('a directional castShadow flip sends only the field', () => {
    const r = planSetLight('light-0001', current, lightForm({ castShadow: true }));
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.args.value).toEqual({ castShadow: true });
  });
});

describe('lightCounts — the §23.10 scene limit is one directional + one ambient', () => {
  const e = (light?: unknown): ProjectedEntity =>
    ({ id: 'e', kind: 'group', name: 'n', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, light } as unknown as ProjectedEntity);
  it('counts only light components by type', () => {
    expect(lightCounts([e({ type: 'directional' }), e({ type: 'ambient' }), e(undefined), e({ type: 'directional' })])).toEqual({ directional: 2, ambient: 1 });
    expect(lightCounts([])).toEqual({ directional: 0, ambient: 0 });
  });
});

// ---------------------------------------------------------------------------
// Surface (rows 15/16)
// ---------------------------------------------------------------------------

describe('parseSurfaceForm — the §23.3.5 table', () => {
  const form = (over: Partial<SurfaceForm> = {}): SurfaceForm => ({
    color: '#b0b0b0',
    roughness: '0.9',
    metalness: '0',
    emissive: '#000000',
    emissiveIntensity: '0',
    ...over,
  });

  it('parses a valid surface (colors canonicalized)', () => {
    const r = parseSurfaceForm(form({ color: '#B0B0B0', emissive: '#001122' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.color).toBe('#b0b0b0');
  });

  it('enforces the numeric bounds', () => {
    expect(parseSurfaceForm(form({ roughness: String(SURFACE_ROUGHNESS_MAX + 0.1) })).ok).toBe(false);
    expect(parseSurfaceForm(form({ metalness: '-0.1' })).ok).toBe(false);
    expect(parseSurfaceForm(form({ emissiveIntensity: String(SURFACE_EMISSIVE_INTENSITY_MAX + 1) })).ok).toBe(false);
    expect(parseSurfaceForm(form({ roughness: String(SURFACE_METALNESS_MAX) })).ok).toBe(true);
  });

  it('refuses non-#hex colors', () => {
    const r = parseSurfaceForm(form({ color: '#12345' }));
    expect(r.ok).toBe(false);
  });
});

describe('planSetSurface — add = complete, edit = changed fields only', () => {
  const current = { color: '#b0b0b0', roughness: 0.9, metalness: 0, emissive: '#000000', emissiveIntensity: 0 };
  const form = (over: Partial<SurfaceForm> = {}): SurfaceForm => ({
    color: '#b0b0b0',
    roughness: '0.9',
    metalness: '0',
    emissive: '#000000',
    emissiveIntensity: '0',
    ...over,
  });

  it('adds the complete five-field value', () => {
    const r = planSetSurface('box-0001', null, form());
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(Object.keys(r.args.value).sort()).toEqual(['color', 'emissive', 'emissiveIntensity', 'metalness', 'roughness']);
  });

  it('sends only the changed fields', () => {
    const r = planSetSurface('box-0001', current, form({ roughness: '0.4' }));
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.args.value).toEqual({ roughness: 0.4 });
  });

  it('is a noop when equal or invalid', () => {
    expect(planSetSurface('box-0001', current, form()).kind).toBe('noop');
    expect(planSetSurface('box-0001', current, form({ roughness: '2' })).kind).toBe('noop');
  });
});

describe('the built-in presets are the frozen §23.3.1a rows (display mirror)', () => {
  it('lists exactly the three preset names', () => {
    expect([...SURFACE_PRESET_NAMES]).toEqual(['matte-ground', 'hazard', 'beacon']);
  });

  it('each row is a complete, frozen surface value', () => {
    for (const name of SURFACE_PRESET_NAMES) {
      const p = SURFACE_PRESETS[name];
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.keys(p).sort()).toEqual(['color', 'emissive', 'emissiveIntensity', 'metalness', 'roughness']);
      expect(Number.isFinite(p.roughness)).toBe(true);
    }
  });

  it('equals the authoritative project-model rows (phase 15.5: the mirror had drifted)', () => {
    expect(SURFACE_PRESETS).toEqual({
      'matte-ground': { color: '#6f6f6f', roughness: 0.95, metalness: 0, emissive: '#000000', emissiveIntensity: 0 },
      hazard: { color: '#d42a1e', roughness: 0.55, metalness: 0, emissive: '#3a0703', emissiveIntensity: 0.35 },
      beacon: { color: '#2f7fd4', roughness: 0.4, metalness: 0.1, emissive: '#1bc8ff', emissiveIntensity: 1.2 },
    });
  });
});

// ---------------------------------------------------------------------------
// Model animation (row 17) + the §8.5.1 animated reimport
// ---------------------------------------------------------------------------

describe('parseModelAnimationForm — the profile shape + byte bound', () => {
  const roles = () => ({ idle: { clipIndex: '0', clipName: 'Idle' }, run: { clipIndex: '1', clipName: 'Run' }, airborne: { clipIndex: '2', clipName: 'Air' } });

  it('parses a valid profile', () => {
    const r = parseModelAnimationForm({ version: '2', roles: roles() }, 3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe(2);
      expect(r.roles.run).toEqual({ clipIndex: 1, clipName: 'Run' });
    }
  });

  it('refuses a version outside [1, maxVersion]', () => {
    expect(parseModelAnimationForm({ version: '0', roles: roles() }, 3).ok).toBe(false);
    expect(parseModelAnimationForm({ version: '4', roles: roles() }, 3).ok).toBe(false);
    expect(parseModelAnimationForm({ version: '3', roles: roles() }, 3).ok).toBe(true);
  });

  it('refuses a negative clipIndex and an empty clipName', () => {
    const bad = roles();
    bad.idle.clipIndex = '-1';
    expect(parseModelAnimationForm({ version: '1', roles: bad }, 1).ok).toBe(false);
    const empty = roles();
    empty.run.clipName = '   ';
    expect(parseModelAnimationForm({ version: '1', roles: empty }, 1).ok).toBe(false);
  });

  it('enforces the ' + ANIMATION_PROFILE_BYTES_MAX + '-byte serialized bound', () => {
    const big = roles();
    big.idle.clipName = 'x'.repeat(6000);
    const r = parseModelAnimationForm({ version: '1', roles: big }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes(String(ANIMATION_PROFILE_BYTES_MAX)))).toBe(true);
  });
});

describe('planSetModelAnimation — assetId fixed to the entity model, complete value', () => {
  const modelEntity = (withAnimation?: unknown): ProjectedEntity =>
    ({
      id: 'model-0001',
      kind: 'model',
      assetId: 'asset-0009',
      name: 'hero',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      modelAnimation: withAnimation,
    }) as unknown as ProjectedEntity;

  const form = { version: '1', roles: { idle: { clipIndex: '0', clipName: 'Idle' }, run: { clipIndex: '1', clipName: 'Run' }, airborne: { clipIndex: '2', clipName: 'Air' } } };

  it('commits the complete component with the fixed assetId', () => {
    const r = planSetModelAnimation('model-0001', modelEntity(), form, 2);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') {
      expect(r.args.component).toBe('modelAnimation');
      expect(r.args.value.assetId).toBe('asset-0009');
      expect(r.args.value.version).toBe(1);
    }
  });

  it('is a noop for a non-model entity (the §23.8 step-5 conflict)', () => {
    const box = { id: 'box-0001', kind: 'box', name: 'b', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } as unknown as ProjectedEntity;
    expect(planSetModelAnimation('box-0001', box, form, 1).kind).toBe('noop');
    expect(planSetModelAnimation('model-0001', { ...modelEntity(), assetId: undefined } as unknown as ProjectedEntity, form, 1).kind).toBe('noop');
  });

  it('is a noop when the profile is unchanged', () => {
    const current = { assetId: 'asset-0009', version: 1, roles: { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Air' } } };
    expect(planSetModelAnimation('model-0001', modelEntity(current), form, 2).kind).toBe('noop');
  });

  it('a version change commits the complete component', () => {
    const current = { assetId: 'asset-0009', version: 1, roles: { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Air' } } };
    const r = planSetModelAnimation('model-0001', modelEntity(current), { ...form, version: '2' }, 2);
    expect(r.kind).toBe('commit');
    if (r.kind === 'commit') expect(r.args.value.version).toBe(2);
  });
});

describe('planAnimatedReimport — the §8.5.1 all-or-nothing args', () => {
  const roles: Record<AnimationRoleKey, { clipIndex: number; clipName: string }> = {
    idle: { clipIndex: 0, clipName: 'Idle' },
    run: { clipIndex: 1, clipName: 'Run' },
    airborne: { clipIndex: 2, clipName: 'Air' },
  };

  it('returns null when nothing references the asset', () => {
    expect(planAnimatedReimport([], 'model-0001', roles)).toBeNull();
  });

  it('returns null when the chosen entity is not a referencing one', () => {
    expect(planAnimatedReimport(['model-0001'], 'model-0002', roles)).toBeNull();
  });

  it('carries the chosen entity + roles when it references the asset', () => {
    expect(planAnimatedReimport(['model-0001', 'model-0002'], 'model-0002', roles)).toEqual({ entityId: 'model-0002', roles });
  });
});

// ---------------------------------------------------------------------------
// Checkpoint activation appearance (row 11)
// ---------------------------------------------------------------------------
