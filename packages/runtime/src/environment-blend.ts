/**
 * The environment a blend of presets looks like — pure
 * maths shared by the renderer (Play, export) and the editor's preview.
 *
 * The simulation (`environment-director.ts`) owns only the blend state: a
 * weight per key (`''` = the base look, a preset id, or a script's patched
 * preset). This module turns those weights into values:
 *
 * - numbers blend linearly, colours linearly in linear-light RGB (then back
 *   to "#rrggbb"), light directions linearly then normalized, angles (sun
 *   azimuth) the short way round;
 * - skies with the same mode (and the same images) blend field by field;
 *   different skies (another mode, another image, or none) become
 *   cross-fade layers the renderer draws over each other;
 * - fog blends in the heavier contributor's mode (linear ↔ exp2 converted:
 *   density = 2 / far, far = 2 / density); a contributor without fog thins
 *   it (linear: the far distance stretches by 1 / weight; exp2: the density
 *   scales by the weight);
 * - post: exposure, bloom strength/radius/threshold, grading and vignette
 *   numbers blend (a contributor without the effect counts as its neutral
 *   value); tone mapping, anti-aliasing, AO, depth of field and the LUT image
 *   are the heaviest contributor's (they cannot blend).
 *
 * Pure: no three.js, no I/O.
 */
import type { EnvironmentLookParts, EnvironmentPreset, EnvironmentPresetLight, FogConfig, PostConfig, SkyConfig } from '@thirdlight/project-model';

/** What the renderer reads each frame while a game has used `ctx.environment`. */
export interface EnvironmentBlendView {
  /** Weight per key (sorted by key; the weights sum to 1): `''` the base look, a preset id, or a patched preset's key. */
  readonly weights: readonly (readonly [string, number])[];
  /** The patched presets (`set(id, { override })`) by key. */
  readonly overrides: Readonly<Record<string, EnvironmentOverride>>;
  /** The preset the last change went to (null: the base look). */
  readonly target: string | null;
  /** How far the running blend is (0–1; 1 when none runs). */
  readonly progress: number;
  /**
   * The active scene, once it is not the start scene (absent before): its look
   * is the base look, blending in from `from`'s with `weight` (the active
   * scene's share, 0–1; 1 and `from` null when no blend runs).
   */
  readonly scene?: { readonly active: string | null; readonly from: string | null; readonly weight: number };
}

export interface EnvironmentOverride {
  /** The preset patched (null: the base look). */
  readonly preset: string | null;
  readonly patch: EnvironmentLookParts;
}

/** The base look: the project environment with the playing level's look over it. */
export interface EnvironmentBaseLook {
  readonly sky?: SkyConfig;
  readonly fog?: FogConfig;
  readonly post?: PostConfig;
}

/** The blended look (sky / fog / post in the environment's own shapes). */
export interface BlendedEnvironment {
  /** One sky (the contributors agreed on mode and images), or absent (none). */
  readonly sky?: SkyConfig;
  /** Several different skies cross-fading (null: no sky — the scene's background); weights sum to 1. */
  readonly skyLayers?: readonly { readonly sky: SkyConfig | null; readonly weight: number }[];
  readonly fog?: FogConfig;
  readonly post?: PostConfig;
  /** The lightmap multiplier (1, "#ffffff" = the bake as it is). */
  readonly lightmap: { readonly intensity: number; readonly tint: string };
}

/** A scene light's values (authored, or blended). */
export interface EnvironmentLightValues {
  color: string;
  intensity: number;
  direction?: [number, number, number];
  groundColor?: string;
}

/** Which light an entry may match. */
export interface EnvironmentLightIdentity {
  readonly id: string;
  /** The entity's tag mask. */
  readonly tags: number;
  readonly type: string;
}

/** Defaults the renderer uses for absent sky fields (environment.ts buildSky; blended from these). */
export const SKY_DEFAULTS = Object.freeze({
  turbidity: 6,
  rayleigh: 1.5,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  sunElevation: 35,
  sunAzimuth: 160,
  topColor: '#3d7cd6',
  horizonColor: '#bfe3ff',
  bottomColor: '#757575',
  color: '#7ec8ff',
  intensity: 1,
  environmentIntensity: 1,
});
/** Fog defaults (environment.ts applyFog). */
export const FOG_DEFAULTS = Object.freeze({ near: 10, far: 120, density: 0.01 });
/** The farthest linear fog distance (the model's limit). */
const FOG_FAR_MAX = 10000;

// ---- colours ------------------------------------------------------------------------

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** "#rrggbb" → linear-light [r, g, b] (0–1). */
export function colorToLinear(hex: string): [number, number, number] {
  const v = /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;
  return [toLinear(((v >> 16) & 255) / 255), toLinear(((v >> 8) & 255) / 255), toLinear((v & 255) / 255)];
}

/** Linear-light [r, g, b] → "#rrggbb". */
export function linearToColor(rgb: readonly number[]): string {
  const ch = (x: number): string => Math.round(Math.max(0, Math.min(1, toSrgb(Math.max(0, x)))) * 255).toString(16).padStart(2, '0');
  return `#${ch(rgb[0]!)}${ch(rgb[1]!)}${ch(rgb[2]!)}`;
}

/** Weighted colour mix in linear light (weights need not sum to 1: they are normalized). */
export function mixColors(parts: readonly (readonly [string, number])[]): string {
  let r = 0, g = 0, b = 0, w = 0;
  for (const [c, k] of parts) {
    const l = colorToLinear(c);
    r += l[0] * k;
    g += l[1] * k;
    b += l[2] * k;
    w += k;
  }
  return w <= 0 ? parts[0]?.[0] ?? '#ffffff' : linearToColor([r / w, g / w, b / w]);
}

const mixNumbers = (parts: readonly (readonly [number, number])[]): number => {
  let s = 0, w = 0;
  for (const [v, k] of parts) {
    s += v * k;
    w += k;
  }
  return w <= 0 ? (parts[0]?.[0] ?? 0) : s / w;
};

/** Angles in degrees, blended the short way round (−180–180). */
const mixAngles = (parts: readonly (readonly [number, number])[]): number => {
  let x = 0, y = 0;
  for (const [deg, k] of parts) {
    const a = (deg * Math.PI) / 180;
    x += Math.cos(a) * k;
    y += Math.sin(a) * k;
  }
  if (Math.hypot(x, y) < 1e-9) return parts[0]?.[0] ?? 0;
  return (Math.atan2(y, x) * 180) / Math.PI;
};

// ---- easing -------------------------------------------------------------------------

export const ENVIRONMENT_EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const;
export type EnvironmentEasing = (typeof ENVIRONMENT_EASINGS)[number];

/** The eased share of a blend at progress t (0–1). */
export function easeEnvironment(easing: EnvironmentEasing, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (easing) {
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x * x * (3 - 2 * x);
    default:
      return x;
  }
}

// ---- resolving a key to its look parts ------------------------------------------------

interface ResolvedParts {
  sky?: SkyConfig;
  fog?: FogConfig;
  post?: PostConfig;
  lights: readonly EnvironmentPresetLight[];
  lightmap: { intensity?: number; tint?: string };
}

const mergePost = (base: PostConfig | undefined, over: PostConfig | undefined, deep: boolean): PostConfig | undefined => {
  if (over === undefined) return base;
  if (base === undefined) return over;
  const out: Record<string, unknown> = { ...base, ...over };
  if (deep) for (const k of ['bloom', 'grading', 'vignette', 'ssao', 'dof'] as const) if (base[k] !== undefined && over[k] !== undefined) out[k] = { ...base[k], ...over[k] };
  return out as PostConfig;
};

/** A key's look: the base, a preset over the base, or a patch over either. */
export function resolveEnvironmentKey(key: string, base: EnvironmentBaseLook, presets: ReadonlyMap<string, EnvironmentPreset>, overrides: Readonly<Record<string, EnvironmentOverride>>): ResolvedParts {
  const ov = overrides[key];
  if (ov !== undefined) {
    const r = resolveEnvironmentKey(ov.preset ?? '', base, presets, {});
    const p = ov.patch;
    return {
      ...(p.sky !== undefined ? { sky: { ...(r.sky ?? { mode: 'gradient' }), ...p.sky } as SkyConfig } : r.sky !== undefined ? { sky: r.sky } : {}),
      ...(p.fog !== undefined ? { fog: { ...(r.fog ?? { mode: 'linear', color: '#ffffff' }), ...p.fog } as FogConfig } : r.fog !== undefined ? { fog: r.fog } : {}),
      ...(mergePost(r.post, p.post, true) !== undefined ? { post: mergePost(r.post, p.post, true)! } : {}),
      lights: [...r.lights, ...(p.lights ?? [])],
      lightmap: { ...r.lightmap, ...(p.lightmap ?? {}) },
    };
  }
  const preset = key === '' ? undefined : presets.get(key);
  if (preset === undefined) return { ...(base.sky !== undefined ? { sky: base.sky } : {}), ...(base.fog !== undefined ? { fog: base.fog } : {}), ...(base.post !== undefined ? { post: base.post } : {}), lights: [], lightmap: {} };
  const sky = preset.sky ?? base.sky;
  const fog = preset.fog ?? base.fog;
  const post = mergePost(base.post, preset.post, false);
  return { ...(sky !== undefined ? { sky } : {}), ...(fog !== undefined ? { fog } : {}), ...(post !== undefined ? { post } : {}), lights: preset.lights ?? [], lightmap: preset.lightmap ?? {} };
}

// ---- blending -------------------------------------------------------------------------

const skyGroupKey = (s: SkyConfig | undefined): string => (s === undefined ? '-' : s.mode === 'texture' ? `texture|${s.texture ?? ''}|${(s.cube ?? []).join(',')}` : s.mode);

function blendSkies(parts: readonly (readonly [SkyConfig, number])[]): SkyConfig {
  const first = parts[0]![0];
  const heaviest = [...parts].sort((a, b) => b[1] - a[1])[0]![0];
  const n = (k: keyof typeof SKY_DEFAULTS): number => mixNumbers(parts.map(([s, w]) => [(s[k] as number | undefined) ?? (SKY_DEFAULTS[k] as number), w]));
  const c = (k: 'topColor' | 'horizonColor' | 'bottomColor' | 'color'): string => mixColors(parts.map(([s, w]) => [s[k] ?? SKY_DEFAULTS[k], w]));
  const common = { intensity: n('intensity'), environmentIntensity: n('environmentIntensity') };
  switch (first.mode) {
    case 'procedural':
      return {
        mode: 'procedural',
        turbidity: n('turbidity'),
        rayleigh: n('rayleigh'),
        mieCoefficient: n('mieCoefficient'),
        mieDirectionalG: n('mieDirectionalG'),
        ...(heaviest.sunFromLight !== undefined ? { sunFromLight: heaviest.sunFromLight } : {}),
        sunElevation: n('sunElevation'),
        sunAzimuth: mixAngles(parts.map(([s, w]) => [s.sunAzimuth ?? SKY_DEFAULTS.sunAzimuth, w])),
        ...common,
      };
    case 'gradient':
      return { mode: 'gradient', topColor: c('topColor'), horizonColor: c('horizonColor'), bottomColor: c('bottomColor'), ...common };
    case 'color':
      return { mode: 'color', color: c('color'), ...common };
    default:
      return { ...first, ...common };
  }
}

function fogAs(f: FogConfig, mode: 'linear' | 'exp2'): { near: number; far: number; density: number } {
  const near = f.near ?? FOG_DEFAULTS.near;
  const far = f.far ?? FOG_DEFAULTS.far;
  const density = f.density ?? FOG_DEFAULTS.density;
  if (f.mode === mode) return { near, far, density };
  // Converted: the distance where exp2 fog is ~98 % thick is 2 / density.
  return mode === 'exp2' ? { near, far, density: Math.min(1, 2 / Math.max(1e-6, far)) } : { near: 0, far: Math.min(FOG_FAR_MAX, 2 / Math.max(1e-6, density)), density };
}

function blendFog(parts: readonly (readonly [FogConfig | undefined, number])[]): FogConfig | undefined {
  const foggy = parts.filter((p): p is readonly [FogConfig, number] => p[0] !== undefined && p[0].mode !== 'none');
  if (foggy.length === 0) {
    const anyNone = parts.find((p) => p[0] !== undefined);
    return anyNone?.[0];
  }
  const total = parts.reduce((s, p) => s + p[1], 0);
  const fogW = foggy.reduce((s, p) => s + p[1], 0);
  const mode = ([...foggy].sort((a, b) => b[1] - a[1])[0]![0].mode) as 'linear' | 'exp2';
  const color = mixColors(foggy.map(([f, w]) => [f.color, w]));
  const share = total <= 0 ? 1 : fogW / total;
  if (mode === 'linear') {
    const near = mixNumbers(foggy.map(([f, w]) => [fogAs(f, 'linear').near, w]));
    const far = mixNumbers(foggy.map(([f, w]) => [fogAs(f, 'linear').far, w]));
    const thinned = share >= 1 ? far : Math.min(FOG_FAR_MAX, near + (far - near) / Math.max(1e-6, share));
    return { mode: 'linear', color, near, far: Math.max(near, thinned) };
  }
  const density = mixNumbers(foggy.map(([f, w]) => [fogAs(f, 'exp2').density, w])) * share;
  return { mode: 'exp2', color, density };
}

function heaviestOf<T>(parts: readonly (readonly [T, number])[]): T | undefined {
  let best: T | undefined;
  let bw = -1;
  for (const [v, w] of parts) if (w > bw) { best = v; bw = w; }
  return best;
}

function blendPost(parts: readonly (readonly [PostConfig | undefined, number])[]): PostConfig | undefined {
  if (parts.every((p) => p[0] === undefined)) return undefined;
  const all = parts.map(([p, w]) => [p ?? {}, w] as const);
  const heavy = heaviestOf(all) ?? {};
  const out: Record<string, unknown> = {};
  if (all.some(([p]) => p.toneMapping !== undefined) && heavy.toneMapping !== undefined) out['toneMapping'] = heavy.toneMapping;
  if (all.some(([p]) => p.exposure !== undefined)) out['exposure'] = mixNumbers(all.map(([p, w]) => [p.exposure ?? 1, w]));
  if (all.some(([p]) => p.bloom?.enabled === true)) {
    out['bloom'] = {
      enabled: true,
      strength: mixNumbers(all.map(([p, w]) => [p.bloom?.enabled === true ? (p.bloom.strength ?? 0.6) : 0, w])),
      radius: mixNumbers(all.map(([p, w]) => [p.bloom?.radius ?? 0.4, w])),
      threshold: mixNumbers(all.map(([p, w]) => [p.bloom?.threshold ?? 0.85, w])),
    };
  } else if (heavy.bloom !== undefined) out['bloom'] = heavy.bloom;
  if (all.some(([p]) => p.grading !== undefined)) {
    const g = (k: 'brightness' | 'contrast' | 'saturation' | 'lift' | 'gamma' | 'gain', neutral: number): number => mixNumbers(all.map(([p, w]) => [p.grading?.[k] ?? neutral, w]));
    const lut = heavy.grading?.lut;
    out['grading'] = {
      brightness: g('brightness', 0),
      contrast: g('contrast', 0),
      saturation: g('saturation', 0),
      lift: g('lift', 0),
      gamma: g('gamma', 1),
      gain: g('gain', 1),
      tint: mixColors(all.map(([p, w]) => [p.grading?.tint ?? '#ffffff', w])),
      ...(lut !== undefined ? { lut } : {}),
    };
  }
  if (all.some(([p]) => p.vignette?.enabled === true)) {
    out['vignette'] = {
      enabled: true,
      darkness: mixNumbers(all.map(([p, w]) => [p.vignette?.enabled === true ? (p.vignette.darkness ?? 0.5) : 0, w])),
      offset: mixNumbers(all.map(([p, w]) => [p.vignette?.offset ?? 1, w])),
    };
  } else if (heavy.vignette !== undefined) out['vignette'] = heavy.vignette;
  for (const k of ['ssao', 'dof', 'antialias'] as const) if (heavy[k] !== undefined) out[k] = heavy[k];
  return out as PostConfig;
}

/** The look of a blend state over a base look. */
export function blendEnvironment(base: EnvironmentBaseLook, presets: ReadonlyMap<string, EnvironmentPreset>, view: Pick<EnvironmentBlendView, 'weights' | 'overrides'>): BlendedEnvironment {
  return blendEnvironmentOver([[base, 1]], presets, view);
}

/**
 * The look of a blend state over several base looks, each with its share
 * (two scenes' looks while the active scene's blends in): every key resolves
 * over every base, weighted by both, so a part one scene leaves out (its fog)
 * thins as that scene's share grows, and a single base of share 1 is that
 * scene's look exactly.
 */
export function blendEnvironmentOver(bases: readonly (readonly [EnvironmentBaseLook, number])[], presets: ReadonlyMap<string, EnvironmentPreset>, view: Pick<EnvironmentBlendView, 'weights' | 'overrides'>): BlendedEnvironment {
  const parts: (readonly [ResolvedParts, number])[] = [];
  for (const [base, share] of bases) {
    if (!(share > 0)) continue;
    for (const [k, w] of view.weights) if (w > 0) parts.push([resolveEnvironmentKey(k, base, presets, view.overrides), w * share] as const);
  }
  if (parts.length === 0) parts.push([resolveEnvironmentKey('', bases[0]?.[0] ?? {}, presets, {}), 1]);
  // Sky: group by mode and images; one group blends, several cross-fade.
  const groups = new Map<string, { skies: [SkyConfig, number][]; none: boolean; weight: number }>();
  for (const [r, w] of parts) {
    const key = skyGroupKey(r.sky);
    let g = groups.get(key);
    if (g === undefined) groups.set(key, (g = { skies: [], none: r.sky === undefined, weight: 0 }));
    if (r.sky !== undefined) g.skies.push([r.sky, w]);
    g.weight += w;
  }
  const layers = [...groups.values()].map((g) => ({ sky: g.none ? null : blendSkies(g.skies), weight: g.weight }));
  const total = layers.reduce((s, l) => s + l.weight, 0) || 1;
  const skyPart: Pick<BlendedEnvironment, 'sky' | 'skyLayers'> =
    layers.length === 1 ? (layers[0]!.sky !== null ? { sky: layers[0]!.sky } : {}) : { skyLayers: layers.map((l) => ({ sky: l.sky, weight: l.weight / total })) };
  const fog = blendFog(parts.map(([r, w]) => [r.fog, w]));
  const post = blendPost(parts.map(([r, w]) => [r.post, w]));
  const lightmap = {
    intensity: mixNumbers(parts.map(([r, w]) => [r.lightmap.intensity ?? 1, w])),
    tint: mixColors(parts.map(([r, w]) => [r.lightmap.tint ?? '#ffffff', w])),
  };
  return { ...skyPart, ...(fog !== undefined ? { fog } : {}), ...(post !== undefined ? { post } : {}), lightmap };
}

/** Does a preset light entry match this light? (a tag entry needs the project's tag registry: name → bit) */
function matches(entry: EnvironmentPresetLight, who: EnvironmentLightIdentity, tagBits: ReadonlyMap<string, number>): boolean {
  if (entry.entity !== undefined) return entry.entity === who.id;
  if (entry.type !== undefined) return entry.type === who.type;
  if (entry.tag !== undefined) {
    const bit = tagBits.get(entry.tag.toLowerCase());
    return bit !== undefined && (who.tags & (1 << bit)) !== 0;
  }
  return true; // no target: every light
}

/** One light's values under one key's look (its entries in order over the authored values). */
export function lightValuesFor(authored: EnvironmentLightValues, who: EnvironmentLightIdentity, lights: readonly EnvironmentPresetLight[], tagBits: ReadonlyMap<string, number>): EnvironmentLightValues {
  const out: EnvironmentLightValues = { ...authored, ...(authored.direction !== undefined ? { direction: [...authored.direction] as [number, number, number] } : {}) };
  for (const e of lights) {
    if (!matches(e, who, tagBits)) continue;
    if (e.color !== undefined) out.color = e.color;
    if (e.intensity !== undefined) out.intensity = e.intensity;
    if (e.direction !== undefined) out.direction = [e.direction[0], e.direction[1], e.direction[2]];
    if (e.groundColor !== undefined) out.groundColor = e.groundColor;
  }
  return out;
}

/** True when some key of the blend sets anything on lights (the renderer skips the per-light work otherwise). */
export function blendTouchesLights(base: EnvironmentBaseLook, presets: ReadonlyMap<string, EnvironmentPreset>, view: Pick<EnvironmentBlendView, 'weights' | 'overrides'>): boolean {
  return view.weights.some(([k, w]) => w > 0 && resolveEnvironmentKey(k, base, presets, view.overrides).lights.length > 0);
}

/** A light's blended values. */
export function blendLight(
  authored: EnvironmentLightValues,
  who: EnvironmentLightIdentity,
  tagBits: ReadonlyMap<string, number>,
  base: EnvironmentBaseLook,
  presets: ReadonlyMap<string, EnvironmentPreset>,
  view: Pick<EnvironmentBlendView, 'weights' | 'overrides'>,
): EnvironmentLightValues {
  const vals = view.weights.filter(([, w]) => w > 0).map(([k, w]) => [lightValuesFor(authored, who, resolveEnvironmentKey(k, base, presets, view.overrides).lights, tagBits), w] as const);
  if (vals.length === 0) return lightValuesFor(authored, who, [], tagBits);
  const out: EnvironmentLightValues = {
    color: mixColors(vals.map(([v, w]) => [v.color, w])),
    intensity: mixNumbers(vals.map(([v, w]) => [v.intensity, w])),
  };
  if (vals.some(([v]) => v.direction !== undefined)) {
    let x = 0, y = 0, z = 0, tw = 0;
    for (const [v, w] of vals) {
      const d = v.direction ?? authored.direction ?? [0, -1, 0];
      const n = Math.hypot(d[0], d[1], d[2]) || 1;
      x += (d[0] / n) * w;
      y += (d[1] / n) * w;
      z += (d[2] / n) * w;
      tw += w;
    }
    const len = Math.hypot(x, y, z);
    // Opposite directions at an even blend cancel out: keep the heavier contributor's.
    out.direction = len < 1e-6 * Math.max(1, tw) ? (heaviestOf(vals)!.direction ?? authored.direction ?? [0, -1, 0]) : [x / len, y / len, z / len];
  }
  if (vals.some(([v]) => v.groundColor !== undefined)) out.groundColor = mixColors(vals.map(([v, w]) => [v.groundColor ?? authored.groundColor ?? '#444444', w]));
  return out;
}
