/**
 * The vertex paint editor's material card: the object's material, what it
 * is, and whether it reads paint.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { MaterialCard } from '../palette/MaterialCard';
import type { VertexPaintSetup } from './vertex-paint-column';

export function PaintMaterialCard({ vp }: { vp: VertexPaintSetup }): JSX.Element {
  const m = vp.channels.material;
  const source = vp.palette.source;
  // Its picture: the base layer's texture, else a shader material's colour map.
  const texture = source.kind !== 'none' ? (vp.palette.layers[0]?.texture ?? null) : (m?.textures['map'] ?? null);
  const open = m === null ? undefined : (): void => vp.host.palette.openMaterial(source.kind === 'instance' ? source.parent : m.materialId);
  return <MaterialCard material={m} summary={vp.channels.summary} reads={vp.channels.meaning !== 'none'} readsLabel="reads paint" offLabel="no paint" texture={texture} thumbnails={vp.host.palette.thumbnails} {...(open !== undefined ? { onOpen: open } : {})} />;
}
