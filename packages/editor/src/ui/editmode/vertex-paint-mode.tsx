/**
 * The vertex paint editor: the edit mode of a placed model, an instance
 * set, generated architecture or a spline. Its rail: Paint (the palette of
 * what the paint means on the object's material, the shared brush), Channels
 * (the channel view, what each byte means, stored and stale paint) and
 * Material (the material's layers). Over the view, in every mode: the
 * channel view's chips and, when the material reads no paint, a toast with
 * Make it paintable. The strokes are the Scene view's vertex paint brush,
 * one `paintVertices` each, as before.
 *
 * Every model is paintable, so a double-click (which opens an object's
 * editor) does not open this one: the Inspector's Paint vertices does.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import type { ProjectedEntity } from '../../session/projection';
import { ChannelsColumn } from '../vertexpaint/ChannelsColumn';
import { MaterialColumn } from '../vertexpaint/MaterialColumn';
import { PaintColumn } from '../vertexpaint/PaintColumn';
import { VertexPaintView } from '../vertexpaint/PaintView';
import type { EditModeView, ObjectEditModeKind } from './modes';

const has = (e: ProjectedEntity, c: string): boolean => e.components[c] !== undefined;

/** What the object is, for the header ("Instance set · 12 copies"). */
function kindOf(e: ProjectedEntity): string {
  if (has(e, 'instances')) {
    const n = (e.components['instances'] as { count?: number }).count ?? 0;
    return `Instance set · ${n} ${n === 1 ? 'copy' : 'copies'}`;
  }
  if (has(e, 'architecture')) {
    const a = e.components['architecture'] as { outlines?: unknown[]; buildings?: unknown[] };
    const n = (a.outlines?.length ?? 0) + (a.buildings?.length ?? 0);
    return `Generated architecture · ${n} ${n === 1 ? 'room or building' : 'rooms and buildings'}`;
  }
  if (has(e, 'spline')) return 'Spline';
  return 'Model';
}

const COLUMNS: Readonly<Record<string, (v: EditModeView) => JSX.Element>> = { paint: PaintColumn, channels: ChannelsColumn, material: MaterialColumn };

export const vertexPaintMode: ObjectEditModeKind = {
  kind: 'vertex-paint',
  label: 'Vertex paint',
  action: 'Paint vertices',
  applies: (e) => has(e, 'model') || has(e, 'instances') || has(e, 'architecture') || has(e, 'spline'),
  activates: false,
  framesOnEnter: true,
  meta: (e) => `${kindOf(e)} · ${has(e, 'vertexPaint') || (e.components['instances'] as { paint?: unknown } | undefined)?.paint !== undefined ? 'painted' : 'not painted yet'}`,
  rail: [
    { id: 'paint', label: 'Paint', glyph: 'paint', hint: 'Drag on the object to paint the picked layer.', navigate: 'A drag orbits round the object; pick Paint or press B to paint it.' },
    { id: 'channels', label: 'Channels', glyph: 'channels', hint: 'Show one channel of the paint, and what each means.' },
    { id: 'material', label: 'Material', glyph: 'material', hint: 'The material the paint is read by, and its layers.', sep: true },
  ],
  tools: ['paint'],
  column: (view) => {
    const Column = COLUMNS[view.mode] ?? PaintColumn;
    return <Column key={view.mode} {...view} />;
  },
  viewExtra: (view) => <VertexPaintView {...view} />,
};
