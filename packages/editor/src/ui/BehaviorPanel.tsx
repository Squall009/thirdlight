/**
 * Behavior publication panel (React; packet 34; runtime.md §14.2,
 * project-model §22, commands.md §3.1.4/§3.1.8/§8.8).
 *
 * The editor's trusted-behavior workflow:
 *
 *  - the **normative trust notice** (no hard runtime timeout, no
 *    hostile-code sandbox, scripts see their origin's globals) is always
 *    visible above the acknowledgment control;
 *  - declared-property schemas are rendered from published declaration data
 *    only — this panel never evaluates behavior source;
 *  - source bytes are **staged** (non-authoritative) and published through the
 *    ordinary `publishBehavior{mode:"source"}` command; the panel displays the
 *    bounded compile/publication error verbatim instead of faking a build;
 *  - a bounded declaration-create form publishes a new declared-property
 *    schema through the ordinary command path, so the property controls and
 *    the source publication have a schema to bind to.
 *
 * Display + intent only: every action is an ordinary typed command issued by
 * the app through the single session client.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import {
  BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL,
  BEHAVIOR_TRUST_NOTICE,
  type BehaviorPublicationState,
} from '../session/behavior-publication';
import type { BehaviorDeclarationView } from '../session/prefab-projection';

export interface BehaviorPanelProps {
  behaviors: readonly BehaviorDeclarationView[];
  selectedBehaviorId: string | null;
  publication: BehaviorPublicationState;
  sourceDraft: string;
  /** The active isolated play (`null` when nothing is playing). */
  activePlay: { snapshotId: string; revision: number } | null;
  error: { code: string; message: string } | null;
  /** New-behavior declaration draft. */
  newBehaviorId: string;
  newDisplayName: string;
  newPropertyKey: string;
  newPropertyDefault: string;
  onSelect: (behaviorId: string) => void;
  onSourceDraft: (text: string) => void;
  onStage: () => void;
  onAcknowledge: (sourceDigest: string) => void;
  onPublishSource: () => void;
  onNewBehaviorId: (value: string) => void;
  onNewDisplayName: (value: string) => void;
  onNewPropertyKey: (value: string) => void;
  onNewPropertyDefault: (value: string) => void;
  onCreateDeclaration: () => void;
}

export function BehaviorPanel(p: BehaviorPanelProps): JSX.Element {
  const selected = p.behaviors.find((b) => b.behaviorId === p.selectedBehaviorId) ?? null;
  const staged = p.publication.staged;
  const digest = staged?.digest ?? selected?.source?.sourceDigest ?? null;
  const acknowledged = digest !== null && p.publication.acknowledgedDigests.includes(digest);

  return (
    <div className="tl-panel tl-behaviors">
      <div className="tl-panel__title">Behaviors — trusted source</div>

      <div className="tl-behaviors__body">
      <div className="tl-behaviors__main">
      <div className="tl-behaviors__notice" role="note" aria-label="trust notice">
        {BEHAVIOR_TRUST_NOTICE.map((line) => (
          <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
            {line}
          </p>
        ))}
      </div>

      <ul className="tl-behaviors__list tl-tiles">
        {p.behaviors.map((b) => (
          <li
            key={b.behaviorId}
            className={b.behaviorId === p.selectedBehaviorId ? 'tl-tile is-selected' : 'tl-tile'}
            onClick={() => p.onSelect(b.behaviorId)}
            title={b.behaviorId}
          >
            <span className="tl-tile__icon tl-tile__icon--script" aria-hidden="true"><img className="tl-tile__img" src="./icons/script.png" alt="" /></span>
            <span className="tl-tile__name">{b.displayName}</span>
            <span className="tl-tile__meta">
              {b.declaration.properties.length} prop · r{b.publishedRevision}
              {b.source !== null ? ' · source' : ' · declaration'}
            </span>
          </li>
        ))}
        {p.behaviors.length === 0 && <li className="tl-row tl-row--empty">no published behaviors</li>}
      </ul>
      </div>

      <div className="tl-behaviors__side">

      {selected && (
        <div className="tl-behaviors__detail">
          <div className="tl-prop__caption" title={selected.behaviorId}>
            {selected.displayName} — {selected.behaviorId}
          </div>
          <table className="tl-behaviors__props">
            <thead>
              <tr>
                <th>key</th>
                <th>type</th>
                <th>default</th>
              </tr>
            </thead>
            <tbody>
              {selected.declaration.properties.map((prop) => (
                <tr key={prop.key}>
                  <td>{prop.key}</td>
                  <td>{prop.type}</td>
                  <td>{JSON.stringify(prop.default)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tl-prop__caption">
            source: {selected.source?.sourceDigest ?? 'declaration only'} ·{' '}
            {selected.source === null ? 'executes nothing' : acknowledged ? 'acknowledged' : 'NOT acknowledged'}
          </div>
          <div className="tl-prop__caption">
            published revision r{selected.publishedRevision} — staged edits never change this.
          </div>
        </div>
      )}

      <div className="tl-behaviors__source">
        <textarea
          className="tl-behaviors__textarea"
          value={p.sourceDraft}
          placeholder={'thirdlight-behavior-source v1 container (canonical JSON), e.g. {"graphVersion":1,...}'}
          onChange={(e) => p.onSourceDraft(e.target.value)}
          spellCheck={false}
        />
        <div className="tl-behaviors__row">
          <button className="tl-btn tl-btn--small" onClick={p.onStage} title="Stage bytes (non-authoritative; no revision change)">
            stage source
          </button>
          <span className="tl-prop__caption" title={digest ?? undefined}>
            {staged ? `${staged.byteLength} bytes · ${staged.digest.slice(0, 16)}…` : 'nothing staged'}
          </span>
        </div>
        <div className="tl-behaviors__row">
          <button
            className="tl-btn tl-btn--small"
            disabled={digest === null || acknowledged}
            onClick={() => digest !== null && p.onAcknowledge(digest)}
            title="Records content.behaviorTrust for this exact digest"
          >
            {acknowledged ? 'digest acknowledged' : BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL}
          </button>
        </div>
        <div className="tl-behaviors__row">
          <button
            className="tl-btn tl-btn--small"
            disabled={!selected || staged === null || !acknowledged}
            onClick={p.onPublishSource}
            title="publishBehavior{mode:'source'} through the ordinary command path"
          >
            publish source
          </button>
          <span className="tl-prop__caption">
            status: {p.publication.status}
            {p.publication.publishedRevision !== null ? ` · r${p.publication.publishedRevision}` : ''}
          </span>
        </div>
      </div>

      {p.publication.compileFailure && (
        <div className="tl-prop__error" title={p.publication.compileFailure.code}>
          {p.publication.compileFailure.code} ({p.publication.compileFailure.reason}):{' '}
          {p.publication.compileFailure.diagnostics.length} diagnostic(s)
          {p.publication.compileFailure.truncated ? ' (truncated at 32)' : ''}
          <ul>
            {p.publication.compileFailure.diagnostics.map((d, i) => (
              <li key={`${d.code}-${i}`}>
                {d.code}/{d.reason}
                {d.path ? ` ${d.path}` : ''}: {d.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.publication.error && (
        <div className="tl-prop__error" title={p.publication.error.message}>
          {p.publication.error.code}: {p.publication.error.message}
        </div>
      )}
      {p.error && (
        <div className="tl-prop__error" title={p.error.message}>
          {p.error.code}: {p.error.message}
        </div>
      )}

      <div className="tl-behaviors__new">
        <div className="tl-prop__caption">New behavior declaration (typed command; no source evaluator)</div>
        <div className="tl-behaviors__row">
          <input className="tl-prop__input" value={p.newBehaviorId} placeholder="behavior-0100" onChange={(e) => p.onNewBehaviorId(e.target.value)} />
          <input className="tl-prop__input" value={p.newDisplayName} placeholder="display name" onChange={(e) => p.onNewDisplayName(e.target.value)} />
        </div>
        <div className="tl-behaviors__row">
          <input className="tl-prop__input" value={p.newPropertyKey} placeholder="property key (speed)" onChange={(e) => p.onNewPropertyKey(e.target.value)} />
          <input className="tl-prop__input" value={p.newPropertyDefault} placeholder="default (3.5)" onChange={(e) => p.onNewPropertyDefault(e.target.value)} />
          <button className="tl-btn tl-btn--small" onClick={p.onCreateDeclaration}>
            create declaration
          </button>
        </div>
      </div>

      <div className="tl-prop__caption">
        active play: {p.activePlay ? `${p.activePlay.snapshotId} @ r${p.activePlay.revision}` : 'none'} — a staged edit or a
        new publication never changes the running play instance (a fresh play is required).
      </div>
      </div>
      </div>
    </div>
  );
}
