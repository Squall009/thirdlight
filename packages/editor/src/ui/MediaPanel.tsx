/**
 * The Media tab: asset-level sound work — listen to the project's sounds.
 *
 * Phase 15.1: the object and game settings that lived here moved to where
 * the data is edited: a surface (with its presets), lights and the old
 * model-animation roles are Inspector sections built from their descriptors
 * (phase 24.4i: sounds for events are the event sounds table below). What stays is per asset: the preview of an audio asset.
 *
 * The PREVIEW plays committed bytes through the injected preview-audio owner
 * (explicit local gesture; the authoring token stays the session credential of
 * the content read, never a resource).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, EventCue, ObjectFieldDescriptor } from '@thirdlight/project-model';
import { EVENT_CUE_LIMITS } from '@thirdlight/project-model/limits';
import type { AssetView } from '../session/content-projection';
import type { PreviewAudioStatus, PreviewAudioDiagnostic } from '../session/preview-audio';
import { componentPatch } from '../session/descriptor-fields';
import { ObjectFields, type FieldContext } from './DescriptorFields';

interface Props {
  assets: readonly AssetView[];
  previewStatus: PreviewAudioStatus;
  previewDiagnostics: readonly PreviewAudioDiagnostic[];
  onUnlockPreview: () => void;
  onPreviewCue: (assetId: string) => void;
  /** Phase 24.4i: the event → cue table (edited with the `eventCues` content descriptor's item). */
  registry?: DescriptorRegistry | null;
  eventCues?: readonly EventCue[];
  fieldContext?: FieldContext;
  eventCuesError?: string | null;
  /** `base`: the table the edit was made on (phase 24.7: re-applied row by row onto the table as it is at send time). */
  onSetEventCues?: (next: EventCue[], base: EventCue[]) => void;
}

const MAX_EVENT_CUES = EVENT_CUE_LIMITS.cues;

function cueItemDesc(registry: DescriptorRegistry | null | undefined): ObjectFieldDescriptor | null {
  const d = registry?.content.find((b) => b.key === 'eventCues')?.value;
  if (d === undefined || d.type !== 'list' || d.item.type !== 'object') return null;
  return d.item;
}

/**
 * Phase 24.4i: the event → cue table — which sound plays when a signal is
 * sent or an event happens. A new row is made from its three essentials (a
 * signal or an event, its name, the sound); each row is then edited with the
 * generic descriptor form. Every edit is one `setEventCues` command (the
 * whole table), issued by the app — one undo step.
 */
function EventSounds(p: Props): JSX.Element | null {
  const [on, setOn] = useState<'signal' | 'event'>('signal');
  const [name, setName] = useState('');
  const [sound, setSound] = useState('');
  const [error, setError] = useState<string | null>(null);
  const desc = cueItemDesc(p.registry);
  const cues = p.eventCues ?? [];
  if (p.onSetEventCues === undefined || p.fieldContext === undefined || desc === null) return null;
  const setCues = p.onSetEventCues;
  const set = (next: EventCue[]): void => setCues(next, [...cues]);
  const ctx = p.fieldContext;
  const sounds = p.assets.filter((a) => a.kind === 'audio');
  const pick = sound !== '' ? sound : (sounds[0]?.assetId ?? '');
  const canAdd = name.trim() !== '' && pick !== '' && cues.length < MAX_EVENT_CUES;
  const add = (): void => {
    if (!canAdd) return;
    set([...cues, { on, name: name.trim(), assetId: pick }]);
    setName('');
  };
  return (
    <section className="tl-media__events" aria-label="event sounds">
      <div className="tl-panel__title">Event sounds — {cues.length} / {MAX_EVENT_CUES}</div>
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
        <select aria-label="new event sound asset" value={pick} onChange={(e) => setSound(e.target.value)}>
          {sounds.map((a) => (
            <option key={a.assetId} value={a.assetId}>
              {a.displayName}
            </option>
          ))}
        </select>
        <button className="tl-btn" onClick={add} disabled={!canAdd}>
          add event sound
        </button>
      </div>
      {(error ?? p.eventCuesError ?? null) !== null && <div className="tl-prop__error" role="alert">{error ?? p.eventCuesError}</div>}
    </section>
  );
}

export function MediaPanel(props: Props): JSX.Element {
  const sounds = props.assets.filter((a) => a.kind === 'audio');
  const status = props.previewStatus;
  return (
    <div className="tl-panel tl-media" aria-label="media">
      <div className="tl-panel__title">Media</div>
      <p className="tl-note">
        Listen to the project's sounds. Where they are used is set in the Inspector (an audio source, a component's sound field) and in the event sounds below (a sound for a signal or an event).
      </p>
      {sounds.length === 0 ? (
        <p className="tl-note">No sounds yet: import a WAV in the Assets tab.</p>
      ) : (
        <div className="tl-media__cues">
          {sounds.map((a) => (
            <div className="tl-media__cue-row" key={a.assetId}>
              <span className="tl-media__cue-label">{a.displayName}</span>
              <span className="tl-inspector__hint">v{a.currentVersion}</span>
              <button className="tl-btn tl-btn--small" aria-label={`preview ${a.displayName}`} onClick={() => props.onPreviewCue(a.assetId)} title="Play the sound (enable preview sound first)">
                ▶
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="tl-note">
        Preview: <code>{status.state}{status.state === 'ready' ? (status.muted ? ' (muted)' : '') : ''}</code>. Sound starts only after the button below (no autoplay).
      </p>
      {status.state === 'blocked' && (
        <button className="tl-btn" onClick={props.onUnlockPreview}>
          enable preview sound
        </button>
      )}
      <EventSounds {...props} />
      {props.previewDiagnostics.length > 0 && (
        <div className="tl-media__diag">
          {props.previewDiagnostics.slice(-4).map((d, i) => (
            <div key={i} className="tl-media__diag-line">
              <code>{d.code}</code> {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
