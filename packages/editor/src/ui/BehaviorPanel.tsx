/**
 * The Scripts section of Project Settings: the project's behaviors as tiles,
 * new behaviors and new visual scripts.
 *
 * - The trust notice (no hard runtime timeout, no hostile-code sandbox,
 *   scripts see their origin's globals) stays visible here.
 * - Double-clicking a tile opens the behavior's own tab: a script in the
 *   Script tab (`ScriptDocument`: its code, publish and trust
 *   acknowledgment), a visual script in its Graph tab. Code is published
 *   there only, so a script has one way to be published.
 * - The declaration editor (`DeclarationEditor`: every property type,
 *   visibility, groups, headers, tooltips) declares a new behavior or edits
 *   the selected one's properties through the ordinary command path.
 *
 * Declaration data only: this panel never evaluates behavior source. Every
 * action is an ordinary typed command issued by the app through the single
 * session client.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { BEHAVIOR_TRUST_NOTICE } from '../session/behavior-publication';
import type { BehaviorDeclarationView } from '../session/prefab-projection';
import { DeclarationEditor, type DeclarationSave } from './DeclarationEditor';
import { kindIcon } from '../session/item-icons';

export interface BehaviorPanelProps {
  behaviors: readonly BehaviorDeclarationView[];
  selectedBehaviorId: string | null;
  error: { code: string; message: string } | null;
  onSelect: (behaviorId: string | null) => void;
  /** Create or update a declaration (one publishBehavior command). */
  onSaveDeclaration: (save: DeclarationSave) => Promise<boolean>;
  /** Open a behavior in the editor window (double-click its tile). */
  onOpen: (behaviorId: string) => void;
  /** Create a visual script (a behavior whose source is a graph) with this name. */
  onCreateVisualScript: (displayName: string) => void;
}

export function BehaviorPanel(p: BehaviorPanelProps): JSX.Element {
  const selected = p.behaviors.find((b) => b.behaviorId === p.selectedBehaviorId) ?? null;
  const [visualName, setVisualName] = useState('');

  return (
    <div className="tl-panel tl-behaviors">
      <div className="tl-panel__title">Behaviors</div>
      <div className="tl-behaviors__body">
        <div className="tl-behaviors__main">
          <div className="tl-behaviors__notice" role="note" aria-label="trust notice">
            {BEHAVIOR_TRUST_NOTICE.map((line) => (
              <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
                {line}
              </p>
            ))}
          </div>
          <ul className="tl-behaviors__list tl-tiles" title="Double-click a behavior to open its script tab">
            {p.behaviors.map((b) => (
              <li
                key={b.behaviorId}
                className={b.behaviorId === p.selectedBehaviorId ? 'tl-tile is-selected' : 'tl-tile'}
                onClick={() => p.onSelect(b.behaviorId)}
                onDoubleClick={() => p.onOpen(b.behaviorId)}
                title={b.behaviorId}
              >
                <span className="tl-tile__icon tl-tile__icon--script" aria-hidden="true"><img className="tl-tile__img" src={kindIcon('behavior')} alt="" /></span>
                <span className="tl-tile__name">{b.displayName}</span>
                <span className="tl-tile__meta">
                  {b.declaration.properties.length} prop · r{b.publishedRevision}
                  {b.graph !== undefined ? ' · visual script' : b.source !== null ? ' · source' : ' · declaration'}
                </span>
              </li>
            ))}
            {p.behaviors.length === 0 && <li className="tl-row tl-row--empty">no published behaviors</li>}
          </ul>
          <div className="tl-behaviors__row">
            <button className="tl-btn tl-btn--small" onClick={() => p.onSelect(null)} title="Declare a new behavior">
              + New behavior
            </button>
          </div>
          <form
            className="tl-behaviors__row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = visualName.trim();
              if (name === '') return;
              p.onCreateVisualScript(name);
              setVisualName('');
            }}
          >
            <input className="tl-prop__input" aria-label="New visual script name" placeholder="Visual script name" maxLength={128} value={visualName} onChange={(e) => setVisualName(e.target.value)} />
            <button className="tl-btn tl-btn--small" type="submit" disabled={visualName.trim() === ''} title="A behavior whose logic is a node graph (opens as a Graph tab)">
              + Visual script
            </button>
          </form>
          {/* Keyed by the behavior so a selection re-seeds the drafts. */}
          <DeclarationEditor
            key={selected !== null ? `${selected.behaviorId}@${selected.publishedRevision}` : 'new'}
            behavior={selected}
            error={p.error}
            onSave={p.onSaveDeclaration}
          />
        </div>
      </div>
    </div>
  );
}
