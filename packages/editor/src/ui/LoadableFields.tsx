/**
 * One item's address and labels in its inspector (the Assets tab's side
 * panel for an asset): the address field sets it on Enter or when the field
 * is left (empty: none), a label is added from the field and removed with
 * its ×. Each change is one command (one undo). Something with an address or
 * a label is loadable: Play and export ship it even if no scene uses it.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

import { labelsOf, type LoadableItem, type LoadingNameActions } from './useLoadingNames';

interface Props {
  item: LoadableItem;
  address: string | null;
  labels: readonly string[];
  actions: LoadingNameActions;
}

export function LoadableFields(p: Props): JSX.Element {
  const [address, setAddress] = useState(p.address ?? '');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The field follows the item and its committed value (an undo, another client).
  useEffect(() => setAddress(p.address ?? ''), [p.address, p.item.kind, p.item.id]);
  useEffect(() => setError(null), [p.item.kind, p.item.id]);
  const commitAddress = async (): Promise<void> => {
    const next = address.trim() === '' ? null : address.trim();
    if (next === p.address) return;
    setError(await p.actions.setAddress(p.item, next));
  };
  const addLabels = async (): Promise<void> => {
    const add = labelsOf(label);
    if (add.length === 0) return;
    const err = await p.actions.setLabels([p.item], add, []);
    setError(err);
    if (err === null) setLabel('');
  };
  const loadable = p.address !== null || p.labels.length > 0;
  return (
    <div className="tl-loadable" data-testid="loadable-fields">
      <div className="tl-subhead" title="The names a script loads this by; anything with an address or a label ships with Play and export even when no scene uses it">
        Loading {loadable ? '· loadable' : '· not loadable'}
      </div>
      <label className="tl-field" title="The one name a script loads this by (unique in the project; empty: none)">
        <span className="tl-field__label">address</span>
        <input
          className="tl-input"
          aria-label="address"
          placeholder="none"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => void commitAddress()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitAddress();
            if (e.key === 'Escape') setAddress(p.address ?? '');
          }}
        />
      </label>
      <div className="tl-loadable__labels" data-testid="loadable-labels">
        {p.labels.map((l) => (
          <span key={l} className="tl-chip" data-label={l}>
            {l}
            <button className="tl-chip__x" aria-label={`remove label ${l}`} title="Remove this label (one undo)" onClick={() => void p.actions.setLabels([p.item], [], [l]).then(setError)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <label className="tl-field" title="Labels a script loads groups by (a letter or digit, then letters, digits, _ - . /); several separated by commas">
        <span className="tl-field__label">add label</span>
        <input
          className="tl-input"
          aria-label="add label"
          placeholder="voice, level-3"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addLabels();
          }}
        />
      </label>
      {error !== null && (
        <div className="tl-assets__error" role="alert" data-testid="loadable-error" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Labels for several items at once (the Assets tab's multi-selection): the
 * labels typed are added to, or removed from, every chosen item in one
 * command.
 */
export function LabelsBar(p: { items: readonly LoadableItem[]; actions: LoadingNameActions; onClear: () => void }): JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const apply = async (mode: 'add' | 'remove'): Promise<void> => {
    const labels = labelsOf(text);
    if (labels.length === 0) return;
    const err = await p.actions.setLabels(p.items, mode === 'add' ? labels : [], mode === 'remove' ? labels : []);
    setError(err);
    if (err === null) setText('');
  };
  return (
    <div className="tl-labels-bar" data-testid="labels-bar">
      <span className="tl-labels-bar__count">{p.items.length} chosen</span>
      <input className="tl-input tl-input--small" aria-label="label the chosen assets" placeholder="voice, level-3" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void apply('add')} />
      <button className="tl-btn tl-btn--small" onClick={() => void apply('add')} title="Add these labels to every chosen asset (one undo)">
        add labels
      </button>
      <button className="tl-btn tl-btn--small" onClick={() => void apply('remove')} title="Remove these labels from every chosen asset (one undo)">
        remove labels
      </button>
      <button className="tl-btn tl-btn--small" onClick={p.onClear} title="Choose none (click an asset to choose one; Ctrl/Cmd-click adds or removes one, Shift-click a range)">
        clear
      </button>
      {error !== null && (
        <span className="tl-assets__error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
