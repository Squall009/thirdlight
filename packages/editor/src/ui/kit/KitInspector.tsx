/**
 * The Inspector beside a kit's tab: what is picked in the kit editor.
 *
 * - A slot: its pieces (one or several weighted variants — each with its
 *   picture, file facts, the piece of its file it draws, its weight,
 *   Replace and Remove), a drop zone and a browser of the project's models
 *   to add one, the picked variant's piece checks (with their fixes), where
 *   the piece stands, and the kit's presets that place it.
 * - A block type the kit names: what it is (read-only; it is edited in the
 *   block editor).
 *
 * Browser-only (React).
 */
import { useState, type ChangeEvent, type JSX } from 'react';
import type { BlockType, GraphDocument, KitDef, KitPieceReport } from '@thirdlight/project-model';
import { BLOCK_LAYER_DEFAULT, KIT_LIMITS, KIT_STANDARD_SLOTS, kitSlotLabel, kitSlotPlacement } from '@thirdlight/project-model/limits';

import { assignPiece, removePiece, setPieceNode, setPieceWeight, slotReports, withSlotPieces } from '../../session/kit-edits';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { TileImage } from '../assets/TileImage';
import { MODEL_KINDS } from '../catalog/RefPicker';
import { useAssetSummaries } from '../catalog/catalog-context';
import { CheckRow } from '../editmode/CheckRow';
import { Section } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import { Popover } from '../palette/LayerPalette';
import { TextureBrowser } from '../palette/TextureBrowser';
import { dropOnSlot, slotDragOk } from './KitDocument';
import type { KitEditor } from './useKitEditor';

export interface KitInspectorProps {
  editor: KitEditor;
  kit: KitDef;
  graphs: readonly GraphDocument[];
  blockTypes: readonly BlockType[];
  thumbnails: TileThumbnails | null;
  onOpenGraph: (id: string) => void;
}

export function KitInspector(p: KitInspectorProps): JSX.Element {
  const pick = p.editor.pick;
  return (
    <div className="tl-inspector tl-kit-inspector" aria-label="kit inspector">
      <div className="tl-panel__title">
        Inspector <span className="tl-hint">{pick === null ? p.kit.name : pick.kind === 'slot' ? `${kitSlotLabel(pick.slot)} slot` : 'Block type'}</span>
      </div>
      {pick === null ? (
        <div className="tl-inspector__empty">Pick a slot on the left to set its piece and see its checks, or a block type the kit names.</div>
      ) : pick.kind === 'slot' ? (
        <SlotInspector {...p} slot={pick.slot} index={pick.index} />
      ) : (
        <BlockTypeSummary type={p.blockTypes.find((b) => b.blockId === pick.id) ?? null} id={pick.id} />
      )}
    </div>
  );
}

function SlotInspector(p: KitInspectorProps & { slot: string; index: number }): JSX.Element {
  const { editor, kit, slot } = p;
  const pieces = kit.pieces?.[slot] ?? [];
  const index = Math.min(p.index, Math.max(0, pieces.length - 1));
  const reports = slotReports(editor.report, slot);
  const picked = pieces[index];
  const report = picked === undefined ? undefined : reports.find((r) => r.index === index && r.assetId === picked.assetId);
  const placement = kitSlotPlacement(slot);
  const [anchor, setAnchor] = useState<{ el: HTMLElement; index: number | null } | null>(null);
  const [over, setOver] = useState(false);
  const save = (next: KitDef): void => void editor.save(next);
  const file = (ev: ChangeEvent<HTMLInputElement>, at: number | null): void => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    setAnchor(null);
    if (f === undefined) return;
    // Published and put in the slot: one undo step.
    void editor.grouped(async (ed) => {
      const id = await ed.importModel(f);
      if (typeof id === 'string') await ed.save(assignPiece(editor.kit ?? kit, slot, at, { assetId: id }));
    });
  };
  const tally = report === undefined ? null : { errors: report.checks.filter((c) => c.state === 'err').length, warnings: report.checks.filter((c) => c.state === 'warn').length };
  return (
    <>
      <Section title="Piece" aside={pieces.length > 1 ? <span className="tl-tag">{pieces.length} variants</span> : undefined}>
        <ul className="tl-kit-variants" aria-label="slot pieces">
          {pieces.map((piece, i) => (
            <Variant
              key={`${i}:${piece.assetId}:${piece.piece ?? ''}`}
              piece={piece}
              report={reports.find((r) => r.index === i)}
              picked={i === index}
              several={pieces.length > 1}
              thumbnails={p.thumbnails}
              onPick={() => editor.setPick({ kind: 'slot', slot, index: i })}
              onReplace={(el) => setAnchor({ el, index: i })}
              onRemove={() => save(removePiece(kit, slot, i))}
              onNode={(node) => save(setPieceNode(kit, slot, i, node))}
              onWeight={(w) => save(setPieceWeight(kit, slot, i, w))}
            />
          ))}
        </ul>
        {pieces.length < KIT_LIMITS.piecesPerSlot && (
          <button
            type="button"
            className={`tl-dropzone tl-kit-drop${over ? ' is-drop' : ''}`}
            aria-label={pieces.length === 0 ? 'pick a piece for the slot' : 'add a variant'}
            title="Drop a GLB file or a model from the project window here, or click to pick one of the project's models"
            onClick={(e) => setAnchor({ el: e.currentTarget, index: null })}
            onDragOver={(ev) => {
              if (!slotDragOk(ev)) return;
              ev.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(ev) => {
              setOver(false);
              void dropOnSlot(ev, editor, kit, slot, null);
            }}
          >
            <Glyph name="plus" size={16} />
            {editor.busy ?? (pieces.length === 0 ? 'Drop a GLB or a piece, or pick a model' : 'Add a variant (drawn at random by weight)')}
          </button>
        )}
        {!KIT_STANDARD_SLOTS.some((x) => x.slot === slot) && (
          <button type="button" className="tl-btn tl-btn--small" onClick={() => save(withSlotPieces(kit, slot, []))} disabled={pieces.length === 0} title="Take every piece out: the slot of its own goes with them">
            Remove the slot
          </button>
        )}
      </Section>
      {picked !== undefined && (
        <Section title="Piece checks" aside={tally === null ? <span className="tl-hint">checking…</span> : <span className="tl-hint">{tally.errors + tally.warnings === 0 ? 'all pass' : `${tally.errors} error${tally.errors === 1 ? '' : 's'} · ${tally.warnings} warning${tally.warnings === 1 ? '' : 's'}`}</span>}>
          <div className="tl-kit-checks" role="list" aria-label="piece checks">
            {(report?.checks ?? []).map((c) => (
              <CheckRow
                key={c.id}
                id={c.id}
                state={c.state}
                title={c.title}
                detail={c.detail}
                action={
                  c.fix?.kind === 'map-material' ? (
                    <button type="button" className="tl-btn tl-btn--small" onClick={() => void editor.mapMaterial(picked.assetId, c.fix!.source, c.fix!.material)} title={`Map “${c.fix.source}” to the kit's trim sheet (the model's default materials; one undo step)`}>
                      Use the sheet
                    </button>
                  ) : undefined
                }
              />
            ))}
          </div>
        </Section>
      )}
      <Section title="Placement">
        <div className="tl-kit-place">
          <span>{placement.kind === 'opening' ? `In an opening of a wall, ${placement.sill === 0 ? 'on the floor' : `its bottom ${placement.sill} m up`}` : placement.kind === 'edge' ? 'On a wall\'s line, in place of a stretch of it' : 'On the floor, free standing'}</span>
          <span className="tl-hint">
            Cells are {BLOCK_LAYER_DEFAULT.cellSize[0]} m; origin at the bottom centre, +X along, +Z facing out, +Y up.
          </span>
        </div>
      </Section>
      {(kit.presets ?? []).length > 0 && (placement.kind === 'opening' || placement.kind === 'edge') && (
        <Section title="Placed by">
          <ul className="tl-kit-uses">
            {(kit.presets ?? []).map((id) => (
              <li key={id}>
                <span>{p.graphs.find((g) => g.graphId === id)?.name ?? id}</span>
                <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onOpenGraph(id)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {anchor !== null && (
        <Popover
          anchor={anchor.el}
          onClose={() => setAnchor(null)}
          aria="kit piece model"
          title={anchor.index === null ? `A piece for ${kitSlotLabel(slot)}` : 'Replace the piece'}
          aside={
            <label className="tl-btn tl-btn--small">
              Choose a GLB…
              <input type="file" accept=".glb,model/gltf-binary" hidden aria-label="kit piece file" onChange={(e) => file(e, anchor.index)} />
            </label>
          }
        >
          <TextureBrowser
            aria="kit piece models"
            kinds={MODEL_KINDS}
            noun="models"
            value={anchor.index !== null ? (pieces[anchor.index]?.assetId ?? null) : null}
            thumbnails={p.thumbnails}
            autoFocus
            onPick={(id) => {
              const at = anchor.index;
              setAnchor(null);
              editor.setPick({ kind: 'slot', slot, index: at ?? pieces.length });
              save(assignPiece(kit, slot, at, { assetId: id }));
            }}
          />
        </Popover>
      )}
    </>
  );
}

function Variant(p: {
  piece: { assetId: string; piece?: string; weight?: number };
  report: KitPieceReport | undefined;
  picked: boolean;
  several: boolean;
  thumbnails: TileThumbnails | null;
  onPick: () => void;
  onReplace: (el: HTMLElement) => void;
  onRemove: () => void;
  onNode: (node: string) => void;
  onWeight: (w: number) => void;
}): JSX.Element {
  const [summary] = useAssetSummaries([p.piece.assetId]);
  const r = p.report;
  const facts = r === undefined || !r.present ? null : `${r.triangles[0] ?? 0} tris${r.lods.length > 0 ? ` · LOD ${r.lods[0]}–${r.lods[r.lods.length - 1]}` : ''}${r.collider ? ' · _COL' : ''}`;
  return (
    <li className={`tl-kit-variant${p.picked ? ' is-active' : ''}`} data-asset={p.piece.assetId}>
      <button type="button" className="tl-kit-variant__main" onClick={p.onPick} aria-pressed={p.picked} aria-label={`piece ${summary?.displayName ?? p.piece.assetId}`}>
        <span className="tl-kit-slot__thumb">
          <TileImage summary={summary} kind="model" piece={p.piece.piece ?? null} thumbnails={p.thumbnails} />
        </span>
        <span className="tl-kit-slot__text">
          <span className="tl-kit-slot__name">{summary?.displayName ?? p.piece.assetId}</span>
          <span className="tl-kit-slot__sub">{facts ?? (r !== undefined && !r.present ? 'not in the project' : 'reading…')}</span>
        </span>
      </button>
      <span className="tl-kit-variant__tools">
        {r !== undefined && r.pieces.length > 1 && (
          <select className="tl-input" aria-label="piece of the file" value={p.piece.piece ?? ''} onChange={(e) => p.onNode(e.target.value)} title="Which piece of the file it draws">
            <option value="">(the whole file)</option>
            {r.pieces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        {p.several && (
          <label className="tl-kit-variant__weight" title="How often it is drawn among the slot's variants">
            weight
            <input className="tl-input" type="number" min={0.01} max={KIT_LIMITS.weightMax} step={0.5} aria-label="variant weight" defaultValue={p.piece.weight ?? 1} key={p.piece.weight ?? 1} onBlur={(e) => Number(e.target.value) !== (p.piece.weight ?? 1) && p.onWeight(Number(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
        )}
        <button type="button" className="tl-btn tl-btn--small" onClick={(e) => p.onReplace(e.currentTarget)}>
          Replace
        </button>
        <button type="button" className="tl-icon-btn" onClick={p.onRemove} aria-label="remove the piece" title="Take it out of the slot (the model stays in the project)">
          <Glyph name="cross" size={12} />
        </button>
      </span>
    </li>
  );
}

function BlockTypeSummary({ type, id }: { type: BlockType | null; id: string }): JSX.Element {
  if (type === null) return <div className="tl-inspector__empty">The block type “{id}” is not in the project: take it out of the kit, or add it again.</div>;
  const looks = type.variants.map((v) => (v.model !== undefined ? `${v.model.assetId}${v.model.piece !== undefined ? ` · ${v.model.piece}` : ''}` : v.prefab !== undefined ? `prefab ${v.prefab}` : `stand-in ${v.color ?? ''}`));
  return (
    <div className="tl-kit-block" aria-label="block type summary" data-block={type.blockId}>
      <Section title={type.name}>
        <dl className="tl-kit-block__facts">
          <dt>Shape</dt>
          <dd>{type.shape}</dd>
          <dt>Placement</dt>
          <dd>{type.placement === 'edge' ? 'on cell edges' : 'fills cells'}</dd>
          <dt>Looks</dt>
          <dd>{looks.join('; ')}</dd>
          <dt>Materials</dt>
          <dd>{Object.entries(type.materials ?? {}).map(([k, v]) => `${k === '*' ? 'all' : k} → ${v}`).join('; ') || 'its own'}</dd>
        </dl>
        <p className="tl-hint">A block type is edited where blocks are built (a block layer in the Scene view): the kit only names it.</p>
      </Section>
    </div>
  );
}
