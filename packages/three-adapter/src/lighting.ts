/**
 * M3 light, shadow and surface realization math —
 * `docs/contracts/presentation.md` §§41.1/41.2 (packet 52).
 *
 * Pure by contract: no three.js, no DOM, no Node built-ins, no clock. The
 * adapter (§41.9: "shadow/light realization options on the accepted
 * `createSceneAdapter` options") maps these plans onto THREE objects; the
 * browser checklist (B11, named checklist per Gate K) compares the realized
 * values against the promoted fixture
 * `fixtures/m3/media/render/light-surface-cases.json` (whose digests the
 * media checker pins and whose rules it re-derives independently).
 *
 * The authored document is never rewritten: only **derived copies** of the
 * authored `direction` are normalized (same rule as accepted project-model
 * §10.1 quaternions, presentation.md §41.1.2 rule 2).
 */

/** §41.1.2 — the single conservative shadow profile. Changing a value is a
 * contract change (presentation.md §41.10); the frozen packet-38 executed
 * configuration (real-browser probe, baseline.md §1). */
export const SHADOW_PROFILE = Object.freeze({
  /** `SHADOW_MAP_SIZE` — shadow map width = height, texels. */
  mapSize: 512,
  /** `SHADOW_TYPE` — three's `THREE.PCFShadowMap` (not PCFSoftShadowMap, not VSM). */
  type: 'PCFShadowMap' as const,
  /** `SHADOW_NEAR` — shadow camera near plane, metres. */
  near: 0.5,
  /** `SHADOW_DISTANCE` — light position offset from the shadow target, metres. */
  distance: 20,
  /** `SHADOW_MARGIN` — metres added around the level bounds. */
  margin: 2,
  /** `SHADOW_HALF_EXTENT_MAX` — the largest accepted shadow half-extent, metres. */
  halfExtentMax: 64,
  /** `SHADOW_FAR_MAX` — the shadow camera far cap, metres. */
  farMax: 200,
} as const);

/**
 * Phase 17.4: the directional light's shadow settings when its data sets
 * none (`light.shadowMapSize`, `shadowBias`, `shadowNormalBias`,
 * `shadowExtent`; the same values and their genre-neutral reasons as
 * project-model `DIRECTIONAL_SHADOW_DEFAULTS`). They replace the frozen
 * profile's 512² map without bias (which striped instance sets and curved
 * models with self-shadowing); SHADOW_PROFILE keeps the camera derivation.
 */
export const DIRECTIONAL_SHADOW_DEFAULTS = Object.freeze({
  /** 1024²: a 4.7 cm texel over the default 48 m square. */
  mapSize: 1024,
  /** Removes acne on surfaces facing the light without lifting the shadow off its caster. */
  bias: -0.0005,
  /** Metres along the normal: about half a texel at the defaults (no stripes on grazing surfaces). */
  normalBias: 0.02,
  /** Half the side of the square that follows the camera in a v4 game (the former engine constant). */
  extent: 24,
} as const);

/** The shadow settings of a directional light (its data over the defaults). */
export function directionalShadowSettings(l: AuthoredLight | null): { mapSize: number; bias: number; normalBias: number; extent: number } {
  const d = DIRECTIONAL_SHADOW_DEFAULTS;
  const fin = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    mapSize: fin(l?.shadowMapSize, d.mapSize),
    bias: fin(l?.shadowBias, d.bias),
    normalBias: fin(l?.shadowNormalBias, d.normalBias),
    extent: fin(l?.shadowExtent, d.extent),
  };
}

/**
 * §41.2.1 — the three frozen preset rows (a **value row**, never a resource).
 * Single change point per package (dependencies.md §4.2 pattern):
 * `three-adapter` has no `project-model` edge (§4.1), so it keeps its own
 * copy of the closed table; `lighting.test.ts` pins it bit-equal against the
 * contract rows, and the media checker pins the promoted fixture against the
 * model table — the two are transitively equal.
 */
export const SURFACE_PRESETS = Object.freeze({
  'matte-ground': Object.freeze({
    color: '#6f6f6f',
    roughness: 0.95,
    metalness: 0,
    emissive: '#000000',
    emissiveIntensity: 0,
  }),
  hazard: Object.freeze({
    color: '#d42a1e',
    roughness: 0.55,
    metalness: 0,
    emissive: '#3a0703',
    emissiveIntensity: 0.35,
  }),
  beacon: Object.freeze({
    color: '#2f7fd4',
    roughness: 0.4,
    metalness: 0.1,
    emissive: '#1bc8ff',
    emissiveIntensity: 1.2,
  }),
} as const);

/** The authored level bounds (`content.game.level`). */
export interface ShadowLevel {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** The §41.1.3 derivation output. The `direction` input is used through a
 * derived normalized copy only; the document value is never rewritten. */
export interface ShadowPlan {
  /** `c = ((minX + maxX) / 2, (minY + maxY) / 2, 0)`. */
  readonly centre: [number, number, number];
  /** `max((maxX − minX) / 2, (maxY − minY) / 2) + SHADOW_MARGIN`. */
  readonly halfExtent: number;
  /** `min(SHADOW_DISTANCE + halfExtent + SHADOW_MARGIN, SHADOW_FAR_MAX)`. */
  readonly far: number;
  /** `c − n · SHADOW_DISTANCE` with `n` the normalized direction copy. */
  readonly lightPosition: [number, number, number];
  /** The derived orthographic shadow camera. */
  readonly camera: Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
  }>;
  /** `false` iff `halfExtent > SHADOW_HALF_EXTENT_MAX` (the shadow is not
   * allocated for that scene; §41.1.4 degradation with reason
   * `shadow_bounds_exceeded`). */
  readonly withinBounds: boolean;
}

/**
 * §41.1.3 — the exact shadow camera derivation. Normative inputs: the
 * authored level bounds and the directional `direction` `d` (let
 * `n = d / ‖d‖`). Z is presentation depth only: the shadow camera covers the
 * authored XY level, not the whole scene.
 *
 * Defensive note: a runtime-validated v3 snapshot guarantees each
 * `|v| ≤ 1`, `‖v‖ ≥ 1e-6` (project-model §23.3.4); a non-finite or
 * degenerate direction cannot reach this function from that path. If it
 * did, `lightPosition` degrades to `centre` (the zero normalized copy) —
 * still a finite, bounded result.
 */
export function deriveShadowCamera(
  level: ShadowLevel,
  direction: readonly [number, number, number],
): ShadowPlan {
  const dx = direction[0];
  const dy = direction[1];
  const dz = direction[2];
  const norm = Math.hypot(dx, dy, dz);
  const valid = Number.isFinite(norm) && norm >= 1e-6;
  const nx = valid ? dx / norm : 0;
  const ny = valid ? dy / norm : 0;
  const nz = valid ? dz / norm : 0;
  const cx = (level.minX + level.maxX) / 2;
  const cy = (level.minY + level.maxY) / 2;
  const halfExtent =
    Math.max((level.maxX - level.minX) / 2, (level.maxY - level.minY) / 2) +
    SHADOW_PROFILE.margin;
  const far = Math.min(
    SHADOW_PROFILE.distance + halfExtent + SHADOW_PROFILE.margin,
    SHADOW_PROFILE.farMax,
  );
  // `cx − 0` on an axis with a zero normalized component yields `-0`; the
  // exact zero is canonicalized to `+0` (same value; stable strict-equality
  // and JSON).
  const clean = (v: number): number => (Object.is(v, -0) ? 0 : v);
  return {
    centre: [cx, cy, 0],
    halfExtent,
    far,
    lightPosition: [
      clean(cx - nx * SHADOW_PROFILE.distance),
      clean(cy - ny * SHADOW_PROFILE.distance),
      clean(0 - nz * SHADOW_PROFILE.distance),
    ],
    camera: Object.freeze({
      left: -halfExtent,
      right: halfExtent,
      top: halfExtent,
      bottom: -halfExtent,
      near: SHADOW_PROFILE.near,
      far,
    }),
    withinBounds: halfExtent <= SHADOW_PROFILE.halfExtentMax,
  };
}

/** The §41.1.4 closed shadow-reason set (present iff `shadows === 'off'`). */
export type ShadowReason =
  | 'cast_shadow_false'
  | 'shadow_bounds_exceeded'
  | 'shadow_unsupported';

/** The §41.1.4 decision. The hard outcome (`render_unsupported`) is the
 * unplayable case: no WebGL 2 at all. */
export type ShadowOutcome =
  | { readonly ok: true; readonly shadows: 'on'; readonly plan: ShadowPlan }
  | {
      readonly ok: true;
      readonly shadows: 'off';
      readonly shadowReason: ShadowReason;
      readonly plan: ShadowPlan;
    }
  | { readonly ok: false; readonly error: 'render_unsupported' };

/**
 * §41.1.4 — the capability/degradation decision, in the exact priority the
 * promoted fixture's reference re-derivation uses (media checker, the
 * `shadow` group):
 *
 * 1. no WebGL 2 ⇒ hard `render_unsupported` (the M3 target is WebGL 2);
 * 2. the author wrote `castShadow: false` (or no shadow-casting light) ⇒
 *    `off` / `cast_shadow_false` (the author's own choice — not an error);
 * 3. the renderer cannot allocate the shadow map (the probe failed) ⇒
 *    `off` / `shadow_unsupported` (soft: rendering continues with the key
 *    light only);
 * 4. `halfExtent > SHADOW_HALF_EXTENT_MAX` ⇒ `off` /
 *    `shadow_bounds_exceeded` (soft);
 * 5. otherwise ⇒ `on` with the §41.1.3 plan.
 *
 * The `plan` is present on every `ok: true` outcome — §41.1.2 rule 2 derives
 * the directional light position (`target − n · SHADOW_DISTANCE`) and target
 * (the shadow centre) regardless of the shadow state.
 */
export function decideShadows(input: {
  readonly webgl2: boolean;
  readonly castShadow: boolean;
  readonly probeOk: boolean;
  readonly level: ShadowLevel;
  readonly direction: readonly [number, number, number];
}): ShadowOutcome {
  const plan = deriveShadowCamera(input.level, input.direction);
  if (!input.webgl2) return { ok: false, error: 'render_unsupported' };
  if (!input.castShadow)
    return { ok: true, shadows: 'off', shadowReason: 'cast_shadow_false', plan };
  if (!input.probeOk)
    return { ok: true, shadows: 'off', shadowReason: 'shadow_unsupported', plan };
  if (!plan.withinBounds)
    return { ok: true, shadows: 'off', shadowReason: 'shadow_bounds_exceeded', plan };
  return { ok: true, shadows: 'on', plan };
}

/**
 * The structural shape of the authored `components.light` value
 * (project-model §23.3.4; `three-adapter` has no `project-model` edge, so
 * the adapter reads it structurally — the runtime-validated snapshot
 * guarantees the full shape).
 */
export interface AuthoredLight {
  readonly type: 'directional' | 'ambient';
  /** `^#[0-9a-f]{6}$`, canonical lowercase. */
  readonly color: string;
  /** [0, 8]. */
  readonly intensity: number;
  /** Required iff `type === 'directional'`; each `|v| ≤ 1`, `‖v‖ ≥ 1e-6`. */
  readonly direction?: readonly [number, number, number];
  /** Directional only; defaulted to `false` by the §23.7 normalizer. */
  readonly castShadow?: boolean;
  /** Phase 17.4 (directional, optional): the shadow map settings (see DIRECTIONAL_SHADOW_DEFAULTS). */
  readonly shadowMapSize?: number;
  readonly shadowBias?: number;
  readonly shadowNormalBias?: number;
  readonly shadowExtent?: number;
}

/** The structural shape of the authored `components.surface` value
 * (project-model §23.3.5 copied value row). */
export interface AuthoredSurface {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
}

/**
 * §41.1.2 rule 1/2 — the per-authored-light realization plan. `ambient` →
 * `(color, intensity)` with no position dependence; `directional` →
 * `(color, intensity)` + the derived position/target (the §41.1.3 centre and
 * `c − n · SHADOW_DISTANCE`), with `castShadow` exactly the decided
 * realization state. The light entities' own `transform` is irrelevant
 * (rule 3): only the component value is read.
 */
export function planSceneLights(
  lights: readonly AuthoredLight[],
  level: ShadowLevel | null,
  decision: ShadowOutcome,
): Array<
  | { readonly kind: 'ambient'; readonly color: string; readonly intensity: number }
  | {
      readonly kind: 'directional';
      readonly color: string;
      readonly intensity: number;
      readonly position: [number, number, number];
      readonly target: [number, number, number];
      readonly castShadow: boolean;
    }
> {
  // Defensive, unreachable on a runtime-validated v3 snapshot (game.level is
  // required there): fall back to the zero level so the derivation always
  // returns a finite position.
  const lvl = level ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const out: Array<
    | { readonly kind: 'ambient'; readonly color: string; readonly intensity: number }
    | {
        readonly kind: 'directional';
        readonly color: string;
        readonly intensity: number;
        readonly position: [number, number, number];
        readonly target: [number, number, number];
        readonly castShadow: boolean;
      }
  > = [];
  // §41.1.2 rule 4: exactly one directional node and one ambient node per
  // realized scene (the model caps both at 1); the first of each kind wins.
  let ambientTaken = false;
  let directionalTaken = false;
  for (const l of lights) {
    if (l.type === 'ambient') {
      if (ambientTaken) continue;
      ambientTaken = true;
      out.push({ kind: 'ambient', color: l.color, intensity: l.intensity });
    } else {
      if (directionalTaken) continue;
      directionalTaken = true;
      const plan =
        decision.ok && decision.plan
          ? decision.plan
          : deriveShadowCamera(lvl, l.direction ?? [0, -1, 0]);
      const shadowsOn = decision.ok && decision.shadows === 'on';
      out.push({
        kind: 'directional',
        color: l.color,
        intensity: l.intensity,
        position: plan.lightPosition,
        target: plan.centre,
        castShadow: shadowsOn,
      });
    }
  }
  return out;
}