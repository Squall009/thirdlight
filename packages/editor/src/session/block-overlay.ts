/**
 * The metadata overlay — which colour a cell shows for a
 * cell field, the legend, and parsing a typed value.
 *
 * Colours come from the schema: a field's `color` (bool, int, float, string
 * fields), or a generated palette for an enum's choices (evenly spaced hues,
 * starting at the field's colour when it has one). What is drawn:
 * - bool: cells whose value is true;
 * - enum: every stored cell, one colour per choice;
 * - int / float: stored cells whose value differs from the field default,
 *   brighter toward the range's max;
 * - string: stored cells with a non-empty value.
 *
 * Pure: no DOM, no three.js.
 */
import type { CellField, CellMetaValue } from '@thirdlight/project-model';

/** A stable hue (0-360) from a string (a field without a colour still gets its own). */
function hueOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h % 360;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A field's overlay colour: its schema colour, else one generated from its key. */
export function fieldColor(f: Pick<CellField, 'key' | 'color'>): string {
  return f.color !== undefined && HEX.test(f.color) ? f.color.toLowerCase() : hslToHex(hueOf(f.key), 0.75, 0.5);
}

/** An enum's choice colours: evenly spaced hues from the field's colour (or its key's hue). */
export function enumColors(f: Pick<CellField, 'key' | 'color' | 'values'>): Record<string, string> {
  const values = f.values ?? [];
  const base = f.color !== undefined && HEX.test(f.color) ? hexToHsl(f.color)[0] : hueOf(f.key);
  const out: Record<string, string> = {};
  values.forEach((v, i) => {
    out[v] = hslToHex((base + (360 * i) / Math.max(1, values.length)) % 360, 0.75, 0.5);
  });
  return out;
}

/** Scale a colour's lightness for a numeric value's place in its range (0: dim, 1: bright). */
function shade(hex: string, t: number): string {
  const [h, s] = hexToHsl(hex);
  return hslToHex(h, Math.max(0.5, s), 0.25 + 0.45 * Math.min(1, Math.max(0, t)));
}

/** The field default (as the effective-metadata rule has it). */
function defaultOf(f: CellField): CellMetaValue {
  return f.default ?? (f.type === 'bool' ? false : f.type === 'enum' ? (f.values?.[0] ?? '') : f.type === 'string' ? '' : 0);
}

/** The colour a cell shows for a field (null: nothing drawn). `stored` is false for a position with no cell. */
export function overlayColor(f: CellField, value: CellMetaValue | undefined, stored = true): string | null {
  if (!stored || value === undefined) return null;
  switch (f.type) {
    case 'bool':
      return value === true ? fieldColor(f) : null;
    case 'enum':
      return typeof value === 'string' ? (enumColors(f)[value] ?? null) : null;
    case 'string':
      return typeof value === 'string' && value !== '' ? fieldColor(f) : null;
    case 'int':
    case 'float': {
      if (typeof value !== 'number' || value === defaultOf(f)) return null;
      const lo = f.min ?? Math.min(0, value);
      const hi = f.max ?? Math.max(lo + 1, value);
      return shade(fieldColor(f), hi > lo ? (value - lo) / (hi - lo) : 1);
    }
  }
}

export interface LegendEntry {
  key: string;
  label: string;
  entries: { label: string; color: string }[];
}

/** The legend of the shown fields (in schema order). */
export function overlayLegend(fields: readonly CellField[], shown: ReadonlySet<string>): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const f of fields) {
    if (!shown.has(f.key)) continue;
    const label = f.label ?? f.key;
    if (f.type === 'enum') {
      const colors = enumColors(f);
      out.push({ key: f.key, label, entries: (f.values ?? []).map((v) => ({ label: v, color: colors[v]! })) });
    } else if (f.type === 'bool') out.push({ key: f.key, label, entries: [{ label: 'true', color: fieldColor(f) }] });
    else if (f.type === 'string') out.push({ key: f.key, label, entries: [{ label: 'set', color: fieldColor(f) }] });
    else {
      const lo = f.min ?? 0;
      const hi = f.max ?? lo + 1;
      out.push({ key: f.key, label, entries: [{ label: `${lo}`, color: shade(fieldColor(f), 0) }, { label: `${hi}`, color: shade(fieldColor(f), 1) }] });
    }
  }
  return out;
}

/** Parse a typed metadata value for a field (the metadata brush's value box). */
export function parseMetaValue(f: CellField, raw: string): { ok: true; value: CellMetaValue } | { ok: false; message: string } {
  const t = raw.trim();
  switch (f.type) {
    case 'bool':
      if (t === 'true' || t === 'false') return { ok: true, value: t === 'true' };
      return { ok: false, message: `${f.key} is true or false` };
    case 'enum':
      if ((f.values ?? []).includes(t)) return { ok: true, value: t };
      return { ok: false, message: `${f.key} is one of ${(f.values ?? []).join(', ')}` };
    case 'string':
      if (raw.length > 64) return { ok: false, message: `${f.key} is at most 64 characters` };
      return { ok: true, value: raw };
    case 'int':
    case 'float': {
      const n = Number(t);
      if (t === '' || !Number.isFinite(n)) return { ok: false, message: `${f.key} is a number` };
      if (f.type === 'int' && !Number.isInteger(n)) return { ok: false, message: `${f.key} is a whole number` };
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return { ok: false, message: `${f.key} is within ${f.min ?? '-∞'}–${f.max ?? '∞'}` };
      return { ok: true, value: n };
    }
  }
}
