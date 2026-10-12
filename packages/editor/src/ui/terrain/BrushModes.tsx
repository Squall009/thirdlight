/**
 * The terrain editor's brush modes — Sculpt, Paint and Holes — each a tool
 * grid, the shared brush panel and noise mask, and what the mode adds:
 *
 * - Sculpt: raise, lower, smooth, flatten, noise, ramp; the height step is
 *   the brush's own row; the noise tool's bump size and seed.
 * - Paint: paint and erase (one tool, one brush: X switches them), the
 *   layer palette of the terrain's material, opacity, the noise mask open.
 * - Holes: cut and fill (one tool, X switches them).
 *
 * The picked tool is armed in the Scene view; a stroke is one `editTerrain`.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';

import { brushKeyHints, PALETTE_KEYS, paletteKeyHint, type KeyHint } from '../../session/edit-keys';
import { TERRAIN_BRUSH_UI, TERRAIN_INVERT_LABELS, TERRAIN_MODES, terrainToolUses, type TerrainMode, type TerrainModeId, type TerrainToolTile } from '../../session/terrain-brush';
import { BrushPanel } from '../brush/BrushPanel';
import { NoiseMask } from '../brush/NoiseMask';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { Section } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import { ToolGrid } from '../editmode/ToolGrid';
import { MaterialLayers, usePalette } from '../palette/MaterialLayers';
import { SeedField } from '../rules/RuleConditions';
import { TERRAIN_LAYER_TILING_M, terrainBrushStore, useTerrainTool, useTerrainToolState, type TerrainColumnProps } from './terrain-column';

const modeOf = (id: TerrainModeId): TerrainMode => TERRAIN_MODES.find((m) => m.id === id)!;

/** The tool tiles' keys as the status line lists them ("Q / W / E" Tools). */
export function toolKeysHint(tiles: readonly TerrainToolTile[]): KeyHint[] {
  const letters = [...new Set(tiles.map((t) => t.key).filter((k) => k !== 'X'))];
  return letters.length < 2 ? [] : [{ keys: [letters.join(' / ')], label: 'Tools' }];
}

/**
 * The tile picked in a mode: for tiles that share a tool and differ by
 * invert (paint and erase), the one matching the brush's invert now (X and
 * the toggle switch it), else the one remembered.
 */
function pickedTile(m: TerrainMode, remembered: string, invert: boolean): TerrainToolTile {
  const t = m.tiles.find((x) => x.id === remembered) ?? m.tiles[0]!;
  if (t.invert === undefined) return t;
  return m.tiles.find((x) => x.tool === t.tool && x.invert === invert) ?? t;
}

function BrushModeColumn({ p, modeId, children, above }: { p: TerrainColumnProps; modeId: 'sculpt' | 'paint' | 'holes'; children?: (tile: TerrainToolTile) => JSX.Element | null; above?: JSX.Element }): JSX.Element {
  const m = modeOf(modeId);
  const [state, setState] = useTerrainToolState(p.entityId);
  const first = m.tiles.find((x) => x.id === state.tiles[modeId]) ?? m.tiles[0]!;
  const store = terrainBrushStore(first.tool);
  const settings = useBrush(store);
  const tile = pickedTile(m, state.tiles[modeId], settings.invert);
  useTerrainTool(p, tile.tool);
  const uses = terrainToolUses(tile.tool);
  const invert = TERRAIN_INVERT_LABELS[tile.tool];
  const pick = (id: string): void => {
    const t = m.tiles.find((x) => x.id === id)!;
    setState({ tiles: { ...state.tiles, [modeId]: id } });
    if (t.invert !== undefined) terrainBrushStore(t.tool).set({ invert: t.invert });
  };
  useEditStatus({ tool: tile.label, text: tile.hint, keys: [...toolKeysHint(m.tiles), ...(modeId === 'paint' ? paletteKeyHint(PALETTE_KEYS, 'Layer') : []), ...brushKeyHints(uses, invert)] });
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Tool">
        <ToolGrid tools={m.tiles} active={tile.id} onPick={pick} aria="terrain tool" cols={modeId === 'sculpt' ? 3 : 4} disabled={p.locked} />
        <p className="tl-hint">{tile.hint}</p>
      </Section>
      {above}
      <Section title="Brush" aside="Shared by every brush">
        <BrushPanel settings={settings} store={store} uses={uses} preview={modeId === 'sculpt'} {...(invert !== undefined ? { invert } : {})} />
      </Section>
      {uses.includes('mask') && (
        <Section key={`mask:${modeId}`} title="Noise mask" open={modeId === 'paint'} aside={<span className={`tl-tag${settings.mask.on ? ' tl-tag--ok' : ''}`}>{settings.mask.on ? 'on' : 'off'}</span>}>
          <NoiseMask settings={settings} store={store} />
        </Section>
      )}
      {children?.(tile)}
    </div>
  );
}

export function SculptColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  const b = state.brush;
  const set = (patch: Partial<typeof b>): void => setState({ brush: { ...b, ...patch } });
  return (
    <BrushModeColumn p={p} modeId="sculpt">
      {(tile) =>
        tile.tool === 'noise' ? (
          <Section title="Noise">
            <SliderField label="Bump size" aria="noise size" value={b.scale} min={0.5} max={256} log limit={[0.1, TERRAIN_BRUSH_UI.scaleMax]} step={0.1} decimals={b.scale < 10 ? 1 : 0} unit="m" hint="The size of the noise's bumps in metres." onChange={(v) => set({ scale: v })} />
            <SeedField aria="noise seed" value={b.seed} onChange={(n) => set({ seed: n })} />
          </Section>
        ) : null
      }
    </BrushModeColumn>
  );
}

export function PaintColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  // The layers the brush paints: the material's, or the stand-in colours the terrain draws without one.
  const palette = usePalette(p.mapping, p.palette.materials, TERRAIN_DEFAULT_COLOURS);
  return <BrushModeColumn p={p} modeId="paint" above={<MaterialLayers entityId={p.entityId} entityName={p.entityName} palette={palette} active={state.brush.layer} onPick={(layer) => setState({ brush: { ...state.brush, layer } })} host={p.palette} disabled={p.locked} layerTiling={TERRAIN_LAYER_TILING_M} />} />;
}

export function HolesColumn(p: TerrainColumnProps): JSX.Element {
  return <BrushModeColumn p={p} modeId="holes" />;
}
