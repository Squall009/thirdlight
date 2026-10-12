/**
 * Rules in words: a range as its field shows and takes it ("35–90", ">35",
 * "<90", "any"), and a material or scatter rule summed up in one line for
 * its card ("Slope 35–90° · noise > 0.35"), so a folded card says what the
 * rule does without opening it.
 *
 * Pure.
 */
import type { ScatterRule, SurfaceRule } from '@thirdlight/runtime';

/** A range's ends (absent: open). */
export interface RangeValue {
  min?: number;
  max?: number;
}

/** Decimals a step shows. */
export const stepDecimals = (step: number): number => (Number.isInteger(step) ? 0 : Math.min(4, String(step).split('.')[1]?.length ?? 1));

const fmt = (n: number, decimals = 2): string => Number(n.toFixed(decimals)).toString();

/** The range as its field shows it. */
export function rangeText(v: RangeValue, decimals: number): string {
  if (v.min !== undefined && v.max !== undefined) return `${fmt(v.min, decimals)}–${fmt(v.max, decimals)}`;
  if (v.min !== undefined) return `>${fmt(v.min, decimals)}`;
  if (v.max !== undefined) return `<${fmt(v.max, decimals)}`;
  return 'any';
}

/** A typed range: "a–b" (or "a..b", "a to b", "a - b"), ">a", "<b", "any" or nothing; null when it reads as none of these. */
export function parseRange(text: string): RangeValue | null {
  const t = text.trim().replace(/,/g, '.').replace(/−/g, '-');
  if (t === '' || /^any$/i.test(t)) return {};
  const num = '(-?\\d+(?:\\.\\d+)?|-?\\.\\d+)';
  const one = (re: string): RegExpExecArray | null => new RegExp(`^${re}$`, 'i').exec(t);
  let m = one(`(?:>=|≥|>|over|above)\\s*${num}`);
  if (m !== null) return { min: Number(m[1]) };
  m = one(`(?:<=|≤|<|under|below)\\s*${num}`);
  if (m !== null) return { max: Number(m[1]) };
  m = one(`${num}\\s*(?:–|—|\\.\\.|to|-)\\s*${num}`);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a <= b ? { min: a, max: b } : { min: b, max: a };
  }
  m = one(`${num}\\s*(?:–|—|\\.\\.|-)`);
  if (m !== null) return { min: Number(m[1]) };
  return null;
}

/** A range in a sentence ("35–90°", "above 70 m", "below 0.3"); null when both ends are open. */
export function rangePhrase(v: RangeValue | undefined, unit = ''): string | null {
  if (v === undefined || (v.min === undefined && v.max === undefined)) return null;
  const u = unit === '' ? '' : unit === '°' ? '°' : ` ${unit}`;
  if (v.min !== undefined && v.max !== undefined) return `${fmt(v.min)}–${fmt(v.max)}${u}`;
  if (v.min !== undefined) return `above ${fmt(v.min)}${u}`;
  return `below ${fmt(v.max!)}${u}`;
}

/** The conditions material and scatter rules share, in words. */
function conditionWords(r: Pick<SurfaceRule, 'height' | 'slope' | 'cavity' | 'noise'>): string[] {
  const out: string[] = [];
  const slope = rangePhrase(r.slope, '°');
  if (slope !== null) out.push(`slope ${slope}`);
  const height = rangePhrase(r.height, 'm');
  if (height !== null) out.push(`height ${height}`);
  if (r.cavity !== undefined) {
    const c = r.cavity;
    out.push(c.min !== undefined && c.min >= 0 && c.max === undefined ? 'in hollows' : c.max !== undefined && c.max <= 0 && c.min === undefined ? 'on ridges' : `cavity ${rangePhrase(c, 'm') ?? 'any'}`);
  }
  if (r.noise !== undefined) out.push(`noise ${rangePhrase(r.noise) ?? 'any'}`);
  return out;
}

const capital = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

/** A material rule in one line ("Slope 35–90° · noise above 0.35"; "Everywhere" with no condition). `layerName` names a layer by index. */
export function surfaceRuleSummary(r: SurfaceRule, layerName: (index: number) => string): string {
  const parts = conditionWords(r);
  if (r.weight !== undefined) parts.push(`where ${layerName(r.weight.layer)} is ${rangePhrase(r.weight) ?? 'any'}`);
  if (r.face !== undefined) parts.push(r.face === 'top' ? 'tops only' : 'walls only');
  if (r.blocks !== undefined && r.blocks.length > 0) parts.push(`on ${r.blocks.join(', ')}`);
  if (r.strength !== undefined && r.strength < 1) parts.push(`${Math.round(r.strength * 100)} %`);
  return parts.length === 0 ? 'Everywhere' : capital(parts.join(' · '));
}

/** A material rule's title: its name, else its layer's name and the first of its conditions. */
export function surfaceRuleTitle(r: SurfaceRule, layerName: (index: number) => string): string {
  if (r.name !== undefined && r.name !== '') return r.name;
  const first = conditionWords(r)[0];
  return first === undefined ? `${layerName(r.layer)} everywhere` : `${layerName(r.layer)}, ${first}`;
}

/** A scatter rule in one line ("1.5 per m² · 0.6 m apart · slope below 30° · on Forest dirt"). */
export function scatterRuleSummary(r: ScatterRule, layerName: (index: number) => string): string {
  const parts = [r.cover === true ? `ground cover, ${fmt(r.density)} per m²` : `${fmt(r.density)} per m²`];
  if (r.spacing !== undefined && r.spacing > 0) parts.push(`${fmt(r.spacing)} m apart`);
  parts.push(...conditionWords(r));
  for (const l of r.layers ?? []) parts.push(`on ${layerName(l.layer)}${l.min !== undefined || l.max !== undefined ? ` ${rangePhrase(l)}` : ''}`);
  return capital(parts.join(' · '));
}
