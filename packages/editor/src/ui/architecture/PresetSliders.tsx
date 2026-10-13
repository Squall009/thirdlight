/**
 * An architecture preset's sliders, shown where a preset is edited: the
 * block editor's Rooms & buildings (the picked room's presets) and the
 * Inspector of a preset open in the editor window.
 *
 * - `PresetSliders`: a preset's style, base and trim sheet, and a slider per
 *   parameter of its style (its value through the presets it derives from,
 *   "↺" taking its own value away). Dragging previews in the Scene view at
 *   once: only the objects whose outlines the preset reaches (it, and every
 *   preset derived from it) are made again, and of those only the chunks
 *   whose elements changed. Releasing stores the value in the preset (one
 *   graph edit, one undo). The engine's starters are read-only: "Derive"
 *   makes a project preset from one. A slider tied to a trim row (a band's
 *   height, a frame's width: `arch-style-rows.ts`) shows the row's height on
 *   the sheet the preset wears, and "Snap to row" sets it to that height.
 * - `presetSlidersHost`: what the sliders read and send, from the project's
 *   graphs and materials.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { GraphDocument, GraphNode, GraphOp, MaterialDef, TrimSheet } from '@thirdlight/project-model';
import {
  ARCHITECTURE_PRESET_KIND,
  ARCHITECTURE_STARTER_GRAPHS,
  ARCHITECTURE_STYLE_KIND,
  architectureRowTies,
  architectureStylesOf,
  architectureTiedRow,
  fitsTrimRow,
  formatRowMetres,
  resolveArchitecturePreset,
  trimSheetOfMaterial,
  type ArchitecturePreview,
  type ArchitectureStyleParam,
} from '@thirdlight/runtime';

export interface PresetSlidersProps {
  presetId: string;
  /** The project's graphs (its styles and presets among them). */
  graphs: readonly GraphDocument[];
  /** Trim sheet materials a preset may name: [id, label]. */
  sheets: readonly (readonly [string, string])[];
  onEdit(graphId: string, ops: GraphOp[]): Promise<string | null>;
  onPreview(preview: ArchitecturePreview | null): void;
  /** Make a project preset deriving from `base` (a starter's sliders are read-only). */
  onDerive?(base: string): void;
  /** A trim material's row table (an instance: its root's; null: not a trim material). */
  sheetOf?(materialId: string): TrimSheet | null;
  /** The trim material the object's architecture wears, for a preset naming none (null: none known). */
  objectSheet?: string | null;
}

/** A slider's trim row: its slot and height, and whether the sheet draws rows at their real height. */
interface SliderRow {
  slot: string;
  metres: number;
  real: boolean;
}

/** What every preset slider reads and sends: the project's graphs, its trim materials, graph edits and the Scene view's preview. */
export type PresetSlidersHost = Pick<PresetSlidersProps, 'graphs' | 'sheets' | 'sheetOf' | 'onEdit' | 'onPreview'>;

export function presetSlidersHost(graphs: readonly GraphDocument[], materials: readonly MaterialDef[], onEdit: PresetSlidersProps['onEdit'], onPreview: PresetSlidersProps['onPreview']): PresetSlidersHost {
  return {
    graphs,
    sheets: materials.filter((m) => m.shader === 'trim').map((m) => [m.materialId, m.name ?? m.materialId] as const),
    sheetOf: (id: string) => trimSheetOfMaterial(materials, id),
    onEdit,
    onPreview,
  };
}

const archGraphsOf = (graphs: readonly GraphDocument[]): GraphDocument[] => graphs.filter((g) => g.kind === ARCHITECTURE_STYLE_KIND || g.kind === ARCHITECTURE_PRESET_KIND);

/** Every preset's id and name: the project's, then the engine's starters it does not replace. */
export function presetChoices(graphs: readonly GraphDocument[]): [string, string][] {
  const own = graphs.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND).map((g) => [g.graphId, g.name] as [string, string]);
  const ids = new Set(own.map(([id]) => id));
  return [...own, ...ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND && !ids.has(g.graphId)).map((g) => [g.graphId, g.name] as [string, string])];
}

function styleChoices(graphs: readonly GraphDocument[]): [string, string][] {
  const own = graphs.filter((g) => g.kind === ARCHITECTURE_STYLE_KIND).map((g) => [g.graphId, g.name] as [string, string]);
  const ids = new Set(own.map(([id]) => id));
  return [...own, ...ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_STYLE_KIND && !ids.has(g.graphId)).map((g) => [g.graphId, g.name] as [string, string])];
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

export function PresetSliders(props: PresetSlidersProps): JSX.Element {
  const { presetId, graphs } = props;
  const table = useMemo(() => architectureStylesOf(archGraphsOf(graphs)), [graphs]);
  const resolved = resolveArchitecturePreset(table, presetId);
  const doc = graphs.find((g) => g.graphId === presetId && g.kind === ARCHITECTURE_PRESET_KIND) ?? null;
  const starter = doc === null && ARCHITECTURE_STARTER_GRAPHS.some((g) => g.graphId === presetId);
  const name = doc?.name ?? ARCHITECTURE_STARTER_GRAPHS.find((g) => g.graphId === presetId)?.name ?? presetId;
  const head = doc?.graph.nodes.find((n) => n.type === 'preset') ?? null;
  // The style's parameters in the order its Parameter nodes stand (top to bottom).
  const params = useMemo((): ArchitectureStyleParam[] => {
    const style = resolved.style;
    if (style === null) return [];
    const at = new Map<string, number>();
    for (const n of style.nodes.values()) if (n.type === 'parameter' && typeof n.data?.['name'] === 'string') at.set(n.data['name'] as string, n.position[1] * 1e6 + n.position[0]);
    return [...style.params.values()].sort((a, b) => (at.get(a.name) ?? 0) - (at.get(b.name) ?? 0));
  }, [resolved.style]);
  // The rows the style's tied sliders size, on the sheet the preset wears (else the object's).
  const sheetId = resolved.sheet ?? props.objectSheet ?? null;
  const sheet = sheetId !== null ? (props.sheetOf?.(sheetId) ?? null) : null;
  const rows = useMemo((): Map<string, SliderRow> => {
    const out = new Map<string, SliderRow>();
    if (resolved.style === null || sheet === null) return out;
    for (const tie of architectureRowTies(resolved.style)) {
      const row = architectureTiedRow(tie, sheet);
      if (row !== null) out.set(tie.param, { ...row, real: sheet.realHeight === true });
    }
    return out;
  }, [resolved.style, sheet]);
  const own = (name: string): GraphNode[] => doc?.graph.nodes.filter((n) => n.type === 'value' && n.data?.['parameter'] === name) ?? [];
  const setHead = (key: 'style' | 'base' | 'sheet', value: string): void => {
    const data = { style: '', base: '', sheet: '', ...(head?.data ?? {}), [key]: value };
    void props.onEdit(presetId, head !== null ? [{ op: 'setNodeData', id: head.id, data }] : [{ op: 'addNodes', nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data }] }]);
  };
  const commit = async (p: ArchitectureStyleParam, value: number): Promise<void> => {
    const mine = own(p.name);
    const first = mine[0];
    const ops: GraphOp[] =
      first !== undefined
        ? [{ op: 'setNodeData', id: first.id, data: { ...(first.data ?? {}), value } }]
        : [{ op: 'addNodes', nodes: [{ id: freshId(doc?.graph.nodes ?? [], `v-${p.name}`), type: 'value', position: [0, 150 * ((doc?.graph.nodes.length ?? 0) + 1)], data: { parameter: p.name, value } }] }];
    await props.onEdit(presetId, ops);
    props.onPreview(null);
  };
  const reset = async (p: ArchitectureStyleParam): Promise<void> => {
    const ids = own(p.name).map((n) => n.id);
    if (ids.length > 0) await props.onEdit(presetId, [{ op: 'removeNodes', ids }]);
    props.onPreview(null);
  };
  return (
    <div className="tl-arch-preset" aria-label={`architecture preset ${presetId}`}>
      <div className="tl-inspector__subtitle">
        Preset “{name}”{starter ? ' (engine starter)' : ''}
      </div>
      {doc !== null && (
        <>
          <Pick label="style" name="preset style" value={String(head?.data?.['style'] ?? '')} options={[['', '— its base’s —'], ...styleChoices(graphs)]} onCommit={(v) => setHead('style', v)} />
          <Pick label="derives from" name="preset base" value={String(head?.data?.['base'] ?? '')} options={[['', '— none —'], ...presetChoices(graphs).filter(([id]) => id !== presetId)]} onCommit={(v) => setHead('base', v)} />
          <Pick label="trim sheet" name="preset trim sheet" value={String(head?.data?.['sheet'] ?? '')} options={[['', '— its base’s / the object’s —'], ...props.sheets]} onCommit={(v) => setHead('sheet', v)} />
        </>
      )}
      {starter && props.onDerive !== undefined && (
        <button type="button" className="tl-btn tl-btn--small" onClick={() => props.onDerive!(presetId)} title="A project preset deriving from this one (its sliders are yours)">
          Derive a preset
        </button>
      )}
      {resolved.problem !== null && <p className="tl-inspector__hint" role="alert">{resolved.problem}</p>}
      {params.map((p) => (
        <ParamSlider
          key={p.name}
          param={p}
          value={resolved.values[p.name] ?? p.default}
          own={own(p.name).length > 0}
          mask={resolved.masks[p.name] !== undefined ? `${resolved.masks[p.name]!.source} mask → ${resolved.masks[p.name]!.to}` : null}
          readOnly={doc === null}
          row={rows.get(p.name) ?? null}
          onDrag={(v) => props.onPreview({ preset: presetId, values: { [p.name]: v } })}
          onCommit={(v) => void commit(p, v)}
          onReset={() => void reset(p)}
        />
      ))}
    </div>
  );
}

function freshId(nodes: readonly GraphNode[], base: string): string {
  const ids = new Set(nodes.map((n) => n.id));
  let id = base.slice(0, 60);
  for (let i = 2; ids.has(id); i++) id = `${base.slice(0, 56)}-${i}`;
  return id;
}

function ParamSlider(props: { param: ArchitectureStyleParam; value: number; own: boolean; mask: string | null; readOnly: boolean; row: SliderRow | null; onDrag(v: number): void; onCommit(v: number): void; onReset(): void }): JSX.Element {
  const { param, value, row } = props;
  const [draft, setDraft] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setDraft(value);
  }, [value, dragging]);
  const step = round((param.max - param.min) / 200) || 0.001;
  const release = (): void => {
    setDragging(false);
    if (draft !== value) props.onCommit(draft);
  };
  const snapTo = row === null ? value : Math.min(param.max, Math.max(param.min, row.metres));
  const slider = (
    <label className="tl-field">
      <span className="tl-field__label" title={props.mask ?? undefined}>
        {param.name.replace(/_/g, ' ')}
        {props.mask !== null ? ' ◐' : ''}
      </span>
      <span className="tl-param__number">
        <input
          type="range"
          aria-label={`${param.name} slider`}
          min={param.min}
          max={param.max}
          step={step}
          value={draft}
          disabled={props.readOnly}
          onPointerDown={() => setDragging(true)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDraft(v);
            props.onDrag(v);
          }}
          onPointerUp={release}
          onKeyUp={release}
        />
        <input
          className="tl-input tl-input--num"
          aria-label={param.name}
          type="number"
          min={param.min}
          max={param.max}
          step={step}
          value={round(draft)}
          disabled={props.readOnly}
          onChange={(e) => setDraft(Number(e.target.value))}
          onBlur={() => {
            const v = Math.min(param.max, Math.max(param.min, draft));
            if (v !== value) props.onCommit(v);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {props.own && !props.readOnly && (
          <button type="button" className="tl-btn tl-btn--small" aria-label={`reset ${param.name}`} title="Take this preset's own value away (its base's or the style's default shows)" onClick={props.onReset}>
            ↺
          </button>
        )}
      </span>
    </label>
  );
  if (row === null) return slider;
  // A part off its row: fitted all the same on a sheet that fits rows to parts; drawn at the row's own height on one that does not.
  const fits = fitsTrimRow(value, row.metres);
  return (
    <>
      {slider}
      <div className="tl-field tl-field--hint" aria-label={`${param.name} row`}>
        <span className="tl-inspector__hint">
          Row “{row.slot}”: {formatRowMetres(row.metres)}
          {fits ? '' : row.real ? ` — the part is ${formatRowMetres(value)}: the row is drawn at its own height, not fitted` : ` — the part is ${formatRowMetres(value)}: the row is stretched to it`}
        </span>
        {!props.readOnly && Math.abs(snapTo - value) > 1e-6 && (
          <button type="button" className="tl-btn tl-btn--small" aria-label={`snap ${param.name} to row`} title={`Set ${param.name.replace(/_/g, ' ')} to the row's height (${formatRowMetres(row.metres)})`} onClick={() => props.onCommit(snapTo)}>
            Snap to row
          </button>
        )}
      </div>
    </>
  );
}

function Pick(props: { label: string; name: string; value: string; options: readonly (readonly [string, string])[]; onCommit: (v: string) => void }): JSX.Element {
  const known = props.options.some(([v]) => v === props.value);
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <select className="tl-input" aria-label={props.name} value={props.value} onChange={(e) => props.onCommit(e.target.value)}>
        {!known && <option value={props.value}>{props.value} (missing)</option>}
        {props.options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
