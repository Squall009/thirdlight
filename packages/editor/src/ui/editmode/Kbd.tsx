/**
 * A key as the edit modes show it (a chip), and a chord of keys ("Shift + 1–7").
 *
 * Browser-only (React).
 */
import { Fragment, type JSX } from 'react';

export function Kbd({ k }: { k: string }): JSX.Element {
  return <kbd className="tl-kbd">{k}</kbd>;
}

/** The parts of a chord, each a key chip, joined by "+" (a part "a / b" is either key: two chips with "/"). */
export function Chord({ keys }: { keys: readonly string[] }): JSX.Element {
  return (
    <span className="tl-chord">
      {keys.map((k, i) => (
        <Fragment key={`${i}:${k}`}>
          {i > 0 && <i aria-hidden="true">+</i>}
          {k.split(' / ').map((a, j) => (
            <Fragment key={a}>
              {j > 0 && <i aria-hidden="true">/</i>}
              <Kbd k={a} />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
