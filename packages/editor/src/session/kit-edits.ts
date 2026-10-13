/**
 * The kit editor's edits as values: each returns the kit as it is after one
 * user action, which the editor stores with one `setKit` (one undo step).
 * Slots: the standard ones (always listed) and the kit's own; a slot holds
 * one or more weighted pieces (variants), an empty slot is not stored.
 *
 * Pure: no DOM.
 */
import type { BlockType, GraphDocument, GraphOp, KitCheckReport, KitCheckState, KitDef, KitPiece, KitPieceReport, KitSlotPlacement } from '@thirdlight/project-model';
import { KIT_LIMITS, KIT_SLOT_RE, KIT_STANDARD_SLOTS, kitCheckTally, kitSlotLabel, kitSlotPlacement } from '@thirdlight/project-model/limits';

export interface KitSlotView {
  slot: string;
  label: string;
  standard: boolean;
  placement: KitSlotPlacement;
  pieces: readonly KitPiece[];
}

/** The kit's slots in the editor's order: the standard ones, then its own by name. */
export function kitSlots(kit: KitDef): KitSlotView[] {
  const standard = new Set(KIT_STANDARD_SLOTS.map((s) => s.slot));
  const own = Object.keys(kit.pieces ?? {}).filter((s) => !standard.has(s)).sort();
  return [...KIT_STANDARD_SLOTS.map((s) => s.slot), ...own].map((slot) => ({ slot, label: kitSlotLabel(slot), standard: standard.has(slot), placement: kitSlotPlacement(slot), pieces: kit.pieces?.[slot] ?? [] }));
}

/** The kit with `slot` holding `pieces` (none: the slot is left out). */
export function withSlotPieces(kit: KitDef, slot: string, pieces: readonly KitPiece[]): KitDef {
  const next: Record<string, KitPiece[]> = { ...(kit.pieces ?? {}) };
  if (pieces.length === 0) delete next[slot];
  else next[slot] = pieces.map((p) => ({ ...p }));
  const { pieces: _old, ...rest } = kit;
  return Object.keys(next).length === 0 ? rest : { ...rest, pieces: next };
}

/**
 * A piece dropped or picked for a slot: in place of variant `index`, or
 * added as a new variant (`index` null; a slot that is full replaces its
 * last). A new variant weighs 1.
 */
export function assignPiece(kit: KitDef, slot: string, index: number | null, piece: { assetId: string; piece?: string }): KitDef {
  const list = [...(kit.pieces?.[slot] ?? [])];
  const made: KitPiece = { assetId: piece.assetId, ...(piece.piece !== undefined && piece.piece !== '' ? { piece: piece.piece } : {}) };
  if (index !== null && index < list.length) {
    const old = list[index]!;
    list[index] = { ...made, ...(old.weight !== undefined ? { weight: old.weight } : {}) };
  } else if (list.length >= KIT_LIMITS.piecesPerSlot) list[list.length - 1] = made;
  else list.push(made);
  return withSlotPieces(kit, slot, list);
}

export function removePiece(kit: KitDef, slot: string, index: number): KitDef {
  return withSlotPieces(kit, slot, (kit.pieces?.[slot] ?? []).filter((_p, i) => i !== index));
}

/** A variant's piece of its file (`''`: the whole file). */
export function setPieceNode(kit: KitDef, slot: string, index: number, node: string): KitDef {
  return withSlotPieces(kit, slot, (kit.pieces?.[slot] ?? []).map((p, i) => (i !== index ? p : { assetId: p.assetId, ...(node !== '' ? { piece: node } : {}), ...(p.weight !== undefined ? { weight: p.weight } : {}) })));
}

/** A variant's weight among the slot's (clamped to the kit's range; 1 is the default and not stored). */
export function setPieceWeight(kit: KitDef, slot: string, index: number, weight: number): KitDef {
  const w = Math.min(KIT_LIMITS.weightMax, Math.max(0.01, Number.isFinite(weight) ? weight : 1));
  return withSlotPieces(kit, slot, (kit.pieces?.[slot] ?? []).map((p, i) => (i !== index ? p : { assetId: p.assetId, ...(p.piece !== undefined ? { piece: p.piece } : {}), ...(w !== 1 ? { weight: w } : {}) })));
}

/** A slot name from what a user typed ("Shop sign" → `shop-sign`), or why it cannot be one. */
export function customSlotName(kit: KitDef, typed: string): { ok: true; slot: string } | { ok: false; message: string } {
  const slot = typed.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (slot === '' || !KIT_SLOT_RE.test(slot)) return { ok: false, message: 'A slot name needs letters or digits (e.g. "shop sign").' };
  if (kitSlots(kit).some((s) => s.slot === slot)) return { ok: false, message: `The kit has a "${kitSlotLabel(slot)}" slot already.` };
  return { ok: true, slot };
}

/** Each piece's report of a slot, by variant index. */
export function slotReports(report: KitCheckReport | null, slot: string): KitPieceReport[] {
  return report === null ? [] : report.pieces.filter((p) => p.slot === slot).sort((a, b) => a.index - b.index);
}

/** A slot's state: the worst of its pieces' checks (null: empty, or not checked yet). */
export function slotState(report: KitCheckReport | null, slot: string, pieces: readonly KitPiece[]): KitCheckState | null {
  if (pieces.length === 0) return null;
  const reports = slotReports(report, slot);
  if (reports.length === 0) return null;
  return kitCheckTally(reports.flatMap((r) => r.checks)).state;
}

/** Errors and warnings across the kit's pieces and its sheet. */
export function kitTally(report: KitCheckReport | null): { errors: number; warnings: number } {
  if (report === null) return { errors: 0, warnings: 0 };
  const t = kitCheckTally([...report.pieces.flatMap((p) => p.checks), ...(report.sheet?.report.checks ?? [])]);
  return { errors: t.errors, warnings: t.warnings };
}

/** A list of ids with one added (at the end) or taken out. */
export function withId(list: readonly string[] | undefined, id: string, on: boolean): string[] {
  const cur = list ?? [];
  return on ? (cur.includes(id) ? [...cur] : [...cur, id]) : cur.filter((x) => x !== id);
}

/** A kit piece offered where a model is picked (a door in an opening, a wall piece): its slot, the model, a key for pickers. */
export interface KitPieceChoice {
  readonly key: string;
  readonly slot: string;
  readonly model: { assetId: string; piece?: string };
}

/** A model reference as a picker's value (`assetId`, `#piece` after it). */
export const modelKey = (m: { assetId: string; piece?: string }): string => (m.piece !== undefined ? `${m.assetId}#${m.piece}` : m.assetId);

/** The pieces of a kit's slots, in the slots' order, each model once (null kit: none). */
export function kitPieceChoices(kit: KitDef | null, slots: readonly string[]): KitPieceChoice[] {
  const out: KitPieceChoice[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    for (const p of kit?.pieces?.[slot] ?? []) {
      const model = { assetId: p.assetId, ...(p.piece !== undefined ? { piece: p.piece } : {}) };
      const key = modelKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, slot, model });
    }
  }
  return out;
}

/** What swapping a kit's trim sheet changes besides the kit: its presets' sheet, its block types' and its pieces' materials. */
export interface KitSheetSwap {
  /** Each preset of the kit that names the old sheet: the graph edit naming the new one. */
  presets: { graphId: string; ops: GraphOp[] }[];
  /** Each block type of the kit wearing the old sheet: the type wearing the new one in its place. */
  blockTypes: BlockType[];
  /** Each piece model of the kit with a material mapped to the old sheet: its whole mapping with the new one in its place. */
  assets: { assetId: string; materials: Record<string, string> }[];
}

/**
 * The kit's parts re-pointed from trim material `from` to `to`: a preset
 * whose own head names `from` names `to` (a preset naming no sheet, or
 * another, is left: it follows its base or the object), a block type's
 * material slots holding `from` hold `to`, and so does a piece model's
 * material mapping (`assetMaterials`: the model's current mapping), since the
 * pieces are UV'd against the sheet's rows and must keep wearing the kit's
 * sheet. Only the kit's own presets, block types and pieces: parts it does
 * not list keep their sheet.
 */
export function kitSheetSwap(kit: KitDef, from: string, to: string, graphs: readonly GraphDocument[], blockTypes: readonly BlockType[], assetMaterials: (assetId: string) => Readonly<Record<string, string>> | undefined = () => undefined): KitSheetSwap {
  if (from === to) return { presets: [], blockTypes: [], assets: [] };
  const presets: KitSheetSwap['presets'] = [];
  for (const id of kit.presets ?? []) {
    const head = graphs.find((g) => g.graphId === id)?.graph.nodes.find((n) => n.type === 'preset');
    if (head === undefined || head.data?.['sheet'] !== from) continue;
    presets.push({ graphId: id, ops: [{ op: 'setNodeData', id: head.id, data: { ...head.data, sheet: to } }] });
  }
  const types: BlockType[] = [];
  for (const id of kit.blockTypes ?? []) {
    const t = blockTypes.find((b) => b.blockId === id);
    if (t?.materials === undefined || !Object.values(t.materials).includes(from)) continue;
    types.push({ ...t, materials: Object.fromEntries(Object.entries(t.materials).map(([slot, m]) => [slot, m === from ? to : m])) });
  }
  const assets: KitSheetSwap['assets'] = [];
  const seen = new Set<string>();
  for (const piece of Object.values(kit.pieces ?? {}).flat()) {
    if (seen.has(piece.assetId)) continue;
    seen.add(piece.assetId);
    const mapping = assetMaterials(piece.assetId);
    if (mapping === undefined || !Object.values(mapping).includes(from)) continue;
    assets.push({ assetId: piece.assetId, materials: Object.fromEntries(Object.entries(mapping).map(([source, m]) => [source, m === from ? to : m])) });
  }
  return { presets, blockTypes: types, assets };
}
