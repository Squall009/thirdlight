/**
 * The Inspector's header for an object of a linked prefab copy: the prefab
 * the copy links (a variant with the prefabs it is made from), the
 * **Overrides** dropdown listing every override of the copy and every object
 * added to it (each reverted or applied to the prefab, or all of them), **Open prefab** and **Unpack**.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { PrefabOverride } from '@thirdlight/project-model';

import { overrideLabel, type PrefabCopyView } from '../session/prefab-copy';

/** What a Revert or Apply names: one override (its part and path), one part, or all. */
export interface OverrideTarget {
  part?: string;
  path?: string;
  all?: true;
}

export function overrideTarget(o: PrefabOverride): OverrideTarget {
  return 'path' in o ? { part: o.part, path: o.path } : { part: o.part };
}

export function PrefabCopyHeader(p: {
  copy: PrefabCopyView;
  /** The selected object's name (a part shows which copy it belongs to). */
  copyName: string;
  /** The linked prefab, then (a variant) the prefabs it is made from, by display name. */
  chain: readonly string[];
  /** A part's display name by its path key. */
  partName: (key: string) => string;
  /** Objects added to the copy under its parts (not overrides: an object is applied to the prefab, or deleted). */
  added: readonly { id: string; name: string }[];
  onRevert: (t: OverrideTarget) => void;
  onApply: (t: OverrideTarget) => void;
  /** Apply one added object: it becomes a part of the prefab (a linked copy: a nested one). */
  onApplyAdded: (entityId: string) => void;
  onOpen: () => void;
  onUnpack: () => void;
}): JSX.Element {
  const { copy } = p;
  const [name, ...bases] = p.chain;
  const n = copy.overrides.length + p.added.length;
  return (
    <div className="tl-copy" aria-label="prefab copy" data-prefab-id={copy.prefabId}>
      <div className="tl-copy__line">
        <span>{copy.root ? 'Copy of' : `Part of ${p.copyName}, a copy of`}</span>
        <span className="tl-copy__name" aria-label="copy prefab">{name}</span>
        {bases.length > 0 && <span className="tl-copy__base" aria-label="variant base">variant of {bases.join(' → ')}</span>}
      </div>
      <div className="tl-copy__line">
        <button type="button" className="tl-btn tl-btn--small" title="Open the prefab on its own: an edit there reaches every copy, except what a copy overrides" onClick={p.onOpen}>
          Open prefab
        </button>
        <button type="button" className="tl-btn tl-btn--small" title="Make this copy plain objects with no link to the prefab (nested copies too); later prefab edits no longer reach it" onClick={p.onUnpack}>
          Unpack
        </button>
      </div>
      <details className="tl-copy__overrides" aria-label="overrides">
        <summary>Overrides ({n})</summary>
        {n === 0 ? (
          <p className="tl-muted">This copy is the same as its prefab.</p>
        ) : (
          <>
            <ul className="tl-copy__list">
              {copy.overrides.map((o, i) => {
                const label = overrideLabel(o, p.partName(o.part));
                return (
                  <li key={i} className="tl-copy__item">
                    <span title={'path' in o ? `${o.part} · ${o.path}` : o.part}>{label}</span>
                    <button type="button" className="tl-btn tl-btn--small" aria-label={`revert ${label}`} title="Take the prefab's value back" onClick={() => p.onRevert(overrideTarget(o))}>
                      Revert
                    </button>
                    <button type="button" className="tl-btn tl-btn--small" aria-label={`apply ${label}`} title="Write this into the prefab: every copy gets it" onClick={() => p.onApply(overrideTarget(o))}>
                      Apply
                    </button>
                  </li>
                );
              })}
              {p.added.map((a) => (
                <li key={a.id} className="tl-copy__item">
                  <span title={a.id}>{a.name} (added)</span>
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`apply added ${a.name}`} title="Make it a part of the prefab: every copy gets it" onClick={() => p.onApplyAdded(a.id)}>
                    Apply
                  </button>
                </li>
              ))}
            </ul>
            <div className="tl-copy__line">
              <button type="button" className="tl-btn tl-btn--small" title="Drop every override: the copy is its prefab again (objects added to it stay)" onClick={() => p.onRevert({ all: true })}>
                Revert all
              </button>
              <button type="button" className="tl-btn tl-btn--small" title="Write every override (and the objects added to the copy) into the prefab" onClick={() => p.onApply({ all: true })}>
                Apply all
              </button>
            </div>
          </>
        )}
      </details>
    </div>
  );
}
