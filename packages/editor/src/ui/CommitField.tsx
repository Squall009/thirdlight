/**
 * The editor's one commit-on-Enter/blur field, so every text and number box
 * that edits a stored value behaves the same way:
 *
 * - typing changes only the draft; Enter, or leaving the field, commits the
 *   draft once, and only when it differs from the stored text;
 * - Escape puts the stored text back and leaves the field without a commit;
 * - a multi-line box commits on Enter too; Shift+Enter is a new line;
 * - out of the field it always shows the stored value: after a commit (what
 *   the backend kept, or the old value when the draft was refused) and when
 *   the value changes underneath it.
 *
 * `NumberField` adds the number rules: an empty box is `null` when the field
 * is `optional` and refused otherwise, a draft that is not a finite number is
 * refused, and a number outside [min, max] is clamped or refused as
 * `outOfRange` says (refused by default). A refused draft commits nothing.
 *
 * Browser-only (React).
 */
import { useRef, useState, type JSX, type KeyboardEvent } from 'react';

import { numberDraft, type NumberDraftRules } from '../session/number-draft';

export interface CommitFieldProps {
  /** The stored value as text. */
  value: string;
  /** The accessible name. */
  label: string;
  onCommit: (text: string) => void;
  title?: string;
  className?: string;
  placeholder?: string;
  list?: string;
  maxLength?: number;
  multiline?: boolean;
  /** A browser input type (`number` gives the spin buttons; the commit rules stay these). */
  type?: string;
  min?: number;
  max?: number;
  step?: number;
}

export function CommitField(p: CommitFieldProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the field, and that blur must not commit.
  const cancelled = useRef(false);
  const commit = (): void => {
    const d = draft;
    setDraft(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (d !== null && d !== p.value) p.onCommit(d);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !(p.multiline === true && e.shiftKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      cancelled.current = true;
      e.currentTarget.blur();
    }
  };
  const common = {
    className: p.className ?? 'tl-input',
    'aria-label': p.label,
    title: p.title,
    placeholder: p.placeholder,
    maxLength: p.maxLength,
    value: draft ?? p.value,
    onFocus: () => {
      cancelled.current = false;
      setDraft(p.value);
    },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown,
  };
  if (p.multiline === true) return <textarea {...common} rows={3} />;
  return <input {...common} type={p.type} min={p.min} max={p.max} step={p.step} list={p.list} />;
}

type NumberValue =
  | { optional: true; value: number | null; onCommit: (value: number | null) => void }
  | { optional?: false; value: number; onCommit: (value: number) => void };

export type NumberFieldProps = Omit<CommitFieldProps, 'value' | 'onCommit' | 'multiline'> & Omit<NumberDraftRules, 'optional'> & NumberValue;

export function NumberField(p: NumberFieldProps): JSX.Element {
  const { value, onCommit, min, max, outOfRange, optional, className, ...rest } = p;
  return (
    <CommitField
      {...rest}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      className={className ?? 'tl-input tl-input--num'}
      value={value === null ? '' : String(value)}
      onCommit={(text) => {
        const next = numberDraft(text, { min, max, outOfRange, optional: optional === true });
        // An empty box reads null only in an optional field, whose callback takes it.
        if (next !== undefined && next !== value) (onCommit as (v: number | null) => void)(next);
      }}
    />
  );
}
