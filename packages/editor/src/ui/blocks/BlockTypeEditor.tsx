/**
 * The block type editor: the Block type panel over the block editor's
 * view, editing the block type picked in the palette (or opened by a click
 * on a block) — everything a block type stores, in plain controls (no JSON):
 *
 * - **Looks**: its models, kit pieces, prefab or stand-in colour, each with
 *   its weight (how often a cell picks it) and where its texture
 *   coordinates come from; drop a model, a GLB file or a kit piece, pick one
 *   of the project's models or the kit's pieces, or add a colour;
 * - **Shape**: the collision shape (full, half, ramp, stairs, custom boxes
 *   edited as numbers, none), whether it fills its cell, its footprint;
 * - **Turns** it may take, **Placement** (in the cell or on its edge,
 *   blocking passage, one-way, a live prefab), **Connections** (the types it joins,
 *   the look of each piece), **Themes** (what it shows under each theme),
 *   **Metadata** (its cells' default values) and **Material**.
 *
 * Every change is one `setBlockType` (one undo step).
 *
 * Browser-only (React).
 */
import { useState, type DragEvent, type JSX } from 'react';
import type { BlockConnectPiece, BlockType, BlockVariant, KitPiece } from '@thirdlight/project-model';
import { BLOCK_LIMITS } from '@thirdlight/project-model/limits';

import { allowedRotations } from '../../session/block-brush';
import { connectPiecesOf, duplicateBlockType, withBoxValue, withConnect, withConnectPiece, withConnectWith, withLook, withLookAdded, withMetadata, withoutLook, withPlacement, withRotations, withShape, withTheme } from '../../session/block-type-edits';
import { ASSET_DRAG_TYPE, assetDropOf } from '../../session/placement';
import { TileImage } from '../assets/TileImage';
import { useAssetSummaries } from '../catalog/catalog-context';
import { MODEL_KINDS } from '../catalog/RefPicker';
import { Section, Segmented, Toggle } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import type { EditModeView } from '../editmode/modes';
import { MaterialMappingEditor } from '../material/MaterialInspector';
import { Popover } from '../palette/LayerPalette';
import { TextureBrowser } from '../palette/TextureBrowser';
import { blockCommand, useBlockSetup, type BlockSetup } from './block-column';
import { IsoBlock } from './BlockPalette';
import { MetaValueField } from './RegionsColumn';

const SHAPES: readonly { id: BlockType['shape']; label: string; hint: string }[] = [
  { id: 'full', label: 'Full', hint: 'A whole cell' },
  { id: 'half', label: 'Half', hint: 'The lower half of the cell' },
  { id: 'ramp', label: 'Ramp', hint: 'A slope rising across the cell' },
  { id: 'stairs', label: 'Stairs', hint: 'Two steps' },
  { id: 'custom', label: 'Boxes', hint: 'Boxes of your own, in shares of the cell' },
  { id: 'none', label: 'None', hint: 'Nothing collides (decoration)' },
];

const PIECE_LABELS: Readonly<Record<BlockConnectPiece, string>> = { single: 'Alone', end: 'End', straight: 'Straight', corner: 'Corner', t: 'T-join', cross: 'Cross', base: 'Base (lowest)', cap: 'Cap (highest)' };

const AXES = ['x', 'y', 'z'] as const;

/** One look of the type: its picture, what it is, its weight, its texture coordinates, Replace and Remove. */
function LookRow({ s, t, v, index, onReplace }: { s: BlockSetup; t: BlockType; v: BlockVariant; index: number; onReplace: (el: HTMLElement, index: number) => void }): JSX.Element {
  const [summary] = useAssetSummaries(v.model !== undefined ? [v.model.assetId] : []);
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const name = v.model !== undefined ? `${summary?.displayName ?? v.model.assetId}${v.model.piece !== undefined ? ` · ${v.model.piece}` : ''}` : v.prefab !== undefined ? `Prefab ${v.prefab}` : 'Colour';
  return (
    <li className="tl-blook" data-look={index}>
      <span className="tl-blook__thumb">{v.model !== undefined ? <TileImage summary={summary} kind="model" piece={v.model.piece ?? null} thumbnails={s.host.palette.thumbnails} /> : v.prefab !== undefined ? <Glyph name="box" size={18} /> : <IsoBlock shape={t.shape} edge={t.placement === 'edge'} colour={v.color ?? '#808080'} texture={null} />}</span>
      <span className="tl-blook__text">
        <span className="tl-blook__name" title={name}>
          {name}
        </span>
        <span className="tl-blook__sub">
          <select className="tl-input" aria-label={`look ${index + 1} texture coordinates`} value={v.uv ?? ''} onChange={(e) => save(withLook(t, index, { uv: e.target.value === '' ? undefined : (e.target.value as 'model' | 'world') }))} title="Where its texture coordinates come from: the model's own, or the cell's place in metres (a texture runs on across cells)">
            <option value="">UVs as the type</option>
            <option value="model">Own UVs</option>
            <option value="world">World UVs</option>
          </select>
        </span>
      </span>
      {v.model === undefined && v.prefab === undefined && <input type="color" aria-label={`look ${index + 1} colour`} value={v.color ?? '#808080'} onChange={(e) => save(withLook(t, index, { color: e.target.value }))} title="The stand-in's colour" />}
      {t.variants.length > 1 && (
        <label className="tl-blook__weight" title="How often a cell picks this look among the type's looks">
          weight
          <input className="tl-input" type="number" min={0.01} step={0.5} aria-label={`look ${index + 1} weight`} defaultValue={v.weight ?? 1} key={v.weight ?? 1} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== (v.weight ?? 1) && save(withLook(t, index, { weight: Number(e.target.value) === 1 ? undefined : Number(e.target.value) }))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
      )}
      <button type="button" className="tl-icon-btn" aria-label={`replace look ${index + 1}`} title="Wear another model instead" onClick={(e) => onReplace(e.currentTarget, index)}>
        <Glyph name="import" size={12} />
      </button>
      <button type="button" className="tl-icon-btn" aria-label={`remove look ${index + 1}`} title="Take this look out" disabled={t.variants.length <= 1} onClick={() => save(withoutLook(t, index))}>
        <Glyph name="cross" size={12} />
      </button>
    </li>
  );
}

/** A kit piece in the kit's pieces popover. */
function KitPieceChoice({ s, slot, piece, onPick }: { s: BlockSetup; slot: string; piece: KitPiece; onPick: () => void }): JSX.Element {
  const [summary] = useAssetSummaries([piece.assetId]);
  return (
    <button type="button" className="tl-bkitpiece" aria-label={`kit piece ${slot} ${summary?.displayName ?? piece.assetId}`} onClick={onPick}>
      <span className="tl-blook__thumb">
        <TileImage summary={summary} kind="model" piece={piece.piece ?? null} thumbnails={s.host.palette.thumbnails} />
      </span>
      <span>
        <b>{slot}</b> {summary?.displayName ?? piece.assetId}
        {piece.piece !== undefined ? ` · ${piece.piece}` : ''}
      </span>
    </button>
  );
}

function LooksSection({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType | null): void => {
    if (next === null) return s.blocks.notice(`${t.name} has ${BLOCK_LIMITS.variants} looks, the most a block type takes.`);
    void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  };
  const [browse, setBrowse] = useState<{ el: HTMLElement; index: number | null; kit: boolean } | null>(null);
  const [over, setOver] = useState(false);
  const wear = (look: BlockVariant, index: number | null): void => {
    if (index === null) save(withLookAdded(t, look));
    else save(withLook(t, index, { model: look.model, prefab: undefined, color: undefined }));
  };
  const drop = async (ev: DragEvent): Promise<void> => {
    const file = ev.dataTransfer.files[0];
    const tile = file === undefined ? assetDropOf(ev, 'model') : null;
    if (file === undefined && tile === null) return;
    ev.preventDefault();
    // A dropped file is published, then worn: one undo step.
    await s.blocks.grouped(async (g) => {
      const assetId = file !== undefined ? await g.importModel(file) : tile!.assetId;
      if (assetId !== null) await blockCommand({ blocks: g }, 'Edit block type', 'setBlockType', { block: withLookAdded(t, { model: { assetId, ...(tile?.piece !== undefined ? { piece: tile.piece } : {}) } }) });
    });
  };
  const kitPieces = Object.entries(s.kit?.pieces ?? {}).flatMap(([slot, list]) => list.map((piece) => ({ slot, piece })));
  return (
    <Section title="Looks" aside={<span className="tl-sec__note">{t.variants.length} look{t.variants.length === 1 ? '' : 's'}</span>}>
      <ul className="tl-blooks" aria-label="block looks">
        {t.variants.map((v, i) => (
          <LookRow key={i} s={s} t={t} v={v} index={i} onReplace={(el, index) => setBrowse({ el, index, kit: false })} />
        ))}
      </ul>
      {t.variants.length < BLOCK_LIMITS.variants && (
        <button
          type="button"
          className={`tl-dropzone${over ? ' is-drop' : ''}`}
          aria-label="add a model look"
          title="Drop a model from the project window or a GLB file here, or click to pick one of the project's models"
          onClick={(e) => setBrowse({ el: e.currentTarget, index: null, kit: false })}
          onDragOver={(ev) => {
            if (!ev.dataTransfer.types.includes(ASSET_DRAG_TYPE) && !ev.dataTransfer.types.includes('Files')) return;
            ev.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(ev) => {
            setOver(false);
            void drop(ev);
          }}
        >
          <Glyph name="plus" size={14} />
          Drop a model or kit piece
        </button>
      )}
      <div className="tl-btnrow">
        {kitPieces.length > 0 && (
          <button type="button" className="tl-btn tl-btn--small" onClick={(e) => setBrowse({ el: e.currentTarget, index: null, kit: true })} title={`The pieces of the kit ${s.kit?.name ?? ''}`}>
            From the kit…
          </button>
        )}
        <button type="button" className="tl-btn tl-btn--small" onClick={() => save(withLookAdded(t, { color: '#808080' }))} disabled={t.variants.length >= BLOCK_LIMITS.variants}>
          + Colour
        </button>
        {s.blocks.prefabs.length > 0 && t.variants.length < BLOCK_LIMITS.variants && (
          <select className="tl-input tl-btype__prefab" aria-label="add a prefab look" value="" title="A look drawn as a prefab's model (Placement: spawned as a live object when that is on)" onChange={(e) => e.target.value !== '' && save(withLookAdded(t, { prefab: e.target.value }))}>
            <option value="">+ Prefab…</option>
            {s.blocks.prefabs.map((p) => (
              <option key={p.prefabId} value={p.prefabId}>
                {p.displayName}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="tl-frow">
        <span className="tl-frow__label">UVs</span>
        <Segmented small aria="block texture coordinates" value={t.uv ?? 'model'} options={[{ id: 'model', label: 'Model’s own', hint: 'The look’s own texture coordinates' }, { id: 'world', label: 'World metres', hint: 'From the cell’s place: a texture runs on across cells without a seam' }]} onChange={(uv) => {
          const next = { ...t };
          if (uv === 'world') next.uv = 'world';
          else delete next.uv;
          save(next);
        }} />
      </div>
      {browse !== null && (
        <Popover anchor={browse.el} onClose={() => setBrowse(null)} title={browse.kit ? 'Kit pieces' : browse.index === null ? 'Add a model look' : `Look ${browse.index + 1}: another model`} aria="block look picker">
          {browse.kit ? (
            <div className="tl-bkitpieces" role="list" aria-label="kit pieces">
              {kitPieces.map(({ slot, piece }, i) => (
                <KitPieceChoice
                  key={`${slot}:${i}`}
                  s={s}
                  slot={slot}
                  piece={piece}
                  onPick={() => {
                    wear({ model: { assetId: piece.assetId, ...(piece.piece !== undefined ? { piece: piece.piece } : {}) }, ...(piece.weight !== undefined ? { weight: piece.weight } : {}) }, browse.index);
                    setBrowse(null);
                  }}
                />
              ))}
            </div>
          ) : (
            <TextureBrowser
              aria="block models"
              noun="models"
              kinds={MODEL_KINDS}
              value={browse.index === null ? null : (t.variants[browse.index]?.model?.assetId ?? null)}
              thumbnails={s.host.palette.thumbnails}
              autoFocus
              onPick={(id) => {
                wear({ model: { assetId: id } }, browse.index);
                setBrowse(null);
              }}
            />
          )}
        </Popover>
      )}
    </Section>
  );
}

function ShapeSection({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const solid = t.solid ?? t.shape === 'full';
  const fp = t.footprint ?? [1, 1, 1];
  return (
    <Section title="Shape">
      <div className="tl-frow tl-frow--stack">
        <span className="tl-frow__label">Collision</span>
        <Segmented small aria="block collision" value={t.shape} options={SHAPES} onChange={(shape) => save(withShape(t, shape))} />
      </div>
      {t.shape === 'custom' && (
        <div className="tl-bboxes" aria-label="collision boxes">
          {(t.boxes ?? []).map((b, i) => (
            <div key={i} className="tl-bbox" aria-label={`box ${i + 1}`}>
              {(['From', 'To'] as const).map((end, e) => (
                <div key={end} className="tl-bbox__row">
                  <span className="tl-bbox__label">{end}</span>
                  {AXES.map((a, k) => (
                    <label key={a} className="tl-bbox__num">
                      {a}
                      <input className="tl-input" type="number" min={0} max={1} step={0.05} aria-label={`box ${i + 1} ${end.toLowerCase()} ${a}`} defaultValue={b[e * 3 + k]} key={`${b[e * 3 + k]}`} onBlur={(ev) => Number.isFinite(Number(ev.target.value)) && Number(ev.target.value) !== b[e * 3 + k] && save(withBoxValue(t, i, e * 3 + k, Number(ev.target.value)))} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
                    </label>
                  ))}
                </div>
              ))}
              <button type="button" className="tl-icon-btn" aria-label={`remove box ${i + 1}`} disabled={(t.boxes ?? []).length <= 1} onClick={() => save({ ...t, boxes: (t.boxes ?? []).filter((_x, j) => j !== i) })}>
                <Glyph name="cross" size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="tl-btn tl-btn--small" onClick={() => save({ ...t, boxes: [...(t.boxes ?? []), [0, 0, 0, 1, 0.5, 1]] })}>
            + Box
          </button>
          <p className="tl-hint">In shares of the cell: 0 to 1 along x, y (up) and z.</p>
        </div>
      )}
      <Toggle label="Fills the cell (hides neighbours' faces)" aria="block fills cell" on={solid} onChange={(on) => {
        const next = { ...t };
        if (on === (t.shape === 'full')) delete next.solid;
        else next.solid = on;
        save(next);
      }} />
      <div className="tl-frow">
        <span className="tl-frow__label">Footprint</span>
        {AXES.map((a, k) => (
          <label key={a} className="tl-bbox__num" title={`Cells along ${a}`}>
            {a}
            <input className="tl-input" type="number" min={1} max={16} step={1} aria-label={`footprint ${a}`} defaultValue={fp[k]} key={`${fp[k]}`} onBlur={(e) => {
              const v = Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1)));
              if (v === fp[k]) return;
              const next = [...fp] as [number, number, number];
              next[k] = v;
              const out = { ...t };
              if (next.every((x) => x === 1)) delete out.footprint;
              else out.footprint = next;
              save(out);
            }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
        ))}
      </div>
    </Section>
  );
}

function TurnsAndPlacement({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const all = t.placement === 'edge' ? [0, 180] : [0, 90, 180, 270];
  const allowed = allowedRotations(t);
  const live = t.variants.some((v) => v.prefab !== undefined);
  return (
    <>
      <Section title="Turns">
        <div className="tl-chips" role="group" aria-label="block turns">
          {all.map((r) => (
            <button key={r} type="button" className={`tl-chip tl-chip--toggle${allowed.includes(r as 0) ? ' is-active' : ''}`} aria-label={`turn ${r}`} aria-pressed={allowed.includes(r as 0)} onClick={() => save(withRotations(t, allowed.includes(r as 0) ? allowed.filter((x) => x !== r) : [...allowed, r]))}>
              {r}°
            </button>
          ))}
        </div>
        <p className="tl-hint">{allowed.length === all.length ? 'It may be turned every way (T turns the brush).' : allowed.length === 1 ? 'It never turns.' : 'Only these turns (T steps through them).'}</p>
      </Section>
      <Section title="Placement">
        <div className="tl-frow">
          <span className="tl-frow__label">Stands</span>
          <Segmented small aria="block placement" value={t.placement ?? 'cell'} options={[{ id: 'cell', label: 'In the cell' }, { id: 'edge', label: 'On a cell edge', hint: 'A wall, door or fence between two cells' }]} onChange={(p) => save(withPlacement(t, p))} />
        </div>
        {t.placement === 'edge' && (
          <Toggle label="Blocks the way across its edge" aria="block blocks passage" on={t.blocking !== false} onChange={(on) => {
            const next = { ...t };
            if (on) delete next.blocking;
            else next.blocking = false;
            save(next);
          }} />
        )}
        {t.placement !== 'edge' && (
          <Toggle label="One-way" aria="block one-way" on={t.oneWay === true} hint="The player jumps up through it and lands on top (a floating ledge); down + jump drops through. Block layers do not apply it yet: their blocks collide solid." onChange={(on) => {
            const next = { ...t };
            if (on) next.oneWay = true;
            else delete next.oneWay;
            save(next);
          }} />
        )}
        {live && (
          <Toggle label="Spawns its prefab as a live object in the game" aria="block live" on={t.live === true} hint="On: each cell of a prefab look is an object of the game (it can move, react, be picked up). Off: only its model is drawn." onChange={(on) => {
            const next = { ...t };
            if (on) next.live = true;
            else delete next.live;
            save(next);
          }} />
        )}
      </Section>
    </>
  );
}

function ConnectionsSection({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const c = t.connect;
  const others = s.blocks.types.filter((x) => x.blockId !== t.blockId && (x.placement ?? 'cell') === (t.placement ?? 'cell'));
  const withIds = c?.with ?? [];
  return (
    <Section title="Connections" aside={<span className="tl-sec__note">{c === undefined ? 'off' : 'on'}</span>}>
      <Toggle label="Its look follows its neighbours" aria="block connects" on={c !== undefined} hint="Straight runs, corners, T-joins, ends: each cell shows the look its neighbours call for, turned to fit." onChange={(on) => save(withConnect(t, on))} />
      {c !== undefined && (
        <>
          <div className="tl-sec__sub">Joins up with</div>
          <div className="tl-chips" aria-label="connects with">
            <span className="tl-chip is-active">{t.name}</span>
            {withIds.map((id) => (
              <span key={id} className="tl-chip is-active">
                {s.typeOf.get(id)?.name ?? id}
                <button type="button" className="tl-chip__x" aria-label={`stop joining ${id}`} onClick={() => save(withConnectWith(t, withIds.filter((x) => x !== id)))}>
                  ✕
                </button>
              </span>
            ))}
            {others.length > withIds.length && (
              <select className="tl-input tl-chip__add" aria-label="join another block type" value="" onChange={(e) => e.target.value !== '' && save(withConnectWith(t, [...withIds, e.target.value]))}>
                <option value="">+ Add</option>
                {others.filter((x) => !withIds.includes(x.blockId)).map((x) => (
                  <option key={x.blockId} value={x.blockId}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="tl-sec__sub">Look of each piece</div>
          <div className="tl-bpieces" aria-label="connection pieces">
            {connectPiecesOf(t).map((piece) => {
              const look = c.pieces[piece];
              return (
                <div key={piece} className="tl-frow">
                  <span className="tl-frow__label">{PIECE_LABELS[piece]}</span>
                  <select className="tl-input" aria-label={`piece ${piece} look`} value={look === undefined ? '' : String(look.variant)} onChange={(e) => save(withConnectPiece(t, piece, e.target.value === '' ? null : Number(e.target.value), look?.rot ?? 0))}>
                    <option value="">Ordinary look</option>
                    {t.variants.map((_v, i) => (
                      <option key={i} value={i}>
                        Look {i + 1}
                      </option>
                    ))}
                  </select>
                  {look !== undefined && (
                    <select className="tl-input tl-bpieces__rot" aria-label={`piece ${piece} turn`} value={look.rot ?? 0} onChange={(e) => save(withConnectPiece(t, piece, look.variant, Number(e.target.value)))} title="An extra turn, for a look authored another way round">
                      {(t.placement === 'edge' ? [0, 180] : [0, 90, 180, 270]).map((r) => (
                        <option key={r} value={r}>
                          +{r}°
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}

function ThemesSection({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const [draft, setDraft] = useState('');
  const swaps = Object.entries(t.kits ?? {});
  const targets = s.blocks.types.filter((x) => (x.placement ?? 'cell') === (t.placement ?? 'cell'));
  return (
    <Section title="Themes" aside={<span className="tl-sec__note">{swaps.length}</span>}>
      {swaps.length === 0 && <p className="tl-hint">Under a theme (winter, ruined…) this type can draw as another: the cells stay as they are.</p>}
      {swaps.map(([theme, swap]) => {
        const target = s.typeOf.get(swap.block);
        return (
          <div key={theme} className="tl-frow" aria-label={`theme ${theme}`}>
            <span className="tl-chip">{theme}</span>
            <span aria-hidden="true">→</span>
            <select className="tl-input" aria-label={`theme ${theme} block`} value={swap.block} onChange={(e) => save(withTheme(t, theme, { block: e.target.value }))}>
              {targets.map((x) => (
                <option key={x.blockId} value={x.blockId}>
                  {x.blockId === t.blockId ? `${x.name} (itself)` : x.name}
                </option>
              ))}
            </select>
            {target !== undefined && target.variants.length > 1 && (
              <select className="tl-input" aria-label={`theme ${theme} look`} value={swap.variant === undefined ? '' : String(swap.variant)} onChange={(e) => save(withTheme(t, theme, { block: swap.block, ...(e.target.value !== '' ? { variant: Number(e.target.value) } : {}) }))}>
                <option value="">Same look</option>
                {target.variants.map((_v, i) => (
                  <option key={i} value={i}>
                    Look {i + 1}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="tl-icon-btn" aria-label={`remove theme ${theme}`} onClick={() => save(withTheme(t, theme, null))}>
              <Glyph name="cross" size={12} />
            </button>
          </div>
        );
      })}
      <form
        className="tl-btnrow"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          if (name === '') return;
          // A new theme starts as a swap to the type itself (it keeps the layout); its block is picked next.
          save(withTheme(t, name, { block: t.blockId }));
          setDraft('');
        }}
      >
        <input className="tl-input" aria-label="new theme" placeholder="Theme name (winter)" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="tl-btn tl-btn--small" disabled={draft.trim() === ''}>
          + Theme
        </button>
      </form>
    </Section>
  );
}

function MetadataSection({ s, t }: { s: BlockSetup; t: BlockType }): JSX.Element {
  const save = (next: BlockType): void => void blockCommand(s, 'Edit block type', 'setBlockType', { block: next });
  const fields = s.blocks.fields;
  const set = Object.keys(t.metadata ?? {});
  const free = fields.filter((f) => !set.includes(f.key));
  return (
    <Section title="Metadata" aside={<span className="tl-sec__note">{set.length}</span>}>
      {fields.length === 0 && <p className="tl-hint">No cell fields yet (Regions → Metadata adds them).</p>}
      {set.map((key) => {
        const f = fields.find((x) => x.key === key);
        return (
          <div key={key} className="tl-frow" aria-label={`metadata ${key}`}>
            <span className="tl-frow__label">{f?.label ?? key}</span>
            {f !== undefined ? <MetaValueField field={f} aria={`metadata ${key} value`} value={t.metadata?.[key]} onChange={(v) => save(withMetadata(t, key, v))} /> : <span className="tl-hint">{String(t.metadata?.[key])} (no such field)</span>}
            <button type="button" className="tl-icon-btn" aria-label={`remove metadata ${key}`} onClick={() => save(withMetadata(t, key, null))}>
              <Glyph name="cross" size={12} />
            </button>
          </div>
        );
      })}
      {free.length > 0 && (
        <select className="tl-input" aria-label="add metadata field" value="" onChange={(e) => {
          const f = fields.find((x) => x.key === e.target.value);
          if (f === undefined) return;
          save(withMetadata(t, f.key, f.default ?? (f.type === 'bool' ? true : f.type === 'enum' ? (f.values?.[0] ?? '') : f.type === 'string' ? '' : 0)));
        }}>
          <option value="">+ Field</option>
          {free.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label ?? f.key}
            </option>
          ))}
        </select>
      )}
    </Section>
  );
}

export function BlockTypeEditor({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const id = s.state.typeOpen ?? s.state.brush.block;
  const t = id === null ? undefined : s.typeOf.get(id);
  if (t === undefined)
    return (
      <div className="tl-btype" aria-label="block type editor">
        <p className="tl-hint tl-btype__empty">Pick a block type in the palette to edit its looks, shape, turns, connections, themes, metadata and material.</p>
      </div>
    );
  const save = (next: BlockType, what = 'Edit block type'): void => void blockCommand(s, what, 'setBlockType', { block: next });
  return (
    <div className="tl-btype" aria-label="block type editor" data-block-type={t.blockId}>
      <div className="tl-btype__head">
        <input className="tl-input tl-btype__name" aria-label="block type name" defaultValue={t.name} key={`${t.blockId}:${t.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== t.name && save({ ...t, name: e.target.value.trim().slice(0, 64) }, 'Rename block type')} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <button type="button" className="tl-btn tl-btn--small" title="A copy of this type to change" onClick={() => {
          const copy = duplicateBlockType(t, s.blocks.types);
          void blockCommand(s, 'Duplicate block type', 'setBlockType', { block: copy }).then((ok) => ok && s.set((st) => ({ brush: { ...st.brush, block: copy.blockId, variant: null }, typeOpen: copy.blockId })));
        }}>
          Duplicate
        </button>
        <button type="button" className="tl-icon-btn" aria-label="delete block type" title="Delete the block type (refused while cells use it)" onClick={() => void blockCommand(s, 'Delete block type', 'deleteBlockType', { blockId: t.blockId }).then((ok) => ok && s.set((st) => ({ typeOpen: null, brush: { ...st.brush, block: st.brush.block === t.blockId ? null : st.brush.block } })))}>
          <Glyph name="trash" size={13} />
        </button>
      </div>
      <LooksSection s={s} t={t} />
      <ShapeSection s={s} t={t} />
      <TurnsAndPlacement s={s} t={t} />
      <ConnectionsSection s={s} t={t} />
      <ThemesSection s={s} t={t} />
      <MetadataSection s={s} t={t} />
      <Section title="Material">
        <MaterialMappingEditor label="Materials" sourceNames={Object.keys(t.materials ?? {}).filter((k) => k !== '*')} mapping={t.materials ?? null} materials={host.palette.materials} onChange={(mapping) => {
          const next = { ...t };
          if (mapping === null) delete next.materials;
          else next.materials = mapping;
          save(next, 'Block type material');
        }} />
      </Section>
    </div>
  );
}
