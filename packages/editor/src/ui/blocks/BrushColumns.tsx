/**
 * The block editor's round-brush modes:
 *
 * - **Shape**: raise, lower, smooth and flatten the ground's tops under the
 *   shared brush (a height step in metres, size, strength, spacing); raising
 *   where nothing stands fills with the palette's block type.
 * - **Paint**: paint and erase (one brush, X switches them) the four
 *   material layers and the wetness on the tops and the walls, through the
 *   shared brush with opacity, falloff and the noise mask. The palette's
 *   tiles are the block types' material's layers by its declaration (Base,
 *   2, 3, 4, Wet). A material that reads no paint gets a banner with
 *   **Make it paintable**.
 *
 * A stroke is one `editBlocks` of dabs, sent by the Scene view's block tools.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { BlockType, MaterialDef, PaintTarget } from '@thirdlight/project-model';

import { blockModeOf, blockPaintChannels, blockToolUses, BLOCK_INVERT_LABELS, type BlockModeId, type BlockToolTile } from '../../session/block-mode';
import { brushKeyHints, paletteKeyHint } from '../../session/edit-keys';
import { paintableMaterial, withSlotTexture } from '../../session/layer-palette';
import { BrushPanel } from '../brush/BrushPanel';
import { NoiseMask } from '../brush/NoiseMask';
import { useBrush } from '../brush/useBrush';
import { TEXTURE_KINDS } from '../catalog/RefPicker';
import { Banner } from '../editmode/Banner';
import { Section, Segmented, Toggle } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { LayerPalette, Popover } from '../palette/LayerPalette';
import { usePalette } from '../palette/MaterialLayers';
import { TextureBrowser } from '../palette/TextureBrowser';
import { blockBrushStore, blockCommand, useBlockSetup, useBlockTool, type BlockSetup } from './block-column';
import { LayerSection, PaletteSection, SliceField, toolKeysHint } from './BuildColumn';

/** The tile of a brush mode matching the brush's invert now (X and Ctrl switch it), else the remembered one. */
function brushTile(s: BlockSetup, modeId: BlockModeId): BlockToolTile {
  const m = blockModeOf(modeId);
  const t = m.tiles.find((x) => x.id === s.state.tiles[modeId]) ?? m.tiles[0]!;
  if (t.invert === undefined) return t;
  const invert = blockBrushStore(t.tool as 'height' | 'paint').get().invert;
  return m.tiles.find((x) => x.tool === t.tool && x.invert === invert) ?? t;
}

function brushModeTools({ s, modeId }: { s: BlockSetup; modeId: BlockModeId }): { tile: BlockToolTile; pick: (id: string) => void } {
  const m = blockModeOf(modeId);
  const tile = brushTile(s, modeId);
  const pick = (id: string): void => {
    const t = m.tiles.find((x) => x.id === id)!;
    s.set((st) => ({ tiles: { ...st.tiles, [modeId]: id } }));
    if (t.invert !== undefined) blockBrushStore(t.tool as 'height' | 'paint').set({ invert: t.invert });
  };
  return { tile, pick };
}

export function ShapeColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const { tile, pick } = brushModeTools({ s, modeId: 'shape' });
  const store = useBlockTool(s, tile.tool)!;
  const settings = useBrush(store);
  const uses = blockToolUses(tile.tool);
  const invert = BLOCK_INVERT_LABELS[tile.tool];
  useEditStatus({ tool: tile.label, text: s.locked ? `${entity.name} is locked: unlock it in Build to shape it.` : tile.hint, keys: [...toolKeysHint(blockModeOf('shape').tiles), ...brushKeyHints(uses, invert)], right: s.state.hover });
  return (
    <div className="tl-bcol" aria-label="block shape tools">
      <Section title="Tool">
        <ToolGrid tools={blockModeOf('shape').tiles} active={tile.id} onPick={pick} aria="shape tool" cols={4} disabled={s.locked} />
        <p className="tl-hint">{tile.hint}</p>
      </Section>
      <Section title="Brush" aside="Shared by every brush">
        <BrushPanel settings={settings} store={store} uses={uses} preview {...(invert !== undefined ? { invert } : {})} />
      </Section>
      <PaletteSection s={s} keys={!s.locked} />
      <p className="tl-hint tl-bcol__note">Raising where nothing stands fills the ground with the picked block type.</p>
      <Section title="Slice" open={false}>
        <SliceField s={s} />
      </Section>
    </div>
  );
}

/**
 * The material the layer's paint is read by: the picked block type's, else
 * the first palette type's that wears one (the types' "*" material).
 */
export function paintMaterialOf(s: BlockSetup, materials: readonly MaterialDef[]): { material: MaterialDef | null; from: BlockType | null } {
  const picked = s.state.brush.block !== null ? s.typeOf.get(s.state.brush.block) : undefined;
  const candidates = [...(picked !== undefined ? [picked] : []), ...s.palette];
  for (const t of candidates) {
    const id = t.materials?.['*'];
    const m = id === undefined ? undefined : materials.find((x) => x.materialId === id);
    if (m !== undefined) return { material: m, from: t };
  }
  return { material: null, from: picked ?? s.palette[0] ?? null };
}

/**
 * Make the layer paintable: a Layered surface whose base is the old
 * material's maps (or empty), worn by every block type of the palette that
 * wore the old one (with none, the picked type). The material and each
 * type's change are their own commands.
 */
async function makePaintable(s: BlockSetup, old: MaterialDef | null, from: BlockType | null): Promise<void> {
  const host = s.host.palette;
  const name = `${s.entity.name} layers`;
  const id = await host.newMaterialId(name);
  if (!(await host.run(old === null ? 'Set up material' : 'Make it paintable', 'setMaterial', { material: paintableMaterial(old, id, name) }))) return;
  const wearers = old === null ? (from !== null ? [from] : []) : s.blocks.types.filter((t) => t.materials?.['*'] === old.materialId);
  for (const t of wearers) await blockCommand(s, 'Block type material', 'setBlockType', { block: { ...t, materials: { ...(t.materials ?? {}), '*': id } } });
}

const PAINT_TARGETS: readonly { id: PaintTarget; label: string; hint: string }[] = [
  { id: 'tops', label: 'Tops', hint: 'The ground (the tops of the columns)' },
  { id: 'walls', label: 'Walls', hint: 'The exposed walls (the layer needs walls with their own paint)' },
  { id: 'both', label: 'Both', hint: 'Tops and walls' },
];

const NO_STAND_INS: readonly string[] = [];

export function PaintColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const { tile, pick } = brushModeTools({ s, modeId: 'paint' });
  const store = useBlockTool(s, 'paint')!;
  const settings = useBrush(store);
  const uses = blockToolUses('paint');
  const materials = host.palette.materials;
  const { material, from } = paintMaterialOf(s, materials);
  const mapping = material === null ? undefined : { '*': material.materialId };
  const palette = usePalette(mapping, materials, NO_STAND_INS, host.palette.heightInAlpha);
  const ch = blockPaintChannels(material, materials, palette.source.kind === 'none' ? undefined : palette.layers);
  const brush = s.state.brush;
  const erase = tile.invert === true;
  const [busy, setBusy] = useState(false);
  const [chooser, setChooser] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const picked = ch.tiles.find((t) => t.index === brush.paintChannel) ?? ch.tiles[1];
  // Paint is stored whatever the block types wear (rules read it, and the walls of rooms drawn on the layer wear their own
  // material): a material that reads none only means the blocks won't show it, as the banner says.
  const paintable = !s.locked;
  useEditStatus({
    tool: tile.label,
    text: s.locked ? `${entity.name} is locked: unlock it in Build to paint.` : !ch.reads ? "The block types' material doesn't read paint: Make it paintable to see it on the blocks." : `Drag on the ${brush.paintTarget === 'tops' ? 'tops' : brush.paintTarget === 'walls' ? 'walls' : 'tops and walls'} to ${erase ? 'take' : 'paint'} ${picked?.name ?? 'the layer'}${erase ? ' off' : ''}.`,
    keys: paintable ? [...paletteKeyHint(ch.tiles.length, 'Layer'), ...brushKeyHints(uses, 'Erase')] : [],
    right: s.state.hover,
  });
  const setTexture = (index: number, textureId: string): void => {
    if (palette.source.kind !== 'layered' || index >= 4) return;
    void host.palette.run('Layer texture', 'setMaterial', { material: withSlotTexture(palette.source.material, index, textureId) });
  };
  const setBrush = (patch: Partial<typeof brush>): void => s.set((st) => ({ brush: { ...st.brush, ...patch } }));
  return (
    <div className="tl-bcol" aria-label="block paint tools">
      {!ch.reads && !s.locked && (
        <Banner
          title="This material doesn't read paint"
          aria="material does not read paint"
          action={{
            label: 'Make it paintable',
            busy,
            onClick: () => {
              setBusy(true);
              void makePaintable(s, material, from).finally(() => setBusy(false));
            },
          }}
        >
          {material === null ? `The block types wear no material of the project (they draw their stand-in colours), which reads no paint: paint is stored but the blocks won't show it. Make it paintable gives ${from?.name ?? 'the picked type'} a Layered surface (its base starts empty: drop a texture on it).` : `${material.name} is a ${ch.summary.replace(' · reads no paint', '')}: paint is stored but the blocks won't show it. Make it paintable swaps in a Layered surface whose base is its own textures, for every block type that wears it.`}
        </Banner>
      )}
      <div className={paintable ? undefined : 'tl-vpaint__off'} inert={!paintable}>
        <Section title="Tool">
          <ToolGrid tools={blockModeOf('paint').tiles} active={tile.id} onPick={pick} aria="paint tool" cols={4} disabled={!paintable} />
        </Section>
        <Section
          title="Layers"
          aside={
            material !== null ? (
              <button type="button" className="tl-btn tl-btn--small" onClick={() => host.palette.openMaterial(material.materialId)} title={`${ch.summary}. Open it in the material editor`}>
                {material.name}
              </button>
            ) : undefined
          }
        >
          <LayerPalette
            layers={ch.tiles}
            active={brush.paintChannel}
            onPick={(i) => setBrush({ paintChannel: i })}
            {...(palette.source.kind === 'layered' ? { onDropTexture: setTexture, onChooseTexture: (index: number, anchor: HTMLElement) => index < 4 && setChooser({ index, anchor }) } : {})}
            thumbnails={host.palette.thumbnails}
            compact
            keys={paintable}
            disabled={!paintable}
            aria="paint layers"
          />
          <p className="tl-hint">{from !== null && material !== null ? `${ch.summary}, worn by ${from.name}. ` : ''}Base is what the other layers leave; Wet darkens and adds shine over any layer.</p>
          <div className="tl-frow">
            <span className="tl-frow__label">Paint on</span>
            <Segmented small aria="paint target" value={brush.paintTarget} options={PAINT_TARGETS} onChange={(t) => setBrush({ paintTarget: t })} />
          </div>
          {brush.paintTarget !== 'tops' && (
            <Toggle
              label="Walls have their own paint"
              aria="wall paint"
              on={s.component.wallPaint === true}
              hint="Off: a wall shows the paint of the top above it. On: walls are painted on their own (an unpainted wall shows layer 2)."
              // A component's field is taken away with null.
              onChange={(on) => void s.blocks.changeLayer(on ? 'Wall paint on' : 'Wall paint off', entity.id, (c) => ({ ...c, wallPaint: (on ? true : null) as boolean }))}
            />
          )}
        </Section>
        <Section title="Brush" aside="Shared by every brush">
          <BrushPanel settings={settings} store={store} uses={uses.filter((u) => u !== 'mask')} invert="Erase" />
        </Section>
        <Section title="Noise mask" open={settings.mask.on} aside={<span className={`tl-tag${settings.mask.on ? ' tl-tag--ok' : ''}`}>{settings.mask.on ? 'on' : 'off'}</span>}>
          <NoiseMask settings={settings} store={store} />
        </Section>
      </div>
      <LayerSection s={s} />
      {chooser !== null && palette.source.kind === 'layered' && (
        <Popover anchor={chooser.anchor} onClose={() => setChooser(null)} title={`Layer ${chooser.index + 1}`} aria="layer texture">
          <TextureBrowser
            aria="layer textures"
            value={null}
            kinds={TEXTURE_KINDS}
            thumbnails={host.palette.thumbnails}
            autoFocus
            onPick={(id) => {
              setTexture(chooser.index, id);
              setChooser(null);
            }}
          />
        </Popover>
      )}
    </div>
  );
}
