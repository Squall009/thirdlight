/**
 * The prefab editor: a prefab opened on its own, in the edit-mode shell.
 *
 * It edits the prefab's stage (`usePrefabStage`): the prefab's objects
 * alone, at the prefab's own place, with nothing of the scene around them
 * (Context shows the scene, not pickable). Its column lists the prefab's
 * objects (a copy of another prefab nested in it shows as that copy) and
 * holds the one Inspector for the one picked. Every edit is an ordinary
 * command naming a stage object, which the backend stores as the prefab
 * changed: one undo step, and every copy in every scene follows it. Editing
 * a nested copy's object writes an override on that nested copy, as editing
 * a copy in a scene does.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import type { ProjectedEntity } from '../../session/projection';
import { onPrefabStage, type PrefabStage } from '../shell/usePrefabStage';
import type { EditModeView, ObjectEditModeKind } from './modes';

/** What the prefab editor reads from the app besides the shared host. */
export interface PrefabModeHost {
  readonly stage: PrefabStage | null;
  /** The display name of a prefab (its id when unknown). */
  readonly prefabName: (prefabId: string) => string;
  /** The object picked (the Inspector's). */
  readonly selectedId: string | null;
  readonly select: (id: string | null) => void;
  /** The one Inspector, drawn in the column while the prefab editor shows. */
  readonly inspector: () => ReactNode;
}

/** The stage's objects in hierarchy order, each with its depth. */
function rows(stage: PrefabStage): { e: ProjectedEntity; depth: number }[] {
  const kids = new Map<string | null, ProjectedEntity[]>();
  for (const e of stage.entities) {
    const list = kids.get(e.parentId) ?? [];
    list.push(e);
    kids.set(e.parentId, list);
  }
  const out: { e: ProjectedEntity; depth: number }[] = [];
  const walk = (id: string | null, depth: number): void => {
    for (const e of kids.get(id) ?? []) {
      out.push({ e, depth });
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function PrefabColumn({ host }: EditModeView): JSX.Element {
  const p = host.prefab;
  const stage = p.stage;
  if (stage === null) return <p className="tl-muted">Reading the prefab…</p>;
  return (
    <div className="tl-prefab-mode">
      <ul className="tl-prefab-mode__parts" role="tree" aria-label="prefab objects">
        {rows(stage).map(({ e, depth }) => {
          const nested = e.prefab !== undefined && e.prefab.prefabId !== stage.prefabId ? e.prefab.prefabId : null;
          const selected = p.selectedId === e.id;
          return (
            <li key={e.id} role="treeitem" aria-selected={selected} aria-level={depth + 1}>
              <button
                className={selected ? 'tl-prefab-mode__part is-selected' : 'tl-prefab-mode__part'}
                style={{ paddingLeft: `${0.5 + depth}em` }}
                data-entity-id={e.id}
                onClick={() => p.select(e.id)}
                title={nested !== null ? `A copy of ${p.prefabName(nested)}: its edits are overrides on this copy` : e.name}
              >
                {e.name}
                {nested !== null && <span className="tl-prefab-mode__nested"> · copy of {p.prefabName(nested)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {p.selectedId !== null && stage.entities.some((e) => e.id === p.selectedId) ? (
        <div className="tl-prefab-mode__inspector">{p.inspector()}</div>
      ) : (
        <p className="tl-muted">Pick an object of the prefab to change it. Every copy follows.</p>
      )}
    </div>
  );
}

export const prefabMode: ObjectEditModeKind = {
  kind: 'prefab',
  label: 'Prefab',
  action: 'Open prefab',
  applies: (e) => onPrefabStage(e) && e.parentId === null,
  framesOnEnter: true,
  ownStage: true,
  meta: () => 'Every copy follows its edits',
  rail: [{ id: 'objects', label: 'Objects', glyph: 'stack', hint: 'Pick an object of the prefab and change it in the column; every copy follows.', navigate: 'A drag orbits; a click picks an object of the prefab.' }],
  tools: [],
  companions: (e, entities) => entities.filter((x) => onPrefabStage(x) && x.id !== e.id).map((x) => x.id),
  column: (view) => <PrefabColumn {...view} />,
};
