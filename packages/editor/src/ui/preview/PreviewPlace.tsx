/**
 * A place an editor gives the editor window's one preview pane (its Preview
 * panel): while it is mounted the pane is drawn here instead of above the
 * Inspector, with the same renderer.
 *
 * Browser-only (React).
 */
import { useContext, useLayoutEffect, useRef, type JSX } from 'react';

import { PreviewPlaceContext } from './preview-request';

export function PreviewPlace(): JSX.Element {
  const set = useContext(PreviewPlaceContext);
  const el = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    set(el.current);
    return () => set(null);
  }, [set]);
  return <div className="tl-preview-place" ref={el} />;
}
