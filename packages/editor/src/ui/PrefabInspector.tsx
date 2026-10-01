/**
 * A prefab in the Inspector (chosen in the project window): place a
 * **copy** of it (`instantiatePrefab`), optionally with **declared-property**
 * initial overrides, or delete the definition. A definition is made from the
 * selection by GameObject → Create prefab from selection or the Hierarchy's
 * context menu (`createPrefab`).
 *
 * The terminology is the contract's: copies, never linked prefabs. There is
 * deliberately no Link, Apply, Revert, variant or propagation control —
 * definitions are immutable and a definition change never rewrites a copy.
 *
 * Display + intent only: every action is an ordinary typed command issued by
 * the app through the session client (the sole mutation path).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { BehaviorControlsView } from '../session/property-controls';
import type { PrefabSummaryView } from '../session/prefab-projection';
import { PropertyControlList, type ControlErrorView } from './PropertyControls';

export interface PrefabInspectorProps {
  prefabId: string;
  /** The definition's summary once read (its name, size). */
  definition: PrefabSummaryView | null;
  /** Declared-property targets of the definition (the copy's initial overrides). */
  targets: readonly BehaviorControlsView[];
  copyError: ControlErrorView | null;
  overrideCount: number;
  onPlaceCopy: (prefabId: string) => void;
  onOverrideCommit: (localId: string, key: string, raw: string) => void;
  onDelete: (prefabId: string) => void;
  deleteError: string | null;
}

/**
 * A prefab chosen in the project window, in the Inspector: place a copy (with
 * initial overrides of its declared properties), or delete the definition.
 * Copies are independent: there is no link back to the definition.
 */
export function PrefabInspector(p: PrefabInspectorProps): JSX.Element {
  const d = p.definition;
  return (
    <div className="tl-prefabs__override" aria-label="prefab" data-prefab-id={p.prefabId}>
      <div className="tl-prop__caption" title={p.prefabId}>
        {d !== null ? `${d.displayName} — ${d.entityCount} object${d.entityCount === 1 ? '' : 's'}, depth ${d.depth}` : p.prefabId} · copies are independent
      </div>
      <div className="tl-prop__caption">Initial override (optional) — applies to the copy placed next, not to the definition.</div>
      {p.targets.length === 0 && <div className="tl-inspector__empty">this definition has no declared properties</div>}
      {p.targets.map((t) => (
        <div className="tl-prefabs__target" key={t.localId}>
          <div className="tl-prop__head">
            <span className="tl-prop__label">{t.entityName}</span>
            <span className="tl-prop__type">{t.behaviorId}</span>
          </div>
          {t.error ? (
            <div className="tl-prop__error" title={t.error.message}>
              {t.error.code}: {t.error.message}
            </div>
          ) : (
            <PropertyControlList controls={t.controls} onCommit={(key, raw) => p.onOverrideCommit(t.localId, key, raw)} />
          )}
        </div>
      ))}
      <div className="tl-prefabs__row">
        <button className="tl-btn tl-btn--small" onClick={() => p.onPlaceCopy(p.prefabId)} title="Materialize one independent copy at the scene root">
          place copy
        </button>
        <span className="tl-prop__caption">{p.overrideCount} override(s)</span>
        <button
          className="tl-btn tl-btn--small"
          aria-label={`delete prefab ${d?.displayName ?? p.prefabId}`}
          onClick={() => p.onDelete(p.prefabId)}
          title="Remove this definition (refused while a placed copy, a block look or a script still uses it; one undo brings it back)"
        >
          delete
        </button>
      </div>
      {p.copyError && (
        <div className="tl-prop__error" title={p.copyError.message}>
          {p.copyError.code}: {p.copyError.message}
        </div>
      )}
      {p.deleteError !== null && (
        <div className="tl-prop__error" role="alert" data-testid="prefab-delete-error" title={p.deleteError}>
          {p.deleteError}
        </div>
      )}
    </div>
  );
}
