/**
 * Style sliders tied to trim rows. A trim row (one that does not tile in v:
 * a baseboard, a frame) is drawn once across the part wearing it, so the
 * part should be as tall as the row: a style's Parameter wired straight into
 * a band profile's height or a frame profile's width is tied to the row its
 * profile's slot names. The preset's sliders show the row's height beside
 * such a parameter and offer to snap it to the row; on a sheet that draws
 * rows at their real height, a tied value further than
 * `TRIM_HEIGHT_TOLERANCE` from its row is a problem naming both heights.
 *
 * Geometry never follows the sheet (the simulation's colliders and an
 * export's meshes are made without row tables): a slider keeps its value
 * until it is snapped, and the row is then drawn at its own height on a part
 * of another size (`trimRunMapping`).
 *
 * Pure.
 */
import { ARCHITECTURE_STYLE_GRAPH_KIND, graphStr } from './arch-style-kinds';
import { architectureGraphsOf, architectureStylesOf, resolveArchitecturePreset, type ArchitectureGraphLike, type ArchitectureStyleDef, type ResolvedArchitecturePreset } from './arch-style';
import { TRIM_HEIGHT_TOLERANCE, trimRowMetres, trimRowOf, type TrimSheet } from './trim-sheet';

/** The profile fields a trim row covers across: the size of the face that wears the row. */
const ROW_FIELDS: Readonly<Record<string, string>> = { band: 'height', frame: 'width' };

/** A style parameter tied to a trim row: the profile node it sizes and the slot that node wears. */
export interface ArchitectureRowTie {
  param: string;
  node: string;
  slot: string;
}

/** The style's parameters tied to trim rows (each once: the first profile it sizes, by node id). */
export function architectureRowTies(style: ArchitectureStyleDef): ArchitectureRowTie[] {
  const out: ArchitectureRowTie[] = [];
  const seen = new Set<string>();
  const nodes = [...style.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of nodes) {
    const field = ROW_FIELDS[n.type];
    if (field === undefined) continue;
    const from = style.inputs.get(n.id)?.get(field)?.[0];
    const src = from === undefined ? undefined : style.nodes.get(from.node);
    if (src?.type !== 'parameter') continue;
    const param = graphStr(ARCHITECTURE_STYLE_GRAPH_KIND, src, 'name');
    const slot = graphStr(ARCHITECTURE_STYLE_GRAPH_KIND, n, 'slot');
    if (param === '' || slot === '' || seen.has(param) || !style.params.has(param)) continue;
    seen.add(param);
    out.push({ param, node: n.id, slot });
  }
  return out;
}

/** A tied parameter's row on a sheet: its slot and height (null: the sheet lacks the row, or it is a field, which stacks at any height). */
export function architectureTiedRow(tie: ArchitectureRowTie, sheet: TrimSheet): { slot: string; metres: number } | null {
  const row = trimRowOf(sheet, tie.slot);
  if (row === null || row.tileV === true) return null;
  return { slot: tie.slot, metres: trimRowMetres(sheet, row) };
}

/** Whether a part `value` metres tall is drawn with its row fitted (within the tolerance of the row's height). */
export function fitsTrimRow(value: number, rowMetres: number): boolean {
  return Math.abs(value - rowMetres) <= TRIM_HEIGHT_TOLERANCE * rowMetres;
}

/** A tied parameter whose value does not fit its row. */
export interface ArchitectureRowMismatch {
  param: string;
  slot: string;
  value: number;
  rowMetres: number;
}

/**
 * A resolved preset's tied parameters that do not fit their rows on `sheet`
 * (its own values, else the style's defaults; masks vary a value per outline
 * and are not judged). Only a sheet that draws rows at their real height:
 * one that fits every part to its rows has no mismatch to show.
 */
export function architectureRowMismatches(r: ResolvedArchitecturePreset, sheet: TrimSheet): ArchitectureRowMismatch[] {
  if (sheet.realHeight !== true || r.style === null) return [];
  const out: ArchitectureRowMismatch[] = [];
  for (const tie of architectureRowTies(r.style)) {
    const row = architectureTiedRow(tie, sheet);
    const p = r.style.params.get(tie.param)!;
    if (row === null) continue;
    const own = r.values[tie.param];
    const value = Math.min(p.max, Math.max(p.min, typeof own === 'number' && Number.isFinite(own) ? own : p.default));
    if (!fitsTrimRow(value, row.metres)) out.push({ param: tie.param, slot: tie.slot, value, rowMetres: row.metres });
  }
  return out;
}

/** A preset's mismatch on the trim material it names. */
export interface PresetRowMismatch extends ArchitectureRowMismatch {
  preset: string;
  /** The trim material the preset names (through its bases). */
  sheet: string;
}

/**
 * Every preset of a project's graphs (and the engine's starters) whose tied
 * sliders do not fit the rows of the sheet it names; `sheetOf` gives a trim
 * material's row table (an instance: its root's), null for anything else.
 * By preset id.
 */
export function presetRowMismatches(graphs: readonly ArchitectureGraphLike[] | undefined, sheetOf: (materialId: string) => TrimSheet | null): PresetRowMismatch[] {
  const table = architectureStylesOf(architectureGraphsOf(graphs ?? []));
  const out: PresetRowMismatch[] = [];
  for (const id of [...table.presets.keys()].sort()) {
    const r = resolveArchitecturePreset(table, id);
    const sheet = r.sheet === null ? null : sheetOf(r.sheet);
    if (sheet === null) continue;
    for (const x of architectureRowMismatches(r, sheet)) out.push({ ...x, preset: id, sheet: r.sheet! });
  }
  return out;
}

/** Metres as the sliders and problems show them (millimetres kept: a spec row is 0.156 m). */
export function formatRowMetres(m: number): string {
  return `${Number(m.toFixed(3))} m`;
}
