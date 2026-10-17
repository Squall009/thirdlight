/**
 * "Swap the style, keep the plan": every room, run and building of a rooms
 * object wearing one preset takes another (inside, outside and facade
 * alike), the outlines, openings and pieces untouched — one component edit,
 * so one undo step. Shown in the block editor's Rooms & buildings and in the
 * Inspector of a rooms object drawn on no layer.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { ArchitectureComponent } from '@thirdlight/project-model';

import { presetUses, withPresetSwapped } from '../../session/room-draw';
import { Pick } from '../blocks/RoomFields';
import type { PickOption } from './preset-choices';

export interface PresetSwapProps {
  component: ArchitectureComponent | null;
  /** Every preset a room may wear: [id, name]. */
  presets: readonly PickOption[];
  disabled?: boolean;
  onSwap(next: ArchitectureComponent, what: string): void;
}

export function PresetSwap(p: PresetSwapProps): JSX.Element | null {
  const uses = presetUses(p.component);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (p.component === null || uses.length === 0) return null;
  const name = (id: string): string => p.presets.find(([v]) => v === id)?.[1] ?? id;
  const picked = uses.find((u) => u.preset === from) ?? uses[0]!;
  const count = `${picked.outlines} ${picked.outlines === 1 ? 'outline' : 'outlines'}`;
  return (
    <div className="tl-arch-restyle" aria-label="swap presets">
      <Pick label="rooms wearing" value={picked.preset} options={uses.map((u) => [u.preset, `${name(u.preset)} (${u.outlines})`] as const)} onCommit={setFrom} />
      <Pick label="wear instead" value={to} options={[['', '— a preset —'], ...p.presets.filter(([id]) => id !== picked.preset)]} onCommit={setTo} />
      <button
        type="button"
        className="tl-btn tl-btn--small"
        disabled={p.disabled === true || to === '' || to === picked.preset}
        title="Every room, path and building wearing the first preset wears the second; the outlines, openings and pieces stay"
        onClick={() => {
          p.onSwap(withPresetSwapped(p.component!, picked.preset, to), `Swap preset ${name(picked.preset)} → ${name(to)}`);
          setTo('');
        }}
      >
        Swap on {count}
      </button>
      <p className="tl-hint">Swap the style, keep the plan: change the trim sheet or the look of every room at once (one undo).</p>
    </div>
  );
}
