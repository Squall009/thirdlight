/**
 * Inspector (React, decision 0001 §10; packet 10 + packet 28).
 *
 * The selected entity's transform readout + gizmo mode (M1), plus the packet-28
 * declared-property controls and the read-only contract component controls.
 * Every control is **schema-driven from published declaration data** — nothing
 * here evaluates behavior code or discovers a schema at runtime. Edits flow
 * through typed commands issued by the app (one `setBehaviorProperties` per
 * property edit), never through a direct scene write.
 *
 * A materialized prefab copy is labelled "Copy of <displayName> — copies are
 * independent"; there is no Link/Apply/Revert/variant affordance.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ColliderComponent, PropertyDeclaration } from '@thirdlight/project-model';
import type { ProjectedEntity } from '../session/projection';
import { deriveBehaviorControls, deriveComponentControls } from '../session/property-controls';
import type { GizmoMode } from '../viewport/viewport';
import { ComponentControlList, PropertyControlList, type ControlErrorView } from './PropertyControls';

interface Props {
  entity: ProjectedEntity | null;
  gizmoMode: GizmoMode;
  onGizmoMode: (m: GizmoMode) => void;
  /** Published declarations (the only schema source), keyed by behaviorId. */
  declarations: ReadonlyMap<string, PropertyDeclaration>;
  /** Display name of a definition, for the copy provenance label. */
  prefabDisplayName: (prefabId: string) => string;
  /** The last property-command error (bounded), when one occurred. */
  propertyError: ControlErrorView | null;
  componentError: ControlErrorView | null;
  onEditProperty: (entityId: string, key: string, raw: string) => void;
  onAddComponent: (entityId: string, component: 'collider' | 'controller') => void;
  onRemoveComponent: (entityId: string, component: 'collider' | 'controller') => void;
  onEditColliderBox: (entityId: string, hx: string, hy: string) => void;
}

function Vec({ label, values }: { label: string; values: number[] }): JSX.Element {
  return (
    <div className="tl-vec">
      <span className="tl-vec__label">{label}</span>
      <div className="tl-vec__nums">
        {values.map((v, i) => (
          <span key={i} className="tl-vec__num" title={['x', 'y', 'z', 'w'][i] ?? ''}>
            {Number(v.toFixed(4))}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Inspector({ entity, gizmoMode, onGizmoMode, declarations, prefabDisplayName, propertyError, componentError, onEditProperty, onAddComponent, onRemoveComponent, onEditColliderBox }: Props): JSX.Element {
  const behavior =
    entity?.behaviorId !== undefined
      ? deriveBehaviorControls(
          {
            localId: entity.id,
            entityName: entity.name,
            behaviorId: entity.behaviorId,
            recordedValues: entity.behaviorValues ?? {},
          },
          declarations,
        )
      : null;
  const components = deriveComponentControls(
    entity ? { collider: entity.collider as ColliderComponent | undefined, controller: entity.controller } : null,
    { includeAbsent: entity !== null },
  );
  return (
    <div className="tl-panel tl-inspector">
      <div className="tl-panel__title">Inspector</div>
      <div className="tl-inspector__modes">
        {(['translate', 'rotate', 'scale'] as GizmoMode[]).map((m) => (
          <button
            key={m}
            className={gizmoMode === m ? 'tl-btn is-active' : 'tl-btn'}
            onClick={() => onGizmoMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
      {entity ? (
        <div className="tl-inspector__body">
          <div className="tl-inspector__name" title={entity.id}>
            {entity.name}
          </div>
          <div className="tl-inspector__kind">{entity.kind}</div>
          {entity.prefab && (
            <div className="tl-inspector__copy" title={`${entity.prefab.prefabId} / ${entity.prefab.localId}`}>
              Copy of {prefabDisplayName(entity.prefab.prefabId)} — copies are independent
            </div>
          )}
          <Vec label="position" values={entity.position} />
          <Vec label="rotation (quat)" values={entity.rotation} />
          <Vec label="scale" values={entity.scale} />

          {behavior && (
            <div className="tl-inspector__section">
              <div className="tl-panel__title">Properties — {behavior.behaviorId}</div>
              {behavior.error ? (
                <div className="tl-prop__error" title={behavior.error.message}>
                  {behavior.error.code}: {behavior.error.message}
                </div>
              ) : (
                <PropertyControlList
                  controls={behavior.controls}
                  onCommit={(key, raw) => onEditProperty(entity.id, key, raw)}
                />
              )}
              {propertyError && (
                <div className="tl-prop__error" title={propertyError.message}>
                  {propertyError.code}: {propertyError.message}
                </div>
              )}
            </div>
          )}

          {components.length > 0 && (
            <div className="tl-inspector__section">
              <div className="tl-panel__title">Physics components</div>
              <ComponentControlList
                controls={components}
                onAdd={(component) => onAddComponent(entity.id, component)}
                onRemove={(component) => onRemoveComponent(entity.id, component)}
                onEditColliderBox={(hx, hy) => onEditColliderBox(entity.id, hx, hy)}
              />
              {componentError && (
                <div className="tl-prop__error" title={componentError.message}>
                  {componentError.code}: {componentError.message}
                </div>
              )}
            </div>
          )}

          <p className="tl-inspector__hint">
            Drag the gizmo in the viewport to edit. One undoable command commits on release.
          </p>        </div>
      ) : (
        <div className="tl-inspector__empty">Nothing selected.</div>
      )}
    </div>
  );
}
