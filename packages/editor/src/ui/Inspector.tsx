/**
 * Inspector (React, decision 0001 §10; packet 10 + packet 28).
 *
 * The selected entity's name, flags, tags and gizmo mode, then (phase 15.1)
 * one section per component built from its descriptor (`DescriptorFields`),
 * with descriptor-keyed extensions where a custom widget adds something (the
 * capsule's "Fit to model", an exit's editor, the material mapping, the
 * script's declared properties), and "+ Add component".
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
import type { ComponentDescriptor, DescriptorRegistry, PropertyDeclaration } from '@thirdlight/project-model';
import type { ProjectedEntity } from '../session/projection';
import type { EffectiveEntityFlags } from '../session/hierarchy';
import { deriveBehaviorControls } from '../session/property-controls';
import { addEntries, componentOp, componentPatch, firstReference, removable, seedsOf, type FieldPath } from '../session/descriptor-fields';
import { CAPSULE_LIMITS } from '@thirdlight/runtime';
import type { GizmoMode } from '../viewport/viewport';
import { PropertyControlList, type ControlErrorView } from './PropertyControls';
import { AddComponent, ComponentSection, type AddExtra, type FieldContext } from './DescriptorFields';

interface Props {
  entity: ProjectedEntity | null;
  gizmoMode: GizmoMode;
  onGizmoMode: (m: GizmoMode) => void;
  /** Phase 15.1: the component descriptors (null until the first game query answered). */
  registry: DescriptorRegistry | null;
  /** Phase 15.1: what the reference pickers offer. */
  fieldContext: FieldContext;
  /** Published declarations (the only schema source), keyed by behaviorId. */
  declarations: ReadonlyMap<string, PropertyDeclaration>;
  /** Display name of a definition, for the copy provenance label. */
  prefabDisplayName: (prefabId: string) => string;
  /** The last property-command error (bounded), when one occurred. */
  propertyError: ControlErrorView | null;
  componentError: ControlErrorView | null;
  onEditProperty: (entityId: string, key: string, raw: string) => void;
  /** Phase 15.1: one component edit (a partial top-level value) or, with null, its removal — one command. */
  onComponentEdit: (entityId: string, component: string, patch: Record<string, unknown> | null) => void;
  /** Phase 15.1: "+ Add component" with the descriptor's value (or the picked one). */
  onAddComponent: (entityId: string, component: string, value: Record<string, unknown>) => void;
  /** Phase 14.0: size the capsule to the entity's models. */
  onFitCapsule?: (entityId: string) => void;
  /** Phase 14.0: the name of the player this entity hangs under (it collides with that capsule), else null. */
  capsuleOwner?: string | null;
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
  /** Phase 15.1: custom section bodies by component (e.g. the material mapping, which knows the model's material names). */
  bodies?: Partial<Record<string, ReactNode>>;
  /** Phase 15.1: extra widgets after a component's fields (e.g. surface presets). */
  extensions?: Partial<Record<string, ReactNode>>;
  /** Phase 15.1: sections shown even while the component is absent (their body adds it). */
  alwaysShow?: readonly string[];
  /** Phase 15.2: extra "+ Add component" actions (a collider from the model's outline). */
  addExtras?: readonly AddExtra[];
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

/**
 * Phase 14.0 (15.1: a descriptor-keyed extension of the controller section):
 * the capsule note, "Fit to model" and "Default" next to the generic capsule
 * fields.
 */
function CapsuleExtras(props: { stored: boolean; onFit: () => void; onDefault: () => void }): JSX.Element {
  const L = CAPSULE_LIMITS;
  return (
    <>
      <p className="tl-inspector__hint">
        A capsule {props.stored ? '' : '(the default: an adult human) '}that every system uses: physics, spawns, zones, pickups and stomps. Drag its top or side handle in the Scene view. Radius {L.minRadius}–{L.maxRadius} m, height {L.minHeight}–{L.maxHeight} m (at least twice the radius), offset up to ±{L.maxOffset} m.
      </p>
      <div className="tl-inspector__modes">
        <button className="tl-btn" onClick={props.onFit} title="Size the capsule to this object's models: their height, half the smaller of width and depth, feet at their lowest point">
          Fit to model
        </button>
        <button className="tl-btn" disabled={!props.stored} onClick={props.onDefault} title="Back to the default capsule">
          Default
        </button>
      </div>
    </>
  );
}

export function Inspector({ entity, gizmoMode, onGizmoMode, registry, fieldContext, declarations, prefabDisplayName, propertyError, componentError, onEditProperty, onComponentEdit, onAddComponent, onFitCapsule, capsuleOwner, onRename, onEditTransform, flags, entityName, selectionCount, onSetFlag, tags, onSetTags, onEditExit, bodies, extensions, alwaysShow, addExtras }: Props): JSX.Element {
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
  const components = entity?.components ?? {};
  const present = new Set(Object.keys(components));
  const sections = registry === null || entity === null ? [] : registry.components.filter((c) => c.name !== 'folder' && (present.has(c.name) || (alwaysShow ?? []).includes(c.name)));
  const edit = (c: ComponentDescriptor, value: Record<string, unknown>) => (path: FieldPath, next: unknown): void => {
    if (entity === null || c.value.type !== 'object') return;
    const patch = componentPatch(c.value, value, path, next, { seeds: seedsOf(c), pick: (f) => firstReference(f, fieldContext) });
    if (patch === null) return;
    if (c.name === 'transform') onEditTransform(entity.id, patch as { position?: number[]; rotation?: number[]; scale?: number[] });
    else onComponentEdit(entity.id, c.name, patch);
  };
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
          {isFolder && <p className="tl-inspector__hint">A folder only organises: it has no transform, and filing objects in it keeps where they are. Active, Locked and Static set here reach everything inside.</p>}
          {entity.prefab && (
            <div className="tl-inspector__copy" title={`${entity.prefab.prefabId} / ${entity.prefab.localId}`}>
              Copy of {prefabDisplayName(entity.prefab.prefabId)} — copies are independent
            </div>
          )}
          {registry === null && <p className="tl-inspector__hint">Loading the component descriptions…</p>}

          {sections.map((c) => {
            const value = (components[c.name] ?? {}) as Record<string, unknown>;
            const op = componentOp(c.name);
            const common = {
              desc: c,
              value,
              ctx: fieldContext,
              onEdit: edit(c, value),
              ...(op === null ? { readOnly: true } : {}),
              ...(present.has(c.name) && removable(c.name) ? { onRemove: () => onComponentEdit(entity.id, c.name, null) } : {}),
            };
            if (c.name === 'behavior') {
              return (
                <ComponentSection
                  key={c.name}
                  {...common}
                  body={
                    behavior === null ? undefined : (
                      <>
                        <div className="tl-field__label">Properties — {behavior.behaviorId}</div>
                        {behavior.error ? (
                          <div className="tl-prop__error" title={behavior.error.message}>
                            {behavior.error.code}: {behavior.error.message}
                          </div>
                        ) : (
                          <PropertyControlList controls={behavior.controls} onCommit={(key, raw) => onEditProperty(entity.id, key, raw)} />
                        )}
                        {propertyError && (
                          <div className="tl-prop__error" title={propertyError.message}>
                            {propertyError.code}: {propertyError.message}
                          </div>
                        )}
                      </>
                    )
                  }
                />
              );
            }
            if (c.name === 'controller') {
              const stored = (value as { capsule?: unknown }).capsule !== undefined;
              return (
                <ComponentSection
                  key={c.name}
                  {...common}
                  className="tl-inspector__collision"
                  data={{ capsule: stored ? 'own' : 'default' }}
                  expandAbsent={['capsule']}
                  extension={<CapsuleExtras stored={stored} onFit={() => onFitCapsule?.(entity.id)} onDefault={() => onComponentEdit(entity.id, 'controller', { capsule: null })} />}
                />
              );
            }
            if (c.name === 'gameZone' && (value as { role?: string }).role === 'exit') {
              return (
                <ComponentSection
                  key={c.name}
                  {...common}
                  extension={
                    <div className="tl-inspector__exit">
                      <p className="tl-inspector__hint">
                        Exit: entering loads {entity.gameZone?.load?.length ? entity.gameZone.load.join(', ') : 'nothing'}, unloads {entity.gameZone?.unload?.length ? entity.gameZone.unload.join(', ') : 'nothing'}
                        {entity.gameZone?.spawnId !== undefined ? `, then moves the player to ${entityName(entity.gameZone.spawnId)}` : ''}.
                      </p>
                      {onEditExit !== undefined && (
                        <button className="tl-btn" onClick={() => onEditExit(entity.id)}>
                          Edit exit…
                        </button>
                      )}
                    </div>
                  }
                />
              );
            }
            if (c.name === 'instances') {
              return (
                <ComponentSection
                  key={c.name}
                  {...common}
                  extension={
                    <>
                      <p className="tl-inspector__hint" data-instances={entity.instances?.count ?? 0}>
                        Instance set: {entity.instances?.count ?? 0} copies of one model, drawn with instancing. The transform moves, turns and scales the whole set; click a copy in the Scene view to edit just that one.
                      </p>
                      {extensions?.['instances']}
                    </>
                  }
                />
              );
            }
            const body = bodies?.[c.name];
            const extension = extensions?.[c.name];
            return <ComponentSection key={c.name} {...common} {...(body !== undefined ? { body } : {})} {...(extension !== undefined ? { extension } : {})} />;
          })}

          {entity.controller !== true && (capsuleOwner ?? null) !== null && !isFolder && (
            <div className="tl-inspector__section tl-inspector__collision" aria-label="collision" data-capsule="parent">
              <div className="tl-panel__title">Collision</div>
              <p className="tl-inspector__hint">Collides with its parent's capsule ({capsuleOwner}).</p>
            </div>
          )}

          {componentError && (
            <div className="tl-prop__error" role="alert" title={componentError.message}>
              {componentError.code}: {componentError.message}
            </div>
          )}

          {registry !== null && !isFolder && (
            <AddComponent entries={addEntries(registry, present, { dimension: fieldContext.physicsDimension ?? 2 })} components={registry.components} ctx={fieldContext} onAdd={(component, value) => onAddComponent(entity.id, component, value)} {...(addExtras !== undefined ? { extras: addExtras } : {})} />
          )}

          <p className="tl-inspector__hint">
            Drag the gizmo or type values (Enter commits). W/E/R switch tools, F focuses, Del deletes, Ctrl+Z undoes.
          </p>
        </div>
      ) : (
        <div className="tl-inspector__empty">Nothing selected.</div>
      )}
    </div>
  );
}
