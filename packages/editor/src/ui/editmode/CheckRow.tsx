/**
 * One check's row, the same wherever a check is shown (the kit editor's
 * piece checks and trim checker, the decal atlas's page warning, stale
 * vertex paint): a state glyph, a title, one line of detail, an optional
 * action. ok rows are quiet; warnings sit on the warning tint, errors on the
 * error tint; info says what was not checked.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import { Glyph } from './glyphs';

export type CheckRowState = 'ok' | 'warn' | 'err' | 'info';

const GLYPH: Record<CheckRowState, string> = { ok: 'check', warn: 'warn', err: 'cross', info: 'info' };

export function CheckRow(p: { state: CheckRowState; title: ReactNode; detail?: ReactNode; action?: ReactNode; aria?: string; role?: 'note' | 'alert' | 'listitem'; id?: string; className?: string }): JSX.Element {
  return (
    <div className={`tl-check tl-check--${p.state}${p.className !== undefined ? ` ${p.className}` : ''}`} role={p.role ?? 'listitem'} aria-label={p.aria} data-check={p.id} data-state={p.state}>
      <span className="tl-check__glyph">
        <Glyph name={GLYPH[p.state]} size={15} />
      </span>
      <div className="tl-check__text">
        <b>{p.title}</b>
        {p.detail !== undefined && <p>{p.detail}</p>}
      </div>
      {p.action}
    </div>
  );
}
