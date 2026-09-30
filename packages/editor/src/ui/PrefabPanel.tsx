/**
 * Prefab panel (React).
 *
 * The authoring UI for prefab **copies**:
 *
 *  - "Create Prefab Definition" captures the current selection into an
 *    immutable definition (`createPrefab`);
 *  - "Place Copy" instantiates one independent materialized copy
 *    (`instantiatePrefab`), optionally with one or more **declared-property**
 *    initial overrides.
 *
 * The terminology is the contract's: copies, never linked prefabs.
 * There is deliberately no Link, Apply, Revert, variant or propagation control
 * anywhere in this panel — definitions are immutable and a definition
 * change never rewrites a copy.
 *
 * Display + intent only: every action is an ordinary typed command issued by
 * the app through the session client (the sole mutation path).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import { useIndexList } from './catalog/useIndexList';
import { VirtualList } from './catalog/VirtualList';
import type { BehaviorControlsView } from '../session/property-controls';
import type { PrefabSummaryView } from '../session/prefab-projection';
import { PropertyControlList, type ControlErrorView } from './PropertyControls';

export interface PrefabPanelProps {
  selection: ProjectedEntity | null;
  /** The definitions read so far (by id); the list itself pages the project index. */
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
  /** Delete a definition (`deletePrefab`; refused while a copy or anything else uses it). */
  onDelete?: (prefabId: string) => void;
  /** Why the last delete was refused, or null. */
  deleteError?: string | null;
  onOverrideCommit: (localId: string, key: string, raw: string) => void;
}

/** A prefab tile's height plus the gap (px; editor.css). */
const TILE_STRIDE = 150;

/** The prefabs, paged from the project index. */
const PREFAB_KINDS: readonly string[] = ['prefab'];

export function PrefabPanel(p: PrefabPanelProps): JSX.Element {
  const selected = p.definitions.find((d) => d.prefabId === p.selectedPrefabId) ?? null;
  const list = useIndexList({ kinds: PREFAB_KINDS });
  const read = new Map(p.definitions.map((d) => [d.prefabId, d] as const));
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

      <VirtualList
        className="tl-prefabs__list tl-tiles tl-tiles--virtual"
        count={list.total ?? 0}
        stride={TILE_STRIDE}
        gap={8}
        padding={8}
        minItemWidth={112}
        onRange={list.need}
        empty={<li className="tl-row tl-row--empty">{list.total === null ? 'loading…' : 'no prefab definitions'}</li>}
        renderItem={(i) => {
          const e = list.entry(i);
          if (e === undefined) return <li key={`slot:${i}`} className="tl-tile tl-tile--loading" aria-hidden="true" />;
          const d = read.get(e.id);
          return (
            <li key={e.id} className={e.id === p.selectedPrefabId ? 'tl-tile is-selected' : 'tl-tile'} onClick={() => p.onSelect(e.id)} title={e.id} data-prefab-id={e.id}>
              <span className="tl-tile__icon tl-tile__icon--prefab" aria-hidden="true"><img className="tl-tile__img" src="./icons/prefab.png" alt="" /></span>
              <span className="tl-tile__name">{e.name}</span>
              <span className="tl-tile__meta">{d !== undefined ? `${d.entityCount} ent · depth ${d.depth}` : 'prefab'}</span>
              <button
                className="tl-btn tl-btn--small"
                onClick={(ev) => {
                  ev.stopPropagation();
                  p.onPlaceCopy(e.id);
                }}
                title="Materialize one independent copy at the scene root"
              >
                place copy
              </button>
              {p.onDelete !== undefined && (
                <button
                  className="tl-btn tl-btn--small"
                  aria-label={`delete prefab ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    p.onDelete?.(e.id);
                  }}
                  title="Remove this definition (refused while a placed copy, a block look or a script still uses it; one undo brings it back)"
                >
                  delete
                </button>
              )}
            </li>
          );
        }}
      />
      {p.deleteError != null && (
        <div className="tl-prop__error" role="alert" data-testid="prefab-delete-error" title={p.deleteError}>
          {p.deleteError}
        </div>
      )}

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
