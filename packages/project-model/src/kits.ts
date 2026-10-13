/**
 * Kits (`content.kits`): one project item gathering what a level style is
 * built from — a trim sheet material, the architecture presets that use it,
 * block types, and named piece slots (a door, a window, a wall override, …)
 * each holding one or more model pieces.
 *
 * A kit references its parts; it never copies them. Block types, presets and
 * the trim material stay ordinary items and may belong to several kits, so a
 * kit that names a part the project no longer has is a problem
 * ({@link kitProblems}), not an invalid project: deleting a part is never
 * refused because a kit lists it.
 *
 * Kits are editor-side organisation. Every place that uses a kit piece
 * stores the concrete reference (an opening's model, a block look), so a
 * build never needs the kits and does not ship them.
 *
 * Not to be confused with a block type's `kits` (shown as "Themes": a
 * remap of block types a layer or region can show, `block-kit.ts`).
 *
 * Pure value validation: no I/O.
 */
import type { ModelErrorV2 } from './errors';
import type { KitCheck, KitCheckState } from './kit-checks';
import { BLOCK_LIMITS } from './block-layers';
import { resolveMaterial, type MaterialDef } from './materials';
import { ID_RE, isValidName } from './validate';

/** One model piece a slot holds: a model asset, optionally one named node of it, with a weight among the slot's pieces. */
export interface KitPiece {
  assetId: string;
  /** The node of the model drawn (absent: the whole model). */
  piece?: string;
  /** Relative weight when the slot holds several pieces (absent: 1), as a block look's. */
  weight?: number;
}

export interface KitDef {
  kitId: string;
  name: string;
  /** What the kit is for (absent: none). */
  description?: string;
  /** A texture asset shown as the kit's picture (absent: none). */
  thumbnail?: string;
  /** The trim sheet material its presets and block faces read (absent: none). */
  trimMaterial?: string;
  /** Architecture preset graph ids (absent: none). */
  presets?: string[];
  /** Block type ids (absent: none). */
  blockTypes?: string[];
  /** Piece slots: slot name → its pieces, one or several weighted variants (absent: none). */
  pieces?: Record<string, KitPiece[]>;
}

/**
 * Where a slot's piece stands, which its checks and the kit editor's sample
 * wall follow: `opening` in a hole of the wall (its bottom at `sill` metres),
 * `edge` on the wall's line in place of a stretch of it, `free` on the floor
 * in front of it. A piece in an opening or on an edge fills whole cells up
 * and along; a free piece only along.
 */
export interface KitSlotPlacement {
  readonly kind: 'opening' | 'edge' | 'free';
  /** An opening's bottom above the floor (metres). */
  readonly sill?: number;
}

export interface KitStandardSlot {
  readonly slot: string;
  readonly label: string;
  readonly placement: KitSlotPlacement;
}

/**
 * The slots every kit offers (the kit editor lists them even when empty);
 * a kit may add slots of its own under any other slot name (placed `free`).
 */
export const KIT_STANDARD_SLOTS: readonly KitStandardSlot[] = Object.freeze([
  { slot: 'door', label: 'Door', placement: { kind: 'opening', sill: 0 } },
  { slot: 'window', label: 'Window', placement: { kind: 'opening', sill: 1 } },
  { slot: 'wall-override', label: 'Wall override', placement: { kind: 'edge' } },
  { slot: 'corner', label: 'Corner', placement: { kind: 'free' } },
  { slot: 'stairs', label: 'Stairs', placement: { kind: 'free' } },
  { slot: 'railing', label: 'Railing', placement: { kind: 'edge' } },
  { slot: 'roof-edge', label: 'Roof edge', placement: { kind: 'free' } },
]);

const FREE_PLACEMENT: KitSlotPlacement = Object.freeze({ kind: 'free' });

/** Where a slot's piece stands (a custom slot: free). */
export function kitSlotPlacement(slot: string): KitSlotPlacement {
  return KIT_STANDARD_SLOTS.find((s) => s.slot === slot)?.placement ?? FREE_PLACEMENT;
}

/** A slot's label: the standard one, else its name. */
export function kitSlotLabel(slot: string): string {
  return KIT_STANDARD_SLOTS.find((s) => s.slot === slot)?.label ?? slot;
}

export const KIT_LIMITS = Object.freeze({
  descriptionChars: 1024,
  /** A slot holds as many weighted pieces as a block type has looks. */
  piecesPerSlot: BLOCK_LIMITS.variants,
  /** A piece's weight range, a block look's. */
  weightMax: 1000,
});

/** A slot's name: the id syntax (lower case, digits, `-`, `_`). */
export const KIT_SLOT_RE = ID_RE;
/** A model node name (as a block look's piece). */
const PIECE_RE = /^[^\u0000-\u001f]{1,128}$/;
const KIT_FIELDS = ['kitId', 'name', 'description', 'thumbnail', 'trimMaterial', 'presets', 'blockTypes', 'pieces'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

function idList(v: unknown, path: string, what: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) return err(errors, 'field_type', path, `${what} is a list of ids`, v, 'array');
  const seen = new Set<string>();
  v.forEach((id, i) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/${i}`, `${what} lists ids (the id syntax)`, id);
    else if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}`, `${what} lists "${id}" twice`, id);
    else seen.add(id);
  });
}

/** Validate one kit's shape (references are problems, {@link kitProblems}). */
export function validateKit(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) return err(errors, 'field_type', path, 'a kit is {kitId, name, trimMaterial?, presets?, blockTypes?, pieces?, description?, thumbnail?}', v, 'object');
  for (const k of Object.keys(v)) if (!KIT_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown kit field "${k}"`, k, KIT_FIELDS.join(', '));
  if (typeof v['kitId'] !== 'string' || !ID_RE.test(v['kitId'])) err(errors, 'id_invalid', `${path}/kitId`, 'kitId uses the id syntax', v['kitId']);
  if (typeof v['name'] !== 'string' || !isValidName(v['name'])) err(errors, 'field_value', `${path}/name`, 'name is 1-128 characters without control characters', v['name']);
  const d = v['description'];
  if (d !== undefined && (typeof d !== 'string' || d.length > KIT_LIMITS.descriptionChars)) err(errors, 'field_value', `${path}/description`, `description is text of at most ${KIT_LIMITS.descriptionChars} characters`, d);
  for (const k of ['thumbnail', 'trimMaterial']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !ID_RE.test(v[k]))) err(errors, 'id_invalid', `${path}/${k}`, `${k} is an id`, v[k]);
  idList(v['presets'], `${path}/presets`, 'presets', errors);
  idList(v['blockTypes'], `${path}/blockTypes`, 'blockTypes', errors);
  const pieces = v['pieces'];
  if (pieces === undefined) return;
  if (!isObj(pieces)) return err(errors, 'field_type', `${path}/pieces`, 'pieces is {slot: [{assetId, piece?, weight?}, …]}', pieces, 'object');
  for (const [slot, list] of Object.entries(pieces)) {
    const p = `${path}/pieces/${slot}`;
    if (!KIT_SLOT_RE.test(slot)) err(errors, 'field_value', p, 'a slot name uses the id syntax (lower case, digits, - and _)', slot);
    if (!Array.isArray(list) || list.length < 1 || list.length > KIT_LIMITS.piecesPerSlot) {
      err(errors, 'field_value', p, `a slot holds 1-${KIT_LIMITS.piecesPerSlot} pieces (an empty slot is not stored)`, Array.isArray(list) ? list.length : list);
      continue;
    }
    list.forEach((piece, i) => {
      const q = `${p}/${i}`;
      if (!isObj(piece)) return err(errors, 'field_type', q, 'a piece is {assetId, piece?, weight?}', piece, 'object');
      for (const k of Object.keys(piece)) if (k !== 'assetId' && k !== 'piece' && k !== 'weight') err(errors, 'field_unexpected', `${q}/${k}`, `unknown piece field "${k}"`, k, 'assetId, piece, weight');
      if (typeof piece['assetId'] !== 'string' || !ID_RE.test(piece['assetId'])) err(errors, 'id_invalid', `${q}/assetId`, 'assetId uses the id syntax', piece['assetId']);
      if (piece['piece'] !== undefined && (typeof piece['piece'] !== 'string' || !PIECE_RE.test(piece['piece']))) err(errors, 'field_value', `${q}/piece`, 'piece is a node name (1-128 characters)', piece['piece']);
      const w = piece['weight'];
      if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > KIT_LIMITS.weightMax)) err(errors, 'field_value', `${q}/weight`, `weight is a number in (0, ${KIT_LIMITS.weightMax}]`, w);
    });
  }
}

export function validateKits(value: unknown, path: string, errors: ModelErrorV2[], trusted?: ReadonlySet<unknown>): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'kits is a list', value, 'array of kits');
  const seen = new Set<string>();
  value.forEach((k, i) => {
    if (trusted?.has(k) !== true) validateKit(k, `${path}/${i}`, errors);
    const id = isObj(k) ? k['kitId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/kitId`, 'kitId is used twice', id);
      seen.add(id);
    }
  });
}

/** One kit in canonical form: fields in order, empty lists and slots left out, slots by name. */
export function canonicalKit(k: KitDef): KitDef {
  const slots = k.pieces === undefined ? [] : Object.keys(k.pieces).filter((s) => (k.pieces![s] ?? []).length > 0).sort(cmp);
  return {
    kitId: k.kitId,
    name: k.name,
    ...(k.description !== undefined && k.description !== '' ? { description: k.description } : {}),
    ...(k.thumbnail !== undefined ? { thumbnail: k.thumbnail } : {}),
    ...(k.trimMaterial !== undefined ? { trimMaterial: k.trimMaterial } : {}),
    ...(k.presets !== undefined && k.presets.length > 0 ? { presets: [...k.presets] } : {}),
    ...(k.blockTypes !== undefined && k.blockTypes.length > 0 ? { blockTypes: [...k.blockTypes] } : {}),
    ...(slots.length > 0
      ? {
          pieces: Object.fromEntries(
            slots.map((s) => [s, k.pieces![s]!.map((p) => ({ assetId: p.assetId, ...(p.piece !== undefined ? { piece: p.piece } : {}), ...(p.weight !== undefined && p.weight !== 1 ? { weight: p.weight } : {}) }))]),
          ),
        }
      : {}),
  };
}

export function canonicalKits(list: readonly KitDef[]): KitDef[] {
  return [...list].sort((a, b) => cmp(a.kitId, b.kitId)).map(canonicalKit);
}

/** What a kit's references are checked against. */
export interface KitProblemContent {
  readonly kits?: readonly KitDef[];
  readonly materials?: readonly MaterialDef[];
  readonly graphs?: readonly { readonly graphId: string; readonly kind: string }[];
  readonly blockTypes?: readonly { readonly blockId: string }[];
  readonly assets?: readonly { readonly assetId: string; readonly kind?: string }[];
}

export interface KitProblemRow {
  readonly kitId: string;
  readonly name: string;
  readonly problems: readonly string[];
}

/**
 * Each kit whose references the project does not satisfy, with what is
 * wrong in plain words: a trim material that is missing or not a trim sheet
 * (an instance draws with its root's rows), presets that are missing or not
 * architecture presets, missing block types, pieces whose model is missing
 * or not a model, a thumbnail that is not a texture. Kits with none are
 * left out.
 */
export function kitProblems(content: KitProblemContent): KitProblemRow[] {
  const kits = content.kits ?? [];
  if (kits.length === 0) return [];
  const materials = content.materials ?? [];
  const graphs = new Map((content.graphs ?? []).map((g) => [g.graphId, g.kind]));
  const blocks = new Set((content.blockTypes ?? []).map((b) => b.blockId));
  const assets = new Map((content.assets ?? []).map((a) => [a.assetId, a.kind ?? 'model']));
  const rows: KitProblemRow[] = [];
  for (const k of kits) {
    const out: string[] = [];
    if (k.trimMaterial !== undefined) {
      const m = resolveMaterial(materials, k.trimMaterial);
      if (!materials.some((x) => x.materialId === k.trimMaterial)) out.push(`its trim material "${k.trimMaterial}" is not in the project`);
      else if (m === null || m.shader !== 'trim') out.push(`its trim material "${k.trimMaterial}" is not a trim sheet material`);
    }
    for (const id of k.presets ?? []) {
      const kind = graphs.get(id);
      if (kind === undefined) out.push(`preset "${id}" is not in the project`);
      else if (kind !== 'architecture-preset') out.push(`"${id}" is a ${kind} graph, not an architecture preset`);
    }
    for (const id of k.blockTypes ?? []) if (!blocks.has(id)) out.push(`block type "${id}" is not in the project`);
    for (const [slot, list] of Object.entries(k.pieces ?? {})) {
      for (const p of list) {
        const kind = assets.get(p.assetId);
        if (kind === undefined) out.push(`the ${slot} piece's model "${p.assetId}" is not in the project`);
        else if (kind !== 'model') out.push(`the ${slot} piece "${p.assetId}" is a ${kind}, not a model`);
      }
    }
    if (k.thumbnail !== undefined) {
      const kind = assets.get(k.thumbnail);
      if (kind === undefined) out.push(`its thumbnail "${k.thumbnail}" is not in the project`);
      else if (kind !== 'texture') out.push(`its thumbnail "${k.thumbnail}" is a ${kind}, not a texture`);
    }
    if (out.length > 0) rows.push({ kitId: k.kitId, name: k.name, problems: out });
  }
  return rows;
}

/** The worst state of some kit checks (ok when empty), and their counts (the kit editor's slot states and tally). */
export function kitCheckTally(checks: readonly Pick<KitCheck, 'state'>[]): { state: KitCheckState; errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const c of checks) {
    if (c.state === 'err') errors += 1;
    else if (c.state === 'warn') warnings += 1;
  }
  return { state: errors > 0 ? 'err' : warnings > 0 ? 'warn' : 'ok', errors, warnings };
}
