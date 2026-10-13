/**
 * The "Kit: <name>" tab of the editor window — a kit's slots, trim sheet,
 * picture and parts in one place, checked against the trim sheet spec.
 *
 * - Left: the piece slots (the standard ones always, then the kit's own),
 *   each with its piece's picture and state; drop a GLB file or a model (or
 *   one piece of it) from the project window on a slot. The kit's trim sheet
 *   (a picker), its picture, what it is for, and the presets and block types
 *   it names, each with Open.
 * - Centre: the trim checker — the sheet with its row bounds and gutters
 *   drawn over it, its rows, and the spec's checklist run on it — or the
 *   spec itself.
 * - The preview pane shows the picked slot's piece in a sample wall, a room
 *   or alone; the Inspector beside it the slot (its variants, piece checks,
 *   placement) or a block type.
 *
 * Every edit is one `setKit` (one undo step); a dropped GLB is published
 * first (its own step).
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';
import type { GraphDocument, KitDef, MaterialDef } from '@thirdlight/project-model';
import { kitSlotPlacement } from '@thirdlight/project-model/limits';
import { ARCHITECTURE_PRESET_KIND } from '@thirdlight/runtime';
import type { MaterialFunctionLike } from '@thirdlight/three-adapter';

import { assignPiece, customSlotName, kitSlots, kitTally, slotReports, slotState, withId, type KitSlotView } from '../../session/kit-edits';
import { trimSheetMaterials } from '../../session/layer-palette';
import { ASSET_DRAG_TYPE, assetDropOf } from '../../session/placement';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { TileImage } from '../assets/TileImage';
import { useAssetSummaries } from '../catalog/catalog-context';
import { EditorToolbar, ToolButton, ToolbarSpacer } from '../chrome/EditorChrome';
import { CheckRow } from '../editmode/CheckRow';
import { Section } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import { TextureBrowser } from '../palette/TextureBrowser';
import { useLayerThumb } from '../palette/LayerPalette';
import { usePreview } from '../preview/preview-request';
import { TrimChecker } from './TrimChecker';
import type { KitEditor } from './useKitEditor';

export interface KitDocumentHost {
  editor: KitEditor;
  kits: readonly KitDef[];
  materials: readonly MaterialDef[];
  graphs: readonly GraphDocument[];
  blockTypes: readonly { blockId: string; name: string }[];
  thumbnails: TileThumbnails | null;
  /** Open a preset (or any graph) in its tab, a material in its tab. */
  onOpen: (kind: 'graph' | 'material', id: string) => void;
  /** A manual page as text (the trim sheet spec). */
  docs: (topic: string) => Promise<{ ok: true; title: string; text: string } | { ok: false; error: { message: string } }>;
}

export interface KitDocumentProps extends KitDocumentHost {
  kitId: string;
}

/** The spec's page in the manual. */
export const TRIM_SPEC_TOPIC = 'guides/trim-sheet-spec';

/** A GLB file or a model tile dropped on a slot: published if it is a file, then the slot holds it (variant `index`, or added). */
export async function dropOnSlot(ev: DragEvent, editor: KitEditor, kit: KitDef, slot: string, index: number | null): Promise<void> {
  const file = ev.dataTransfer.files[0];
  const tile = file === undefined ? assetDropOf(ev, 'model') : null;
  if (file === undefined && tile === null) return;
  ev.preventDefault();
  const assetId = file !== undefined ? await editor.importModel(file) : tile!.assetId;
  if (typeof assetId !== 'string') return;
  editor.setPick({ kind: 'slot', slot, index: index ?? (kit.pieces?.[slot]?.length ?? 0) });
  await editor.save(assignPiece(editor.kit ?? kit, slot, index, { assetId, ...(tile?.piece !== undefined ? { piece: tile.piece } : {}) }));
}

/** Whether a drag carries something a slot takes (a file, a model tile). */
export const slotDragOk = (ev: DragEvent): boolean => ev.dataTransfer.types.includes('Files') || ev.dataTransfer.types.includes(ASSET_DRAG_TYPE);

export function KitDocument(p: KitDocumentProps): JSX.Element {
  const { editor } = p;
  const kit = p.kits.find((k) => k.kitId === p.kitId) ?? null;
  const [pending, setPending] = useState<readonly string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [spec, setSpec] = useState(false);
  const report = editor.report;
  const sheets = useMemo(() => trimSheetMaterials(p.materials), [p.materials]);
  const sheetDef = kit?.trimMaterial !== undefined ? (p.materials.find((m) => m.materialId === kit.trimMaterial) ?? null) : null;
  const functions = useMemo(() => p.graphs.filter((g) => g.kind === 'material-function'), [p.graphs]);
  const pick = editor.pick;
  const pickedSlot = pick?.kind === 'slot' ? pick.slot : null;
  const pickedPiece = kit !== null && pick?.kind === 'slot' ? (kit.pieces?.[pick.slot]?.[pick.index] ?? kit.pieces?.[pick.slot]?.[0]) : undefined;
  const pickedReport = pick?.kind === 'slot' ? slotReports(report, pick.slot).find((r) => r.assetId === pickedPiece?.assetId && r.piece === pickedPiece?.piece) : undefined;
  const sheetTrim = report?.sheet?.trim ?? sheetDef?.trim ?? null;
  const mappingKey = JSON.stringify(pickedReport?.materials ?? null);
  // The picked slot's piece in the preview pane, on the kit's sheet.
  usePreview(
    useMemo(
      () =>
        kit === null || pickedSlot === null || pickedPiece === undefined
          ? null
          : {
              kind: 'kit-piece' as const,
              kitId: kit.kitId,
              slot: pickedSlot,
              assetId: pickedPiece.assetId,
              ...(pickedPiece.piece !== undefined ? { piece: pickedPiece.piece } : {}),
              placement: kitSlotPlacement(pickedSlot),
              sheet: kit.trimMaterial !== undefined && sheetTrim !== null ? { materialId: kit.trimMaterial, trim: sheetTrim } : null,
              mapping: JSON.parse(mappingKey) as Record<string, string> | null,
              materials: p.materials,
              functions: functions as unknown as MaterialFunctionLike[],
            },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the piece and its map are compared by value (the kit is a new object after every edit)
      [kit?.kitId, kit?.trimMaterial, pickedSlot, pickedPiece?.assetId, pickedPiece?.piece, sheetTrim, mappingKey, p.materials, functions],
    ),
  );
  // A slot of its own that got a piece is stored: it is no longer pending.
  useEffect(() => setPending((list) => list.filter((s) => kit?.pieces?.[s] === undefined)), [kit]);
  if (kit === null) return <p className="tl-hint">This kit is not in the project (deleted or undone). Close the tab, or undo the deletion.</p>;

  const slots: KitSlotView[] = [...kitSlots(kit), ...pending.filter((s) => kit.pieces?.[s] === undefined).map((slot) => ({ slot, label: slot, standard: false, placement: kitSlotPlacement(slot), pieces: [] }))];
  const tally = kitTally(report);
  const save = (next: KitDef): void => void editor.save(next);
  const addSlot = (typed: string): void => {
    const made = customSlotName({ ...kit, pieces: { ...(kit.pieces ?? {}), ...Object.fromEntries(pending.map((s) => [s, [{ assetId: 'x' }]])) } }, typed);
    if (!made.ok) return setAddError(made.message);
    setPending((l) => [...l, made.slot]);
    setAdding(null);
    setAddError(null);
    editor.setPick({ kind: 'slot', slot: made.slot, index: 0 });
  };
  const presets = p.graphs.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND);
  return (
    <div className="tl-kit-doc" aria-label="kit editor">
      <EditorToolbar label="kit toolbar">
        <ToolButton action="compile" label="Check all" primary title="Check every piece and the trim sheet against the spec (reads the sheet's pixels again)" onClick={editor.checkAll} disabled={editor.checking !== null} />
        <ToolButton action="add" label="Add slot" title="A slot of your own (a shop sign, a lamp): drop a piece on it to keep it" onClick={() => setAdding('')} />
        <ToolButton action="open" label="Trim sheet spec" pressed={spec} title="The spec every kit's trim sheet and pieces follow (what the checks check)" onClick={() => setSpec((s) => !s)} />
        <span className="tl-editor-toolbar__note">
          <Glyph name="info" size={14} />
          {kit.description !== undefined && kit.description !== '' ? kit.description.slice(0, 120) : 'A kit names its parts: block types, presets and the trim sheet stay items of their own.'}
        </span>
        <ToolbarSpacer />
        {editor.busy !== null && <span className="tl-hint" role="status">{editor.busy}</span>}
        {editor.checking !== null && <span className="tl-hint" role="status" aria-label="kit check running">{editor.checking.pixels ? 'Reading the sheet…' : 'Checking…'}</span>}
        <span className={`tl-tag tl-kit-doc__tally${tally.errors > 0 ? ' is-err' : tally.warnings > 0 ? ' is-warn' : ' is-ok'}`} aria-label="kit problems" data-errors={tally.errors} data-warnings={tally.warnings}>
          {report === null ? 'not checked yet' : tally.errors + tally.warnings === 0 ? 'meets the spec' : `${tally.errors} error${tally.errors === 1 ? '' : 's'} · ${tally.warnings} warning${tally.warnings === 1 ? '' : 's'}`}
        </span>
      </EditorToolbar>
      {editor.error !== null && (
        <p className="tl-error" role="alert">
          {editor.error}
        </p>
      )}
      <div className="tl-kit-doc__main">
        <aside className="tl-kit-doc__side" aria-label="kit parts">
          <Section title="Piece slots" aside={<span className="tl-tag">{slots.filter((s) => s.pieces.length > 0).length} / {slots.length}</span>}>
            <ul className="tl-kit-slots" aria-label="kit slots">
              {slots.map((s) => (
                <SlotRow key={s.slot} slot={s} kit={kit} editor={editor} picked={pickedSlot === s.slot} thumbnails={p.thumbnails} />
              ))}
            </ul>
            {adding !== null ? (
              <div className="tl-kit-slots__add">
                <input
                  className="tl-input"
                  aria-label="new slot name"
                  placeholder="A name, e.g. shop sign"
                  autoFocus
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addSlot(adding);
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setAdding(null);
                      setAddError(null);
                    }
                  }}
                />
                <button type="button" className="tl-btn tl-btn--small" onClick={() => addSlot(adding)}>
                  Add
                </button>
              </div>
            ) : (
              <button type="button" className="tl-kit-slots__more" onClick={() => setAdding('')}>
                <Glyph name="plus" size={14} /> Add a slot
              </button>
            )}
            {addError !== null && (
              <p className="tl-error" role="alert">
                {addError}
              </p>
            )}
          </Section>
          <Section title="Trim sheet">
            <SheetCard kit={kit} sheets={sheets} sheetDef={sheetDef} report={report} thumbnails={p.thumbnails} onPick={(id) => save(id === '' ? withoutKey(kit, 'trimMaterial') : { ...kit, trimMaterial: id })} onOpen={(id) => p.onOpen('material', id)} />
          </Section>
          <Section title="Picture and notes" open={false}>
            <PictureCard kit={kit} albedo={(sheetDef?.textures['map'] as string | undefined) ?? null} thumbnails={p.thumbnails} onSave={save} />
          </Section>
          <Section title="Uses">
            <UsesList
              title="style presets"
              aria="kit presets"
              ids={kit.presets ?? []}
              names={new Map(presets.map((g) => [g.graphId, g.name]))}
              choices={presets.map((g) => ({ id: g.graphId, name: g.name }))}
              onOpen={(id) => p.onOpen('graph', id)}
              onSet={(id, on) => save({ ...kit, presets: withId(kit.presets, id, on) })}
            />
            <UsesList
              title="block types"
              aria="kit block types"
              ids={kit.blockTypes ?? []}
              names={new Map(p.blockTypes.map((b) => [b.blockId, b.name]))}
              choices={p.blockTypes.map((b) => ({ id: b.blockId, name: b.name }))}
              onOpen={(id) => editor.setPick({ kind: 'blockType', id })}
              onSet={(id, on) => save({ ...kit, blockTypes: withId(kit.blockTypes, id, on) })}
            />
          </Section>
        </aside>
        <section className="tl-kit-doc__centre">{spec ? <SpecView docs={p.docs} /> : <TrimChecker sheet={report?.sheet ?? null} hasSheet={kit.trimMaterial !== undefined} albedo={(sheetDef?.textures['map'] as string | undefined) ?? null} thumbnails={p.thumbnails} onSpec={() => setSpec(true)} />}</section>
      </div>
    </div>
  );
}

function withoutKey<K extends keyof KitDef>(kit: KitDef, key: K): KitDef {
  const next = { ...kit };
  delete next[key];
  return next;
}

/** One slot: its piece's picture, its name, its file (or what to drop), its state; a drop target. */
function SlotRow(p: { slot: KitSlotView; kit: KitDef; editor: KitEditor; picked: boolean; thumbnails: TileThumbnails | null }): JSX.Element {
  const first = p.slot.pieces[0];
  const [summary] = useAssetSummaries(first === undefined ? [] : [first.assetId]);
  const [over, setOver] = useState(false);
  const state = slotState(p.editor.report, p.slot.slot, p.slot.pieces);
  const empty = first === undefined;
  const sub = empty ? 'Drop a GLB or a piece' : `${summary?.displayName ?? first.assetId}${first.piece !== undefined ? ` · ${first.piece}` : ''}${p.slot.pieces.length > 1 ? ` · ${p.slot.pieces.length} variants` : ''}`;
  return (
    <li>
      <button
        type="button"
        className={`tl-kit-slot${p.picked ? ' is-active' : ''}${empty ? ' is-empty' : ''}${over ? ' is-drop' : ''}`}
        aria-label={`${p.slot.label} slot`}
        aria-pressed={p.picked}
        data-slot={p.slot.slot}
        data-state={state ?? 'none'}
        title={empty ? `${p.slot.label}: drop a GLB file or a model from the project window here, or pick one in the Inspector` : `${p.slot.label}: ${sub}`}
        onClick={() => p.editor.setPick({ kind: 'slot', slot: p.slot.slot, index: 0 })}
        onDragOver={(ev) => {
          if (!slotDragOk(ev)) return;
          ev.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => {
          setOver(false);
          void dropOnSlot(ev, p.editor, p.kit, p.slot.slot, empty ? null : 0);
        }}
      >
        <span className="tl-kit-slot__thumb">{empty ? <Glyph name="plus" size={16} /> : <TileImage summary={summary} kind="model" piece={first.piece ?? null} thumbnails={p.thumbnails} />}</span>
        <span className="tl-kit-slot__text">
          <span className="tl-kit-slot__name">{p.slot.label}</span>
          <span className="tl-kit-slot__sub">{sub}</span>
        </span>
        {state !== null && (
          <span className={`tl-kit-slot__state is-${state}`} aria-label={`${p.slot.label} checks: ${state}`}>
            <Glyph name={state === 'ok' ? 'check' : state === 'err' ? 'cross' : 'warn'} size={14} />
          </span>
        )}
      </button>
    </li>
  );
}

/** The kit's trim sheet: a picker of the project's trim materials, the sheet's picture and facts. */
function SheetCard(p: { kit: KitDef; sheets: readonly MaterialDef[]; sheetDef: MaterialDef | null; report: KitEditor['report']; thumbnails: TileThumbnails | null; onPick: (id: string) => void; onOpen: (id: string) => void }): JSX.Element {
  const albedo = (p.sheetDef?.textures['map'] as string | undefined) ?? null;
  const thumb = useLayerThumb(albedo, p.thumbnails);
  const trim = p.sheetDef?.trim;
  const height = p.report?.sheet?.report.checks.find((c) => c.id === 'height');
  return (
    <div className="tl-kit-sheet">
      <div className="tl-kit-sheet__card">
        <span className="tl-kit-sheet__thumb" data-thumb={thumb.state}>
          {thumb.url !== null && <img src={thumb.url} alt="" draggable={false} />}
        </span>
        <span className="tl-kit-slot__text">
          <span className="tl-kit-slot__name">{p.sheetDef?.name ?? (p.kit.trimMaterial !== undefined ? `${p.kit.trimMaterial} (missing)` : 'No trim sheet')}</span>
          <span className="tl-kit-slot__sub">{trim !== undefined ? `${trim.size[0]}² · ${trim.rows.length} rows${height !== undefined ? ` · ${height.state === 'ok' ? 'height in A' : 'no height in A'}` : ''}` : 'Pick the trim material its presets and block faces wear.'}</span>
        </span>
        {p.sheetDef !== null && (
          <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onOpen(p.sheetDef!.materialId)} title="Open the trim material (its row table, its maps)">
            Open
          </button>
        )}
      </div>
      <select className="tl-input" aria-label="kit trim sheet" value={p.kit.trimMaterial ?? ''} onChange={(e) => p.onPick(e.target.value)}>
        <option value="">(none)</option>
        {p.kit.trimMaterial !== undefined && !p.sheets.some((m) => m.materialId === p.kit.trimMaterial) && <option value={p.kit.trimMaterial}>{p.kit.trimMaterial} (not a trim sheet)</option>}
        {p.sheets.map((m) => (
          <option key={m.materialId} value={m.materialId}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The kit's picture: a texture picked for it (stored on the kit), else made
 * from its trim sheet (nothing stored: it follows the sheet). And what the
 * kit is for.
 */
function PictureCard(p: { kit: KitDef; albedo: string | null; thumbnails: TileThumbnails | null; onSave: (next: KitDef) => void }): JSX.Element {
  const [browsing, setBrowsing] = useState(false);
  const shown = p.kit.thumbnail ?? p.albedo;
  const thumb = useLayerThumb(shown, p.thumbnails);
  return (
    <div className="tl-kit-picture">
      <div className="tl-kit-sheet__card">
        <span className={`tl-kit-picture__img${p.kit.thumbnail === undefined ? ' is-sheet' : ''}`} data-thumb={thumb.state} aria-label="kit picture">
          {thumb.url !== null && <img src={thumb.url} alt="" draggable={false} />}
        </span>
        <span className="tl-kit-slot__text">
          <span className="tl-kit-slot__sub">{p.kit.thumbnail !== undefined ? 'A picture of its own' : p.albedo !== null ? 'Made from its trim sheet' : 'None yet: pick a picture or a trim sheet'}</span>
          <span>
            <button type="button" className="tl-btn tl-btn--small" onClick={() => setBrowsing((b) => !b)}>
              {browsing ? 'Close' : 'Pick a picture…'}
            </button>{' '}
            {p.kit.thumbnail !== undefined && (
              <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onSave(withoutKey(p.kit, 'thumbnail'))} title="Show its trim sheet instead">
                Use the sheet
              </button>
            )}
          </span>
        </span>
      </div>
      {browsing && (
        <TextureBrowser
          aria="kit picture texture"
          value={p.kit.thumbnail ?? null}
          thumbnails={p.thumbnails}
          onPick={(id) => {
            setBrowsing(false);
            p.onSave({ ...p.kit, thumbnail: id });
          }}
        />
      )}
      <textarea
        className="tl-input tl-kit-picture__about"
        aria-label="kit description"
        placeholder="What the kit is for (a style, a place)"
        defaultValue={p.kit.description ?? ''}
        key={p.kit.description ?? ''}
        maxLength={1024}
        rows={3}
        onBlur={(e) => {
          const text = e.target.value.trim();
          if (text !== (p.kit.description ?? '')) p.onSave(text === '' ? withoutKey(p.kit, 'description') : { ...p.kit, description: text });
        }}
      />
    </div>
  );
}

/** Presets or block types the kit names: each with Open and remove; a picker adds one. */
function UsesList(p: { title: string; aria: string; ids: readonly string[]; names: ReadonlyMap<string, string>; choices: readonly { id: string; name: string }[]; onOpen: (id: string) => void; onSet: (id: string, on: boolean) => void }): JSX.Element {
  const free = p.choices.filter((c) => !p.ids.includes(c.id));
  return (
    <div className="tl-kit-uses" role="group" aria-label={p.aria}>
      <div className="tl-kit-uses__head">
        {p.ids.length} {p.title}
      </div>
      <ul>
        {p.ids.map((id) => {
          const name = p.names.get(id);
          return (
            <li key={id} data-id={id}>
              <span className={name === undefined ? 'tl-assets__error' : ''} title={name === undefined ? 'Not in the project' : id}>
                {name ?? `${id} (missing)`}
              </span>
              <button type="button" className="tl-btn tl-btn--small" disabled={name === undefined} onClick={() => p.onOpen(id)} aria-label={`open ${name ?? id}`}>
                Open
              </button>
              <button type="button" className="tl-icon-btn" onClick={() => p.onSet(id, false)} aria-label={`take ${name ?? id} out of the kit`} title="Take it out of the kit (the item itself stays)">
                <Glyph name="cross" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      {free.length > 0 && (
        <select className="tl-input" aria-label={`add to ${p.aria}`} value="" onChange={(e) => e.target.value !== '' && p.onSet(e.target.value, true)}>
          <option value="">Add {p.title.replace(/s$/, '')}…</option>
          {free.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** The trim sheet spec, as the manual has it. */
function SpecView(p: { docs: KitDocumentHost['docs'] }): JSX.Element {
  const [page, setPage] = useState<{ title: string; text: string } | string | null>(null);
  const docs = useRef(p.docs);
  docs.current = p.docs;
  useEffect(() => {
    let live = true;
    void docs.current(TRIM_SPEC_TOPIC).then((r) => live && setPage(r.ok ? { title: r.title, text: r.text } : r.error.message));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="tl-kit-spec" role="document" aria-label="trim sheet spec">
      {page === null ? <p className="tl-hint">Reading the spec…</p> : typeof page === 'string' ? <CheckRow state="info" title="The spec could not be read" detail={page} /> : <pre className="tl-kit-spec__text">{page.text}</pre>}
    </div>
  );
}
