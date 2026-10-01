/**
 * Problems panel: asset files missing from the game folder (path, asset, who
 * uses it; paged), asset files the file check could not bring in step (live
 * state, with re-import), then the backend's recent
 * project problems (failed commands, Play and export failures, external
 * edits), newest first.
 */
import type { JSX } from 'react';
import type { ProblemView } from '../session/client';
import type { SourceIssue } from '../session/asset-sources';
import type { AssetFileCheck, MissingFilesView } from './useAssetFileCheck';

/** One graph problem (from the graph kind's rules); a click opens the graph at the node. */
export interface GraphIssueView {
  key: string;
  graphId: string;
  graphName: string;
  nodeId?: string;
  nodeLabel: string | null;
  severity: 'error' | 'warning';
  message: string;
  /** A visual script's compile problem (the click opens its Graph tab at the node; `nodeId` scoped in a function). */
  behaviorId?: string;
  /** A graph material's problem (the click opens its Material tab at the node). */
  materialId?: string;
}

interface Props {
  graphIssues?: readonly GraphIssueView[];
  onGraphIssue?: (issue: GraphIssueView) => void;
  problems: readonly ProblemView[];
  /** Models the scene view could not load (by asset or entity). */
  viewFailures: readonly { id: string; name: string; code: string; message: string }[];
  /** The file check (null: the project has no folder to check). */
  fileCheck: AssetFileCheck | null;
  onReimport: (issue: SourceIssue) => void;
}

/** How one use of a missing file reads. */
function userText(u: MissingFilesView['files'][number]['usedBy'][number]): string {
  return u.kind === 'project' ? `project ${u.id}` : `${u.kind} ${u.id}`;
}

function MissingFiles({ missing }: { missing: MissingFilesView }): JSX.Element {
  return (
    <ul className="tl-problems__list tl-problems__sources" aria-label="Missing files">
      <li className="tl-problem tl-problem--heading">
        {missing.total} asset file{missing.total === 1 ? ' is' : 's are'} missing from the game folder. Put them back, or move each together with its .tlasset file and check files again.
      </li>
      {missing.files.map((f) => (
        <li key={f.assetId} className="tl-problem" data-asset={f.assetId}>
          <span className="tl-problem__source tl-problem__source--asset">missing</span>
          <span className="tl-problem__message" title={`${f.kind} asset ${f.assetId}`}>
            <span className="tl-problem__path">{f.path}</span> ({f.displayName}
            {f.displayName !== f.assetId ? `, ${f.assetId}` : ''}) — {f.usedBy.length > 0 ? `used by ${f.usedBy.map(userText).join(', ')}` : 'nothing uses it'}
          </span>
        </li>
      ))}
      {missing.files.length < missing.total && (
        <li className="tl-problem">
          <button className="tl-btn tl-btn--small" onClick={missing.more}>
            Show more ({missing.total - missing.files.length} more)
          </button>
        </li>
      )}
    </ul>
  );
}

export function ProblemsPanel({ graphIssues = [], onGraphIssue, problems, viewFailures, fileCheck, onReimport }: Props): JSX.Element {
  const newest = [...problems].reverse();
  const issues = fileCheck?.sourceIssues ?? [];
  const missing = fileCheck?.missing ?? null;
  const checking = fileCheck?.checking ?? false;
  return (
    <div className="tl-panel tl-problems">
      <div className="tl-panel__title">
        Problems
        {fileCheck !== null && fileCheck.sourceIssues !== null && (
          <button className="tl-btn tl-btn--small" disabled={checking} onClick={() => void fileCheck.checkFiles()} title="Check the asset files in the game folder: a file moved with its .tlasset file keeps its asset, a changed file is imported again">
            {checking ? 'checking…' : 'check files'}
          </button>
        )}
      </div>
      {missing !== null && missing.total > 0 && <MissingFiles missing={missing} />}
      {issues.length > 0 && (
        <ul className="tl-problems__list tl-problems__sources" aria-label="Asset files">
          {issues.map((i) => (
            <li key={i.key} className="tl-problem">
              <span className={`tl-problem__source tl-problem__source--asset`}>{i.kind === 'old-versions' ? 'history' : 'asset'}</span>
              <span className="tl-problem__message" title={i.sourcePath}>
                {i.message}
              </span>
              {i.canReimport && (
                <button className="tl-btn tl-btn--small" onClick={() => onReimport(i)} title={`Import ${i.sourcePath} again (undoable)`}>
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
      {graphIssues.length > 0 && (
        <ul className="tl-problems__list" aria-label="Graphs">
          {graphIssues.map((g) => (
            <li key={g.key} className="tl-problem">
              <span className={`tl-problem__source tl-problem__source--${g.severity === 'error' ? 'command' : 'workspace'}`}>{g.behaviorId !== undefined ? (g.severity === 'error' ? 'script error' : 'script warning') : g.materialId !== undefined ? (g.severity === 'error' ? 'material error' : 'material warning') : g.severity === 'error' ? 'graph error' : 'graph warning'}</span>
              <button className="tl-problem__message tl-problem__link" title="Open the graph at this node" data-behavior={g.behaviorId} data-material={g.materialId} onClick={() => onGraphIssue?.(g)}>
                {g.graphName}
                {g.nodeLabel !== null ? ` › ${g.nodeLabel} (${g.nodeId ?? ''})` : ''}: {g.message}
              </button>
            </li>
          ))}
        </ul>
      )}
      {newest.length === 0 && issues.length === 0 && (missing?.total ?? 0) === 0 && viewFailures.length === 0 && graphIssues.length === 0 ? (
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
