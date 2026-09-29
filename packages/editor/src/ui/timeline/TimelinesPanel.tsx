/**
 * The Timelines list (bottom dock) — the project's timelines;
 * create (a name → an id), delete and open (the "Timeline: <name>" centre
 * tab). Each action is one command (setTimeline, deleteTimeline).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { TimelineAsset } from '@thirdlight/project-model';

interface Props {
  timelines: readonly TimelineAsset[];
  openId: string | null;
  error: string | null;
  onOpen: (timelineId: string) => void;
  onCreate: (name: string) => void;
  onDelete: (timelineId: string) => void;
}

export function TimelinesPanel({ timelines, openId, error, onOpen, onCreate, onDelete }: Props): JSX.Element {
  const [name, setName] = useState('');
  return (
    <div className="tl-panel tl-timelines">
      <div className="tl-panel__title">Timelines</div>
      <form
        className="tl-graphs__new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() === '') return;
          onCreate(name.trim());
          setName('');
        }}
      >
        <input className="tl-input" aria-label="New timeline name" placeholder="New timeline name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === ''}>
          Create timeline
        </button>
      </form>
      <p className="tl-hint">A timeline sequences camera cuts, moves, animation, sound, dialogue, effects, signals and fades on a time ruler. Its tracks name slots, bound to objects when it plays (ctx.timeline.play), so one timeline serves any actors.</p>
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
      {timelines.length === 0 ? (
        <div className="tl-inspector__empty">No timelines yet.</div>
      ) : (
        <ul className="tl-effects__list" aria-label="Timeline list">
          {timelines.map((t) => (
            <li key={t.timelineId} className={`tl-effects__row${openId === t.timelineId ? ' is-active' : ''}`} data-timeline-id={t.timelineId} onDoubleClick={() => onOpen(t.timelineId)}>
              <span className="tl-effects__name">{t.name}</span>
              <span className="tl-effects__meta">
                {t.tracks.length} track{t.tracks.length === 1 ? '' : 's'} · {t.duration} s
              </span>
              <button className="tl-btn tl-btn--small" onClick={() => onOpen(t.timelineId)} aria-label={`Open ${t.name}`}>
                Open
              </button>
              <button className="tl-btn tl-btn--small" onClick={() => onDelete(t.timelineId)} aria-label={`Delete ${t.name}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
