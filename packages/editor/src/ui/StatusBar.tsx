/**
 * Status bar (React, decision 0001 §10) — connection status, save status,
 * revision, and the structured error / revision_conflict explanation
 * (conflict/reconnect handling must EXPLAIN failed edits, never silently
 * lose them — sessions.md §9).
 */
import type { JSX } from 'react';
import type { RendererInfo } from '@thirdlight/three-adapter';
import type { ClientUiState } from '../session/client';

interface Props {
  state: ClientUiState;
  onResync: () => void;
  /** Phase 17.1: the Scene view's renderer (backend, state, why). */
  renderer?: RendererInfo | null;
}

function Badge({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'err' | 'idle' }): JSX.Element {
  return <span className={`tl-badge tl-badge--${tone}`}>{label}</span>;
}

export function StatusBar({ state, onResync, renderer }: Props): JSX.Element {
  const connTone = state.connection === 'connected' ? 'ok' : state.connection === 'disconnected' ? 'err' : 'warn';
  const saveTone = state.save === 'saved' || state.save === 'idle' ? 'ok' : state.save === 'pending' ? 'warn' : 'err';
  return (
    <div className="tl-statusbar">
      <Badge label={`conn: ${state.connection}`} tone={connTone} />
      <Badge label={`save: ${state.save}`} tone={saveTone} />
      <span className="tl-statusbar__rev">revision {state.revision}</span>
      {renderer !== undefined && renderer !== null && (
        <span className="tl-statusbar__renderer" title={renderer.reason} data-render-backend={renderer.backend ?? 'pending'} data-render-state={renderer.state}>
          scene view: {renderer.backend ?? 'choosing'}{renderer.state !== 'ready' ? ` (${renderer.state})` : ''}
        </span>
      )}
      {state.error && (
        <span className="tl-statusbar__error" title={state.error.message}>
          error {state.error.code}
        </span>
      )}
      {state.conflict && (
        <span className="tl-statusbar__conflict" title={state.conflict.message}>
          conflict — the scene moved to revision {state.conflict.currentRevision}
        </span>
      )}
      <span className="tl-statusbar__spacer" />
      {state.conflict && (
        <button className="tl-btn tl-btn--small" onClick={onResync} title="Re-read the current scene from the backend">
          re-sync scene
        </button>
      )}
    </div>
  );
}