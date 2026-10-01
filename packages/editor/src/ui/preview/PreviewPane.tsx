/**
 * The editor window's preview pane, above the one Inspector.
 *
 * One component and one renderer path for every editor that previews: the
 * pane makes one `PreviewRenderer` when the editor window opens and keeps it
 * while items are switched (each switch only swaps the subject), and shows
 * the controls of what the front editor asked for (`usePreview`). Editors
 * describe the subject; none builds a renderer. What is shown on its scene
 * (a timeline, a conversation, a UI document) is drawn by the Scene view's
 * own renderer in the pane instead of the pane's canvas.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';

import { PreviewRenderer } from '../../viewport/preview-renderer';
import { AnimatorPreview } from './AnimatorPreview';
import { EffectPreview } from './EffectPreview';
import { MaterialPreview } from './MaterialPreview';
import { DialoguePreview, TimelinePreview, UiDocumentPreview } from './ScenePreview';
import { previewKey, type PreviewRequest } from './preview-request';
import type { PreviewDeps } from './use-subject';

export type { PreviewDeps } from './use-subject';

const TITLE: Record<PreviewRequest['kind'], string> = {
  material: 'material on a shape',
  effect: 'effect',
  animator: 'model with its animator',
  timeline: 'timeline on its scene',
  dialogue: 'conversation on its scene',
  ui: 'UI document on its scene',
};

/** Kinds shown on their scene (the Scene view's canvas, not the pane's own). */
const ON_SCENE: ReadonlySet<PreviewRequest['kind']> = new Set(['timeline', 'dialogue', 'ui']);

export function PreviewPane({ request, deps }: { request: PreviewRequest | null; deps: PreviewDeps }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderer, setRenderer] = useState<PreviewRenderer | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const r = new PreviewRenderer(canvas, { loadTexture: (id) => latest.current.loadTexture(id) });
    r.setEnvironment(latest.current.environment);
    setRenderer(r);
    return () => {
      r.dispose();
      setRenderer(null);
    };
  }, []);
  useEffect(() => renderer?.setEnvironment(deps.environment), [renderer, deps.environment]);
  const key = request !== null ? previewKey(request) : '';
  return (
    <section className="tl-preview" aria-label="preview pane" hidden={request === null} data-kind={request?.kind ?? ''}>
      <div className="tl-subhead">
        Preview
        {request !== null && <span className="tl-hint">{TITLE[request.kind]}</span>}
      </div>
      <canvas ref={canvasRef} className="tl-preview__canvas" aria-label="preview canvas" hidden={request !== null && ON_SCENE.has(request.kind)} />
      {renderer !== null && request !== null && (
        <div className="tl-preview__controls" key={key}>
          {request.kind === 'material' && <MaterialPreview renderer={renderer} request={request} deps={deps} />}
          {request.kind === 'effect' && <EffectPreview renderer={renderer} request={request} deps={deps} />}
          {request.kind === 'animator' && <AnimatorPreview renderer={renderer} request={request} deps={deps} />}
          {request.kind === 'timeline' && <TimelinePreview renderer={renderer} request={request} deps={deps} />}
          {request.kind === 'dialogue' && <DialoguePreview renderer={renderer} request={request} deps={deps} />}
          {request.kind === 'ui' && <UiDocumentPreview renderer={renderer} request={request} deps={deps} />}
        </div>
      )}
    </section>
  );
}
