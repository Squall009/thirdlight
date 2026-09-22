/**
 * Prefab panel (React; packet 28; project-model §20.1/§20.5,
 * commands.md §8.6–§8.7).
 *
 * The authoring UI for prefab **copies**:
 *
 *  - "Create Prefab Definition" captures the current selection into an
 *    immutable definition (`createPrefab`);
 *  - "Place Copy" instantiates one independent materialized copy
 *    (`instantiatePrefab`), optionally with one or more **declared-property**
 *    initial overrides.
 *
 * The terminology is the contract's (§20.1.5): copies, never linked prefabs.
 * There is deliberately no Link, Apply, Revert, variant or propagation control
 * anywhere in this panel — definitions are immutable in M2 and a definition
 * change never rewrites a copy.
 *
 * Display + intent only: every action is an ordinary typed command issued by
 * the app through the session client (the sole mutation path).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import type { BehaviorControlsView } from '../session/property-controls';
import type { PrefabSummaryView } from '../session/prefab-projection';
import { PropertyControlList, type ControlErrorView } from './PropertyControls';

export interface PrefabPanelProps {
  selection: ProjectedEntity | null;
  definitions: readonly PrefabSummaryView[];
  selectedPrefabId: string | null;
  /** Declared-property targets of the selected definition (override editor). */
  targets: readonly BehaviorControlsView[];
  captureDraft: { prefabId: string; displayName: string } | null;
  captureError: ControlErrorView | null;
  copyError: ControlErrorView | null;
  /** How many initial overrides the draft currently holds. */
  overrideCount: number;
  onCaptureName: (name: string) => void;
  onCapture: () => void;
  onSelect: (prefabId: string) => void;
  onPlaceCopy: (prefabId: string) => void;
  onOverrideCommit: (localId: string, key: string, raw: string) => void;
}

export function PrefabPanel(p: PrefabPanelProps): JSX.Element {
  const selected = p.definitions.find((d) => d.prefabId === p.selectedPrefabId) ?? null;
  return (
    <div className="tl-panel tl-prefabs">
      <div className="tl-panel__title">Prefabs — copies, not links</div>

      <div className="tl-prefabs__capture">
        <div className="tl-prop__caption">
          Capture the selected subtree as an immutable definition ("Create Prefab Definition").
        </div>
        <div className="tl-prefabs__row">
          <input
            className="tl-prop__input"
            value={p.captureDraft?.displayName ?? ''}
            placeholder="definition name"
            disabled={!p.captureDraft}
            onChange={(e) => p.onCaptureName(e.target.value)}
            title="1–128 characters, display only"
          />
          <button
            className="tl-btn tl-btn--small"
            disabled={!p.captureDraft}
            onClick={p.onCapture}
            title={p.selection ? `Capture ${p.selection.id}` : 'Select an entity first'}
          >
            create definition
          </button>
        </div>
        {p.captureDraft && <div className="tl-prop__caption">id: {p.captureDraft.prefabId}</div>}
        {!p.selection && <div className="tl-prop__caption">select an entity in the hierarchy or viewport</div>}
        {p.captureError && (
          <div className="tl-prop__error" title={p.captureError.message}>
            {p.captureError.code}: {p.captureError.message}
          </div>
        )}
      </div>

      <ul className="tl-prefabs__list">
        {p.definitions.map((d) => (
          <li
            key={d.prefabId}
            className={d.prefabId === p.selectedPrefabId ? 'tl-row is-selected' : 'tl-row'}
            onClick={() => p.onSelect(d.prefabId)}
          >
            <span className="tl-row__name" title={d.prefabId}>
              {d.displayName}
            </span>
            <span className="tl-prefabs__meta">
              {d.entityCount} ent · depth {d.depth}
            </span>
            <button
              className="tl-btn tl-btn--small"
              onClick={(e) => {
                e.stopPropagation();
                p.onPlaceCopy(d.prefabId);
              }}
              title="Materialize one independent copy at the scene root"
            >
              place copy
            </button>
          </li>
        ))}
        {p.definitions.length === 0 && <li className="tl-row tl-row--empty">no prefab definitions</li>}
      </ul>

      {selected && (
        <div className="tl-prefabs__override">
          <div className="tl-prop__caption" title={selected.prefabId}>
            Copy of {selected.displayName} — copies are independent
          </div>
          <div className="tl-prop__caption">
            Initial override (optional) — applies to the copy created next, not to the definition.
          </div>
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
                <PropertyControlList
                  controls={t.controls}
                  onCommit={(key, raw) => p.onOverrideCommit(t.localId, key, raw)}
                />
              )}
            </div>
          ))}
          <div className="tl-prefabs__row">
            <button className="tl-btn tl-btn--small" onClick={() => p.onPlaceCopy(selected.prefabId)}>
              place copy
            </button>
            <span className="tl-prop__caption">{p.overrideCount} override(s)</span>
          </div>
          {p.copyError && (
            <div className="tl-prop__error" title={p.copyError.message}>
              {p.copyError.code}: {p.copyError.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
