/**
 * The edit mode's status line: the current tool or mode in the brush colour,
 * one plain sentence of what to do, then its keys as chips with what they do.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import type { KeyHint } from '../../session/edit-keys';
import { Chord } from './Kbd';

export function StatusHints({ tool, text, keys, right }: { tool: string; text: string; keys: readonly KeyHint[]; right?: string }): JSX.Element {
  return (
    <footer className="tl-hints" aria-label="edit mode hints">
      <b className="tl-hints__tool">{tool}</b>
      <span className="tl-hints__text">{text}</span>
      <span className="tl-hints__keys">
        {keys.map((h) => (
          <span className="tl-hint-key" key={`${h.keys.join('+')}:${h.label}`}>
            <Chord keys={h.keys} />
            <span>{h.label}</span>
          </span>
        ))}
      </span>
      {right !== undefined && <span className="tl-hints__right">{right}</span>}
    </footer>
  );
}
