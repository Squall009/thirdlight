/**
 * The preview pane's kit piece controls: the piece in a sample wall, a room
 * or alone (Segmented), the legend of the two boxes, and how it fits. The
 * sample wears the kit's trim sheet; the piece its own material map.
 *
 * Browser-only (React).
 */
import { BLOCK_LAYER_DEFAULT } from '@thirdlight/project-model/limits';
import type { MaterialDefLike, MaterialFunctionLike } from '@thirdlight/three-adapter';
import { useEffect, useRef, useState, type JSX } from 'react';

import { withSlotTextureKeys } from '../../session/texture-slots';
import { KitPieceSubject, type KitPieceScene, type KitPreviewMode } from '../../viewport/preview-kit';
import { Segmented } from '../editmode/controls';
import { useSubject, type PreviewControlsProps } from './use-subject';

const MODES: readonly { id: KitPreviewMode; label: string; hint: string }[] = [
  { id: 'wall', label: 'Wall', hint: 'In a sample wall wearing the kit\'s trim sheet' },
  { id: 'room', label: 'Room', hint: 'In a sample room (three walls and a floor)' },
  { id: 'alone', label: 'Piece alone', hint: 'Only the piece, on the grid' },
];

/** The mode is kept while pieces are switched (one pane, one choice). */
let lastMode: KitPreviewMode = 'wall';

function sceneOf(r: PreviewControlsProps<'kit-piece'>['request']): KitPieceScene {
  return {
    sheet: r.sheet,
    materials: withSlotTextureKeys(r.materials) as unknown as MaterialDefLike[],
    functions: r.functions as readonly MaterialFunctionLike[],
    mapping: r.mapping,
    placement: r.placement,
    cell: BLOCK_LAYER_DEFAULT.cellSize[0],
  };
}

export function KitPiecePreview({ renderer, request, deps }: PreviewControlsProps<'kit-piece'>): JSX.Element {
  const [mode, setMode] = useState<KitPreviewMode>(lastMode);
  const [fit, setFit] = useState('loading the piece…');
  const loadModel = useRef(deps.loadModel);
  loadModel.current = deps.loadModel;
  const subject = useSubject(renderer, () => new KitPieceSubject(`kit-piece:${request.kitId}:${request.slot}`, sceneOf(request), () => loadModel.current(request.assetId, request.piece), setFit));
  useEffect(() => {
    lastMode = mode;
    subject?.setMode(mode);
  }, [subject, mode]);
  // The sheet, the materials or the piece's map changed while it shows.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    subject?.setScene(sceneOf(request));
  }, [subject, request]);
  return (
    <div className="tl-kit-preview" aria-label="kit piece preview">
      <Segmented options={MODES} value={mode} onChange={setMode} aria="kit preview" small />
      <div className="tl-kit-preview__legend">
        <span className="tl-kit-preview__key is-cell">Cell it should fill</span>
        <span className="tl-kit-preview__key is-draws">Where it draws</span>
      </div>
      <span className="tl-hint" role="status" aria-label="kit piece fit">
        {fit}
        {request.sheet === null ? ' · no trim sheet: the sample is plain' : ''}
      </span>
    </div>
  );
}
