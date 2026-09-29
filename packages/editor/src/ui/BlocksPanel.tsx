/**
 * Phase 23.6 (E8): the Blocks panel — block-layer editing in the Scene view.
 *
 * - Layer: which block layer the tools edit, its visibility and lock (the
 *   object's Hierarchy flags), the height slice (PageUp/PageDown or ] / [).
 * - Tools: paint, line, rectangle, box, flood, raise/lower, erase, pick,
 *   replace-all, metadata, select, paste, stamp, region; brush rotation (Q),
 *   randomized looks, the box height.
 * - Palette: the project's block types (colour swatch or model thumbnail) and
 *   the chosen type's form (its content descriptor, as the Inspector draws
 *   it); the cell fields' forms; the metadata brush with the overlay toggles
 *   and legend; the selection (copy, paste, move, mirror, rotate, delete,
 *   save as stamp); the stamp library; the layer's named regions.
 *
 * Every change is a command through the App (`run` / `edit`): block types,
 * fields and stamps are content ops, cells and regions `editBlocks` edits —
 * one undo step each. Strokes are the Scene view's (`BlockEditor`).
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { BlockCell, BlockEdit, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField, CellMetaValue, DescriptorRegistry, ObjectFieldDescriptor } from '@thirdlight/project-model';
import { SCULPT_LIMITS } from '@thirdlight/runtime';
import { ObjectFields, type FieldContext } from './DescriptorFields';
import { componentPatch } from '../session/descriptor-fields';
import {
  BLOCK_TOOLS,
  DEFAULT_BRUSH,
  arrayFromCells,
  boxVolume,
  mirrorEdit,
  movedBox,
  nextRotation,
  pickBrush,
  rotateEdit,
  rotatedBox,
  sliceKey,
  type BlockToolId,
  type BrushState,
  type Cell3,
  type CellBox,
  type PasteSource,
} from '../session/block-brush';
import { enumColors, fieldColor, overlayLegend, parseMetaValue } from '../session/block-overlay';
import type { BlockEditor } from '../viewport/block-editor';

export interface BlockLayerRow {
  entityId: string;
  name: string;
  component: BlockLayerComponent;
  regions: readonly BlockRegion[];
  active: boolean;
  locked: boolean;
}

/** What the App hands the Scene view's block tools back to the panel (set by the panel). */
export interface BlockPanelHandlers {
  onPick(cell: BlockCell | null): void;
  onSelect(box: CellBox | null): void;
  onHover(at: Cell3 | null, cell: BlockCell | null): void;
  /** A stroke was stored. */
  onCommitted(entityId: string, edits: readonly BlockEdit[]): void;
  /** A key in the Scene (true: handled). */
  onKey(e: KeyboardEvent): boolean;
}

interface Props {
  editor: BlockEditor | null;
  /** The panel is in front (the tools are armed only then). */
  visible: boolean;
  layers: readonly BlockLayerRow[];
  /** The layer the tools edit (the App holds it: the Scene view draws its grid). */
  layerId: string | null;
  onLayer: (entityId: string | null) => void;
  types: readonly BlockType[];
  fields: readonly CellField[];
  stamps: readonly BlockStamp[];
  registry: DescriptorRegistry | null;
  fieldContext: FieldContext;
  thumbnails: ReadonlyMap<string, string>;
  handlers: { current: BlockPanelHandlers | null };
  /** A content / scene command (true: stored). */
  run: (what: string, op: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Some `editBlocks` edits of a layer (true: stored). */
  edit: (what: string, entityId: string, edits: BlockEdit[]) => Promise<boolean>;
  onCreateLayer: () => void;
  onSetFlag: (entityId: string, flag: 'active' | 'locked', value: boolean) => void;
  onNotice: (message: string) => void;
}

const newId = (base: string, taken: readonly string[]): string => {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  let id = slug;
  for (let i = 2; taken.includes(id); i++) id = `${slug}-${i}`;
  return id;
};

/** A block type's swatch: its first model's thumbnail, else its first colour. */
function Swatch({ t, thumbnails }: { t: BlockType; thumbnails: ReadonlyMap<string, string> }): JSX.Element {
  const v = t.variants[0];
  const thumb = v?.model !== undefined ? thumbnails.get(v.model.assetId) : undefined;
  if (thumb !== undefined) return <img className="tl-blocks__swatch" src={thumb} alt="" />;
  return <span className="tl-blocks__swatch" style={{ background: v?.color ?? '#808080' }} />;
}

function itemDesc(registry: DescriptorRegistry | null, key: string): ObjectFieldDescriptor | null {
  const d = registry?.content.find((b) => b.key === key)?.value;
  if (d === undefined || d.type !== 'list' || d.item.type !== 'object') return null;
  return d.item;
}

function applyPatch<T extends object>(current: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

export function BlocksPanel(p: Props): JSX.Element {
  const layerId = p.layerId;
  const setLayerId = p.onLayer;
  const [armed, setArmed] = useState(true);
  const [tool, setTool] = useState<BlockToolId>('single');
  const [brush, setBrush] = useState<BrushState>(DEFAULT_BRUSH);
  const [invert, setInvert] = useState(false);
  const [slice, setSlice] = useState(0);
  const [metaField, setMetaField] = useState<string>('');
  const [metaRaw, setMetaRaw] = useState<string>('');
  const [metaErase, setMetaErase] = useState(false);
  const [metaShape, setMetaShape] = useState<'cells' | 'rect'>('cells');
  const [occupiedOnly, setOccupiedOnly] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [showRegions, setShowRegions] = useState(true);
  const [region, setRegion] = useState<string | null>(null);
  const [regionDraft, setRegionDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState<{ id: string; to: string } | null>(null);
  const [selection, setSelection] = useState<CellBox | null>(null);
  const [clip, setClip] = useState<{ layerId: string; box: CellBox; array: PasteSource & { kind: 'array' }; move: boolean } | null>(null);
  const [stamp, setStamp] = useState<{ stampId: string; rot: 0 | 90 | 180 | 270; mirror: 'x' | 'z' | null } | null>(null);
  const [stampName, setStampName] = useState('');
  const [editType, setEditType] = useState<string | null>(null);
  const [hover, setHover] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // The first layer is chosen when none is (or the chosen one is gone).
  useEffect(() => {
    if (layerId !== null && p.layers.some((l) => l.entityId === layerId)) return;
    setLayerId(p.layers[0]?.entityId ?? null);
  }, [p.layers, layerId, setLayerId]);
  const layer = p.layers.find((l) => l.entityId === layerId) ?? null;
  const typeOf = useMemo(() => new Map(p.types.map((t) => [t.blockId, t])), [p.types]);
  const field = p.fields.find((f) => f.key === metaField) ?? null;

  // The metadata brush value (parsed per the field's type).
  const metaValue = useMemo((): { ok: true; value: CellMetaValue | null } | { ok: false; message: string } => {
    if (field === null) return { ok: false, message: 'choose a field' };
    if (metaErase) return { ok: true, value: null };
    const raw = metaRaw !== '' ? metaRaw : field.type === 'bool' ? 'true' : field.type === 'enum' ? (field.values?.[0] ?? '') : '';
    return parseMetaValue(field, raw);
  }, [field, metaRaw, metaErase]);

  // Drive the Scene view's tools.
  const editor = p.editor;
  // A moved selection pastes as a move within its layer (the cells leave their place).
  const pasteSource: PasteSource | null = clip === null ? null : clip.layerId === layerId ? { kind: 'copy', box: clip.box, ...(clip.move ? { move: true } : {}) } : clip.array;
  useEffect(() => {
    editor?.setOptions({
      tool,
      brush,
      invert,
      meta: field !== null && metaValue.ok ? { field: field.key, value: metaValue.value, occupiedOnly, shape: metaShape } : null,
      region,
      stamp,
      paste: pasteSource,
      pasteSize: clip === null ? null : [clip.box[3] - clip.box[0], clip.box[4] - clip.box[1], clip.box[5] - clip.box[2]],
    });
  });
  useEffect(() => {
    editor?.setActive(p.visible && armed && layer !== null);
    return () => editor?.setActive(false);
  }, [editor, p.visible, armed, layer !== null]);
  useEffect(() => {
    if (editor !== null && layer !== null) setSlice(editor.setSlice(slice));
  }, [editor, slice, layer?.entityId]);
  useEffect(() => editor?.setShownFields(shown), [editor, shown]);
  useEffect(() => editor?.setShowRegions(showRegions), [editor, showRegions]);
  useEffect(() => editor?.setSelection(selection), [editor, selection]);
  useEffect(() => setSelection(null), [layerId]);

  const clampSlice = (y: number): number => (layer === null ? y : Math.min(layer.component.bounds.max[1] - 1, Math.max(layer.component.bounds.min[1], y)));

  const copySelection = (move: boolean): void => {
    if (layer === null || selection === null || editor === null) return;
    setClip({ layerId: layer.entityId, box: selection, array: arrayFromCells(selection, (x, y, z) => editor.cellAt(x, y, z)), move });
    setTool('paste');
  };
  const selectionEdit = async (what: string, e: BlockEdit, next: CellBox | null): Promise<void> => {
    if (layer === null) return;
    if (await p.edit(what, layer.entityId, [e])) setSelection(next);
  };

  // Keys (only while the tools are armed and the Scene view is in front).
  p.handlers.current = {
    onPick: (cell) => {
      if (cell === null || cell.block === undefined) return p.onNotice('Pick: that cell holds no block.');
      setBrush((b) => pickBrush(b, cell));
    },
    onSelect: (box) => setSelection(box),
    onCommitted: (_entityId, edits) => {
      // A moved selection is placed once; the selection follows it.
      const e = edits[0];
      if (e?.kind === 'copy' && e.move === true && clip !== null) {
        setSelection(movedBox(clip.box, e.to as Cell3));
        setClip(null);
        setTool('select');
      }
    },
    onHover: (at, cell) => setHover(at === null ? '' : `${at.join(', ')}${cell?.block !== undefined ? ` · ${typeOf.get(cell.block)?.name ?? cell.block}${cell.rot !== undefined ? ` ${cell.rot}°` : ''}` : cell !== null ? ' · metadata' : ''}`),
    onKey: (e) => {
      if (!(p.visible && armed && layer !== null)) return false;
      const s = sliceKey(e.key, slice, layer.component.bounds);
      if (s !== null) {
        setSlice(s);
        return true;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!mod && key === 'q') {
        setBrush((b) => ({ ...b, rot: nextRotation(b.rot, b.block !== null ? typeOf.get(b.block) : undefined) }));
        return true;
      }
      if (selection !== null && mod && (key === 'c' || key === 'x')) {
        copySelection(key === 'x');
        return true;
      }
      if (clip !== null && mod && key === 'v') {
        setTool('paste');
        return true;
      }
      if (selection !== null && !mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        void selectionEdit('Delete cells', { kind: 'fill', box: [...selection], cell: null }, null);
        return true;
      }
      if (e.key === 'Escape' && selection !== null) {
        setSelection(null);
        return true;
      }
      return false;
    },
  };

  const typeDesc = itemDesc(p.registry, 'blockTypes');
  const fieldDesc = itemDesc(p.registry, 'cellFields');
  const editing = editType !== null ? (typeOf.get(editType) ?? null) : null;
  const legend = overlayLegend(p.fields, shown);

  const addType = (): void => {
    const blockId = newId('block', p.types.map((t) => t.blockId));
    const hue = (p.types.length * 67) % 360;
    const color = `#${[0, 8, 4].map((n) => { const k = (n + hue / 30) % 12; const c = 0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); }).join('')}`;
    void p.run('New block type', 'setBlockType', { block: { blockId, name: `Block ${p.types.length + 1}`, variants: [{ color }], shape: 'full' } }).then((ok) => {
      if (ok) {
        setEditType(blockId);
        setBrush((b) => ({ ...b, block: blockId, variant: null }));
      }
    });
  };
  const addField = (): void => {
    const key = newId('field', p.fields.map((f) => f.key)).replace(/-/g, '_');
    void p.run('New cell field', 'setCellFields', { fields: [...p.fields, { key, type: 'bool' }] }).then((ok) => ok && setMetaField(key));
  };

  const place = (tool: BlockToolId): void => {
    setTool(tool);
    setArmed(true);
  };

  return (
    <div className="tl-blocks" aria-label="blocks panel">
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
      <div className="tl-blocks__bar">
        <label>
          Layer{' '}
          <select aria-label="block layer" value={layerId ?? ''} onChange={(e) => setLayerId(e.target.value === '' ? null : e.target.value)}>
            {p.layers.length === 0 && <option value="">(none)</option>}
            {p.layers.map((l) => (
              <option key={l.entityId} value={l.entityId}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button className="tl-btn tl-btn--small" onClick={p.onCreateLayer} title="A new block layer object (64 × 16 × 64 cells of 1 m)">
          + Layer
        </button>
        {layer !== null && (
          <>
            <button className={`tl-btn tl-btn--small${layer.active ? '' : ' is-active'}`} aria-label="hide layer" aria-pressed={!layer.active} title="Hide or show the layer (the object's Active flag)" onClick={() => p.onSetFlag(layer.entityId, 'active', !layer.active)}>
              {layer.active ? 'Hide' : 'Hidden'}
            </button>
            <button className={`tl-btn tl-btn--small${layer.locked ? ' is-active' : ''}`} aria-label="lock layer" aria-pressed={layer.locked} title="Lock the layer against edits (the object's Locked flag)" onClick={() => p.onSetFlag(layer.entityId, 'locked', !layer.locked)}>
              {layer.locked ? 'Locked' : 'Lock'}
            </button>
            <label title="The height slice: the row the tools work on where no block is under the pointer (PageUp / PageDown or ] / [).">
              Slice{' '}
              <button className="tl-btn tl-btn--small" aria-label="slice down" onClick={() => setSlice((s) => clampSlice(s - 1))}>
                −
              </button>
              <input aria-label="slice" type="number" className="tl-blocks__num" value={slice} min={layer.component.bounds.min[1]} max={layer.component.bounds.max[1] - 1} onChange={(e) => Number.isFinite(Number(e.target.value)) && setSlice(clampSlice(Math.round(Number(e.target.value))))} />
              <button className="tl-btn tl-btn--small" aria-label="slice up" onClick={() => setSlice((s) => clampSlice(s + 1))}>
                +
              </button>
            </label>
            <label title="Edit cells in the Scene view (Alt+drag or the right button orbits)">
              <input type="checkbox" aria-label="edit cells" checked={armed} onChange={(e) => setArmed(e.target.checked)} /> Edit cells
            </label>
            <span className="tl-blocks__hover" aria-label="hovered cell">
              {hover}
            </span>
          </>
        )}
      </div>
      {p.layers.length === 0 && <p className="tl-note">No block layers in this scene. + Layer adds one (or add the Block layer component to an object).</p>}

      <div className="tl-blocks__tools" role="toolbar" aria-label="block tools">
        {BLOCK_TOOLS.map((t) => (
          <button key={t.id} className={`tl-btn tl-btn--small${tool === t.id ? ' is-active' : ''}`} aria-pressed={tool === t.id} title={t.hint} onClick={() => place(t.id)} disabled={(t.id === 'paste' && clip === null) || (t.id === 'stamp' && stamp === null)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tl-blocks__opts">
        <button className="tl-btn tl-btn--small" aria-label="rotate brush" title="Turn the brush a quarter turn (Q)" onClick={() => setBrush((b) => ({ ...b, rot: nextRotation(b.rot, b.block !== null ? typeOf.get(b.block) : undefined) }))}>
          Rotate {brush.rot}°
        </button>
        <label title="Each painted cell shows a look picked by the variants' weights from its position (the same everywhere); off: the chosen look.">
          <input type="checkbox" aria-label="randomize looks" checked={brush.randomize} onChange={(e) => setBrush((b) => ({ ...b, randomize: e.target.checked }))} /> Random look
        </label>
        {!brush.randomize && brush.block !== null && (typeOf.get(brush.block)?.variants.length ?? 0) > 1 && (
          <select aria-label="look" value={brush.variant ?? 0} onChange={(e) => setBrush((b) => ({ ...b, variant: Number(e.target.value) }))}>
            {typeOf.get(brush.block)!.variants.map((_v, i) => (
              <option key={i} value={i}>
                Look {i + 1}
              </option>
            ))}
          </select>
        )}
        <label title="The box brush's height in cells.">
          Box height <input aria-label="box height" type="number" className="tl-blocks__num" min={1} max={256} value={brush.height} onChange={(e) => setBrush((b) => ({ ...b, height: Math.max(1, Math.min(256, Math.round(Number(e.target.value) || 1))) }))} />
        </label>
        {(tool === 'height' || tool === 'smooth' || tool === 'flatten') && (
          <>
            <label title="The terrain brush's radius in cells.">
              Radius <input aria-label="brush radius" type="number" className="tl-blocks__num" min={SCULPT_LIMITS.radiusMin} max={SCULPT_LIMITS.radiusMax} step={0.5} value={brush.radius} onChange={(e) => setBrush((b) => ({ ...b, radius: Math.max(SCULPT_LIMITS.radiusMin, Math.min(SCULPT_LIMITS.radiusMax, Number(e.target.value) || b.radius)) }))} />
            </label>
            <label title="Height: cells raised (or lowered) at the centre per dab. Smooth and flatten: how far toward the target per dab (0-1).">
              Strength <input aria-label="brush strength" type="number" className="tl-blocks__num" min={0.015625} max={tool === 'height' ? SCULPT_LIMITS.strengthMax : 1} step={0.05} value={brush.strength} onChange={(e) => setBrush((b) => ({ ...b, strength: Math.max(0.015625, Math.min(SCULPT_LIMITS.strengthMax, Number(e.target.value) || b.strength)) }))} />
            </label>
          </>
        )}
        <label title="Lower columns (raise/lower), lower the ground (height) or remove from the region (region); Ctrl held flips it for one stroke.">
          <input type="checkbox" aria-label="lower or remove" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Lower / remove
        </label>
      </div>

      <div className="tl-blocks__cols">
        <section className="tl-blocks__col" aria-label="block palette">
          <div className="tl-panel__title">Palette</div>
          <div className="tl-blocks__palette">
            <button className={`tl-blocks__type${brush.block === null ? ' is-active' : ''}`} aria-label="no block" title="No block: flood erases, raising copies each column's top block" onClick={() => setBrush((b) => ({ ...b, block: null }))}>
              <span className="tl-blocks__swatch tl-blocks__swatch--none" />
              <span>None</span>
            </button>
            {p.types.map((t) => (
              <button key={t.blockId} className={`tl-blocks__type${brush.block === t.blockId ? ' is-active' : ''}`} aria-label={`block ${t.blockId}`} aria-pressed={brush.block === t.blockId} title={`${t.name} (${t.shape})`} onClick={() => { setBrush((b) => ({ ...b, block: t.blockId, variant: null })); setEditType(t.blockId); }}>
                <Swatch t={t} thumbnails={p.thumbnails} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
          <button className="tl-btn tl-btn--small" onClick={addType}>
            + Block type
          </button>
          {editing !== null && typeDesc !== null && (
            <div className="tl-blocks__form" aria-label="block type form">
              <div className="tl-desc__head">
                <span className="tl-panel__title">{editing.name}</span>
                <button className="tl-btn tl-btn--small tl-btn--danger" aria-label="delete block type" onClick={() => void p.run('Delete block type', 'deleteBlockType', { blockId: editing.blockId }).then((ok) => ok && setEditType(null))}>
                  delete
                </button>
              </div>
              <ObjectFields
                desc={typeDesc}
                value={editing as unknown as Record<string, unknown>}
                path={[]}
                component="blockType"
                ctx={p.fieldContext}
                onFail={setError}
                onEdit={(path, next) => {
                  setError(null);
                  const patch = componentPatch(typeDesc, editing as unknown as Record<string, unknown>, path, next);
                  if (patch === null) return;
                  if (patch['blockId'] !== undefined) return setError('A block type keeps its id (cells name it); make a new type instead.');
                  void p.run('Edit block type', 'setBlockType', { block: applyPatch(editing, patch) });
                }}
              />
            </div>
          )}
        </section>

        <section className="tl-blocks__col" aria-label="cell metadata">
          <div className="tl-panel__title">Metadata</div>
          {p.fields.length === 0 ? (
            <p className="tl-note">No cell fields yet. A field is data every cell can carry (walkable, slippery, cost…).</p>
          ) : (
            <>
              <div className="tl-blocks__row">
                <select aria-label="metadata field" value={metaField} onChange={(e) => { setMetaField(e.target.value); setMetaRaw(''); }}>
                  <option value="">(field)</option>
                  {p.fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label ?? f.key}
                    </option>
                  ))}
                </select>
                {field !== null && !metaErase && (field.type === 'bool' || field.type === 'enum' ? (
                  <select aria-label="metadata value" value={metaRaw !== '' ? metaRaw : field.type === 'bool' ? 'true' : (field.values?.[0] ?? '')} onChange={(e) => setMetaRaw(e.target.value)}>
                    {(field.type === 'bool' ? ['true', 'false'] : (field.values ?? [])).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input aria-label="metadata value" className="tl-blocks__text" value={metaRaw} placeholder={field.type} onChange={(e) => setMetaRaw(e.target.value)} />
                ))}
                <label title="Remove the field's value from the cells (they fall back to the block's and the schema's defaults).">
                  <input type="checkbox" aria-label="clear metadata" checked={metaErase} onChange={(e) => setMetaErase(e.target.checked)} /> Clear
                </label>
                <select aria-label="metadata shape" value={metaShape} onChange={(e) => setMetaShape(e.target.value as 'cells' | 'rect')}>
                  <option value="cells">Cells</option>
                  <option value="rect">Rectangle</option>
                </select>
                <label title="Only cells that hold something (empty cells otherwise become metadata-only cells).">
                  <input type="checkbox" aria-label="occupied only" checked={occupiedOnly} onChange={(e) => setOccupiedOnly(e.target.checked)} /> Occupied only
                </label>
              </div>
              {field !== null && !metaValue.ok && <p className="tl-prop__error">{metaValue.message}</p>}
              <div className="tl-blocks__row" aria-label="overlay fields">
                Overlay:
                {p.fields.map((f) => (
                  <label key={f.key}>
                    <input
                      type="checkbox"
                      aria-label={`overlay ${f.key}`}
                      checked={shown.has(f.key)}
                      onChange={(e) => {
                        const next = new Set(shown);
                        if (e.target.checked) next.add(f.key);
                        else next.delete(f.key);
                        setShown(next);
                      }}
                    />{' '}
                    <span className="tl-blocks__dot" style={{ background: f.type === 'enum' ? Object.values(enumColors(f))[0] : fieldColor(f) }} />
                    {f.label ?? f.key}
                  </label>
                ))}
              </div>
              {legend.length > 0 && (
                <div className="tl-blocks__legend" aria-label="overlay legend">
                  {legend.map((l) => (
                    <div key={l.key}>
                      <b>{l.label}</b>{' '}
                      {l.entries.map((e) => (
                        <span key={e.label} className="tl-blocks__legend-entry">
                          <span className="tl-blocks__dot" style={{ background: e.color }} />
                          {e.label}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <details className="tl-blocks__details">
            <summary>Cell fields ({p.fields.length})</summary>
            {fieldDesc !== null &&
              p.fields.map((f, i) => (
                <div key={f.key} className="tl-blocks__form" aria-label={`cell field ${f.key}`}>
                  <div className="tl-desc__head">
                    <span className="tl-panel__title">{f.label ?? f.key}</span>
                    <button className="tl-btn tl-btn--small tl-btn--danger" aria-label={`delete field ${f.key}`} onClick={() => void p.run('Delete cell field', 'setCellFields', { fields: p.fields.filter((_x, j) => j !== i) })}>
                      delete
                    </button>
                  </div>
                  <ObjectFields
                    desc={fieldDesc}
                    value={f as unknown as Record<string, unknown>}
                    path={[]}
                    component="cellField"
                    ctx={p.fieldContext}
                    onFail={setError}
                    onEdit={(path, next) => {
                      setError(null);
                      const patch = componentPatch(fieldDesc, f as unknown as Record<string, unknown>, path, next);
                      if (patch === null) return;
                      const nextField = applyPatch(f, patch);
                      void p.run('Edit cell field', 'setCellFields', { fields: p.fields.map((x, j) => (j === i ? nextField : x)) });
                    }}
                  />
                </div>
              ))}
            <button className="tl-btn tl-btn--small" onClick={addField}>
              + Cell field
            </button>
          </details>
        </section>

        <section className="tl-blocks__col" aria-label="selection and stamps">
          <div className="tl-panel__title">Selection</div>
          {selection === null ? (
            <p className="tl-note">Select tool: drag a box of cells.</p>
          ) : (
            <>
              <p className="tl-blocks__readout" aria-label="selection box">
                [{selection.slice(0, 3).join(', ')}] – [{selection.slice(3).map((v) => v - 1).join(', ')}] · {boxVolume(selection)} cells
              </p>
              <div className="tl-blocks__row">
                <button className="tl-btn tl-btn--small" onClick={() => copySelection(false)} title="Copy (Ctrl+C); then click with Paste">
                  Copy
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => copySelection(true)} title="Move (Ctrl+X); then click where the cells go">
                  Move
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => void selectionEdit('Mirror', mirrorEdit(selection, 'x'), selection)}>
                  Mirror X
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => void selectionEdit('Mirror', mirrorEdit(selection, 'z'), selection)}>
                  Mirror Z
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => void selectionEdit('Rotate', rotateEdit(selection), clipRotated(selection, layer))}>
                  Rotate 90°
                </button>
                <button className="tl-btn tl-btn--small tl-btn--danger" onClick={() => void selectionEdit('Delete cells', { kind: 'fill', box: [...selection], cell: null }, null)}>
                  Delete
                </button>
              </div>
              <div className="tl-blocks__row">
                <input aria-label="stamp name" className="tl-blocks__text" placeholder="stamp name" value={stampName} onChange={(e) => setStampName(e.target.value)} />
                <button
                  className="tl-btn tl-btn--small"
                  disabled={stampName.trim() === '' || layer === null}
                  onClick={() => {
                    const stampId = newId(stampName, p.stamps.map((s) => s.stampId));
                    void p.run('Save stamp', 'setBlockStamp', { stampId, name: stampName.trim().slice(0, 64), entityId: layer!.entityId, box: [...selection] }).then((ok) => {
                      if (!ok) return;
                      setStampName('');
                      setStamp({ stampId, rot: 0, mirror: null });
                    });
                  }}
                >
                  Save as stamp
                </button>
              </div>
            </>
          )}
          {clip !== null && <p className="tl-blocks__readout">{clip.move ? 'Moving' : 'Copied'} {boxVolume(clip.box)} cells — Paste tool: click where the min corner goes.</p>}
          <div className="tl-panel__title">Stamps</div>
          {p.stamps.length === 0 ? (
            <p className="tl-note">No stamps yet: select cells and save them as a stamp.</p>
          ) : (
            <ul className="tl-blocks__list" aria-label="stamp library">
              {p.stamps.map((s) => (
                <li key={s.stampId} className={stamp?.stampId === s.stampId ? 'is-active' : ''}>
                  <span>
                    {s.name} <small>{s.size.join('×')}</small>
                  </span>
                  <button className="tl-btn tl-btn--small" aria-label={`place stamp ${s.stampId}`} onClick={() => { setStamp({ stampId: s.stampId, rot: stamp?.stampId === s.stampId ? stamp.rot : 0, mirror: stamp?.stampId === s.stampId ? stamp.mirror : null }); place('stamp'); }}>
                    Place
                  </button>
                  <button className="tl-btn tl-btn--small tl-btn--danger" aria-label={`delete stamp ${s.stampId}`} onClick={() => void p.run('Delete stamp', 'deleteBlockStamp', { stampId: s.stampId }).then((ok) => ok && stamp?.stampId === s.stampId && setStamp(null))}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {stamp !== null && (
            <div className="tl-blocks__row">
              <button className="tl-btn tl-btn--small" onClick={() => setStamp({ ...stamp, rot: ((stamp.rot + 90) % 360) as 0 | 90 | 180 | 270 })}>
                Stamp {stamp.rot}°
              </button>
              <select aria-label="stamp mirror" value={stamp.mirror ?? ''} onChange={(e) => setStamp({ ...stamp, mirror: e.target.value === '' ? null : (e.target.value as 'x' | 'z') })}>
                <option value="">No mirror</option>
                <option value="x">Mirror X</option>
                <option value="z">Mirror Z</option>
              </select>
            </div>
          )}
        </section>

        <section className="tl-blocks__col" aria-label="regions">
          <div className="tl-panel__title">Regions</div>
          <label>
            <input type="checkbox" aria-label="show regions" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} /> Show outlines
          </label>
          <ul className="tl-blocks__list" aria-label="region list">
            {(layer?.regions ?? []).map((r) => (
              <li key={r.regionId} className={region === r.regionId ? 'is-active' : ''}>
                {renameDraft?.id === r.regionId ? (
                  <input
                    aria-label={`rename region ${r.regionId}`}
                    className="tl-blocks__text"
                    autoFocus
                    value={renameDraft.to}
                    onChange={(e) => setRenameDraft({ id: r.regionId, to: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setRenameDraft(null);
                      if (e.key !== 'Enter' || layer === null) return;
                      const to = renameDraft.to.trim();
                      setRenameDraft(null);
                      if (to === '' || to === r.regionId) return;
                      void p.edit('Rename region', layer.entityId, [{ kind: 'region', regionId: r.regionId, op: 'rename', to }]).then((ok) => ok && region === r.regionId && setRegion(to));
                    }}
                  />
                ) : (
                  <button className="tl-blocks__name" aria-label={`region ${r.regionId}`} onClick={() => { setRegion(r.regionId); place('region'); }} onDoubleClick={() => setRenameDraft({ id: r.regionId, to: r.regionId })} title="Paint it with the Region tool; double-click to rename">
                    {r.regionId} <small>{r.boxes.length} box{r.boxes.length === 1 ? '' : 'es'}</small>
                  </button>
                )}
                <button className="tl-btn tl-btn--small" aria-label={`rename ${r.regionId}`} onClick={() => setRenameDraft({ id: r.regionId, to: r.regionId })}>
                  Rename
                </button>
                <button className="tl-btn tl-btn--small tl-btn--danger" aria-label={`delete region ${r.regionId}`} onClick={() => layer !== null && void p.edit('Delete region', layer.entityId, [{ kind: 'region', regionId: r.regionId, op: 'delete' }])}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="tl-blocks__row">
            <input aria-label="new region" className="tl-blocks__text" placeholder="region id (e.g. zone1.start)" value={regionDraft} onChange={(e) => setRegionDraft(e.target.value)} />
            <button
              className="tl-btn tl-btn--small"
              disabled={regionDraft.trim() === '' || layer === null}
              title="A new region: the selection (or paint it with the Region tool)"
              onClick={() => {
                const id = regionDraft.trim();
                if (selection !== null && layer !== null) {
                  void p.edit('New region', layer.entityId, [{ kind: 'region', regionId: id, op: 'set', boxes: [[...selection]] }]).then((ok) => ok && setRegionDraft(''));
                } else {
                  setRegion(id);
                  setRegionDraft('');
                  place('region');
                }
              }}
            >
              + Region
            </button>
          </div>
          {selection !== null && region !== null && layer !== null && (
            <div className="tl-blocks__row">
              <button className="tl-btn tl-btn--small" onClick={() => void p.edit('Add to region', layer.entityId, [{ kind: 'region', regionId: region, op: 'add', boxes: [[...selection]] }])}>
                Add selection to {region}
              </button>
              <button className="tl-btn tl-btn--small" onClick={() => void p.edit('Remove from region', layer.entityId, [{ kind: 'region', regionId: region, op: 'remove', boxes: [[...selection]] }])}>
                Remove selection
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The selection after a quarter turn, clipped to the layer (null: outside). */
function clipRotated(box: CellBox, layer: BlockLayerRow | null): CellBox | null {
  const r = rotatedBox(box);
  if (layer === null) return r;
  const b = layer.component.bounds;
  return r[3] <= b.max[0] && r[5] <= b.max[2] ? r : null;
}
