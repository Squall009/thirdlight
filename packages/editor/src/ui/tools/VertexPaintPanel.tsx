/**
 * The Vertex paint tool window: while it is open (and the Scene view in
 * front), a left drag on a placed model, a copy of an instance set,
 * generated architecture or a spline paints its vertices — one
 * `paintVertices` and one undo step per stroke, the preview drawn as the
 * brush moves.
 *
 * - The brush is the shared one: radius (metres), strength, falloff, the
 *   channel (R, G, B, A: what each means is the material's — a tint, grime,
 *   wetness, a blend weight), erase.
 * - The channel view shows one channel as grey over the whole view.
 * - A stroke over paint made for a model's earlier vertices (it was
 *   reimported) is refused; the window says so and offers to remove that
 *   stale paint (one `setComponent`), after which the mesh can be painted
 *   again.
 * - The settings are remembered per browser (never project data).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { BRUSH_FALLOFFS, VERTEX_PAINT_BRUSH_LIMITS, type BrushFalloff } from '@thirdlight/runtime';

import { PAINT_CHANNEL_NAMES, VERTEX_PAINT_DEFAULTS, stalePaintOf, vertexPaintSettingsError, withoutMeshPaint, type VertexPaintSettings } from '../../session/vertex-paint-brush';
import type { ClientRef, SetNotice, ViewportRef } from '../shell/commands';

const KEY = 'thirdlight.vertexPaint.v1';

function stored(): VertexPaintSettings {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<VertexPaintSettings> | null;
    const s: VertexPaintSettings = { ...VERTEX_PAINT_DEFAULTS, ...(v ?? {}) };
    return vertexPaintSettingsError(s) === null ? s : { ...VERTEX_PAINT_DEFAULTS };
  } catch {
    return { ...VERTEX_PAINT_DEFAULTS };
  }
}

/** A mesh whose stored paint was made for other vertices (a stroke over it was refused). */
interface StalePaint {
  entityId: string;
  mesh: string;
  message: string;
}

export interface VertexPaintToolState {
  settings: VertexPaintSettings;
  setSettings: (s: VertexPaintSettings) => void;
  stale: StalePaint | null;
  /** Take the stale paint away (one `setComponent`); the mesh can be painted again. */
  removeStale: () => Promise<void>;
}

export interface VertexPaintToolDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  /** The tool window is open over the Scene view. */
  armed: boolean;
  setNotice: SetNotice;
}

export function useVertexPaintTool(deps: VertexPaintToolDeps): VertexPaintToolState {
  const { clientRef, viewportRef, armed, setNotice } = deps;
  const [settings, setState] = useState<VertexPaintSettings>(stored);
  const [stale, setStale] = useState<StalePaint | null>(null);
  const setSettings = useCallback((s: VertexPaintSettings) => {
    setState(s);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // A browser without storage keeps the settings for this page only.
    }
  }, []);

  useEffect(() => {
    const v = viewportRef.current;
    if (v === null) return;
    if (!armed || vertexPaintSettingsError(settings) !== null) return v.setVertexPaintTool(null, null);
    v.setVertexPaintTool(settings, {
      stroke: async (args) => {
        const c = clientRef.current;
        if (c === null) return { ok: false, message: 'not connected' };
        const r = await c.command('paintVertices', args, c.projection.revision);
        if (r.ok) return { ok: true };
        const res = r.response as { code?: string; message?: string; found?: unknown };
        const message = res.message ?? res.code ?? 'the stroke was refused';
        // Paint made for a model's earlier vertices: offered for removal (the backend names the mesh).
        const stale = stalePaintOf(String(args['entityId']), res);
        if (stale !== null) setStale(stale);
        return { ok: false, ...(res.code !== undefined ? { code: res.code } : {}), message };
      },
      refused: (m) => setNotice(`Vertex paint: ${m}`),
    });
  }, [armed, settings, clientRef, viewportRef, setNotice]);
  // The tool goes off with the page.
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
  return { settings, setSettings, stale, removeStale };
}

const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));

/** The Vertex paint window's body: the brush and the channel view. */
export function VertexPaintPanel({ tool }: { tool: VertexPaintToolState }): JSX.Element {
  const { settings: s, setSettings, stale, removeStale } = tool;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const L = VERTEX_PAINT_BRUSH_LIMITS;
  const field = (label: string, key: 'radius' | 'strength', step: number, title: string): JSX.Element => (
    <label className="tl-field" title={title}>
      <span className="tl-field__label">{label}</span>
      <input
        className="tl-input"
        type="number"
        step={step}
        aria-label={`vertex paint ${key}`}
        value={draft[key] ?? String(s[key])}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          const raw = draft[key];
          if (raw === undefined) return;
          const next = { ...s, [key]: num(raw) };
          const why = vertexPaintSettingsError(next);
          setError(why);
          if (why === null) setSettings(next);
          const { [key]: _gone, ...rest } = draft;
          setDraft(rest);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
  return (
    <div className="tl-vertex-paint-tool" aria-label="vertex paint tool">
      <div className="tl-toolbar__group" role="group" aria-label="vertex paint mode">
        <button className={!s.erase ? 'tl-btn is-active' : 'tl-btn'} aria-pressed={!s.erase} onClick={() => setSettings({ ...s, erase: false })} title="Strokes raise the channel toward full">
          Paint
        </button>
        <button className={s.erase ? 'tl-btn is-active' : 'tl-btn'} aria-pressed={s.erase} onClick={() => setSettings({ ...s, erase: true })} title="Strokes lower the channel toward nothing">
          Erase
        </button>
      </div>
      {field('radius (m)', 'radius', 0.05, `The brush's radius in the world, ${L.radius.min}–${L.radius.max} m: every vertex within it is painted.`)}
      {field('strength', 'strength', 0.05, 'How far one dab moves a vertex at the brush’s middle toward full (or nothing), above 0 and at most 1.')}
      <label className="tl-field" title="How the brush fades toward its edge">
        <span className="tl-field__label">falloff</span>
        <select className="tl-input" aria-label="vertex paint falloff" value={s.falloff} onChange={(e) => setSettings({ ...s, falloff: e.target.value as BrushFalloff })}>
          {BRUSH_FALLOFFS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field" title="The byte painted: what it means is the material's (a standard material's paint tint, a trim sheet's grime G and wetness B, a graph's Vertex colour (paint), a height blend's weights)">
        <span className="tl-field__label">channel</span>
        <select className="tl-input" aria-label="vertex paint channel" value={s.channel} onChange={(e) => setSettings({ ...s, channel: Number(e.target.value) })}>
          {PAINT_CHANNEL_NAMES.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field" title="Show one channel as grey over the whole Scene view (white: full, black: unpainted) while this window is open">
        <span className="tl-field__label">channel view</span>
        <select className="tl-input" aria-label="vertex paint channel view" value={s.view ?? ''} onChange={(e) => setSettings({ ...s, view: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">off (materials)</option>
          {PAINT_CHANNEL_NAMES.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {error !== null && (
        <p className="tl-hint tl-hint--error" role="alert">
          {error}
        </p>
      )}
      {stale !== null && (
        <div className="tl-hint tl-hint--error" role="alert" aria-label="stale vertex paint">
          <p>{stale.message}</p>
          <button className="tl-btn" onClick={() => void removeStale()} title="Remove this mesh's old paint (one undo step); then it can be painted again">
            Remove its stale paint
          </button>
        </div>
      )}
      <p className="tl-hint">Drag on a model, a copy, a generated wall or a spline to paint it; Alt+drag orbits. Each stroke is one undo step.</p>
    </div>
  );
}
