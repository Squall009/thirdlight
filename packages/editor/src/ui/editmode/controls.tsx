/**
 * The small controls the edit modes' columns share: a collapsible Section
 * (a caps header with an aside), a Toggle (a switch with its label and key)
 * and a Segmented choice. One each, so every editor's column reads alike.
 *
 * Browser-only (React).
 */
import { useState, type JSX, type ReactNode } from 'react';

import { Kbd } from './Kbd';

/** A column section: its header (click to fold), the aside on the right (a tag, a picker, a count), its body. */
export function Section({ title, aside, children, open: initial = true }: { title: string; aside?: ReactNode; children: ReactNode; open?: boolean }): JSX.Element {
  const [open, setOpen] = useState(initial);
  return (
    <section className={`tl-sec${open ? '' : ' is-closed'}`} aria-label={title.toLowerCase()}>
      <div className="tl-sec__head">
        <button type="button" className="tl-sec__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg className="tl-sec__chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d={open ? 'M3 4.5l3 3 3-3' : 'M4.5 3l3 3-3 3'} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>{title}</span>
        </button>
        {aside !== undefined && <span className="tl-sec__aside">{aside}</span>}
      </div>
      {open && <div className="tl-sec__body">{children}</div>}
    </section>
  );
}

/** An on/off switch with its label and, when it has one, its key. */
export function Toggle({ label, on, onChange, aria, keyName, hint, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; aria?: string; keyName?: string; hint?: string; disabled?: boolean }): JSX.Element {
  return (
    <label className={`tl-toggle${disabled === true ? ' is-disabled' : ''}`} title={hint}>
      <input type="checkbox" role="switch" className="tl-toggle__input" aria-label={aria ?? label.toLowerCase()} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="tl-switch" aria-hidden="true">
        <span />
      </span>
      <span>{label}</span>
      {keyName !== undefined && <Kbd k={keyName} />}
    </label>
  );
}

/** One choice of a few, side by side. */
export function Segmented<T extends string | number>({ options, value, onChange, aria, small, disabled }: { options: readonly { id: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void; aria: string; small?: boolean; disabled?: boolean }): JSX.Element {
  return (
    <div className={`tl-seg${small === true ? ' tl-seg--sm' : ''}${disabled === true ? ' is-disabled' : ''}`} role="radiogroup" aria-label={aria} aria-disabled={disabled === true ? true : undefined}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? 'is-active' : ''} title={o.hint} disabled={disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
