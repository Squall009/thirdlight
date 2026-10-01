/**
 * What the preview pane's controls share: the editor's dependencies for
 * building subjects, the controls' props, and the hook that shows one subject
 * on the pane's renderer while the controls are mounted.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';

import type { PreviewEnvironment, PreviewRenderer, PreviewSubject } from '../../viewport/preview-renderer';
import type { StartPreview } from '../animator/parts';
import type { PreviewRequest } from './preview-request';

/** What the pane needs from the editor to build its subjects. */
export interface PreviewDeps {
  /** The active scene's look with its wind (null: a neutral backdrop). */
  environment: PreviewEnvironment;
  /** A texture asset's texture (the editor's decoded bytes, shared with the Scene view). */
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** A model asset as a new object (a material's preview shape); `dispose` releases it. */
  loadModel: (assetId: string) => Promise<{ root: THREE.Object3D; dispose: () => void } | null>;
  /** A model asset's scene (an effect's mesh particles and mesh-surface shapes). */
  loadEffectModel: (assetId: string) => Promise<THREE.Object3D | null>;
  /** A controller running on its model under the stage. */
  startAnimator: StartPreview;
}

export interface PreviewControlsProps<K extends PreviewRequest['kind']> {
  renderer: PreviewRenderer;
  request: Extract<PreviewRequest, { kind: K }>;
  deps: PreviewDeps;
}

/**
 * Show `make()`'s subject on the renderer while the calling controls are
 * mounted (made once per mount; released when they unmount).
 */
export function useSubject<S extends PreviewSubject>(renderer: PreviewRenderer, make: () => S): S | null {
  const [subject, setSubject] = useState<S | null>(null);
  const makeRef = useRef(make);
  makeRef.current = make;
  useEffect(() => {
    const s = makeRef.current();
    renderer.show(s);
    setSubject(s);
    return () => {
      if (renderer.shown() === s) renderer.show(null);
      else s.dispose();
    };
  }, [renderer]);
  return subject;
}
