/**
 * Phase 20.0: the Effects list (bottom dock) — the project's visual effects
 * with their systems; create (a name → an id), rename, delete and open (the
 * "Effect: <name>" centre tab). Each action is one command (setEffect,
 * renameEffect, deleteEffect).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { EffectDef } from '@thirdlight/project-model';

interface Props {
  effects: readonly EffectDef[];
  openId: string | null;
  error: string | null;
  onOpen: (effectId: string) => void;
  onCreate: (name: string) => void;
  onRename: (effectId: string, name: string) => void;
  onDelete: (effectId: string) => void;
}

export function EffectsPanel({ effects, openId, error, onOpen, onCreate, onRename, onDelete }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="tl-panel tl-effects">
      <div className="tl-panel__title">Effects</div>
      <form
        className="tl-graphs__new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() === '') return;
          onCreate(name.trim());
          setName('');
        }}
      >
        <input className="tl-input" aria-label="New effect name" placeholder="New effect name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === ''}>
          Create effect
        </button>
      </form>
      <p className="tl-hint">Visual effects are particle systems authored as node graphs (visual only: they never change the game simulation). Objects play one with the Effect component.</p>
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
      {effects.length === 0 ? (
        <div className="tl-inspector__empty">No effects yet.</div>
      ) : (
        <ul className="tl-effects__list" aria-label="Effect list">
          {effects.map((fx) => (
            <li key={fx.effectId} className={`tl-effects__row${openId === fx.effectId ? ' is-active' : ''}`} data-effect-id={fx.effectId} onDoubleClick={() => onOpen(fx.effectId)}>
              {renaming?.id === fx.effectId ? (
                <input
                  autoFocus
                  className="tl-input"
                  aria-label="Effect name"
                  maxLength={128}
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: fx.effectId, name: e.target.value })}
                  onBlur={() => {
                    if (renaming.name.trim() !== '' && renaming.name.trim() !== fx.name) onRename(fx.effectId, renaming.name.trim());
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="tl-effects__name">{fx.name}</span>
              )}
              <span className="tl-effects__meta">
                {fx.systems.length} system{fx.systems.length === 1 ? '' : 's'} · {fx.duration} s{fx.loop ? ' loop' : ''}
              </span>
              <button className="tl-btn tl-btn--small" onClick={() => onOpen(fx.effectId)} aria-label={`Open ${fx.name}`}>
                Open
              </button>
              <button className="tl-btn tl-btn--small" onClick={() => setRenaming({ id: fx.effectId, name: fx.name })} aria-label={`Rename ${fx.name}`}>
                Rename
              </button>
              <button className="tl-btn tl-btn--small" onClick={() => onDelete(fx.effectId)} aria-label={`Delete ${fx.name}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
