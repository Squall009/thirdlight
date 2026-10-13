/**
 * Vertex paint's wiring for its edit mode: the Scene view's brush armed on
 * the edited object (a stroke is one `paintVertices`, stored on release)
 * and paint made for a model's earlier vertices — a stroke over it is
 * refused, and the editor offers to remove that stale paint (one
 * `setComponent`), after which the mesh can be painted again.
 */
import { useCallback, useEffect, useState } from 'react';

import { stalePaintOf, withoutMeshPaint } from '../../session/vertex-paint-brush';
import type { VertexPaintArm } from '../../viewport/vertex-paint-tool';
import type { ClientRef, SetNotice, ViewportRef } from './commands';

/** A mesh whose stored paint was made for other vertices (a stroke over it was refused). */
export interface StalePaint {
  readonly entityId: string;
  readonly mesh: string;
  readonly message: string;
}

export interface VertexPaintTools {
  /** Arm the brush on an object (null: off). */
  arm(a: VertexPaintArm | null): void;
  /** The stale paint a refused stroke found (null: none). */
  readonly stale: StalePaint | null;
  /** Take the stale paint away (one `setComponent`). */
  removeStale(): Promise<void>;
}

export function useVertexPaintTools(deps: { clientRef: ClientRef; viewportRef: ViewportRef; setNotice: SetNotice }): VertexPaintTools {
  const { clientRef, viewportRef, setNotice } = deps;
  const [stale, setStale] = useState<StalePaint | null>(null);
  const arm = useCallback(
    (a: VertexPaintArm | null): void => {
      const v = viewportRef.current;
      if (v === null) return;
      if (a === null) {
        v.setVertexPaintTool(null, null);
        return;
      }
      v.setVertexPaintTool(a, {
        stroke: async (args) => {
          const c = clientRef.current;
          if (c === null) return { ok: false, message: 'not connected' };
          const r = await c.command('paintVertices', args, c.projection.revision);
          if (r.ok) return { ok: true };
          const res = r.response as { code?: string; message?: string; found?: unknown };
          const message = res.message ?? res.code ?? 'the stroke was refused';
          // Paint made for a model's earlier vertices: offered for removal (the backend names the mesh).
          const s = stalePaintOf(String(args['entityId']), res);
          if (s !== null) setStale(s);
          return { ok: false, ...(res.code !== undefined ? { code: res.code } : {}), message };
        },
        refused: (m) => setNotice(`Vertex paint: ${m}`),
      });
    },
    [clientRef, viewportRef, setNotice],
  );
  // The brush goes off with the page.
  useEffect(() => () => viewportRef.current?.setVertexPaintTool(null, null), [viewportRef]);

  const removeStale = useCallback(async () => {
    const c = clientRef.current;
    if (c === null || stale === null) return;
    const e = c.projection.listEntities().find((x) => x.id === stale.entityId);
    const change = e === undefined ? null : withoutMeshPaint(e.components, stale.mesh);
    setStale(null);
    if (change === null) return;
    const r = await c.setComponent(stale.entityId, change.component, change.value, c.projection.revision);
    if (!r.ok) setNotice(`Vertex paint: the stale paint could not be removed (${(r.response as { message?: string }).message ?? 'refused'})`);
  }, [clientRef, stale, setNotice]);
  return { arm, stale, removeStale };
}
