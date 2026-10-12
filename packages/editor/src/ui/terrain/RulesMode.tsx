/**
 * The terrain editor's Material rules mode: the rules as cards (each layer
 * picked from the palette by its picture), a live preview of the bake on the
 * terrain while the draft is edited, the open card's rule alone on request
 * (where it applies), and Bake — the draft stored and baked into every tile
 * in one command (`editTerrain` bake; hand paint stays over the rules) — or
 * Revert to what is stored.
 *
 * The preview is drawn by the Scene view from the draft (`previewRules`);
 * leaving the mode, or a bake landing, gives the stored layers back.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { SurfaceRule } from '@thirdlight/runtime';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';

import { Section, Toggle } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import { LayerPicker } from '../palette/LayerPalette';
import { usePalette } from '../palette/MaterialLayers';
import { MaterialRuleCards, useRuleDraft } from '../rules/MaterialRuleCards';
import { useTerrainTool, useTerrainToolState, type TerrainColumnProps } from './terrain-column';

/** Milliseconds the draft rests before the preview is drawn again (a drag of a slider draws once it settles). */
const PREVIEW_SETTLE_MS = 180;

/** The terrain's height range in world metres (the height sliders' track). */
export const heightTrack = (p: TerrainColumnProps): [number, number] => [p.origin[1] + p.component.heightRange[0], p.origin[1] + p.component.heightRange[1]];

export function RulesColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  const { draft, setDraft, changed, revert } = useRuleDraft<SurfaceRule>(p.component.rules ?? []);
  const [busy, setBusy] = useState(false);
  const [covered, setCovered] = useState<{ covered: number; total: number } | null>(null);
  useTerrainTool(p, null);
  const palette = usePalette(p.mapping, p.palette.materials, TERRAIN_DEFAULT_COLOURS);
  const layerName = (i: number): string => palette.layers.find((l) => l.index === i)?.name ?? `Layer ${i + 1}`;
  const material = palette.source.kind !== 'none' ? palette.source.material.name : undefined;
  const layerField = (value: number, onChange: (layer: number) => void, aria: string): ReactNode => <LayerPicker layers={palette.layers} value={value} onChange={onChange} aria={aria} title="Layer for this rule" {...(material !== undefined ? { material } : {})} thumbnails={p.palette.thumbnails} disabled={p.locked} />;
  const selected = state.rule !== null && state.rule < draft.length ? state.rule : null;

  // The live preview: the draft (or the open card's rule alone) drawn on the terrain once it rests.
  const editor = p.editor;
  // (A draft as stored draws as the stored layers do: no preview then.)
  const shown = !state.livePreview ? null : state.solo && selected !== null ? [draft[selected]!] : changed ? draft : null;
  const key = JSON.stringify(shown) + p.component.tiles.map((t) => t.data ?? '').join(',');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = editor?.previewRules(shown) ?? null;
      setCovered(r === null ? null : { covered: r.covered, total: r.total });
    }, PREVIEW_SETTLE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the rules shown and the tiles they lie on
  }, [editor, key]);
  useEffect(() => () => void editor?.previewRules(null), [editor]);

  const bake = async (): Promise<void> => {
    setBusy(true);
    try {
      await p.run('Bake material rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', rules: draft });
    } finally {
      setBusy(false);
    }
  };
  useEditStatus({ tool: 'Material rules', text: selected !== null ? `Shown: where "${draft[selected]?.name ?? `rule ${selected + 1}`}" paints${state.solo ? ' (alone)' : ''}. Bake when it looks right.` : 'Pick a rule to edit it; drag ⋮⋮ to reorder. Bake when the preview looks right.', right: `${draft.length} rule${draft.length === 1 ? '' : 's'}${changed ? ' · not baked' : ''}` });
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Rules" aside={`${draft.length} rule${draft.length === 1 ? '' : 's'}`}>
        <p className="tl-hint">Rules apply top to bottom; a later rule paints over the ones above it. Where none applies, the first layer. Hand painting stays on top.</p>
        <div role="group" aria-label="material rules">
          <MaterialRuleCards rules={draft} onChange={setDraft} selected={selected} onSelect={(i) => setState({ rule: i })} blocks={false} layerField={layerField} layerName={layerName} height={heightTrack(p)} disabled={p.locked} />
        </div>
      </Section>
      <Section title="Preview">
        <Toggle label="Live preview of the bake" aria="live preview" hint="Draw the rules on the terrain as they would bake, while you edit them." on={state.livePreview} onChange={(on) => setState({ livePreview: on })} />
        <Toggle label="Only the open rule" aria="open rule alone" hint="Draw the open card's rule alone, over the first layer: where it applies." disabled={!state.livePreview || selected === null} on={state.solo} onChange={(on) => setState({ solo: on })} />
        {covered !== null && covered.covered < covered.total && <p className="tl-hint">Previewed on the {covered.covered} tiles nearest the view (of {covered.total}); the bake does every tile.</p>}
        <div className="tl-inspector__modes">
          <button type="button" className="tl-btn tl-btn--primary" aria-label="bake rules" disabled={busy || p.locked || !changed} onClick={() => void bake()}>
            {busy ? 'Baking…' : 'Bake rules'}
          </button>
          <button type="button" className="tl-btn tl-btn--small" aria-label="revert rules" disabled={!changed || busy} onClick={revert}>
            Revert to last bake
          </button>
        </div>
      </Section>
    </div>
  );
}
