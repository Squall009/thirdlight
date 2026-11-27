/**
 * A number field of the material Inspector: committed on blur or Enter, an
 * empty field meaning "absent" (the format's default).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

/** A number field committed on blur or Enter (empty: absent). */
export function NumberField(p: { aria: string; value: number | undefined; placeholder: string; min: number; max: number; step: number; onCommit: (v: number | undefined) => void }): JSX.Element {
  const [draft, setDraft] = useState(p.value === undefined ? '' : String(p.value));
  useEffect(() => setDraft(p.value === undefined ? '' : String(p.value)), [p.value]);
  const commit = (): void => {
    const t = draft.trim();
    const v = t === '' ? undefined : Math.min(p.max, Math.max(p.min, Number(t)));
    if (v !== undefined && !Number.isFinite(v)) return;
    if (v !== p.value) p.onCommit(v);
  };
  return (
    <input
      className="tl-input tl-input--num"
      type="number"
      aria-label={p.aria}
      min={p.min}
      max={p.max}
      step={p.step}
      placeholder={p.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
