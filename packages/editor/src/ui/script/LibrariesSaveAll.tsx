/**
 * "Save all" for the shared script libraries, above each library's editor:
 * the libraries with unsaved edits, and one button that commits them all at
 * once (staged in several patches, one commit: one revision, one undo, each
 * importing script compiled once), with the trust acknowledgment when the
 * build asks for it.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE } from '../../session/behavior-publication';
import type { LibrarySaveOutcome } from './LibraryDocument';

export interface LibrariesSaveAllProps {
  /** The libraries with unsaved edits in their editors. */
  dirty: readonly string[];
  /** The last "Save all" outcome. */
  outcome: LibrarySaveOutcome | { kind: 'working' } | null;
  onSaveAll: (acknowledge: boolean) => void;
}

export function LibrariesSaveAll({ dirty, outcome, onSaveAll }: LibrariesSaveAllProps): JSX.Element {
  return (
    <div className="tl-libraries-save-all">
      <div className="tl-script__row" aria-label="unsaved libraries">
        <span className="tl-prop__caption">{dirty.length === 0 ? 'No unsaved library edits.' : `Unsaved edits: ${dirty.map((id) => `@lib/${id}`).join(', ')}`}</span>
        <button className="tl-btn tl-btn--small tl-btn--primary" disabled={dirty.length === 0 || outcome?.kind === 'working'} onClick={() => onSaveAll(false)} title="Save every library with unsaved edits in one commit (one undo step); each script that imports them is recompiled once">
          Save all
        </button>
      </div>
      {outcome?.kind === 'needs-ack' && (
        <div className="tl-script__trust" role="group" aria-label="save all trust acknowledgment">
          {BEHAVIOR_TRUST_NOTICE.map((line) => (
            <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
              {line}
            </p>
          ))}
          <div className="tl-prop__caption" title={outcome.digest}>
            library digest {outcome.digest.slice(0, 16)}…
          </div>
          <button className="tl-btn tl-btn--small" onClick={() => onSaveAll(true)}>
            {BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL} and save all
          </button>
        </div>
      )}
      {outcome?.kind === 'saved' && (
        <p className="tl-hint" aria-label="save all result">
          Saved (r{outcome.revision}) in {outcome.patches ?? 1} patch{outcome.patches === 1 ? '' : 'es'}, one commit.{outcome.recompiled.length > 0 ? ` Recompiled ${outcome.recompiled.join(', ')} (each once).` : ''}
        </p>
      )}
      {outcome?.kind === 'failed' && (
        <p className="tl-error" role="alert" aria-label="save all result">
          {outcome.message}
        </p>
      )}
    </div>
  );
}
