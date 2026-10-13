/**
 * The block editor's Build mode: the tools (single, line, rect, box, flood,
 * column, erase, pick, replace, stamp, paste, select), the palette of block
 * types from the layer's kit, how the brush places (turn, look, box height,
 * the slice), the selection (copy, move, mirror, turn, delete, save as a
 * stamp), the stamps, and the layer's lock.
 *
 * Every stroke is one `editBlocks` sent by the Scene view's block tools;
 * new block types and stamps are content commands.
 *
 * Browser-only (React).
 */
import type { DragEvent, JSX } from 'react';
import type { BlockType } from '@thirdlight/project-model';

import { allowedRotations, boxVolume, mirrorEdit, rotateEdit, rotatedBox, type CellBox } from '../../session/block-brush';
import { BLOCK_MODES, blockModeOf, type BlockToolTile } from '../../session/block-mode';
import { newBlockId, newBlockType } from '../../session/block-type-edits';
import { paletteKeyHint, type KeyHint } from '../../session/edit-keys';
import { assetDropOf } from '../../session/placement';
import { SliderField } from '../brush/SliderField';
import { Section, Segmented, Toggle } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { blockCommand, useBlockSetup, useBlockTool, type BlockSetup } from './block-column';
import type { BlockModeHost } from './block-host';
import { BlockPalette } from './BlockPalette';
import { copySelection, deleteSelection } from './BlockView';

/** The tile picked in a mode (the remembered one, else the first). */
export function pickedTile(s: BlockSetup, modeId: 'build' | 'shape' | 'paint' | 'regions' | 'rules'): BlockToolTile {
  const m = blockModeOf(modeId);
  return m.tiles.find((t) => t.id === s.state.tiles[modeId]) ?? m.tiles[0]!;
}

/** Letters the status line lists one by one; a longer grid's letters are read off its tiles. */
const TOOL_KEYS_LISTED = 6;

/** The tool tiles' letters as the status line lists them ("Q / W / E" Tools). */
export function toolKeysHint(tiles: readonly BlockToolTile[]): KeyHint[] {
  const letters = tiles.map((t) => t.key).filter((k): k is string => k !== undefined);
  if (letters.length < 2) return [];
  return [{ keys: [letters.length > TOOL_KEYS_LISTED ? 'Letter on a tile' : letters.join(' / ')], label: 'Tool' }];
}

/** Make a block type wearing what was dropped on "New type" (a model tile or a GLB file), then pick it. */
async function dropNewType(s: BlockSetup, ev: DragEvent): Promise<void> {
  const file = ev.dataTransfer.files[0];
  const tile = file === undefined ? assetDropOf(ev, 'model') : null;
  if (file === undefined && tile === null) return;
  ev.preventDefault();
  // The model published (a file), the type and its place in the kit: one undo step.
  await s.blocks.grouped(async (g) => {
    const assetId = file !== undefined ? await g.importModel(file) : tile!.assetId;
    if (assetId === null) return;
    const name = (file?.name.replace(/\.[^.]+$/, '') ?? tile?.piece ?? assetId).replace(/[_-]+/g, ' ');
    const block = newBlockType(s.blocks.types, { model: { assetId, ...(tile?.piece !== undefined ? { piece: tile.piece } : {}) } }, name.charAt(0).toUpperCase() + name.slice(1));
    if (await blockCommand({ blocks: g }, 'New block type', 'setBlockType', { block })) await addToPalette(s, block, g);
  });
}

/** A new type joins the layer's kit (when it has one, so it shows in the palette), and becomes the brush; `blocks`: the host of the action it is part of. */
async function addToPalette(s: BlockSetup, block: BlockType, blocks: BlockModeHost): Promise<void> {
  if (s.kit !== null && s.kit.kitId !== '' && !(s.kit.blockTypes ?? []).includes(block.blockId)) await blockCommand({ blocks }, 'Add block type to kit', 'setKit', { kit: { ...s.kit, blockTypes: [...(s.kit.blockTypes ?? []), block.blockId] } });
  s.set((st) => ({ brush: { ...st.brush, block: block.blockId, variant: null, rot: 0 }, typeOpen: block.blockId }));
}

/** The palette with its kit picker: the layer's kit's block types first, "New type" last. */
export function PaletteSection({ s, keys }: { s: BlockSetup; keys: boolean }): JSX.Element {
  const brush = s.state.brush;
  const inKit = new Set(s.kit?.blockTypes ?? []);
  const outside = s.kit === null ? undefined : new Set(s.palette.filter((t) => !inKit.has(t.blockId)).map((t) => t.blockId));
  // A component's field is taken away with null.
  const setKit = (kitId: string): void => void s.blocks.changeLayer(kitId === '' ? 'Layer kit off' : 'Layer kit', s.entity.id, (c) => ({ ...c, kitId: (kitId === '' ? null : kitId) as string }));
  return (
    <Section
      title="Palette"
      aside={
        <select className="tl-input tl-sec__picker" aria-label="layer kit" title="The kit the layer is built from: its block types fill the palette" value={s.component.kitId ?? ''} onChange={(e) => setKit(e.target.value)} disabled={s.locked}>
          <option value="">No kit · every type</option>
          {s.blocks.kits.map((k) => (
            <option key={k.kitId} value={k.kitId}>
              {k.name}
            </option>
          ))}
        </select>
      }
    >
      <BlockPalette
        types={s.palette}
        active={brush.block}
        onPick={(blockId) => s.set((st) => ({ brush: { ...st.brush, block: blockId, variant: null, rot: allowedRotations(s.typeOf.get(blockId)).includes(st.brush.rot) ? st.brush.rot : 0 }, typeOpen: null }))}
        onNew={() => {
          const block = newBlockType(s.blocks.types);
          // The type and its place in the kit: one undo step.
          void s.blocks.grouped(async (g) => {
            if (await blockCommand({ blocks: g }, 'New block type', 'setBlockType', { block })) await addToPalette(s, block, g);
          });
        }}
        onDropModel={(ev) => void dropNewType(s, ev)}
        materials={s.host.palette.materials}
        thumbnails={s.host.palette.thumbnails}
        keys={keys}
        disabled={s.locked}
        {...(outside !== undefined ? { outside } : {})}
      />
      {s.kit !== null && (
        <Toggle label="Show every block type of the project" aria="show all block types" on={s.state.allTypes} onChange={(on) => s.set({ allTypes: on })} hint="Off: the kit's types and the ones the layer already uses." />
      )}
      {s.component.kitId !== undefined && s.kit === null && <p className="tl-hint">The layer names a kit that is not in the project ({s.component.kitId}).</p>}
    </Section>
  );
}

/** The slice as a field (PageUp / PageDown move it too). */
export function SliceField({ s }: { s: BlockSetup }): JSX.Element {
  const b = s.component.bounds;
  return <SliderField label="Slice" aria="slice level" value={s.slice} min={b.min[1]} max={b.max[1] - 1} step={1} unit="row" hint="The row the tools work on where no block is under the pointer (PageUp / PageDown)." onChange={(v) => s.set({ slice: Math.round(v) })} />;
}

function PlacementSection({ s, tool }: { s: BlockSetup; tool: string }): JSX.Element {
  const brush = s.state.brush;
  const t = brush.block !== null ? s.typeOf.get(brush.block) : undefined;
  const turns = allowedRotations(t);
  const setBrush = (patch: Partial<typeof brush>): void => s.set((st) => ({ brush: { ...st.brush, ...patch } }));
  return (
    <Section title="Placement">
      <div className="tl-frow">
        <span className="tl-frow__label">Turn</span>
        <Segmented small aria="brush turn" value={brush.rot} options={turns.map((r) => ({ id: r, label: `${r}°`, hint: 'T turns it' }))} onChange={(r) => setBrush({ rot: r })} />
      </div>
      {t !== undefined && t.variants.length > 1 && (
        <div className="tl-frow">
          <span className="tl-frow__label">Look</span>
          <select className="tl-input" aria-label="look" value={brush.randomize ? 'random' : String(brush.variant ?? 0)} onChange={(e) => (e.target.value === 'random' ? setBrush({ randomize: true, variant: null }) : setBrush({ randomize: false, variant: Number(e.target.value) }))} title="Random: each cell shows a look picked by the looks' weights from its place (the same everywhere)">
            <option value="random">Random by weight</option>
            {t.variants.map((_v, i) => (
              <option key={i} value={i}>
                Look {i + 1}
              </option>
            ))}
          </select>
        </div>
      )}
      {tool === 'box' && <SliderField label="Box height" value={brush.height} min={1} max={32} limit={[1, 256]} step={1} unit="cells" hint="How many cells high the box fills (an edge piece: how many rows of wall)." onChange={(v) => setBrush({ height: Math.round(v) })} />}
      <SliceField s={s} />
    </Section>
  );
}

function SelectionSection({ s, box }: { s: BlockSetup; box: CellBox }): JSX.Element {
  const edit = async (what: string, e: Parameters<BlockSetup['blocks']['edit']>[2][number], next: CellBox | null): Promise<void> => {
    if (await s.blocks.edit(what, s.entity.id, [e])) s.set({ selection: next });
  };
  const b = s.component.bounds;
  const turned = rotatedBox(box);
  const fits = turned[3] <= b.max[0] && turned[5] <= b.max[2];
  return (
    <Section title="Selection" aside={<span className="tl-sec__note">{boxVolume(box)} cells</span>}>
      <p className="tl-hint" aria-label="selection box">
        [{box.slice(0, 3).join(', ')}] – [{box.slice(3).map((v) => v - 1).join(', ')}] · {boxVolume(box)} cells
      </p>
      <div className="tl-btnrow">
        <button type="button" className="tl-btn tl-btn--small" onClick={() => copySelection(s, false)} title="Copy (Ctrl+C); then click with Paste">
          Copy
        </button>
        <button type="button" className="tl-btn tl-btn--small" onClick={() => copySelection(s, true)} title="Move (Ctrl+X); then click where the cells go">
          Move
        </button>
        <button type="button" className="tl-btn tl-btn--small" onClick={() => void edit('Mirror', mirrorEdit(box, 'x'), box)}>
          Mirror X
        </button>
        <button type="button" className="tl-btn tl-btn--small" onClick={() => void edit('Mirror', mirrorEdit(box, 'z'), box)}>
          Mirror Z
        </button>
        <button type="button" className="tl-btn tl-btn--small" onClick={() => void edit('Turn', rotateEdit(box), fits ? turned : null)}>
          Turn 90°
        </button>
        <button type="button" className="tl-btn tl-btn--small tl-btn--danger" onClick={() => void deleteSelection(s)} title="Empty the cells (Delete)">
          Delete
        </button>
      </div>
      <StampSave s={s} box={box} />
    </Section>
  );
}

function StampSave({ s, box }: { s: BlockSetup; box: CellBox }): JSX.Element {
  const save = (form: HTMLFormElement): void => {
    const input = form.elements.namedItem('stamp') as HTMLInputElement;
    const name = input.value.trim();
    if (name === '') return;
    const stampId = newBlockId(name, s.blocks.stamps.map((x) => x.stampId));
    void blockCommand(s, 'Save stamp', 'setBlockStamp', { stampId, name: name.slice(0, 64), entityId: s.entity.id, box: [...box] }).then((ok) => {
      if (!ok) return;
      input.value = '';
      s.set((st) => ({ stamp: { stampId, rot: 0, mirror: null }, tiles: { ...st.tiles, build: 'stamp' } }));
    });
  };
  return (
    <form
      className="tl-btnrow"
      onSubmit={(e) => {
        e.preventDefault();
        save(e.currentTarget);
      }}
    >
      <input className="tl-input" name="stamp" aria-label="stamp name" placeholder="Stamp name" />
      <button type="submit" className="tl-btn tl-btn--small">
        Save as stamp
      </button>
    </form>
  );
}

function StampsSection({ s }: { s: BlockSetup }): JSX.Element {
  const st = s.state.stamp;
  return (
    <Section title="Stamps" aside={<span className="tl-sec__note">{s.blocks.stamps.length}</span>}>
      {s.blocks.stamps.length === 0 ? (
        <p className="tl-hint">No stamps yet: select cells (Select) and save them as a stamp.</p>
      ) : (
        <ul className="tl-blist" aria-label="stamp library">
          {s.blocks.stamps.map((x) => (
            <li key={x.stampId} className={st?.stampId === x.stampId ? 'is-active' : ''}>
              <button type="button" className="tl-blist__name" aria-label={`place stamp ${x.stampId}`} onClick={() => s.set((q) => ({ stamp: { stampId: x.stampId, rot: q.stamp?.stampId === x.stampId ? q.stamp.rot : 0, mirror: q.stamp?.stampId === x.stampId ? q.stamp.mirror : null }, tiles: { ...q.tiles, build: 'stamp' } }))}>
                {x.name} <small>{x.size.join(' × ')}</small>
              </button>
              <button type="button" className="tl-icon-btn" aria-label={`delete stamp ${x.stampId}`} title="Delete the stamp" onClick={() => void blockCommand(s, 'Delete stamp', 'deleteBlockStamp', { stampId: x.stampId }).then((ok) => ok && st?.stampId === x.stampId && s.set({ stamp: null }))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {st !== null && (
        <div className="tl-frow">
          <span className="tl-frow__label">Stamp</span>
          <Segmented small aria="stamp turn" value={st.rot} options={([0, 90, 180, 270] as const).map((r) => ({ id: r, label: `${r}°` }))} onChange={(r) => s.set({ stamp: { ...st, rot: r } })} />
          <Segmented small aria="stamp mirror" value={st.mirror ?? 'none'} options={[{ id: 'none', label: 'As saved' }, { id: 'x', label: 'Mirror X' }, { id: 'z', label: 'Mirror Z' }]} onChange={(m) => s.set({ stamp: { ...st, mirror: m === 'none' ? null : m } })} />
        </div>
      )}
    </Section>
  );
}

export function BuildColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const mode = BLOCK_MODES[0]!;
  const tile = pickedTile(s, 'build');
  useBlockTool(s, tile.tool);
  const brush = s.state.brush;
  const t = brush.block !== null ? s.typeOf.get(brush.block) : undefined;
  const pick = (id: string): void => {
    if (id === 'paste' && s.state.clip === null) return s.blocks.notice('Paste: copy a selection first (Select, then Ctrl+C).');
    if (id === 'stamp' && s.state.stamp === null) {
      const first = s.blocks.stamps[0];
      if (first === undefined) return s.blocks.notice('Stamp: save a selection as a stamp first.');
      s.set({ stamp: { stampId: first.stampId, rot: 0, mirror: null } });
    }
    s.set((st) => ({ tiles: { ...st.tiles, build: id } }));
  };
  const needsBlock = ['single', 'line', 'rect', 'box', 'flood', 'replace'].includes(tile.tool);
  useEditStatus({
    tool: tile.label,
    text: s.locked ? `${entity.name} is locked: unlock it below to build.` : needsBlock && t === undefined ? 'Pick a block type in the palette first.' : `${tile.hint}${needsBlock && t !== undefined ? ` (${t.name})` : ''}`,
    keys: [...toolKeysHint(mode.tiles), ...paletteKeyHint(s.palette.length, 'Block type'), { keys: ['T'], label: 'Turn' }, { keys: ['PgUp / PgDn'], label: 'Slice' }, ...(tile.tool === 'column' ? [{ keys: ['Ctrl'], label: 'Lower' }] : [])],
    right: s.state.hover,
  });
  return (
    <div className="tl-bcol" aria-label="block tools">
      <Section title="Tool">
        <ToolGrid tools={mode.tiles} active={tile.id} onPick={pick} aria="block tool" cols={4} disabled={s.locked} />
        <p className="tl-hint">{tile.hint}</p>
      </Section>
      <PaletteSection s={s} keys={!s.locked} />
      <PlacementSection s={s} tool={tile.tool} />
      {s.state.selection !== null && <SelectionSection s={s} box={s.state.selection} />}
      {s.state.clip !== null && <p className="tl-hint tl-bcol__clip">{s.state.clip.move ? 'Moving' : 'Copied'} {boxVolume(s.state.clip.box)} cells: Paste, then click where their corner goes.</p>}
      {(tile.tool === 'stamp' || tile.tool === 'select' || s.blocks.stamps.length > 0) && <StampsSection s={s} />}
      <LayerSection s={s} />
    </div>
  );
}

/** The layer's lock (its Hierarchy flag), so a finished layer is not changed by a stray stroke. */
export function LayerSection({ s }: { s: BlockSetup }): JSX.Element {
  return (
    <Section title="Layer" open={s.locked}>
      <Toggle label="Locked (nothing can be edited)" aria="lock layer" on={s.locked} onChange={(on) => s.blocks.setFlag(s.entity.id, 'locked', on)} hint="The object's Locked flag, as in the Hierarchy." />
    </Section>
  );
}
