/**
 * The New material dialog: the defaults a material starts from, each with
 * its preview, what it is for and what it reads (paint, layer weights, …),
 * and the new material's name. Enter or Create makes it (one command, one
 * undo); a material made here is the project's own, and Customize in its
 * Inspector turns it into a node graph to change further.
 *
 * Rendered over the page (a portal), so the project window's keys and
 * right-click menu stay out of it.
 *
 * Browser-only (React).
 */
import { useMemo, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';

import { declarationLabels, MATERIAL_DEFAULT_KEY, MATERIAL_DEFAULTS } from '../../session/material-defaults';
import { Dialog } from '../Dialog';

export interface NewMaterialDialogProps {
  /** The name it suggests. */
  defaultName: string;
  /** Make it from a default (its key); resolves to the refusal's message, or null. */
  onCreate: (key: string, name: string) => Promise<string | null>;
  onClose: () => void;
}

export function NewMaterialDialog(p: NewMaterialDialogProps): JSX.Element {
  const [picked, setPicked] = useState(MATERIAL_DEFAULT_KEY);
  const [name, setName] = useState(p.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What each default reads, from the material it makes (the same check the editors make).
  const reads = useMemo(() => new Map(MATERIAL_DEFAULTS.map((d) => [d.key, declarationLabels(d.make('preview', d.label))])), []);
  const create = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const err = await p.onCreate(picked, name);
      setError(err);
      if (err === null) p.onClose();
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <Dialog title="New material" onClose={p.onClose} className="tl-dialog--wide">
      <p className="tl-hint">Start from a default. You can change everything later; Customize in its Inspector turns it into a node graph of your own.</p>
      <div className="tl-newmat__grid" role="radiogroup" aria-label="material defaults">
        {MATERIAL_DEFAULTS.map((d) => (
          <button
            key={d.key}
            type="button"
            role="radio"
            aria-checked={picked === d.key}
            aria-label={d.label}
            data-default={d.key}
            className={`tl-newmat__card${picked === d.key ? ' is-picked' : ''}`}
            onClick={() => setPicked(d.key)}
            onDoubleClick={() => {
              setPicked(d.key);
              void create();
            }}
          >
            <img className="tl-newmat__preview" src={d.preview} alt="" width={80} height={80} draggable={false} />
            <span className="tl-newmat__text">
              <b>{d.label}</b>
              <span className="tl-newmat__use">{d.use}</span>
              {(reads.get(d.key) ?? []).length > 0 && (
                <span className="tl-newmat__reads">
                  {reads.get(d.key)!.map((r) => (
                    <span key={r} className="tl-tag">
                      {r}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="tl-newmat__name">
        <label className="tl-field">
          <span className="tl-field__label">name</span>
          <input
            className="tl-input"
            aria-label="new item name"
            autoFocus
            onFocus={(e) => e.target.select()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
        </label>
        <button type="button" className="tl-btn" onClick={p.onClose}>
          Cancel
        </button>
        <button type="button" className="tl-btn tl-btn--primary" aria-label="create material" disabled={busy || name.trim() === ''} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error !== null && (
        <p className="tl-dialog__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>,
    document.body,
  );
}
