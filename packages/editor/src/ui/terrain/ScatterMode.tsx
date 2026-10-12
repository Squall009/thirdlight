/**
 * The terrain editor's Scatter mode: the scatter rules as cards (every
 * field a rule has; the layers it grows on picked from the palette), Bake —
 * the rules stored and their copies baked into every tile in one command —
 * and the hand-scatter brush: drag to put the chosen rule's copies under it
 * whatever its conditions, X (or Ctrl held) to take them off. Hand edits
 * stay over every later bake.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { ScatterRule } from '@thirdlight/runtime';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';

import { brushKeyHints } from '../../session/edit-keys';
import { TERRAIN_INVERT_LABELS, TERRAIN_MODES, terrainToolUses } from '../../session/terrain-brush';
import { BrushPanel } from '../brush/BrushPanel';
import { useBrush } from '../brush/useBrush';
import { Section, Segmented } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import { ToolGrid } from '../editmode/ToolGrid';
import { LayerPicker } from '../palette/LayerPalette';
import { usePalette } from '../palette/MaterialLayers';
import { useRuleDraft } from '../rules/MaterialRuleCards';
import { ScatterRuleCards } from '../rules/ScatterRuleCards';
import { toolKeysHint } from './BrushModes';
import { heightTrack } from './RulesMode';
import { terrainBrushStore, useTerrainTool, useTerrainToolState, type TerrainColumnProps } from './terrain-column';

const MODE = TERRAIN_MODES.find((m) => m.id === 'scatter')!;

export function ScatterColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  const { draft, setDraft, changed, revert } = useRuleDraft<ScatterRule>(p.component.scatter ?? []);
  const [busy, setBusy] = useState(false);
  const store = terrainBrushStore('scatter');
  const settings = useBrush(store);
  const tile = MODE.tiles.find((t) => t.invert === settings.invert) ?? MODE.tiles[0]!;
  // The brush paints a rule the terrain has stored (ground cover is never stored: no hand edits).
  const stored = (p.component.scatter ?? []).filter((r) => r.cover !== true).map((r) => r.id);
  const rule = stored.includes(state.brush.rule) ? state.brush.rule : (stored[0] ?? '');
  useEffect(() => {
    if (rule !== state.brush.rule) setState({ brush: { ...state.brush, rule } });
  }, [rule, state.brush, setState]);
  useTerrainTool(p, 'scatter');
  const palette = usePalette(p.mapping, p.palette.materials, TERRAIN_DEFAULT_COLOURS, p.palette.heightInAlpha);
  const layerName = (i: number): string => palette.layers.find((l) => l.index === i)?.name ?? `Layer ${i + 1}`;
  const material = palette.source.kind !== 'none' ? palette.source.material.name : undefined;
  const layerField = (value: number, onChange: (layer: number) => void, aria: string): ReactNode => <LayerPicker layers={palette.layers} value={value} onChange={onChange} aria={aria} title="The layer the ground must show" {...(material !== undefined ? { material } : {})} thumbnails={p.palette.thumbnails} disabled={p.locked} />;
  const ready = draft.every((r) => r.asset.assetId !== '');
  const uses = terrainToolUses('scatter');
  const selected = state.scatterRule !== null && state.scatterRule < draft.length ? state.scatterRule : null;
  const bake = async (): Promise<void> => {
    setBusy(true);
    try {
      await p.run('Bake scatter rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', scatter: draft });
    } finally {
      setBusy(false);
    }
  };
  useEditStatus({ tool: tile.label, text: rule === '' ? 'Add a rule and bake it; then drag on the ground to place its copies by hand.' : tile.hint, keys: [...toolKeysHint(MODE.tiles), ...brushKeyHints(uses, TERRAIN_INVERT_LABELS.scatter)] });
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Rules" aside={`${draft.length} rule${draft.length === 1 ? '' : 's'}`}>
        <p className="tl-hint">Models placed where the conditions hold, baked into the tiles; a sculpt or paint bakes them again around itself.</p>
        <div role="group" aria-label="scatter rules">
          <ScatterRuleCards rules={draft} onChange={setDraft} selected={selected} onSelect={(i) => setState({ scatterRule: i })} blocks={false} layerField={layerField} layerName={layerName} height={heightTrack(p)} disabled={p.locked} />
          <div className="tl-inspector__modes">
            <button type="button" className="tl-btn tl-btn--primary" aria-label="bake scatter rules" disabled={!changed || !ready || busy || p.locked} title={ready ? undefined : 'Every rule needs a model'} onClick={() => void bake()}>
              {busy ? 'Baking…' : 'Bake rules'}
            </button>
            <button type="button" className="tl-btn tl-btn--small" aria-label="revert scatter rules" disabled={!changed || busy} onClick={revert}>
              Revert
            </button>
          </div>
        </div>
      </Section>
      <Section title="Scatter by hand">
        <ToolGrid tools={MODE.tiles} active={tile.id} onPick={(id) => store.set({ invert: MODE.tiles.find((t) => t.id === id)!.invert === true })} aria="terrain tool" cols={4} disabled={p.locked} />
        {stored.length === 0 ? (
          <p className="tl-hint">Bake a rule first: the brush places a stored rule's copies.</p>
        ) : (
          <div className="tl-frow tl-frow--stack">
            <span className="tl-frow__label">Rule</span>
            <Segmented small aria="scatter brush rule" value={rule} options={stored.map((id) => ({ id, label: id }))} onChange={(id) => setState({ brush: { ...state.brush, rule: id } })} />
          </div>
        )}
        <BrushPanel settings={settings} store={store} uses={uses} invert={TERRAIN_INVERT_LABELS.scatter!} />
      </Section>
    </div>
  );
}
