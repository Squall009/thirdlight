/**
 * Problems panel: files referenced in place in the game folder that changed or
 * went missing (live state, with re-import), then the backend's recent project
 * problems (failed commands, Play and export failures, external edits), newest
 * first.
 */
import type { JSX } from 'react';
import type { ProblemView } from '../session/client';
import type { SourceIssue } from '../session/asset-sources';

interface Props {
  problems: readonly ProblemView[];
  /** Models the scene view could not load (by asset or entity). */
  viewFailures: readonly { id: string; name: string; code: string; message: string }[];
  /** null for a project in the data root (no game folder to check). */
  sourceIssues: readonly SourceIssue[] | null;
  checking: boolean;
  onCheckFiles: () => void;
  onReimport: (issue: SourceIssue) => void;
}

export function ProblemsPanel({ problems, viewFailures, sourceIssues, checking, onCheckFiles, onReimport }: Props): JSX.Element {
  const newest = [...problems].reverse();
  const issues = sourceIssues ?? [];
  return (
    <div className="tl-panel tl-problems">
      <div className="tl-panel__title">
        Problems
        {sourceIssues !== null && (
          <button className="tl-btn tl-btn--small" disabled={checking} onClick={onCheckFiles} title="Compare the asset files in the game folder with the imported versions">
            {checking ? 'checking…' : 'check files'}
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="tl-problems__list tl-problems__sources" aria-label="Asset files">
          {issues.map((i) => (
            <li key={i.key} className="tl-problem">
              <span className={`tl-problem__source tl-problem__source--asset`}>{i.kind === 'old-versions' ? 'history' : 'asset'}</span>
              <span className="tl-problem__message" title={i.sourcePath}>
                {i.message}
              </span>
              {i.canReimport && (
                <button className="tl-btn tl-btn--small" onClick={() => onReimport(i)} title={`Record ${i.sourcePath} as a new version (undoable)`}>
                  Re-import
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {viewFailures.length > 0 && (
        <ul className="tl-problems__list" aria-label="Scene view">
          {viewFailures.map((f) => (
            <li key={f.id} className="tl-problem">
              <span className="tl-problem__source tl-problem__source--play">view</span>
              <span className="tl-problem__message" title={f.code}>
                {f.name} cannot be shown in the scene view: {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {newest.length === 0 && issues.length === 0 && viewFailures.length === 0 ? (
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
