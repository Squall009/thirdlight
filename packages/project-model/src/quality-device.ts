/**
 * The quality level a device starts at when nobody chose one: the device's
 * lighting tier from its renderer and GPU, then the highest of the
 * project's levels whose tier fits it.
 *
 * The rule (logged by the page once its renderer is up):
 *
 * - WebGL 2, or a software adapter (SwiftShader, llvmpipe, a fallback
 *   adapter): low — WebGL 2 has no compute, so its light is the saved light
 *   whatever the level.
 * - WebGPU on a phone or tablet GPU (Qualcomm, ARM, Imagination, Samsung):
 *   low — live light costs more than such a GPU has beside the frame.
 * - WebGPU on an integrated GPU (Intel's integrated parts, Apple, an AMD
 *   APU named as one): medium.
 * - WebGPU on a discrete GPU (NVIDIA, Intel Arc, an AMD Radeon RX or Pro):
 *   high.
 * - Anything the adapter does not tell apart: medium.
 *
 * Browsers say little about the GPU (`GPUAdapterInfo`: vendor and
 * architecture, the description often blank), so the rule leans on the
 * vendor and only reads the description where it names the part.
 *
 * A level that names no tier counts as the default tier
 * (`DEFAULT_LIGHTING_TIER`, as `levelLighting` draws it), so a project whose
 * own levels name none still starts where the device fits: its highest on a
 * medium or high device, its lowest on a low one.
 *
 * Pure: no I/O.
 */
import { levelLighting, lightingTierRank, type LightingTier, type QualityLevelConfig } from './quality-levels';

/** What the page knows of its GPU. */
export interface DeviceGpuInfo {
  /** The graphics API the renderer draws with. */
  readonly api: 'webgpu' | 'webgl2';
  /** `GPUAdapterInfo` where WebGPU gives it (lowercase vendor, architecture; device and description often blank). */
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}

/** The kinds of GPU the rule tells apart. */
export type DeviceGpuClass = 'software' | 'mobile' | 'integrated' | 'discrete' | 'unknown';

/** A device's tier and why. */
export interface DeviceLightingTier {
  readonly tier: LightingTier;
  readonly gpu: DeviceGpuClass;
  /** One line: what was read and the rule that applied. */
  readonly reason: string;
}

const SOFTWARE_RE = /swiftshader|llvmpipe|lavapipe|softpipe|microsoft basic render/i;
const MOBILE_VENDORS = new Set(['qualcomm', 'arm', 'imagination', 'img-tec', 'samsung', 'mediatek']);
/** Intel's discrete architectures (Arc: Xe-HPG, Xe2-HPG; Xe-HP and Xe-HPC parts are discrete too). */
const INTEL_DISCRETE_RE = /hpg|hpc|12hp|xe-hp/i;
/** An AMD part named as an APU's graphics ("AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics"). */
const AMD_INTEGRATED_RE = /radeon(\(tm\))? (vega \d+ )?graphics|radeon \d+m\b/i;
const AMD_DISCRETE_RE = /radeon(\(tm\))? (rx|pro)\b/i;

/** The GPU's class from what the adapter says. */
export function deviceGpuClassOf(info: DeviceGpuInfo): DeviceGpuClass {
  const vendor = (info.vendor ?? '').toLowerCase();
  const text = `${info.description ?? ''} ${info.device ?? ''}`;
  if (info.isFallbackAdapter === true || SOFTWARE_RE.test(`${text} ${vendor} ${info.architecture ?? ''}`)) return 'software';
  if (MOBILE_VENDORS.has(vendor)) return 'mobile';
  if (vendor === 'nvidia') return 'discrete';
  if (vendor === 'intel') return INTEL_DISCRETE_RE.test(info.architecture ?? '') || /\barc\b/i.test(text) ? 'discrete' : 'integrated';
  if (vendor === 'apple') return 'integrated';
  if (vendor === 'amd' || vendor === 'ati') return AMD_DISCRETE_RE.test(text) ? 'discrete' : AMD_INTEGRATED_RE.test(text) ? 'integrated' : 'unknown';
  return 'unknown';
}

const TIER_OF_CLASS: Readonly<Record<DeviceGpuClass, LightingTier>> = { software: 'low', mobile: 'low', integrated: 'medium', discrete: 'high', unknown: 'medium' };

/** The device's lighting tier by the rule above. */
export function deviceLightingTier(info: DeviceGpuInfo): DeviceLightingTier {
  const named = [info.vendor, info.architecture, info.description].filter((x) => x !== undefined && x !== '').join(' ') || 'no adapter info';
  if (info.api === 'webgl2') return { tier: 'low', gpu: 'unknown', reason: 'WebGL 2: saved light only → low' };
  const gpu = deviceGpuClassOf(info);
  const tier = TIER_OF_CLASS[gpu];
  return { tier, gpu, reason: `WebGPU, ${named}: ${gpu} GPU → ${tier}` };
}

/**
 * The level a device with `tier` starts at: the highest level whose tier
 * (the default tier where it names none) is at most the device's, else the
 * lowest level (null: no levels).
 */
export function deviceQualityLevel(levels: readonly QualityLevelConfig[], tier: LightingTier): QualityLevelConfig | null {
  const rank = lightingTierRank(tier);
  let pick: QualityLevelConfig | null = null;
  for (const l of levels) if (lightingTierRank(levelLighting(l).tier) <= rank) pick = l;
  return pick ?? levels[0] ?? null;
}
