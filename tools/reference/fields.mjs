/**
 * Field descriptors as reference tables: one row per stored field, nested
 * objects, list items and map values flattened into paths (`shape.radius`,
 * `points[].at`, `materials{}`), with the type, unit, range, default and the
 * tooltip the Inspector shows. Everything comes from project-model's
 * descriptor registry; nothing here restates a rule.
 */
import { code, json, ref, table, typeId } from './markdown.mjs';

/** Type-language names that are not declarations of their own. */
const BUILTIN_TYPES = new Set(['Record', 'Readonly', 'ReadonlyArray', 'Array', 'Partial']);

/** The declared types a `shape` names (`Record<string, ArchitectureMask>` → ArchitectureMask). */
export function shapeNames(shape) {
  return [...shape.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((m) => m[0]).filter((n) => !BUILTIN_TYPES.has(n));
}

/** Every type name the descriptors' `shape`s name, sorted. */
export function descriptorShapeNames(D) {
  const out = new Set();
  const walk = (f) => {
    if (f.type === 'json' && f.shape !== undefined) for (const n of shapeNames(f.shape)) out.add(n);
    if (f.type === 'object') f.fields.forEach(walk);
    if (f.type === 'list') walk(f.item);
    if (f.type === 'map') walk(f.value);
  };
  walk(D.entity);
  D.components.forEach((c) => walk(c.value));
  D.content.forEach((b) => walk(b.value));
  if (D.sceneEnvironment !== undefined) walk(D.sceneEnvironment);
  if (D.ui !== undefined) Object.values(D.ui).forEach(walk);
  return [...out].sort();
}

function rangeText(f) {
  const parts = [];
  const lo = f.min === undefined ? undefined : `${f.minExclusive === true ? '>' : '≥'} ${f.min}`;
  const hi = f.max === undefined ? undefined : `${f.maxExclusive === true ? '<' : '≤'} ${f.max}`;
  if (lo !== undefined && hi !== undefined && f.minExclusive !== true && f.maxExclusive !== true) parts.push(`${f.min} – ${f.max}`);
  else {
    if (lo !== undefined) parts.push(lo);
    if (hi !== undefined) parts.push(hi);
  }
  if (f.step !== undefined) parts.push(`step ${f.step}`);
  if (f.nonZero === true) parts.push('not 0');
  if (f.ascending === true) parts.push('ascending');
  if (f.unit !== undefined) parts.push(f.unit);
  return parts.join(', ');
}

function lengthText(min, max, what) {
  if (min === undefined && max === undefined) return '';
  if (min !== undefined && max !== undefined) return min === max ? `${min} ${what}` : `${min}–${max} ${what}`;
  return min !== undefined ? `≥ ${min} ${what}` : `≤ ${max} ${what}`;
}

/** The type column: the kind of value and what it names. */
export function typeText(f) {
  switch (f.type) {
    case 'int': {
      const vals = f.values === undefined ? '' : ` (one of ${f.values.map((v, i) => (f.valueLabels?.[i] !== undefined ? `${v} = ${f.valueLabels[i]}` : String(v))).join(', ')})`;
      return `int${vals}${f.mask === 'lightLayers' ? ' (light layer mask)' : ''}`;
    }
    case 'enum':
      return `enum: ${f.options.map((o) => code(o.value)).join(', ')}`;
    case 'vec2':
    case 'vec3':
      return `${f.type} [${f.labels.join(', ')}]${f.optionalLast === true ? ' (last may be left out)' : ''}`;
    case 'assetRef':
      return `asset id (${f.kinds.join(', ')})`;
    case 'entityRef':
      return `object id${f.component !== undefined ? ` (with ${code(f.component)})` : ''}${f.anyScene === true ? ', any scene' : ''}`;
    case 'sceneRef':
      return 'scene id';
    case 'ref':
      return `${f.target} id${f.paramTypes !== undefined ? ` (${f.paramTypes.join(', ')})` : ''}${f.also !== undefined ? ` or ${f.also.map(code).join(', ')}` : ''}`;
    case 'signal':
      return 'signal name';
    case 'string': {
      const len = lengthText(f.minLength, f.maxLength, 'chars');
      return ['string', f.format, len].filter((x) => x !== undefined && x !== '').join(', ');
    }
    case 'list': {
      const n = f.length !== undefined ? `${f.length} items` : lengthText(f.minItems, f.maxItems, 'items');
      return `list of ${f.item.type === 'object' ? 'objects' : typeText(f.item)}${n !== '' ? `, ${n}` : ''}${f.unique === true ? ', distinct' : ''}`;
    }
    case 'map': {
      const n = lengthText(f.minEntries, f.maxEntries, 'entries');
      const key = f.keyRef !== undefined ? `${f.keyRef} id` : f.keyFormat !== undefined ? f.keyFormat : 'key';
      return `map ${key} → ${f.value.type === 'object' ? 'object' : typeText(f.value)}${n !== '' ? `, ${n}` : ''}`;
    }
    case 'components':
      return `components (${f.allowed.length} kinds)`;
    case 'json':
      if (f.shape !== undefined) return `JSON: ${code(f.shape)} (${shapeNames(f.shape).map((n) => ref(typeId(n), n)).join(', ')})`;
      return `JSON${f.typedBy !== undefined ? ` (typed by ${f.typedBy})` : ''}${f.valueType !== undefined ? ` (${f.valueType})` : ''}`;
    default:
      return f.type;
  }
}

function conditionText(when) {
  const list = Array.isArray(when) ? when : [when];
  return list.map((c) => `${code(c.key)} is ${c.in.map((v) => code(v)).join(' or ')}`).join(' and ');
}

function notesText(f) {
  const notes = [];
  notes.push(`**${f.label}.** ${f.tooltip}`);
  const tags = [];
  if (f.required === true) tags.push('required');
  if (f.when !== undefined) tags.push(`applies when ${conditionText(f.when)}`);
  if (f.nullable === true) tags.push('may be null');
  if (f.omitDefault === true) tags.push('stored only when not the default');
  if (f.readOnly === true) tags.push('written by a tool');
  if (f.dimension !== undefined) tags.push(`${f.dimension}D projects only`);
  if (f.handle !== undefined) tags.push(`Scene handle: ${f.handle}`);
  if (f.runtimeWritable === true) tags.push('scripts read and write');
  else if (f.scriptReadable === true) tags.push('scripts read');
  if (f.runtimeOnly === true) tags.push('exists only while the game runs');
  if (f.type === 'string' && f.format !== undefined) tags.push(`format ${f.format}`);
  if (f.type === 'enum' && f.options.some((o) => o.label.toLowerCase() !== o.value.toLowerCase())) tags.push(`choices: ${f.options.map((o) => `${code(o.value)} = ${o.label}`).join(', ')}`);
  if (f.type === 'components') tags.push(`allowed: ${f.allowed.map(code).join(', ')}`);
  if (f.rules !== undefined) tags.push(`rules: ${f.rules.join('; ')}`);
  if (tags.length > 0) notes.push(`(${tags.join('; ')})`);
  return notes.join(' ');
}

/** Flatten a field (and what it holds) into rows. */
function collect(f, path, rows) {
  rows.push([code(path), typeText(f), f.default === undefined ? '' : json(f.default), rangeText(f), notesText(f)]);
  if (f.type === 'object') for (const c of f.fields) collect(c, `${path}.${c.key}`, rows);
  else if (f.type === 'list' && (f.item.type === 'object' || f.item.type === 'list' || f.item.type === 'map')) collectInner(f.item, `${path}[]`, rows);
  else if (f.type === 'map' && (f.value.type === 'object' || f.value.type === 'list' || f.value.type === 'map')) collectInner(f.value, `${path}{}`, rows);
}

/** A list item or map value: its own row only when it is not a plain object (whose fields follow). */
function collectInner(f, path, rows) {
  if (f.type === 'object') {
    if (f.rules !== undefined) rows.push([code(path), 'object', '', '', `**${f.label}.** ${f.tooltip} (rules: ${f.rules.join('; ')})`]);
    for (const c of f.fields) collect(c, `${path}.${c.key}`, rows);
  } else collect(f, path, rows);
}

const HEADER = ['Field', 'Type', 'Default', 'Range', 'Description'];

/**
 * The table of a value descriptor: an object's fields at the top level
 * (`prefix` before each path, e.g. `environment.`), anything else as one row
 * named `value`.
 */
export function fieldTable(root, prefix = '') {
  const rows = [];
  if (root.type === 'object') for (const c of root.fields) collect(c, `${prefix}${c.key}`, rows);
  else if (root.type === 'list' || root.type === 'map') {
    collect(root, prefix === '' ? root.key : prefix.replace(/\.$/, ''), rows);
  } else collect(root, prefix === '' ? 'value' : prefix.replace(/\.$/, ''), rows);
  return table(HEADER, rows);
}
