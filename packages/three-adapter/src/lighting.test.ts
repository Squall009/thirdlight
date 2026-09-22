/**
 * Packet 52 — light/shadow/surface realization math (presentation.md
 * §§41.1/41.2).
 *
 * Pure, Node-runnable (no WebGL, no three, no DOM, no Node built-ins).
 * The `shadowCases` replay below mirrors the promoted fixture
 * `fixtures/m3/media/render/light-surface-cases.json` (the media checker
 * re-derives the same rules independently and pins the file's digest) —
 * the inputs and expected outcomes are pinned here verbatim, so a
 * regression in the derivation or the priority order fails both places.
 * The visual half (real WebGL realization, screenshots, the named B11
 * checklist) is `tests/browser/m3-render/` — UNVERIFIED in this container.
 */
import { describe, expect, it } from 'vitest';
import {
  decideShadows,
  deriveShadowCamera,
  planSceneLights,
  SHADOW_PROFILE,
  SURFACE_PRESETS,
  type ShadowLevel,
} from './lighting';

// The fixture's shadow block (presentation.md §41.1.2 frozen profile).
const FIXTURE_SHADOW = {
  mapSize: 512,
  type: 'PCFShadowMap',
  near: 0.5,
  distance: 20,
  margin: 2,
  halfExtentMax: 64,
  farMax: 200,
};

// The fixture's preset table (presentation.md §41.2.1 frozen rows).
const FIXTURE_PRESETS = {
  'matte-ground': { color: '#6f6f6f', roughness: 0.95, metalness: 0, emissive: '#000000', emissiveIntensity: 0 },
  hazard: { color: '#d42a1e', roughness: 0.55, metalness: 0, emissive: '#3a0703', emissiveIntensity: 0.35 },
  beacon: { color: '#2f7fd4', roughness: 0.4, metalness: 0.1, emissive: '#1bc8ff', emissiveIntensity: 1.2 },
};

const LEVEL: ShadowLevel = { minX: 0, maxX: 48, minY: -4, maxY: 8 };
const LEVEL_WIDE: ShadowLevel = { minX: 0, maxX: 200, minY: -4, maxY: 8 };
const DIR: [number, number, number] = [0.5, -1, -0.6];

describe('packet 52 — the §41.1.2 frozen shadow profile', () => {
  it('carries exactly the fixture constants (bit-equal, deep-frozen)', () => {
    expect({
      mapSize: SHADOW_PROFILE.mapSize,
      type: SHADOW_PROFILE.type,
      near: SHADOW_PROFILE.near,
      distance: SHADOW_PROFILE.distance,
      margin: SHADOW_PROFILE.margin,
      halfExtentMax: SHADOW_PROFILE.halfExtentMax,
      farMax: SHADOW_PROFILE.farMax,
    }).toEqual(FIXTURE_SHADOW);
    expect(Object.isFrozen(SHADOW_PROFILE)).toBe(true);
  });
});

describe('packet 52 — the §41.1.3 exact shadow camera derivation', () => {
  it('derives the fixture case: level X[0,48] Y[-4,8], direction (0.5,-1,-0.6)', () => {
    const p = deriveShadowCamera(LEVEL, DIR);
    // centre = ((0+48)/2, (-4+8)/2, 0)
    expect(p.centre).toEqual([24, 2, 0]);
    // halfExtent = max((48-0)/2, (8-(-4))/2) + 2 = max(24, 6) + 2 = 26
    expect(p.halfExtent).toBe(26);
    // far = min(20 + 26 + 2, 200) = 48 (the far cap is a safety bound: with
    // halfExtent ≤ 64 the raw far is ≤ 86, so min(·, 200) never binds)
    expect(p.far).toBe(48);
    expect(p.camera).toEqual({
      left: -26,
      right: 26,
      top: 26,
      bottom: -26,
      near: 0.5,
      far: 48,
    });
    expect(p.withinBounds).toBe(true);
    // lightPosition = c − n·20 with n = d/‖d‖ (the derived copy; the
    // authored direction is never rewritten).
    const norm = Math.hypot(0.5, -1, -0.6);
    const n: [number, number, number] = [0.5 / norm, -1 / norm, -0.6 / norm];
    expect(p.lightPosition[0]).toBe(24 - n[0] * 20);
    expect(p.lightPosition[1]).toBe(2 - n[1] * 20);
    expect(p.lightPosition[2]).toBe(0 - n[2] * 20);
    // The light sits on the far side of the level centre from the direction
    // (shining DOWN the authored direction over the level).
    expect(p.lightPosition[1]).toBeGreaterThan(2); // d.y < 0 ⇒ light above
  });

  it('flags shadow_bounds_exceeded: halfExtent = max(100, 6) + 2 = 102 > 64', () => {
    const p = deriveShadowCamera(LEVEL_WIDE, DIR);
    expect(p.halfExtent).toBe(102);
    expect(p.withinBounds).toBe(false);
  });

  it('the half-extent boundary is inclusive at exactly 64', () => {
    // level X[0,124] Y[-4,8]: halfExtent = max(62, 6) + 2 = 64 ⇒ still on
    const p = deriveShadowCamera({ minX: 0, maxX: 124, minY: -4, maxY: 8 }, DIR);
    expect(p.halfExtent).toBe(64);
    expect(p.withinBounds).toBe(true);
    // one more metre of level ⇒ 64.5 > 64 ⇒ off
    const p2 = deriveShadowCamera({ minX: 0, maxX: 125, minY: -4, maxY: 8 }, DIR);
    expect(p2.halfExtent).toBe(64.5);
    expect(p2.withinBounds).toBe(false);
  });

  it('is deterministic and derived-copy only (the input direction array is untouched)', () => {
    const dir: [number, number, number] = [0.5, -1, -0.6];
    const a = deriveShadowCamera(LEVEL, dir);
    const b = deriveShadowCamera(LEVEL, dir);
    expect(a.lightPosition).toEqual(b.lightPosition);
    expect(dir).toEqual([0.5, -1, -0.6]); // never normalized in place
  });

  it('degrades finitely on a degenerate direction (defensive; unreachable on a validated snapshot)', () => {
    const p = deriveShadowCamera(LEVEL, [0, 0, 0]);
    expect(Number.isFinite(p.lightPosition[0])).toBe(true);
    expect(p.lightPosition).toEqual([24, 2, 0]); // the zero normalized copy ⇒ centre
  });
});

describe('packet 52 — the §41.1.4 decision (the fixture shadowCases replay)', () => {
  // The five promoted fixture cases, verbatim (inputs + expected outcomes).
  const cases = [
    {
      id: 'shadow-on',
      input: { webgl2: true, castShadow: true, probeOk: true, level: LEVEL, direction: DIR },
      expect: { shadows: 'on' as const },
    },
    {
      id: 'shadow-author-off',
      input: { webgl2: true, castShadow: false, probeOk: true, level: LEVEL, direction: DIR },
      expect: { shadows: 'off' as const, shadowReason: 'cast_shadow_false' as const },
    },
    {
      id: 'shadow-degraded-capability',
      input: { webgl2: true, castShadow: true, probeOk: false, level: LEVEL, direction: DIR },
      expect: { shadows: 'off' as const, shadowReason: 'shadow_unsupported' as const },
    },
    {
      id: 'shadow-degraded-bounds',
      input: { webgl2: true, castShadow: true, probeOk: true, level: LEVEL_WIDE, direction: DIR },
      expect: { shadows: 'off' as const, shadowReason: 'shadow_bounds_exceeded' as const },
    },
    {
      id: 'no-webgl2',
      input: { webgl2: false, castShadow: true, probeOk: false, level: LEVEL, direction: DIR },
      expect: { error: 'render_unsupported' as const },
    },
  ];

  for (const c of cases) {
    it(`${c.id} ⇒ the exact fixture outcome`, () => {
      const got = decideShadows(c.input);
      if (c.expect.error) {
        expect(got).toEqual({ ok: false, error: c.expect.error });
      } else {
        expect(got.ok).toBe(true);
        if (!got.ok) return;
        expect(got.shadows).toBe(c.expect.shadows);
        if (c.expect.shadowReason) {
          expect((got as { shadowReason?: string }).shadowReason).toBe(c.expect.shadowReason);
        } else {
          expect('shadowReason' in got).toBe(false); // `on` carries no reason
        }
      }
    });
  }

  it('the priority order is webgl2 → castShadow → probe → bounds (the fixture reference order)', () => {
    // probe failure beats bounds: the reference derivation checks probeOk
    // first (no fixture case has both, but the order is pinned anyway).
    const got = decideShadows({ webgl2: true, castShadow: true, probeOk: false, level: LEVEL_WIDE, direction: DIR });
    expect(got.ok && got.shadows === 'off' && got.shadowReason === 'shadow_unsupported').toBe(true);
    // castShadow false beats probe failure and bounds (the author's choice).
    const got2 = decideShadows({ webgl2: true, castShadow: false, probeOk: false, level: LEVEL_WIDE, direction: DIR });
    expect(got2.ok && got2.shadows === 'off' && got2.shadowReason === 'cast_shadow_false').toBe(true);
    // the hard outcome beats everything.
    const got3 = decideShadows({ webgl2: false, castShadow: false, probeOk: false, level: LEVEL_WIDE, direction: DIR });
    expect(got3).toEqual({ ok: false, error: 'render_unsupported' });
  });

  it('the plan is present on every ok outcome (the directional position is derived even when shadows are off)', () => {
    const off = decideShadows({ webgl2: true, castShadow: false, probeOk: true, level: LEVEL, direction: DIR });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const norm = Math.hypot(0.5, -1, -0.6);
    expect(off.plan.lightPosition[0]).toBe(24 - (0.5 / norm) * 20);
    expect(off.plan.centre).toEqual([24, 2, 0]);
  });
});

describe('packet 52 — the §41.2.1 frozen preset rows', () => {
  it('carries exactly the three fixture rows (bit-equal, deep-frozen, closed)', () => {
    expect({
      'matte-ground': SURFACE_PRESETS['matte-ground'],
      hazard: SURFACE_PRESETS.hazard,
      beacon: SURFACE_PRESETS.beacon,
    }).toEqual(FIXTURE_PRESETS);
    expect(Object.keys(SURFACE_PRESETS).sort()).toEqual(['beacon', 'hazard', 'matte-ground']); // no fourth row
    expect(Object.isFrozen(SURFACE_PRESETS)).toBe(true);
    for (const row of Object.values(SURFACE_PRESETS)) expect(Object.isFrozen(row)).toBe(true);
  });
});

describe('packet 52 — the §41.1.2 light realization plans', () => {
  const ambientLight = { type: 'ambient' as const, color: '#8899bb', intensity: 0.55 };
  const keyLight = {
    type: 'directional' as const,
    color: '#fff4e0',
    intensity: 2.2,
    direction: DIR,
    castShadow: true,
  };

  it('ambients plan with no position dependence; directionals carry the derived position/target', () => {
    const decision = decideShadows({ webgl2: true, castShadow: true, probeOk: true, level: LEVEL, direction: DIR });
    const plans = planSceneLights([keyLight, ambientLight], LEVEL, decision);
    expect(plans).toHaveLength(2);
    const key = plans.find((p) => p.kind === 'directional');
    const amb = plans.find((p) => p.kind === 'ambient');
    expect(amb).toEqual({ kind: 'ambient', color: '#8899bb', intensity: 0.55 });
    const norm = Math.hypot(0.5, -1, -0.6);
    expect(key).toEqual({
      kind: 'directional',
      color: '#fff4e0',
      intensity: 2.2,
      position: [
        24 - (0.5 / norm) * 20,
        2 - (-1 / norm) * 20,
        0 - (-0.6 / norm) * 20,
      ],
      target: [24, 2, 0],
      castShadow: true,
    });
  });

  it('the castShadow flag follows the decision (author-off ⇒ the light is realized without a shadow)', () => {
    const keyOff = { ...keyLight, castShadow: false };
    const decision = decideShadows({ webgl2: true, castShadow: false, probeOk: true, level: LEVEL, direction: DIR });
    const plans = planSceneLights([keyOff], LEVEL, decision);
    expect(plans).toHaveLength(1);
    const key = plans[0]!;
    expect(key.kind).toBe('directional');
    if (key.kind === 'directional') {
      expect(key.castShadow).toBe(false);
      // the position is still derived (§41.1.2 rule 2 — shadow state or not)
      expect(key.target).toEqual([24, 2, 0]);
    }
  });

  it('rule 4: at most one directional node and one ambient node per realized scene (first of each wins)', () => {
    const decision = decideShadows({ webgl2: true, castShadow: true, probeOk: true, level: LEVEL, direction: DIR });
    const plans = planSceneLights([keyLight, keyLight, ambientLight, ambientLight], LEVEL, decision);
    expect(plans.filter((p) => p.kind === 'directional')).toHaveLength(1);
    expect(plans.filter((p) => p.kind === 'ambient')).toHaveLength(1);
  });

  it('bounds-exceeded ⇒ the key light is realized without a shadow (soft degradation)', () => {
    const decision = decideShadows({ webgl2: true, castShadow: true, probeOk: true, level: LEVEL_WIDE, direction: DIR });
    const plans = planSceneLights([keyLight], LEVEL_WIDE, decision);
    expect(plans).toHaveLength(1);
    const key = plans[0]!;
    expect(key.kind).toBe('directional');
    if (key.kind === 'directional') expect(key.castShadow).toBe(false);
  });

  it('no authored lights ⇒ no light nodes (the M1 fixed pair is v1/v2 only)', () => {
    const decision = decideShadows({ webgl2: true, castShadow: false, probeOk: true, level: LEVEL, direction: DIR });
    expect(planSceneLights([], LEVEL, decision)).toEqual([]);
  });
});