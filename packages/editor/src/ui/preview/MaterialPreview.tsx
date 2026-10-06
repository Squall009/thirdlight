/**
 * The preview pane's material controls — the material on a sphere, a plane, a
 * cube or a model of the project (the first one until another is picked), in
 * the active scene's look; drag the canvas to orbit. The status names the
 * backend and the graph's compile errors.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { MaterialDefLike } from '@thirdlight/three-adapter';
import type * as THREE from 'three';

import { withSlotTextureKeys } from '../../session/texture-slots';
import { MaterialSubject, type PreviewShape } from '../../viewport/preview-subjects';
import { MODEL_KINDS, RefPicker } from '../catalog/RefPicker';
import { useIndexList } from '../catalog/useIndexList';
import { useSubject, type PreviewControlsProps } from './use-subject';

/** How often the status line is refreshed (ms). */
const STATUS_INTERVAL_MS = 250;

export function MaterialPreview({ renderer, request, deps }: PreviewControlsProps<'material'>): JSX.Element {
  const subject = useSubject(renderer, () => new MaterialSubject(request.materialId));
  const [shape, setShape] = useState<PreviewShape>('sphere');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('starting…');
  const loadModel = useRef(deps.loadModel);
  loadModel.current = deps.loadModel;
  // The project's first model stands in until one is chosen (the models are paged from the index).
  const models = useIndexList({ kinds: MODEL_KINDS });
  const firstModel = models.entry(0)?.id ?? '';
  useEffect(() => {
    // Per-layer texture slots draw as the array the backend assembles from them.
    subject?.setMaterial(withSlotTextureKeys(request.materials) as unknown as MaterialDefLike[], request.functions, request.materialId);
  }, [subject, request.materials, request.functions, request.materialId]);
  useEffect(() => {
    if (subject === null) return undefined;
    const timer = window.setInterval(() => {
      const info = renderer.info();
      const errors = (subject.problems() ?? []).filter((x) => x.severity === 'error').length;
      setStatus(info.state !== 'ready' ? `${info.state}…` : `${info.backend}${errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`);
    }, STATUS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [renderer, subject]);
  useEffect(() => {
    if (subject === null) return undefined;
    if (shape !== 'model') {
      subject.setShape(shape);
      return undefined;
    }
    const id = modelId !== '' ? modelId : firstModel;
    if (id === '') {
      subject.setShape('sphere');
      return undefined;
    }
    let live = true;
    let loaded: { root: THREE.Object3D; dispose: () => void } | null = null;
    void loadModel.current(id).then((m) => {
      if (!live) {
        m?.dispose();
        return;
      }
      loaded = m;
      subject.setShape(m !== null ? 'model' : 'sphere', m?.root ?? null);
    });
    return () => {
      live = false;
      if (loaded !== null) {
        subject.setShape('sphere');
        loaded.dispose();
      }
    };
  }, [subject, shape, modelId, firstModel]);
  return (
    <div className="tl-material-preview" aria-label="material preview">
      <label className="tl-preview__row">
        <span>Shape</span>
        <select className="tl-input" aria-label="preview shape" value={shape} onChange={(e) => setShape(e.target.value as PreviewShape)}>
          <option value="sphere">sphere</option>
          <option value="plane">plane</option>
          <option value="cube">cube</option>
          <option value="model" disabled={models.total === 0}>
            model
          </option>
        </select>
      </label>
      {shape === 'model' && firstModel !== '' && <RefPicker aria="preview model" kinds={MODEL_KINDS} value={modelId !== '' ? modelId : firstModel} onPick={setModelId} />}
      <span className="tl-hint tl-material-preview__status" role="status">
        {status}
        {deps.environment === null ? ' · neutral backdrop (no scene look)' : ' · the active scene\'s look'}
      </span>
    </div>
  );
}
