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
import { useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import * as THREE from 'three';
import type { ColliderComponent, PropertyDeclaration } from '@thirdlight/project-model';
import type { ProjectedEntity } from '../session/projection';
import type { EffectiveEntityFlags } from '../session/hierarchy';
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
  onRename: (entityId: string, name: string) => void;
  onEditTransform: (entityId: string, patch: { position?: number[]; rotation?: number[]; scale?: number[] }) => void;
  /** Phase 12: the entity's effective (inherited) flags. */
  flags: EffectiveEntityFlags | null;
  /** Display name of an entity id (for "inherited from …"). */
  entityName: (id: string) => string;
  /** How many entities are selected in the hierarchy. */
  selectionCount: number;
  onSetFlag: (entityId: string, flag: 'active' | 'locked' | 'static', value: boolean) => void;
  /** Phase 12 (b): the project tag registry. */
  tags: readonly { bit: number; name: string }[];
  onSetTags: (entityId: string, names: string[]) => void;
  /** Phase 12 (c): open the exit-zone editor for this zone (absent: no scenes). */
  onEditExit?: (entityId: string) => void;
  /** Phase 9.4: extra sections for the entity (the material mapping). */
  extra?: ReactNode;
}

/**
 * Phase 12 (b): the entity's tags. A checkbox is the entity's own tag; a tag
 * a folder above passes down is marked as inherited (it counts either way).
 */
function TagControls(props: { entity: ProjectedEntity; flags: EffectiveEntityFlags | null; tags: Props['tags']; onSetTags: Props['onSetTags'] }): JSX.Element {
  const { entity, flags, tags } = props;
  const own = entity.tags;
  const inherited = flags?.inheritedTags ?? 0;
  return (
    <div className="tl-inspector__section tl-inspector__tags" aria-label="tags">
      <div className="tl-panel__title">Tags</div>
      {tags.length === 0 ? (
        <p className="tl-inspector__hint">No project tags yet (bottom dock → Tags).</p>
      ) : (
        tags.map((t) => {
          const bit = 1 << t.bit;
          const mine = (own & bit) !== 0;
          return (
            <label key={t.bit} className="tl-flag" data-tag={t.name}>
              <input
                type="checkbox"
                aria-label={`tag ${t.name}`}
                checked={mine}
                onChange={(e) => {
                  const names = tags.filter((x) => (x.bit === t.bit ? e.target.checked : (own & (1 << x.bit)) !== 0)).map((x) => x.name);
                  props.onSetTags(entity.id, names);
                }}
              />
              <span>{t.name}</span>
              {(inherited & bit) !== 0 && <span className="tl-flag__inherited" data-inherited-tag={t.name}>inherited from a folder</span>}
            </label>
          );
        })
      )}
    </div>
  );
}

const FLAG_ROWS = [
  { flag: 'active', label: 'Active', hint: 'Off: left out of the game and hidden in the editor, with everything under it.' },
  { flag: 'locked', label: 'Locked', hint: 'Editor only: cannot be picked or moved in the Scene view.' },
  { flag: 'static', label: 'Static', hint: 'Marks the object as not moving.' },
] as const;

/**
 * Phase 12: the hierarchy flags. Each checkbox is the entity's own value; an
 * inherited value (from a folder above, or an inactive parent) is shown next
 * to it and wins.
 */
function FlagControls(props: { entity: ProjectedEntity; flags: EffectiveEntityFlags | null; entityName: (id: string) => string; onSetFlag: Props['onSetFlag'] }): JSX.Element {
  const { entity, flags } = props;
  return (
    <div className="tl-inspector__section tl-inspector__flags" aria-label="hierarchy flags">
      {FLAG_ROWS.map(({ flag, label, hint }) => {
        const own = entity[flag];
        const from = flags?.inheritedFrom[flag];
        const effective = flags?.[flag] ?? own;
        return (
          <label key={flag} className="tl-flag" title={hint}>
            <input type="checkbox" aria-label={label} checked={own} onChange={(e) => props.onSetFlag(entity.id, flag, e.target.checked)} />
            <span>{label}</span>
            {from !== undefined && (
              <span className="tl-flag__inherited" data-flag={flag}>
                {flag === 'active' ? (effective ? 'active' : 'inactive') : effective ? flag : `not ${flag}`} — inherited from {props.entityName(from)}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** A text field that commits on Enter/blur and reverts on Escape. */
function CommitField(props: { value: string; label: string; className: string; onCommit: (raw: string) => void }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null && draft !== props.value) props.onCommit(draft);
    setDraft(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') {
      setDraft(null);
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
    }
  };
  return (
    <input
      className={props.className}
      aria-label={props.label}
      title={props.label}
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

/** Three editable numbers; commits the whole vector when one changes. */
function VecField(props: { label: string; values: number[]; onCommit: (next: number[]) => void }): JSX.Element {
  return (
    <div className="tl-vec">
      <span className="tl-vec__label">{props.label}</span>
      <div className="tl-vec__nums">
        {props.values.map((v, i) => (
          <CommitField
            key={i}
            className="tl-vec__num"
            label={`${props.label} ${['x', 'y', 'z'][i] ?? ''}`}
            value={fmt(v)}
            onCommit={(raw) => {
              const n = Number(raw);
              if (!Number.isFinite(n) || raw.trim() === '') return;
              const next = [...props.values];
              next[i] = n;
              props.onCommit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

const DEG = 180 / Math.PI;

function eulerDegrees(q: number[]): number[] {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'XYZ');
  return [e.x * DEG, e.y * DEG, e.z * DEG];
}

function quaternionOf(deg: number[]): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((deg[0] ?? 0) / DEG, (deg[1] ?? 0) / DEG, (deg[2] ?? 0) / DEG, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

export function Inspector({ entity, gizmoMode, onGizmoMode, declarations, prefabDisplayName, propertyError, componentError, onEditProperty, onAddComponent, onRemoveComponent, onEditColliderBox, onRename, onEditTransform, flags, entityName, selectionCount, onSetFlag, tags, onSetTags, onEditExit, extra }: Props): JSX.Element {
  const isFolder = entity?.kind === 'folder';
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
    entity && !isFolder ? { collider: entity.collider as ColliderComponent | undefined, controller: entity.controller } : null,
    { includeAbsent: entity !== null && !isFolder },
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
          <CommitField
            className="tl-inspector__name"
            label="name"
            value={entity.name}
            onCommit={(raw) => {
              if (raw.trim() !== '') onRename(entity.id, raw.trim());
            }}
          />
          <div className="tl-inspector__kind">{entity.kind}{selectionCount > 1 ? ` · ${selectionCount} selected` : ''}</div>
          <FlagControls entity={entity} flags={flags} entityName={entityName} onSetFlag={onSetFlag} />
          <TagControls entity={entity} flags={flags} tags={tags} onSetTags={onSetTags} />
          {extra}
          {entity.gameZone?.role === 'exit' && (
            <div className="tl-inspector__exit">
              <p className="tl-inspector__hint">
                Exit: entering loads {entity.gameZone.load?.length ? entity.gameZone.load.join(', ') : 'nothing'}, unloads {entity.gameZone.unload?.length ? entity.gameZone.unload.join(', ') : 'nothing'}
                {entity.gameZone.spawnId !== undefined ? `, then moves the player to ${entityName(entity.gameZone.spawnId)}` : ''}.
              </p>
              {onEditExit !== undefined && (
                <button className="tl-btn" onClick={() => onEditExit(entity.id)}>
                  Edit exit…
                </button>
              )}
            </div>
          )}
          {entity.instances !== undefined && (
            <p className="tl-inspector__hint" data-instances={entity.instances.count}>
              Instance set: {entity.instances.count} copies of one model, drawn with instancing. The transform moves, turns and scales the whole set.
            </p>
          )}
          {isFolder && <p className="tl-inspector__hint">A folder only organises: it has no transform, and filing objects in it keeps where they are. Active, Locked and Static set here reach everything inside.</p>}
          {entity.prefab && (
            <div className="tl-inspector__copy" title={`${entity.prefab.prefabId} / ${entity.prefab.localId}`}>
              Copy of {prefabDisplayName(entity.prefab.prefabId)} — copies are independent
            </div>
          )}
          {!isFolder && (
            <>
              <VecField label="position" values={entity.position} onCommit={(v) => onEditTransform(entity.id, { position: v })} />
              <VecField
                label="rotation"
                values={eulerDegrees(entity.rotation)}
                onCommit={(v) => onEditTransform(entity.id, { rotation: quaternionOf(v) })}
              />
              <VecField label="scale" values={entity.scale} onCommit={(v) => onEditTransform(entity.id, { scale: v })} />
            </>
          )}

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
            Drag the gizmo or type values (Enter commits). W/E/R switch tools, F focuses, Del deletes, Ctrl+Z undoes.
          </p>        </div>
      ) : (
        <div className="tl-inspector__empty">Nothing selected.</div>
      )}
    </div>
  );
}
