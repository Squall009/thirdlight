/**
 * The project's save schema (`content.saveSchema`, v4) —
 * the shape of the project-defined save document and the project settings
 * document, both project data:
 *
 * - `version`: the save document's schema version (a save written by an
 *   older version is migrated on load, one version at a time);
 * - `migrations`: for each older version `from`, the name of the project
 *   script function (registered with `ctx.saves.migration(name, fn)`) that
 *   turns a version-`from` document into a version-`from + 1` one;
 * - `slots`: how many numbered slots the game offers (engine cap 99);
 * - `sections`: engine state included in every save automatically (opt-in):
 *   `grid` (the block-layer cells scripts changed), `materials` (material
 *   parameters scripts set), `spawned` (the spawned prefab copies),
 *   `storage` (the scripts' `ctx.save` values), `environment` (the
 *   environment preset blend scripts set), `dialogue`, `components`
 *   (objects' current health, collected collectibles, where
 *   patrollers are and which primitives scripts switched off), `world`
 *   (where the play stands: the loaded scenes, the active spawn, the scene
 *   list entry and the character's place — a load moves the game there);
 * - `legacyWorld`: `world` decides where a game stands after a load, so it is
 *   opt-in. A schema that neither lists it nor sets `legacyWorld: false`
 *   still gets it, as every save did before (deprecated, with a Problems
 *   line per Play); `false` means the game restores scenes and its player
 *   from its own document;
 * - `thumbnail`: the size and format of a slot's optional picture of the view;
 * - `settings`: the fields of the project settings document the game's own
 *   settings screen writes (with defaults); a field may be bound to an engine
 *   setting (music/sfx/ui volume, quality, the frame-rate cap) the host applies.
 *
 * Pure: no I/O.
 */
import type { ModelErrorV2 } from './errors';
import { FRAME_RATE_CAP_CHOICES } from './frame-rate-cap';
import { AMBIENT_OCCLUSION_KINDS, RENDER_SCALE_MAX, RENDER_SCALE_MIN } from './render-settings';
import { utf8Encode } from './sha256';
import { fieldType, unexpectedField, withFound } from './validate';

/** A script's `ctx.save` store (and a play's injected variables, which fill it): keys, and a value's JSON characters. */
export const SCRIPT_SAVE_LIMITS = Object.freeze({ keys: 64, valueChars: 4096 });

/** Engine limits of project saves (documented in deployment.md). */
export const SAVE_LIMITS = Object.freeze({
  /** Numbered slots a project may offer (1–99). */
  slots: 99,
  /** A save document (its JSON text, UTF-8) per slot: 1 MiB. */
  documentBytes: 1_048_576,
  /** A slot's thumbnail (the encoded image as a data URL): 64 KiB. */
  thumbnailBytes: 65_536,
  /** The longest thumbnail side in pixels. */
  thumbnailSide: 512,
  /** Fields of the project settings document. */
  settingsFields: 64,
  /** The longest text value of a settings field. */
  settingsText: 256,
  /** Declared migrations. */
  migrations: 256,
  /** The highest schema version. */
  version: 1_000_000,
  /** A slot's title / chapter / location text. */
  metaText: 128,
  /**
   * A slot's own `meta` record as JSON text (UTF-8): what the game shows on a
   * slot card (a leader, a portrait id, a difficulty). Every slot's record is
   * read to list the slots, so the record is bounded, not how many fields it has.
   */
  metaBytes: 4096,
  /** The longest `meta` field name. */
  metaKeyChars: 32,
});

/**
 * A slot `meta` field name: an identifier (letters, digits, _; not a digit
 * first), so a load screen binds it by name (`$item.meta.leader`).
 */
export const SAVE_META_KEY_RE = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,${SAVE_LIMITS.metaKeyChars - 1}}$`);

/**
 * Why a slot's `meta` object does not fit (null: it does): names to text
 * values (a slot card shows text), the whole record within
 * `SAVE_LIMITS.metaBytes` as JSON.
 */
export function saveSlotMetaProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'meta is an object of text values';
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!SAVE_META_KEY_RE.test(k)) return `meta field "${k.slice(0, 40)}" is not a name (letters, digits and _, at most ${SAVE_LIMITS.metaKeyChars} characters)`;
    if (typeof x !== 'string') return `meta field "${k}" is not text`;
  }
  const bytes = utf8Encode(JSON.stringify(v)).length;
  if (bytes > SAVE_LIMITS.metaBytes) return `meta is ${bytes} bytes as JSON, over the ${SAVE_LIMITS.metaBytes}-byte budget of a slot's own fields`;
  return null;
}

// + dialogue (the dialogue variables and the seen-lines set).
// + components (the state of objects' health, collectibles, patrols and hitboxes).
// + world (where the play stands; saved and loaded outside `sections` in the save document, as `world`).
export const SAVE_SECTIONS = ['grid', 'materials', 'spawned', 'storage', 'environment', 'dialogue', 'components', 'world'] as const;
export type SaveSection = (typeof SAVE_SECTIONS)[number];

/** Engine settings a settings field may drive (the host applies them). */
export const SETTINGS_ENGINE_BINDINGS = ['music', 'sfx', 'ui', 'quality', 'frameRateCap', 'ambientOcclusion', 'renderScale', 'dynamicResolution'] as const;
export type SettingsEngineBinding = (typeof SETTINGS_ENGINE_BINDINGS)[number];

export interface SaveMigration {
  /** The version this migration upgrades from (to `from + 1`). */
  from: number;
  /** The script function registered with `ctx.saves.migration(name, fn)`. */
  name: string;
}

export interface SaveThumbnail {
  width: number;
  height: number;
  format: 'jpeg' | 'webp';
  /** Encoder quality 0.1–1 (absent: 0.8). */
  quality?: number;
}

export type SettingsFieldValue = boolean | number | string;

export interface SettingsField {
  key: string;
  type: 'bool' | 'number' | 'string' | 'enum';
  default: SettingsFieldValue;
  label?: string;
  min?: number;
  max?: number;
  /** enum: the choices. */
  values?: string[];
  /**
   * An engine setting this field drives (music/sfx/ui: a number 0–1; quality: an enum of low/medium/high; frameRateCap: an enum of 30/60/120/none;
   * ambientOcclusion: an enum of off/ssao/gtao; renderScale: a number within 0.5–1; dynamicResolution: a bool).
   */
  engine?: SettingsEngineBinding;
}

export interface SaveSchema {
  version: number;
  slots: number;
  migrations?: SaveMigration[];
  sections?: SaveSection[];
  /** `false`: without `world` in `sections` a save keeps no world (absent: the deprecated always-on world). */
  legacyWorld?: boolean;
  thumbnail?: SaveThumbnail;
  settings?: SettingsField[];
}

/** Defaults (genre-neutral): a 16:9 picture small enough for a slot list, JPEG (every browser encodes it). */
export const SAVE_THUMBNAIL_DEFAULT: Readonly<SaveThumbnail> = Object.freeze({ width: 256, height: 144, format: 'jpeg', quality: 0.8 });

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MIGRATION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const SCHEMA_KEYS = new Set(['version', 'slots', 'migrations', 'sections', 'legacyWorld', 'thumbnail', 'settings']);
const FIELD_KEYS = new Set(['key', 'type', 'default', 'label', 'min', 'max', 'values', 'engine']);
const QUALITY = ['low', 'medium', 'high'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const bad = (path: string, found: unknown, message: string, expected: string): ModelErrorV2 => withFound({ code: 'field_value', path, message, expected }, found);

/** Whether a value fits a settings field (type, range, choices). */
export function settingsValueFits(field: SettingsField, v: unknown): v is SettingsFieldValue {
  switch (field.type) {
    case 'bool':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max);
    case 'string':
      return typeof v === 'string' && v.length <= SAVE_LIMITS.settingsText;
    case 'enum':
      return typeof v === 'string' && (field.values ?? []).includes(v);
  }
}

function validateField(f: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(f)) {
    errors.push(fieldType(path, f, 'object'));
    return;
  }
  for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) errors.push(unexpectedField(`${path}/${k}`, k, [...FIELD_KEYS].join(', ')));
  if (typeof f['key'] !== 'string' || !KEY_RE.test(f['key'])) errors.push(bad(`${path}/key`, f['key'], 'a settings key is a letter or _ then up to 31 letters, digits or _', 'an identifier'));
  const type = f['type'];
  if (type !== 'bool' && type !== 'number' && type !== 'string' && type !== 'enum') {
    errors.push(bad(`${path}/type`, type, 'a settings field is bool, number, string or enum', 'bool | number | string | enum'));
    return;
  }
  if (f['label'] !== undefined && (typeof f['label'] !== 'string' || f['label'].length < 1 || f['label'].length > 64)) errors.push(bad(`${path}/label`, f['label'], 'a label is 1–64 characters', 'text'));
  for (const k of ['min', 'max'] as const) {
    if (f[k] === undefined) continue;
    if (type !== 'number') errors.push(bad(`${path}/${k}`, f[k], `${k} belongs to a number field`, 'absent'));
    else if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) errors.push(fieldType(`${path}/${k}`, f[k], 'number'));
  }
  if (typeof f['min'] === 'number' && typeof f['max'] === 'number' && f['min'] > f['max']) errors.push(bad(`${path}/max`, f['max'], 'min ≤ max', 'a number ≥ min'));
  if (type === 'enum') {
    const vals = f['values'];
    if (!Array.isArray(vals) || vals.length < 1 || vals.length > 32 || !vals.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 64) || new Set(vals).size !== vals.length) {
      errors.push(bad(`${path}/values`, vals, 'an enum field lists 1–32 unique choices of 1–64 characters', 'a list of choices'));
    }
  } else if (f['values'] !== undefined) errors.push(bad(`${path}/values`, f['values'], 'values belong to an enum field', 'absent'));
  const engine = f['engine'];
  if (engine !== undefined) {
    if (!(SETTINGS_ENGINE_BINDINGS as readonly unknown[]).includes(engine)) errors.push(bad(`${path}/engine`, engine, `engine is one of ${SETTINGS_ENGINE_BINDINGS.join(', ')}`, SETTINGS_ENGINE_BINDINGS.join(' | ')));
    else if (engine === 'frameRateCap') {
      if (type !== 'enum' || !Array.isArray(f['values']) || !f['values'].every((v) => (FRAME_RATE_CAP_CHOICES as readonly unknown[]).includes(v))) errors.push(bad(`${path}/engine`, engine, `a field driving the frame-rate cap is an enum of ${FRAME_RATE_CAP_CHOICES.join(', ')}`, `an enum of ${FRAME_RATE_CAP_CHOICES.join(' | ')}`));
    } else if (engine === 'ambientOcclusion') {
      if (type !== 'enum' || !Array.isArray(f['values']) || !f['values'].every((v) => (AMBIENT_OCCLUSION_KINDS as readonly unknown[]).includes(v))) errors.push(bad(`${path}/engine`, engine, `a field driving the ambient occlusion is an enum of ${AMBIENT_OCCLUSION_KINDS.join(', ')}`, `an enum of ${AMBIENT_OCCLUSION_KINDS.join(' | ')}`));
    } else if (engine === 'renderScale') {
      if (type !== 'number' || typeof f['min'] !== 'number' || typeof f['max'] !== 'number' || f['min'] < RENDER_SCALE_MIN || f['max'] > RENDER_SCALE_MAX) errors.push(bad(`${path}/engine`, engine, `a field driving the render scale is a number with min ≥ ${RENDER_SCALE_MIN} and max ≤ ${RENDER_SCALE_MAX}`, `a number field (min ≥ ${RENDER_SCALE_MIN}, max ≤ ${RENDER_SCALE_MAX})`));
    } else if (engine === 'dynamicResolution') {
      if (type !== 'bool') errors.push(bad(`${path}/engine`, engine, 'a field driving dynamic resolution is a bool', 'a bool field'));
    } else if (engine === 'quality') {
      if (type !== 'enum' || !Array.isArray(f['values']) || !f['values'].every((v) => QUALITY.includes(v as string))) errors.push(bad(`${path}/engine`, engine, 'a field driving the quality is an enum of low, medium and/or high', 'an enum of low | medium | high'));
    } else if (type !== 'number' || (f['min'] !== undefined && (f['min'] as number) < 0) || (f['max'] !== undefined && (f['max'] as number) > 1)) {
      errors.push(bad(`${path}/engine`, engine, 'a field driving a volume is a number within 0–1', 'a number field (min ≥ 0, max ≤ 1)'));
    }
  }
  // (the caller passes a fresh list per field: no problem so far means the field itself is sound)
  if (errors.length === 0) {
    if (!settingsValueFits(effectiveField(f as unknown as SettingsField), f['default'])) errors.push(bad(`${path}/default`, f['default'], 'the default fits the field (type, range, choices)', `a ${type} value`));
  }
}

/** Validate `content.saveSchema` (pushes one error per problem). */
export function validateSaveSchema(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push(fieldType(path, v, 'object'));
    return;
  }
  for (const k of Object.keys(v)) if (!SCHEMA_KEYS.has(k)) errors.push(unexpectedField(`${path}/${k}`, k, [...SCHEMA_KEYS].join(', ')));
  const version = v['version'];
  if (!intIn(version, 1, SAVE_LIMITS.version)) errors.push(bad(`${path}/version`, version, `the save document version is an integer 1–${SAVE_LIMITS.version}`, 'an integer'));
  if (!intIn(v['slots'], 1, SAVE_LIMITS.slots)) errors.push(bad(`${path}/slots`, v['slots'], `a project offers 1–${SAVE_LIMITS.slots} save slots (engine limit)`, `an integer 1–${SAVE_LIMITS.slots}`));
  if (v['migrations'] !== undefined) {
    const m = v['migrations'];
    if (!Array.isArray(m) || m.length > SAVE_LIMITS.migrations) errors.push(bad(`${path}/migrations`, m, `at most ${SAVE_LIMITS.migrations} migrations`, 'a list'));
    else {
      const seen = new Set<number>();
      m.forEach((x, i) => {
        const p = `${path}/migrations/${i}`;
        if (!isObj(x)) return void errors.push(bad(p, x, 'a migration is { from, name }', '{ from, name }'));
        for (const k of Object.keys(x)) if (k !== 'from' && k !== 'name') errors.push(unexpectedField(`${p}/${k}`, k, 'from, name'));
        if (!intIn(x['from'], 1, SAVE_LIMITS.version - 1) || (intIn(version, 1, SAVE_LIMITS.version) && (x['from'] as number) >= version)) errors.push(bad(`${p}/from`, x['from'], 'a migration upgrades from an older version (1 ≤ from < version) to from + 1', 'an integer below version'));
        else if (seen.has(x['from'] as number)) errors.push(bad(`${p}/from`, x['from'], 'one migration per version', 'a version not listed yet'));
        else seen.add(x['from'] as number);
        if (typeof x['name'] !== 'string' || !MIGRATION_NAME_RE.test(x['name'])) errors.push(bad(`${p}/name`, x['name'], 'a migration name is a letter or _ then up to 63 letters, digits, _ . : -', 'a name'));
      });
    }
  }
  if (v['sections'] !== undefined) {
    const s = v['sections'];
    if (!Array.isArray(s) || s.length > SAVE_SECTIONS.length) errors.push(bad(`${path}/sections`, s, `sections lists some of ${SAVE_SECTIONS.join(', ')}`, 'a list of sections'));
    else s.forEach((x, i) => {
      if (!(SAVE_SECTIONS as readonly unknown[]).includes(x)) errors.push(bad(`${path}/sections/${i}`, x, `a section is one of ${SAVE_SECTIONS.join(', ')}`, SAVE_SECTIONS.join(' | ')));
    });
  }
  if (v['legacyWorld'] !== undefined && typeof v['legacyWorld'] !== 'boolean') errors.push(fieldType(`${path}/legacyWorld`, v['legacyWorld'], 'boolean'));
  if (v['thumbnail'] !== undefined) {
    const t = v['thumbnail'];
    const p = `${path}/thumbnail`;
    if (!isObj(t)) errors.push(bad(p, t, 'a thumbnail is { width, height, format, quality? }', '{ width, height, format }'));
    else {
      for (const k of Object.keys(t)) if (k !== 'width' && k !== 'height' && k !== 'format' && k !== 'quality') errors.push(unexpectedField(`${p}/${k}`, k, 'width, height, format, quality'));
      if (!intIn(t['width'], 16, SAVE_LIMITS.thumbnailSide)) errors.push(bad(`${p}/width`, t['width'], `16–${SAVE_LIMITS.thumbnailSide} pixels`, 'an integer'));
      if (!intIn(t['height'], 16, SAVE_LIMITS.thumbnailSide)) errors.push(bad(`${p}/height`, t['height'], `16–${SAVE_LIMITS.thumbnailSide} pixels`, 'an integer'));
      if (t['format'] !== 'jpeg' && t['format'] !== 'webp') errors.push(bad(`${p}/format`, t['format'], 'jpeg or webp', 'jpeg | webp'));
      if (t['quality'] !== undefined && (typeof t['quality'] !== 'number' || !(t['quality'] >= 0.1 && t['quality'] <= 1))) errors.push(bad(`${p}/quality`, t['quality'], 'a quality 0.1–1', 'a number'));
    }
  }
  if (v['settings'] !== undefined) {
    const s = v['settings'];
    if (!Array.isArray(s) || s.length > SAVE_LIMITS.settingsFields) errors.push(bad(`${path}/settings`, s, `at most ${SAVE_LIMITS.settingsFields} settings fields`, 'a list'));
    else {
      const keys = new Set<string>();
      s.forEach((f, i) => {
        const local: ModelErrorV2[] = [];
        validateField(f, `${path}/settings/${i}`, local);
        errors.push(...local);
        const key = isObj(f) ? f['key'] : undefined;
        if (typeof key === 'string') {
          if (keys.has(key)) errors.push(bad(`${path}/settings/${i}/key`, key, 'settings keys are unique', 'a new key'));
          keys.add(key);
        }
      });
      const bound = s.map((f) => (isObj(f) ? f['engine'] : undefined)).filter((e) => e !== undefined);
      if (new Set(bound).size !== bound.length) errors.push(bad(`${path}/settings`, bound, 'an engine setting is driven by one field at most', 'distinct engine bindings'));
    }
  }
}

/** The canonical form (members in a fixed order; empty lists dropped). Assumes a valid schema. */
export function canonicalSaveSchema(s: SaveSchema): SaveSchema {
  return {
    version: s.version,
    slots: s.slots,
    ...(s.migrations !== undefined && s.migrations.length > 0 ? { migrations: [...s.migrations].sort((a, b) => a.from - b.from).map((m) => ({ from: m.from, name: m.name })) } : {}),
    ...(s.sections !== undefined && s.sections.length > 0 ? { sections: SAVE_SECTIONS.filter((x) => s.sections!.includes(x)) } : {}),
    // true is the default (absent).
    ...(s.legacyWorld === false ? { legacyWorld: false } : {}),
    ...(s.thumbnail !== undefined ? { thumbnail: { width: s.thumbnail.width, height: s.thumbnail.height, format: s.thumbnail.format, ...(s.thumbnail.quality !== undefined ? { quality: s.thumbnail.quality } : {}) } } : {}),
    ...(s.settings !== undefined && s.settings.length > 0
      ? {
          settings: s.settings.map((f) => ({
            key: f.key,
            type: f.type,
            default: f.default,
            ...(f.label !== undefined ? { label: f.label } : {}),
            ...(f.min !== undefined ? { min: f.min } : {}),
            ...(f.max !== undefined ? { max: f.max } : {}),
            ...(f.values !== undefined ? { values: [...f.values] } : {}),
            ...(f.engine !== undefined ? { engine: f.engine } : {}),
          })),
        }
      : {}),
  };
}

/** A settings document: the stored values that still fit their fields, the defaults for the rest. */
export function settingsDocumentOf(fields: readonly SettingsField[], stored: unknown): Record<string, SettingsFieldValue> {
  const out: Record<string, SettingsFieldValue> = {};
  const src = isObj(stored) ? stored : {};
  for (const f of fields) {
    const v = Object.prototype.hasOwnProperty.call(src, f.key) ? src[f.key] : undefined;
    out[f.key] = settingsValueFits(effectiveField(f), v) ? v : f.default;
  }
  return out;
}

/** A field with the implied 0–1 range of a volume binding. */
export function effectiveField(f: SettingsField): SettingsField {
  return f.engine === 'music' || f.engine === 'sfx' || f.engine === 'ui' ? { ...f, min: f.min ?? 0, max: f.max ?? 1 } : f;
}

/**
 * How a save treats `world` under a schema: `section` (listed), `legacy`
 * (neither listed nor `legacyWorld: false`: the deprecated always-on world)
 * or `off` (the game restores scenes and its player itself).
 */
export function saveWorldMode(s: Pick<SaveSchema, 'sections' | 'legacyWorld'>): 'section' | 'legacy' | 'off' {
  if (s.sections?.includes('world') === true) return 'section';
  return s.legacyWorld === false ? 'off' : 'legacy';
}
