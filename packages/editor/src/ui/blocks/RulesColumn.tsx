/**
 * The block editor's Rules mode: the material rules that paint the layer's
 * layers 1–4 by slope, height, cavity, noise and block type when chunks are
 * meshed (one `setComponent`), the scatter rules that place models on the
 * tops (the rules, then every chunk baked with them: one undo step), and
 * the scatter brush that puts a rule's copies where it is dragged (one
 * `editBlocks` a stroke). The rule cards are the terrain editor's.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import { SURFACE_RULE_BLOCK_LAYERS } from '@thirdlight/runtime';

import { blockModeOf, blockToolUses, BLOCK_INVERT_LABELS } from '../../session/block-mode';
import { brushKeyHints } from '../../session/edit-keys';
import { BrushPanel } from '../brush/BrushPanel';
import { useBrush } from '../brush/useBrush';
import { Section, Segmented } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { MaterialRulesEditor } from '../rules/MaterialRuleCards';
import { ScatterRulesEditor } from '../rules/ScatterRuleCards';
import { blockCommand, useBlockSetup, useBlockTool } from './block-column';
import { LayerSection } from './BuildColumn';

/** The heights a block layer's cells span (metres above its object): the rules' height sliders' track. */
const blockHeights = (c: { bounds: { min: readonly number[]; max: readonly number[] }; cellSize: readonly number[] }): [number, number] => [c.bounds.min[1]! * c.cellSize[1]!, Math.max(c.bounds.min[1]! * c.cellSize[1]! + 1, c.bounds.max[1]! * c.cellSize[1]!)];

export function RulesColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const c = s.component;
  const store = useBlockTool(s, 'scatter')!;
  const settings = useBrush(store);
  const uses = blockToolUses('scatter');
  const rules = (c.scatter ?? []).filter((r) => r.cover !== true);
  const rule = s.state.brush.scatterRule;
  useEditStatus({
    tool: 'Scatter',
    text: s.locked ? `${entity.name} is locked: unlock it to edit its rules.` : rule === '' ? 'Edit the rules below; pick a scatter rule to brush its copies on by hand.' : `Drag on the tops to put ${rule}'s copies there (Ctrl held: take them off).`,
    keys: brushKeyHints(uses, BLOCK_INVERT_LABELS.scatter),
    right: s.state.hover,
  });
  return (
    <div className="tl-bcol" aria-label="block rules">
      <Section title="Material rules" aside={<span className="tl-sec__note">{c.rules?.length ?? 0}</span>}>
        <p className="tl-hint">Layers 1–4 painted by slope, height, cavity, noise and block type when the chunks are made; hand paint stays over them.</p>
        <MaterialRulesEditor rules={c.rules ?? []} blocks={true} height={blockHeights(c)} disabled={s.locked} onApply={(next) => s.blocks.changeLayer(next.length > 0 ? 'Set material rules' : 'Remove material rules', entity.id, (now) => ({ ...now, rules: next }))} />
      </Section>
      <Section title="Scatter rules" aside={<span className="tl-sec__note">{c.scatter?.length ?? 0}</span>}>
        <ScatterRulesEditor
          rules={c.scatter ?? []}
          blocks={true}
          height={blockHeights(c)}
          layerField={(value, onChange, aria) => <Segmented small aria={aria} value={value} options={Array.from({ length: SURFACE_RULE_BLOCK_LAYERS }, (_x, k) => ({ id: k, label: String(k + 1), hint: `Layer ${k + 1}` }))} onChange={onChange} />}
          disabled={s.locked}
          onApply={(scatter) =>
            // The rules on the component, then every chunk baked with them: one undo step.
            s.blocks.grouped(async () => {
              const stored = await s.blocks.changeLayer(scatter.length > 0 ? 'Set scatter rules' : 'Remove scatter rules', entity.id, (now) => {
                const { scatter: _old, ...rest } = now;
                return scatter.length > 0 ? { ...rest, scatter } : rest;
              });
              if (!stored) return false;
              return blockCommand(s, 'Bake scatter', 'editBlocks', { entityId: entity.id, edits: [{ kind: 'bakeScatter' }] });
            })
          }
        />
      </Section>
      <Section title="Scatter brush">
        <ToolGrid tools={blockModeOf('rules').tiles} active="scatter" onPick={() => undefined} aria="rules tool" cols={4} disabled={s.locked} />
        <div className="tl-frow">
          <span className="tl-frow__label">Rule</span>
          <select className="tl-input" aria-label="scatter brush rule" value={rule} onChange={(e) => s.set((st) => ({ brush: { ...st.brush, scatterRule: e.target.value } }))}>
            <option value="">(pick a rule)</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </div>
        <BrushPanel settings={settings} store={store} uses={uses} invert={BLOCK_INVERT_LABELS.scatter ?? 'Take off'} />
      </Section>
      <LayerSection s={s} />
    </div>
  );
}
