/**
 * Problems panel: the backend's recent project problems (failed commands,
 * Play and export failures, external edits), newest first.
 */
import type { JSX } from 'react';
import type { ProblemView } from '../session/client';

export function ProblemsPanel({ problems }: { problems: readonly ProblemView[] }): JSX.Element {
  const newest = [...problems].reverse();
  return (
    <div className="tl-panel tl-problems">
      <div className="tl-panel__title">Problems</div>
      {newest.length === 0 ? (
        <div className="tl-inspector__empty">No problems reported.</div>
      ) : (
        <ul className="tl-problems__list">
          {newest.map((p) => (
            <li key={p.seq} className="tl-problem">
              <span className={`tl-problem__source tl-problem__source--${p.source}`}>{p.source}</span>
              <span className="tl-problem__message" title={`${p.code} · ${p.at}`}>
                {p.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
