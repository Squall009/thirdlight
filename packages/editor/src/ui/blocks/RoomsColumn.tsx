/**
 * The block editor's Rooms & buildings mode: rooms, paths and buildings of
 * generated architecture drawn on the layer (one rooms object naming it,
 * made with the first room).
 *
 * - **Tool**: Rect, Polygon, Path, Building, Door, Window, Arch, Move
 *   walls, Wall piece and Corner piece — the Scene view's Rooms tool, one
 *   command a gesture, on the slice's floor.
 * - **New rooms**: the presets new rooms, paths and buildings wear.
 * - **Kit pieces**: the rooms' kit (the rooms object's, else the layer's)
 *   and the pieces of its slots that Door, Window, Wall piece and Corner
 *   piece put: a door or window piece takes the hole its size needs, from
 *   its slot's sill (`KIT_STANDARD_SLOTS`).
 *
 * Docked panels over the view (`EditPanels`):
 * - **Rooms** (top right, collapsed): the list, and Presets in use — every
 *   room wearing one preset swapped to another, the outlines kept
 *   (`PresetSwap`). The view is where rooms are mostly picked: with no tool
 *   a click selects one, and with a drawing tool a click on it (no drag)
 *   does; it is outlined there, and Esc lets it go.
 * - **The picked room, building or path** (right edge, while one is picked):
 *   its properties (`RoomInspector`).
 * - **Layer** (bottom left, collapsed): the layer's lock.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { ArchitectureModelRef, KitDef } from '@thirdlight/project-model';
import { kitSlotPlacement } from '@thirdlight/project-model/limits';
import { ARCHITECTURE_MATERIAL_SLOT } from '@thirdlight/runtime';

import { blockModeOf } from '../../session/block-mode';
import { kitPieceChoices, modelKey, type KitPieceChoice } from '../../session/kit-edits';
import { allOutlines, isBuilding, openingPiece, type RoomToolMode, type RoomToolOptions } from '../../session/room-draw';
import { PresetSwap } from '../architecture/PresetSwap';
import { useRoomsBinding } from '../architecture/useRoomsBinding';
import { SliderField } from '../brush/SliderField';
import { Section } from '../editmode/controls';
import { EditPanels, type EditPanel } from '../editmode/docks';
import { useEditStatus } from '../editmode/edit-status';
import { useEditSelection, useToolArmed } from '../editmode/edit-tool';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { useBlockSetup, useBlockTool, type BlockSetup } from './block-column';
import { layerPanel } from './block-panels';
import { SliceField, toolKeysHint } from './BuildColumn';
import { RoomInspector, roomTitle, type RoomPieces } from './RoomInspector';
import { Pick } from './RoomFields';

/** The pieces' sizes (metres across, up, deep) the kit's check read from their files, by model key. */
function usePieceSizes(s: BlockSetup, kit: KitDef | null): ReadonlyMap<string, readonly number[]> {
  const [sizes, setSizes] = useState<{ kit: KitDef | null; sizes: ReadonlyMap<string, readonly number[]> }>({ kit: null, sizes: new Map() });
  const client = s.blocks.clientRef.current;
  useEffect(() => {
    if (kit === null || client === null) return;
    let live = true;
    void client.kitCheck(kit.kitId, false).then((r) => {
      if (live && r.ok) setSizes({ kit, sizes: new Map(r.pieces.flatMap((p) => (p.size !== undefined ? [[modelKey(p), p.size] as const] : []))) });
    });
    return () => {
      live = false;
    };
  }, [kit, client]);
  return sizes.kit === kit ? sizes.sizes : new Map();
}

/** The tool's options: the remembered ones, its mode the picked tile, door and window holes sized from the pieces' sizes. */
function toolOptions(s: BlockSetup, mode: RoomToolMode, sizes: ReadonlyMap<string, readonly number[]>): RoomToolOptions {
  const o = s.state.roomOpts;
  const sized = (p: RoomToolOptions['doorPiece'], kind: 'door' | 'window'): RoomToolOptions['doorPiece'] => (p === null ? null : openingPiece(p.model, kind, kitSlotPlacement(kind).sill ?? 0, sizes.get(modelKey(p.model)) ?? null, s.component.cellSize));
  return { ...o, mode, doorPiece: sized(o.doorPiece, 'door'), windowPiece: sized(o.windowPiece, 'window') };
}

/** A kit slot's pieces as a picker (none: the style's own). */
function PiecePick(p: { label: string; none: string; choices: readonly KitPieceChoice[]; value: ArchitectureModelRef | null; name: (m: ArchitectureModelRef) => string; onPick: (m: ArchitectureModelRef | null) => void }): JSX.Element {
  return <Pick label={p.label} value={p.value !== null ? modelKey(p.value) : ''} options={[['', p.none], ...p.choices.map((c) => [c.key, p.name(c.model)] as const)]} onCommit={(v) => p.onPick(p.choices.find((c) => c.key === v)?.model ?? null)} />;
}

export function RoomsColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const armed = useToolArmed();
  useBlockTool(s, 'room');
  const mode = blockModeOf('rooms');
  const tile = mode.tiles.find((t) => t.id === s.state.tiles.rooms) ?? mode.tiles[0]!;
  const b = useRoomsBinding(entity, host.entities, s.blocks.graphs, s.blocks.kits, s.blocks.clientRef, s.blocks.viewportRef, s.blocks.reportFailure);
  const editor = s.blocks.editor;
  const kitId = b?.component?.kitId ?? s.component.kitId;
  const kit = kitId === undefined ? null : (s.blocks.kits.find((k) => k.kitId === kitId) ?? null);
  const sizes = usePieceSizes(s, kit);
  const opts = toolOptions(s, tile.id as RoomToolMode, sizes);
  const optsKey = JSON.stringify(opts);
  useEffect(() => editor?.rooms.setOptions(JSON.parse(optsKey) as RoomToolOptions), [editor, optsKey]);
  useEffect(() => {
    if (b === undefined) return;
    editor?.rooms.setTarget({ entityId: b.entityId, component: b.component, origin: b.origin, elements: b.elements });
    editor?.setRoomWalls(b.walls);
  }, [editor, b?.entityId, b?.component, b?.origin, b?.elements, b?.walls]); // eslint-disable-line react-hooks/exhaustive-deps -- the binding is made again each render; these are what the tool reads
  if (editor !== null && b !== undefined) {
    editor.roomHandlers.current = {
      onRooms: (_layerId, next, what) => b.setRooms(next, what),
      onPreview: (id, next) => b.preview(id, next),
      onPickRoom: (id) => s.set({ room: id }),
    };
  }
  const setOpts = (patch: Partial<BlockSetup['state']['roomOpts']>): void => s.set((st) => ({ roomOpts: { ...st.roomOpts, ...patch } }));
  const pieces = useMemo((): RoomPieces => {
    const client = s.blocks.clientRef.current;
    const label = (m: ArchitectureModelRef): string => `${client?.content.getAsset(m.assetId)?.displayName ?? m.assetId}${m.piece !== undefined ? ` · ${m.piece}` : ''}`;
    return {
      door: kitPieceChoices(kit, ['door']),
      window: kitPieceChoices(kit, ['window']),
      railing: kitPieceChoices(kit, ['railing']),
      label,
      hole: (m, kind) => openingPiece(m, kind, kitSlotPlacement(kind).sill ?? 0, sizes.get(modelKey(m)) ?? null, s.component.cellSize),
    };
  }, [kit, sizes, s.blocks.clientRef, s.component.cellSize]);
  const walls = kitPieceChoices(kit, ['wall-override']);
  const corners = kitPieceChoices(kit, ['corner']);
  const outlines = allOutlines(b?.component ?? null);
  const room = outlines.find((o) => o.id === s.state.room) ?? null;
  useEffect(() => editor?.rooms.setSelected(room?.id ?? null), [editor, room?.id]);
  useEffect(() => () => editor?.rooms.setSelected(null), [editor]);
  useEditSelection(room === null ? null : roomTitle(b?.component ?? null, room), () => s.set({ room: null }), room?.id, () => editor?.rooms.selectionBox() ?? null);
  const drawing = tile.id === 'polygon' || tile.id === 'path' || tile.id === 'building';
  const needsPiece = (tile.id === 'piece' && opts.wallModel === null) || (tile.id === 'corner' && opts.cornerModel === null);
  useEditStatus({
    tool: tile.label,
    text: s.locked ? `${entity.name} is locked: unlock it in its Layer panel to draw rooms.` : needsPiece ? `Pick a ${tile.id === 'corner' ? 'corner' : 'wall'} piece from the kit in the column first.` : (tile.hint ?? mode.hint),
    keys: [...toolKeysHint(mode.tiles), ...(armed && drawing ? [{ keys: ['Enter'], label: 'Finish' }, { keys: ['Backspace'], label: 'Undo corner' }] : []), ...(armed && (tile.id === 'piece' || tile.id === 'corner') ? [{ keys: ['Ctrl', 'Click'], label: 'Take off' }] : []), { keys: ['PgUp / PgDn'], label: 'Floor' }],
    right: s.state.hover,
  });
  const roomsEntity = b?.entityId !== null && b?.entityId !== undefined ? host.entities.find((e) => e.id === b.entityId) : undefined;
  const mats = roomsEntity?.components['materials'] as Readonly<Record<string, string>> | undefined;
  const objectSheet = mats?.[ARCHITECTURE_MATERIAL_SLOT] ?? mats?.['*'] ?? null;
  const setKit = (id: string): void => {
    if (b?.component === null || b === undefined) return;
    const { kitId: _k, ...rest } = b.component;
    void b.setRooms(id === '' ? rest : { ...rest, kitId: id }, id === '' ? 'Rooms kit: the layer’s' : 'Rooms kit');
  };
  const roomPanels: EditPanel[] =
    b === undefined
      ? []
      : [
          {
            id: 'rooms',
            title: 'Rooms',
            dock: 'tr',
            collapsed: true,
            badge: outlines.length,
            render: () => (
              <>
                <Section title="List">
                  <div className="tl-rooms__list" aria-label="rooms">
                    {outlines.length === 0 && <p className="tl-note">No rooms yet: draw one on the slice's floor.</p>}
                    {outlines.map((o) => (
                      <button key={o.id} type="button" className={`tl-btn tl-btn--small${o.id === room?.id ? ' is-active' : ''}`} aria-label={`${isBuilding(b.component, o.id) ? 'building' : 'room'} ${o.id}`} aria-pressed={o.id === room?.id} onClick={() => s.set({ room: o.id })}>
                        {o.id}
                        {o.path.closed === true ? '' : ' (path)'}
                      </button>
                    ))}
                  </div>
                </Section>
                {outlines.length > 0 && (
                  <Section title="Presets in use">
                    <PresetSwap component={b.component} presets={b.presets} disabled={s.locked} onSwap={(next, what) => void b.setRooms(next, what)} />
                  </Section>
                )}
              </>
            ),
          },
          {
            id: 'selection',
            title: room === null ? '' : roomTitle(b.component, room),
            dock: 'r',
            shown: room !== null,
            selection: true,
            ...(room !== null ? { badge: `${room.path.points.length} corners` } : {}),
            render: () =>
              room !== null && (
                <RoomInspector
                  s={s}
                  b={b}
                  room={room}
                  pieces={pieces}
                  presets={s.blocks.presets}
                  objectSheet={objectSheet}
                  edgeTypes={s.blocks.types.filter((t) => t.placement === 'edge')}
                  onDerive={(base) => void s.blocks.grouped((g) => b.derive(base, g.clientRef))}
                  onPick={(id) => s.set({ room: id })}
                />
              ),
          },
        ];
  return (
    <div className="tl-bcol" aria-label="block rooms">
      <Section title="Tool">
        <ToolGrid tools={mode.tiles} active={tile.id} onPick={(id) => s.set((st) => ({ tiles: { ...st.tiles, rooms: id } }))} aria="room tool" cols={4} disabled={s.locked} />
        {armed && <p className="tl-hint">{tile.hint}</p>}
        {drawing && <SliderField label="Arc" aria="arc bulge" value={s.state.roomOpts.bulge} min={-2.4} max={2.4} step={0.05} hint="The next side bends this much (0: straight; minus bends the other way)." onChange={(v) => setOpts({ bulge: v })} />}
        <SliceField s={s} />
      </Section>
      {b !== undefined && (
        <Section title="New rooms">
          <Pick label="new room preset" value={opts.roomPreset} options={b.presets} onCommit={(v) => setOpts({ roomPreset: v })} />
          <Pick label="new path preset" value={opts.pathPreset} options={b.presets} onCommit={(v) => setOpts({ pathPreset: v })} />
          <Pick label="new facade preset" value={opts.facadePreset} options={[['', '— the inside’s —'], ...b.presets]} onCommit={(v) => setOpts({ facadePreset: v })} />
        </Section>
      )}
      <Section
        title="Kit pieces"
        aside={
          <select className="tl-input tl-sec__picker" aria-label="rooms kit" title="The kit the rooms take their door, window, wall and corner pieces from" value={b?.component?.kitId ?? ''} disabled={b?.component === null || s.locked} onChange={(e) => setKit(e.target.value)}>
            <option value="">The layer’s kit{s.kit !== null ? ` (${s.kit.name})` : ''}</option>
            {s.blocks.kits.map((k) => (
              <option key={k.kitId} value={k.kitId}>
                {k.name}
              </option>
            ))}
          </select>
        }
      >
        {kit === null ? (
          <p className="tl-hint">No kit: pick one for the layer in Build's palette (or here, once a room is drawn). Its door, window, wall and corner pieces show here.</p>
        ) : (
          <>
            <PiecePick label="door piece" none="The style’s frame (no piece)" choices={pieces.door} value={s.state.roomOpts.doorPiece?.model ?? null} name={pieces.label} onPick={(m) => setOpts({ doorPiece: m === null ? null : openingPiece(m, 'door', kitSlotPlacement('door').sill ?? 0, null, s.component.cellSize) })} />
            <PiecePick label="window piece" none="The style’s frame and pane" choices={pieces.window} value={s.state.roomOpts.windowPiece?.model ?? null} name={pieces.label} onPick={(m) => setOpts({ windowPiece: m === null ? null : openingPiece(m, 'window', kitSlotPlacement('window').sill ?? 1, null, s.component.cellSize) })} />
            {(['door', 'window'] as const).map((k) => {
              const h = opts[k === 'door' ? 'doorPiece' : 'windowPiece'];
              return h === null ? null : (
                <p key={k} className="tl-hint" aria-label={`${k} hole`}>
                  {k === 'door' ? 'Door' : 'Window'} hole: {h.cells} cell{h.cells === 1 ? '' : 's'} wide, {h.bottom}–{h.top} m{sizes.has(modelKey(h.model)) ? '' : ' (the piece’s size not read yet)'}
                </p>
              );
            })}
            <PiecePick label="wall piece" none="(pick one for Wall piece)" choices={walls} value={opts.wallModel} name={pieces.label} onPick={(m) => setOpts({ wallModel: m })} />
            <PiecePick label="corner piece" none="(pick one for Corner piece)" choices={corners} value={opts.cornerModel} name={pieces.label} onPick={(m) => setOpts({ cornerModel: m })} />
            <p className="tl-hint">
              {kit.name}: Door and Window put these pieces in new openings (sized to the piece); Wall piece and Corner piece put them on a clicked wall.
              {walls.length === 0 && corners.length === 0 ? ' The kit has no wall or corner pieces yet (the kit editor adds them).' : ''}
            </p>
            <button type="button" className="tl-btn tl-btn--small" onClick={() => s.blocks.openKit(kit.kitId)}>
              Open the kit
            </button>
          </>
        )}
      </Section>
      <EditPanels
        panels={[
          ...roomPanels,
          layerPanel(s),
        ]}
      />
    </div>
  );
}
