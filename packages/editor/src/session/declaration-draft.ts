/**
 * Phase 15.4: the Behaviors tab's declaration editor model.
 *
 * A declaration is edited as text drafts (one per property: every declared
 * field as the user types it) and turned back into a `PropertyDeclaration`
 * for the ordinary `publishBehavior` declaration command. The backend stays
 * the authority on every rule; this module only parses the typed text and
 * reports the first problem next to its field so a save is not a guess.
 *
 * Pure: no DOM, no I/O, no code evaluation.
 */

import type { DeclaredProperty, PropertyDeclaration, PropertyType, PropertyValue } from '@thirdlight/project-model';

export const PROPERTY_TYPES: readonly PropertyType[] = ['number', 'boolean', 'string', 'enum', 'vec3', 'entityRef', 'assetRef'];

/** One property as the editor holds it (all text; empty = absent). */
export interface PropertyDraft {
  key: string;
  label: string;
  type: PropertyType;
  default: string;
  visibility: 'public' | 'private';
  group: string;
  header: string;
  tooltip: string;
  min: string;
  max: string;
  step: string;
  maxLength: string;
  /** enum members, comma separated. */
  values: string;
  /** vec3 bounds, "x, y, z" each. */
  boundsMin: string;
  boundsMax: string;
}

export interface DraftProblem {
  index: number;
  field: keyof PropertyDraft | 'properties';
  message: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function valueText(v: PropertyValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** The drafts of a published declaration (declaration order). */
export function draftsOf(declaration: PropertyDeclaration): PropertyDraft[] {
  return declaration.properties.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
    default: valueText(p.default),
    visibility: p.visibility === 'private' ? 'private' : 'public',
    group: p.group ?? '',
    header: p.header ?? '',
    tooltip: p.tooltip ?? '',
    min: p.min !== undefined ? String(p.min) : '',
    max: p.max !== undefined ? String(p.max) : '',
    step: p.step !== undefined ? String(p.step) : '',
    maxLength: p.maxLength !== undefined ? String(p.maxLength) : '',
    values: (p.values ?? []).join(', '),
    boundsMin: p.bounds !== undefined ? p.bounds.min.join(', ') : '',
    boundsMax: p.bounds !== undefined ? p.bounds.max.join(', ') : '',
  }));
}

/** A fresh number property with an unused key (`value`, `value_2`, …). */
export function newPropertyDraft(existing: readonly PropertyDraft[]): PropertyDraft {
  const keys = new Set(existing.map((d) => d.key));
  let key = 'value';
  for (let n = 2; keys.has(key); n++) key = `value_${n}`;
  return { key, label: labelOfKey(key), type: 'number', default: '0', visibility: 'public', group: '', header: '', tooltip: '', min: '', max: '', step: '', maxLength: '', values: '', boundsMin: '', boundsMax: '' };
}

/** "jump_height" → "Jump height" (the same default label the compiler uses for code declarations). */
export function labelOfKey(key: string): string {
  const words = key.split('_').filter((w) => w.length > 0).join(' ');
  return (words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : key).slice(0, 64);
}

/** A draft retyped: the default is reset to the new type's neutral value; type-only limits are cleared. */
export function retype(d: PropertyDraft, type: PropertyType): PropertyDraft {
  const neutral: Record<PropertyType, string> = { number: '0', boolean: 'false', string: '', enum: 'a', vec3: '0, 0, 0', entityRef: '', assetRef: '' };
  return { ...d, type, default: neutral[type], min: '', max: '', step: '', maxLength: '', values: type === 'enum' ? 'a, b' : '', boundsMin: '', boundsMax: '' };
}

function num(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function vec(text: string): [number, number, number] | null {
  const parts = text.split(',').map((x) => x.trim());
  if (parts.length !== 3 || parts.some((x) => x === '')) return null;
  const v = parts.map(Number);
  return v.every((x) => Number.isFinite(x)) ? (v as [number, number, number]) : null;
}

/**
 * Parse the drafts into a declaration (canonical field order; public is
 * omitted), or the first problem found.
 */
export function declarationOf(drafts: readonly PropertyDraft[]): { ok: true; declaration: PropertyDeclaration } | { ok: false; problem: DraftProblem } {
  const bad = (index: number, field: DraftProblem['field'], message: string): { ok: false; problem: DraftProblem } => ({ ok: false, problem: { index, field, message } });
  if (drafts.length > 32) return bad(-1, 'properties', 'a behavior declares at most 32 properties');
  const seen = new Set<string>();
  const out: DeclaredProperty[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i] as PropertyDraft;
    const key = d.key.trim();
    if (!KEY_RE.test(key)) return bad(i, 'key', 'a key is a lowercase letter, then lowercase letters, digits or _ (up to 64)');
    if (seen.has(key)) return bad(i, 'key', `"${key}" is declared twice`);
    seen.add(key);
    const label = d.label.trim() === '' ? labelOfKey(key) : d.label.trim();
    if (label.length > 64) return bad(i, 'label', 'a label has 1–64 characters');
    const p: Record<string, unknown> = { key, label, type: d.type };
    // default
    switch (d.type) {
      case 'number': {
        const n = num(d.default);
        if (n === null || Number.isNaN(n)) return bad(i, 'default', 'the default must be a number');
        p['default'] = n;
        break;
      }
      case 'boolean':
        if (d.default !== 'true' && d.default !== 'false') return bad(i, 'default', 'the default is true or false');
        p['default'] = d.default === 'true';
        break;
      case 'string':
      case 'enum':
        p['default'] = d.default;
        break;
      case 'vec3': {
        const v = vec(d.default);
        if (v === null) return bad(i, 'default', 'the default is three numbers: x, y, z');
        p['default'] = v;
        break;
      }
      case 'entityRef':
      case 'assetRef': {
        const t = d.default.trim();
        if (t !== '' && !ID_RE.test(t)) return bad(i, 'default', 'the default is an id or empty (none)');
        p['default'] = t === '' ? null : t;
        break;
      }
    }
    if (d.type === 'number') {
      for (const f of ['min', 'max', 'step'] as const) {
        const n = num(d[f]);
        if (n === null) continue;
        if (Number.isNaN(n)) return bad(i, f, `${f} must be a number`);
        p[f] = n;
      }
    }
    if (d.type === 'string') {
      const n = num(d.maxLength);
      if (n !== null) {
        if (!Number.isInteger(n) || n < 1 || n > 1024) return bad(i, 'maxLength', 'max length is a whole number 1–1024');
        p['maxLength'] = n;
      }
    }
    if (d.type === 'enum') {
      const values = d.values.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      if (values.length === 0) return bad(i, 'values', 'an enum lists 1–32 choices, comma separated');
      p['values'] = values;
      if (!values.includes(String(p['default']))) return bad(i, 'default', 'the default must be one of the choices');
    }
    if (d.type === 'vec3' && (d.boundsMin.trim() !== '' || d.boundsMax.trim() !== '')) {
      const min = vec(d.boundsMin);
      const max = vec(d.boundsMax);
      if (min === null) return bad(i, 'boundsMin', 'bounds min is three numbers: x, y, z');
      if (max === null) return bad(i, 'boundsMax', 'bounds max is three numbers: x, y, z');
      p['bounds'] = { min, max };
    }
    if (d.visibility === 'private') p['visibility'] = 'private';
    for (const f of ['group', 'header', 'tooltip'] as const) {
      const t = d[f].trim();
      if (t !== '') p[f] = t;
    }
    out.push(p as unknown as DeclaredProperty);
  }
  return { ok: true, declaration: { properties: out } };
}
