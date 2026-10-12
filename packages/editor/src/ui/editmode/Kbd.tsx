/**
 * A key as the edit modes show it (a chip), and a chord of keys ("Shift + 1–7").
 *
 * Browser-only (React).
 */
import { Fragment, type JSX } from 'react';

export function Kbd({ k }: { k: string }): JSX.Element {
  return <kbd className="tl-kbd">{k}</kbd>;
}

/** The parts of a chord, each a key chip, joined by "+". */
export function Chord({ keys }: { keys: readonly string[] }): JSX.Element {
  return (
    <span className="tl-chord">
      {keys.map((k, i) => (
        <Fragment key={`${i}:${k}`}>
          {i > 0 && <i aria-hidden="true">+</i>}
          <Kbd k={k} />
        </Fragment>
      ))}
    </span>
  );
}
