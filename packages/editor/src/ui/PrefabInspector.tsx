/**
 * A prefab in the Inspector (chosen in the project window): place a linked
 * **copy** of it (`instantiatePrefab`), optionally with **declared-property**
 * overrides, or delete the definition. A definition is made from the
 * selection by GameObject → Create prefab from selection or the Hierarchy's
 * context menu (`createPrefab`). A copy follows every edit of its prefab
 * except what it overrides; its own overrides are in its Inspector.
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
 * overrides of its declared properties), or delete the definition.
 */
export function PrefabInspector(p: PrefabInspectorProps): JSX.Element {
  const d = p.definition;
  return (
    <div className="tl-prefabs__override" aria-label="prefab" data-prefab-id={p.prefabId}>
      <div className="tl-prop__caption" title={p.prefabId}>
        {d !== null ? `${d.displayName} — ${d.entityCount} object${d.entityCount === 1 ? '' : 's'}, depth ${d.depth}` : p.prefabId} · copies follow its edits
      </div>
      {/* A prefab made in the editor gets a generated id, and scripts spawn it by that id, so it is shown to copy. */}
      <div className="tl-prop__caption" aria-label="prefab id">
        id <code>{p.prefabId}</code> — the name <code>ctx.spawn</code> takes
      </div>
      <div className="tl-prop__caption">Override (optional) — kept by the copy placed next, not written to the prefab.</div>
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
        <button className="tl-btn tl-btn--small" onClick={() => p.onPlaceCopy(p.prefabId)} title="Place one linked copy at the scene root (or drag the prefab into the Scene view)">
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
