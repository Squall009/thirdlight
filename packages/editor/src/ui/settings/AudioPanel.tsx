/**
 * Project Settings → Audio: the event → sound table — which sound plays when
 * a signal is sent or an event happens (Unity keeps its project-wide audio
 * under Project Settings → Audio too). Listening to a sound is in the audio
 * asset's Inspector.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, EventCue, ObjectFieldDescriptor } from '@thirdlight/project-model';
import { componentPatch } from '../../session/descriptor-fields';
import { ObjectFields, type FieldContext } from '../DescriptorFields';
import { AUDIO_KINDS, RefPicker, useFirstEntry } from '../catalog/RefPicker';

interface Props {
  /** The event → cue table (edited with the `eventCues` content descriptor's item). */
  registry: DescriptorRegistry | null;
  eventCues: readonly EventCue[];
  fieldContext: FieldContext;
  eventCuesError: string | null;
  /** `base`: the table the edit was made on (re-applied row by row onto the table as it is at send time). */
  onSetEventCues: (next: EventCue[], base: EventCue[]) => void;
}

function cueItemDesc(registry: DescriptorRegistry | null | undefined): ObjectFieldDescriptor | null {
  const d = registry?.content.find((b) => b.key === 'eventCues')?.value;
  if (d === undefined || d.type !== 'list' || d.item.type !== 'object') return null;
  return d.item;
}

/**
 * The event → cue table — which sound plays when a signal is
 * sent or an event happens. A new row is made from its three essentials (a
 * signal or an event, its name, the sound); each row is then edited with the
 * generic descriptor form. Every edit is one `setEventCues` command (the
 * whole table), issued by the app — one undo step.
 */
export function AudioPanel(p: Props): JSX.Element | null {
  const [on, setOn] = useState<'signal' | 'event'>('signal');
  const [name, setName] = useState('');
  const [sound, setSound] = useState('');
  const [error, setError] = useState<string | null>(null);
  const desc = cueItemDesc(p.registry);
  const cues = p.eventCues;
  const first = useFirstEntry(AUDIO_KINDS).first;
  if (desc === null) return null;
  const setCues = p.onSetEventCues;
  const set = (next: EventCue[]): void => setCues(next, [...cues]);
  const ctx = p.fieldContext;
  const pick = sound !== '' ? sound : (first ?? '');
  const canAdd = name.trim() !== '' && pick !== '';
  const add = (): void => {
    if (!canAdd) return;
    set([...cues, { on, name: name.trim(), assetId: pick }]);
    setName('');
  };
  return (
    <section className="tl-media__events" aria-label="event sounds">
      <div className="tl-panel__title">Event sounds — {cues.length}</div>
      <p className="tl-note">A sound played when a signal is sent (by its name) or an event happens (a trigger&apos;s enter or exit, collected, damaged, died, contact…; optionally only one object&apos;s).</p>
      {cues.map((c, i) => (
        <div className="tl-media__event" key={i} data-event-cue={i} aria-label={`event sound ${i + 1}`}>
          <ObjectFields
            desc={desc}
            value={c as unknown as Record<string, unknown>}
            path={[]}
            component="eventCue"
            ctx={ctx}
            onFail={setError}
            onEdit={(path, next) => {
              setError(null);
              const patch = componentPatch(desc, c as unknown as Record<string, unknown>, path, next);
              if (patch === null) return;
              const out: Record<string, unknown> = { ...(c as unknown as Record<string, unknown>) };
              for (const [k, v] of Object.entries(patch)) {
                if (v === null) delete out[k];
                else out[k] = v;
              }
              set(cues.map((x, j) => (j === i ? (out as unknown as EventCue) : x)));
            }}
          />
          <button className="tl-btn tl-btn--small" aria-label={`remove event sound ${i + 1}`} onClick={() => set(cues.filter((_, j) => j !== i))}>
            remove
          </button>
        </div>
      ))}
      <div className="tl-tags__add">
        <select aria-label="new event sound source" value={on} onChange={(e) => setOn(e.target.value === 'event' ? 'event' : 'signal')}>
          <option value="signal">signal</option>
          <option value="event">event</option>
        </select>
        <input
          aria-label="new event sound name"
          placeholder={on === 'signal' ? 'signal name…' : 'event (enter, collected…)'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <RefPicker aria="new event sound asset" kinds={AUDIO_KINDS} value={pick} onPick={(id) => id !== '' && setSound(id)} />
        <button className="tl-btn" onClick={add} disabled={!canAdd}>
          add event sound
        </button>
      </div>
      {(error ?? p.eventCuesError ?? null) !== null && <div className="tl-prop__error" role="alert">{error ?? p.eventCuesError}</div>}
    </section>
  );
}
