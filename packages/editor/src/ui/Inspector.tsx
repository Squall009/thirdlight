/**
 * Transform inspector (React, decision 0001 §10) — the selected entity's
 * transform readout + gizmo mode. Display only: edits flow through the
 * gizmo (one commit command) and create/delete/undo/redo (toolbar), never
 * through direct scene mutation.
 */
import type { JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import type { GizmoMode } from '../viewport/gizmo';

interface Props {
  entity: ProjectedEntity | null;
  gizmoMode: GizmoMode;
  onGizmoMode: (m: GizmoMode) => void;
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

export function Inspector({ entity, gizmoMode, onGizmoMode }: Props): JSX.Element {
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
          <Vec label="position" values={entity.position} />
          <Vec label="rotation (quat)" values={entity.rotation} />
          <Vec label="scale" values={entity.scale} />
          <p className="tl-inspector__hint">
            Drag the gizmo in the viewport to edit. One undoable command commits on release.
          </p>
        </div>
      ) : (
        <div className="tl-inspector__empty">Nothing selected.</div>
      )}
    </div>
  );
}