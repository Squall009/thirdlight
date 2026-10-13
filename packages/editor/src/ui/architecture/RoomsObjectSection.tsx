/**
 * The Inspector's rooms section for a generated-architecture object drawn on
 * no block layer (made over MCP, or before rooms were drawn on layers): what
 * each room, run and building wears (inside, outside or facade preset), the
 * presets swapped across all of them (`PresetSwap`), and the sliders of the
 * presets in use with Derive. Shapes are not drawn here: the Rooms tool
 * draws on a block layer's slice, so new rooms are drawn in a layer's block
 * editor (Rooms & buildings), where an object naming the layer opens.
 *
 * Every change is one command on the object (Derive: two, one undo step).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ArchitectureComponent, ArchitectureOutline } from '@thirdlight/project-model';

import { allOutlines, isBuilding, presetUses, withOutlineSet } from '../../session/room-draw';
import { Pick } from '../blocks/RoomFields';
import { presetChoices, PresetSliders, type PresetSlidersHost } from './PresetSliders';
import { PresetSwap } from './PresetSwap';

export interface RoomsObjectSectionProps {
  component: ArchitectureComponent;
  host: PresetSlidersHost;
  /** The trim material the object wears for presets naming none. */
  objectSheet: string | null;
  onChange(next: ArchitectureComponent, what: string): void;
  /** A project preset made from a starter, worn by the object's rooms of it (one undo step). */
  onDerive(base: string): void;
}

export function RoomsObjectSection(p: RoomsObjectSectionProps): JSX.Element | null {
  const outlines = allOutlines(p.component);
  if (outlines.length === 0) return null;
  const choices = presetChoices(p.host.graphs);
  const set = (o: ArchitectureOutline, next: ArchitectureOutline, what: string): void => p.onChange(withOutlineSet(p.component, o.id, next), what);
  return (
    <div className="tl-arch-outlines" aria-label="architecture rooms">
      <div className="tl-inspector__subtitle">Rooms and presets</div>
      {outlines.map((o) => {
        const closed = o.path.closed === true;
        const building = isBuilding(p.component, o.id);
        return (
          <div key={o.id} className="tl-arch-outline" aria-label={`${building ? 'building' : closed ? 'room' : 'path'} ${o.id}`}>
            <Pick label={`${o.id}${closed ? '' : ' (path)'}`} value={o.preset} options={choices} onCommit={(v) => set(o, { ...o, preset: v }, 'Room preset')} />
            {closed && (
              <Pick
                label={building ? 'facade' : 'outside'}
                value={o.outside ?? ''}
                options={[['', '— the inside’s —'], ...choices]}
                onCommit={(v) => {
                  const { outside: _o, ...rest } = o;
                  set(o, v === '' ? rest : { ...rest, outside: v }, 'Room outside');
                }}
              />
            )}
          </div>
        );
      })}
      <PresetSwap component={p.component} presets={choices} onSwap={p.onChange} />
      {presetUses(p.component).map((u) => (
        <PresetSliders key={u.preset} presetId={u.preset} {...p.host} objectSheet={p.objectSheet} onDerive={p.onDerive} />
      ))}
      <p className="tl-hint">This object is drawn on no block layer. Rooms are drawn and reshaped on a block layer's slice: open a layer's block editor → Rooms & buildings.</p>
    </div>
  );
}
