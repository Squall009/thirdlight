/**
 * The brush settings every brush in the editor shares: one type, one set of
 * bounds, one way to change them from keys and drags, one place they are
 * remembered.
 *
 * - **Size** is metres across (the stroke's radius is half of it), so a
 *   stamp or an erosion square of that size is the brush's footprint.
 * - **Strength** is how much one dab does (flow, 0–1). A sculpt tool's
 *   metres are its own setting, the **height step**: a dab at full strength
 *   moves the ground by it.
 * - **Opacity** is the most one stroke can reach, however long it paints
 *   (paint tools; applied by the commands, `paint-brush.ts`).
 * - **Falloff** (smooth, linear, constant, a curve with its hardness),
 *   **spacing** (between dabs, a share of the size), **invert** (lower,
 *   erase, fill) and the **noise mask** a dab is multiplied by.
 *
 * Each editor names the settings its tools use (`BrushUse`); the panel shows
 * those, the keys change those, and a stroke's command carries only those
 * (an additive argument is sent only when it changes something).
 *
 * Settings are editor preferences, remembered per editor and tool in this
 * browser (`localStorage`), never in the project. Invert is not remembered:
 * a reload never leaves a brush erasing.
 *
 * Pure but for the store's storage.
 */
import { BRUSH_FALLOFFS, BRUSH_HARDNESS_DEFAULT, BRUSH_MASK_LIMITS, type BrushFalloff, type BrushMask } from '@thirdlight/runtime';

/** The settings a tool can use (the panel's rows, in its order). */
export type BrushUse = 'heightStep' | 'size' | 'strength' | 'opacity' | 'falloff' | 'spacing' | 'invert' | 'mask';

export interface BrushMaskSettings extends BrushMask {
  /** Paint through the noise (off: the mask's settings are kept, not sent). */
  on: boolean;
}

export interface BrushSettings {
  /** Metres across. */
  size: number;
  /** One dab's share of the way (0–1]. */
  strength: number;
  /** The most one stroke reaches (0–1]; 1: no ceiling. */
  opacity: number;
  falloff: BrushFalloff;
  /** A curve falloff's share of the radius at full strength. */
  hardness: number;
  /** Between dabs, a share of the size. */
  spacing: number;
  /** Lower / erase / fill instead (Ctrl held flips it for one stroke). */
  invert: boolean;
  /** Sculpt: metres one dab at full strength moves the ground. */
  heightStep: number;
  mask: BrushMaskSettings;
}

/** The bounds the panel, the keys and storage keep settings in (an editor may narrow size and height step). */
export interface BrushBounds {
  size: readonly [number, number];
  heightStep: readonly [number, number];
}

export const BRUSH_BOUNDS = Object.freeze({
  strength: [0.01, 1] as const,
  opacity: [0.01, 1] as const,
  hardness: [0, 0.95] as const,
  spacing: [0.02, 1] as const,
  maskScale: [BRUSH_MASK_LIMITS.scaleMin, BRUSH_MASK_LIMITS.scaleMax] as const,
  maskContrast: [0, BRUSH_MASK_LIMITS.contrastMax] as const,
  maskOctaves: [1, BRUSH_MASK_LIMITS.octavesMax] as const,
});

export const DEFAULT_BRUSH_MASK: BrushMaskSettings = Object.freeze({ on: false, scale: 4, contrast: 1.6, threshold: 0.45, octaves: 4, seed: 1207 }) as BrushMaskSettings;

/** The spacing a quarter of the radius makes (a fast drag leaves no gaps). */
const SPACING_DEFAULT = 0.125;

export const DEFAULT_BRUSH: BrushSettings = Object.freeze({ size: 16, strength: 0.5, opacity: 1, falloff: 'smooth', hardness: BRUSH_HARDNESS_DEFAULT, spacing: SPACING_DEFAULT, invert: false, heightStep: 0.5, mask: DEFAULT_BRUSH_MASK }) as BrushSettings;

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, range: readonly [number, number]): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, range) : fallback);

/** Settings read from anywhere (storage, a patch): every field within bounds, anything malformed its default from `base`. */
export function sanitizeBrush(raw: unknown, base: BrushSettings, bounds: BrushBounds): BrushSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const m = typeof r['mask'] === 'object' && r['mask'] !== null ? (r['mask'] as Record<string, unknown>) : {};
  const B = BRUSH_BOUNDS;
  return {
    size: num(r['size'], clamp(base.size, bounds.size), bounds.size),
    strength: num(r['strength'], base.strength, B.strength),
    opacity: num(r['opacity'], base.opacity, B.opacity),
    falloff: BRUSH_FALLOFFS.includes(r['falloff'] as BrushFalloff) ? (r['falloff'] as BrushFalloff) : base.falloff,
    hardness: num(r['hardness'], base.hardness, B.hardness),
    spacing: num(r['spacing'], base.spacing, B.spacing),
    invert: typeof r['invert'] === 'boolean' ? r['invert'] : base.invert,
    heightStep: num(r['heightStep'], clamp(base.heightStep, bounds.heightStep), bounds.heightStep),
    mask: {
      on: typeof m['on'] === 'boolean' ? m['on'] : base.mask.on,
      scale: num(m['scale'], base.mask.scale, B.maskScale),
      contrast: num(m['contrast'], base.mask.contrast, B.maskContrast),
      threshold: num(m['threshold'], base.mask.threshold, [0, 1]),
      octaves: Math.round(num(m['octaves'], base.mask.octaves, B.maskOctaves)),
      seed: typeof m['seed'] === 'number' && Number.isInteger(m['seed']) && Math.abs(m['seed']) <= BRUSH_MASK_LIMITS.seedMax ? m['seed'] : base.mask.seed,
    },
  };
}

/** The stroke's radius (metres). */
export const brushRadius = (b: Pick<BrushSettings, 'size'>): number => b.size / 2;

/** The mask a stroke sends (null: off, or the tool does not use one). */
export function strokeMask(b: BrushSettings, uses: readonly BrushUse[]): BrushMask | null {
  if (!uses.includes('mask') || !b.mask.on) return null;
  const { scale, contrast, threshold, octaves, seed } = b.mask;
  return { scale, contrast, threshold, octaves, seed };
}

/**
 * The additive arguments a stroke's command takes from the settings — only
 * those that change something: a curve's hardness, an opacity under 1 (paint
 * tools), a mask that is on. Absent, the command paints as it always did.
 */
export function brushStrokeExtras(b: BrushSettings, uses: readonly BrushUse[]): { hardness?: number; opacity?: number; mask?: BrushMask } {
  const mask = strokeMask(b, uses);
  return {
    ...(uses.includes('falloff') && b.falloff === 'curve' ? { hardness: b.hardness } : {}),
    ...(uses.includes('opacity') && b.opacity < 1 ? { opacity: b.opacity } : {}),
    ...(mask !== null ? { mask } : {}),
  };
}

/** How much `[` / `]` change the size (a share of it: big brushes move as fast as small ones). */
const SIZE_KEY_STEP = 0.15;
/** How much `Shift+[` / `Shift+]` change the strength. */
const STRENGTH_KEY_STEP = 0.05;

/** The size after `dir` presses of `[` (−1) or `]` (+1), rounded to what the panel shows. */
export function stepSize(size: number, dir: number, bounds: BrushBounds): number {
  const next = dir > 0 ? size * (1 + SIZE_KEY_STEP) : size / (1 + SIZE_KEY_STEP);
  return clamp(roundSize(next), bounds.size);
}

/** The strength after `dir` presses of `Shift+[` / `Shift+]` (steps of 5 %). */
export function stepStrength(strength: number, dir: number): number {
  const steps = Math.round(strength / STRENGTH_KEY_STEP) + Math.sign(dir);
  return clamp(Math.round(steps * STRENGTH_KEY_STEP * 100) / 100, BRUSH_BOUNDS.strength);
}

/** Pixels of drag that take the strength from 0 to 1 (Shift+F). */
export const STRENGTH_DRAG_PX = 240;

/** The strength while Shift+F drags: from where it began, right and up add. */
export function dragStrength(start: number, dx: number, dy: number): number {
  return clamp(Math.round((start + (dx - dy) / STRENGTH_DRAG_PX) * 100) / 100, BRUSH_BOUNDS.strength);
}

/** A size as the panel shows it: 0.1 m steps under 10 m, then whole metres. */
export function roundSize(size: number): number {
  return size < 10 ? Math.round(size * 10) / 10 : Math.round(size);
}

/** What the brush's readout says ("9 m · 35 % · opacity 80 % · noise"). */
export function brushSummary(b: BrushSettings, uses: readonly BrushUse[]): string {
  const parts = [`${roundSize(b.size)} m`];
  if (uses.includes('heightStep')) parts.push(`${Math.round(b.heightStep * 100) / 100} m step`);
  if (uses.includes('strength')) parts.push(`${Math.round(b.strength * 100)} %`);
  if (uses.includes('opacity') && b.opacity < 1) parts.push(`opacity ${Math.round(b.opacity * 100)} %`);
  if (uses.includes('mask') && b.mask.on) parts.push('noise');
  return parts.join(' · ');
}

// ---- the store ------------------------------------------------------------------------------

/** One editor tool's settings: read, changed, watched (the panel and the Scene view's tool share one). */
export interface BrushStore {
  readonly key: string;
  readonly bounds: BrushBounds;
  get(): BrushSettings;
  set(patch: Partial<Omit<BrushSettings, 'mask'>> & { mask?: Partial<BrushMaskSettings> }): void;
  subscribe(listener: () => void): () => void;
}

/** Where a tool's settings are remembered. */
export function brushStorageKey(editor: string, tool: string): string {
  return `thirdlight.brush.${editor}.${tool}`;
}

const stores = new Map<string, BrushStore>();

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage refused (a private window's policy): settings last for the page.
    return null;
  }
}

/**
 * The settings store of `editor`'s `tool` (one per tool for the page's life):
 * loaded from storage over the tool's `defaults`, saved on each change
 * (but invert).
 */
export function brushStore(editor: string, tool: string, defaults: BrushSettings, bounds: BrushBounds, storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()): BrushStore {
  const key = brushStorageKey(editor, tool);
  const have = stores.get(key);
  if (have !== undefined) return have;
  let stored: unknown = null;
  try {
    const text = storage?.getItem(key) ?? null;
    stored = text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    stored = null;
  }
  let current = sanitizeBrush({ ...(typeof stored === 'object' && stored !== null ? stored : {}), invert: defaults.invert }, defaults, bounds);
  const listeners = new Set<() => void>();
  const store: BrushStore = {
    key,
    bounds,
    get: () => current,
    set: (patch) => {
      const next = sanitizeBrush({ ...current, ...patch, mask: { ...current.mask, ...(patch.mask ?? {}) } }, current, bounds);
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      try {
        const { invert: _invert, ...kept } = next;
        storage?.setItem(key, JSON.stringify(kept));
      } catch {
        // Storage full or refused: the change still holds for the page.
      }
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  stores.set(key, store);
  return store;
}

/** Forget the page's stores (tests start from storage again). */
export function resetBrushStores(): void {
  stores.clear();
}
