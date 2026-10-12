/**
 * The status line's words from the mode's column: the tool picked and what
 * to do with it ("Raise · Drag on the ground to raise it."), its own keys,
 * and a readout on the right. A column says it with `useEditStatus`; the
 * shell shows the rail mode's hint when the column says nothing.
 *
 * Browser-only (React).
 */
import { createContext, useContext, useEffect } from 'react';

import type { KeyHint } from '../../session/edit-keys';

export interface EditStatus {
  readonly tool: string;
  readonly text: string;
  /** The tool's own keys, listed before the mode's and the shared ones. */
  readonly keys?: readonly KeyHint[];
  readonly right?: string;
}

export const EditStatusContext = createContext<((s: EditStatus | null) => void) | null>(null);

/** Say what the status line shows while the column is up (null: the mode's own hint). */
export function useEditStatus(status: EditStatus | null): void {
  const set = useContext(EditStatusContext);
  const key = JSON.stringify(status);
  useEffect(() => {
    set?.(key === 'null' ? null : (JSON.parse(key) as EditStatus));
  }, [set, key]);
  useEffect(() => () => set?.(null), [set]);
}
