/**
 * What the decal editor does over the Scene view while it shows, in every
 * rail mode: the Scene view's decal tool armed for the mode (Place, Scatter,
 * Select) with the editor's settings and selection. Opened on a decal (a
 * double-click on it), that decal starts selected; opened otherwise, nothing
 * is.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, type JSX } from 'react';

import type { DecalToolMode } from '../../viewport/decal-tool';
import type { SceneModeView } from '../editmode/modes';

const MODES: readonly DecalToolMode[] = ['place', 'scatter', 'select'];

export function DecalView({ mode, host, focus }: SceneModeView): JSX.Element | null {
  const tools = host.decals;
  const { arm, select } = tools;
  // The selection it opened with (once per opening).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    select(focus === null ? [] : [focus], focus);
  }, [focus, select]);
  const toolMode = MODES.find((m) => m === mode) ?? null;
  useEffect(() => {
    arm(toolMode, host.entities);
  }, [arm, toolMode, host.entities]);
  // Off when the editor closes (not when the wiring changes: re-arming keeps the stamps' count).
  const armRef = useRef(arm);
  armRef.current = arm;
  useEffect(() => () => armRef.current(null, []), []);
  return null;
}
