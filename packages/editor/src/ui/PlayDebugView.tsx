/**
 * Phase 15.4: the Play debug view (React).
 *
 * While Play runs, the selected object's scripts show the property values
 * the running game reads — public and private — read-only. The values come
 * from the Play preview over the game-observe relay (`tl.game.observe` with
 * the entity id); the editor never runs game code. Polled twice a second
 * while visible.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

export interface DebugScriptView {
  behaviorId: string;
  properties: { key: string; label: string; type: string; visibility: string; value: unknown }[];
}

/** One observation's `behaviors` block (see `preview-m3.ts`). */
export interface DebugBehaviorsView {
  entityId: string;
  scripts: DebugScriptView[];
}

/** The observation's `behaviors` block, when well formed. */
export function behaviorsOf(observation: Record<string, unknown> | null): DebugBehaviorsView | null {
  const b = observation?.['behaviors'];
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null;
  const v = b as { entityId?: unknown; scripts?: unknown };
  if (typeof v.entityId !== 'string' || !Array.isArray(v.scripts)) return null;
  return { entityId: v.entityId, scripts: v.scripts as DebugScriptView[] };
}

function text(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? String(Math.round(x * 1000) / 1000) : String(x))).join(', ');
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  return String(v);
}

export function PlayDebugView({
  entityId,
  observe,
}: {
  entityId: string;
  /** One observation of the running Play for `entityId` (null: no answer). */
  observe: (entityId: string) => Promise<Record<string, unknown> | null>;
}): JSX.Element {
  const [view, setView] = useState<DebugBehaviorsView | null>(null);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    let alive = true;
    setView(null);
    setWaiting(true);
    const tick = async (): Promise<void> => {
      const o = await observe(entityId);
      if (!alive) return;
      const b = behaviorsOf(o);
      if (b !== null && b.entityId === entityId) setView(b);
      setWaiting(false);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [entityId, observe]);

  return (
    <div className="tl-inspector__section tl-playdebug" aria-label="play debug" data-entity={entityId}>
      <div className="tl-panel__title">Play — script values (read-only)</div>
      {view === null ? (
        <p className="tl-inspector__hint">{waiting ? 'Reading the running game…' : 'The running game did not answer.'}</p>
      ) : view.scripts.length === 0 ? (
        <p className="tl-inspector__hint">No script runs on this object in Play.</p>
      ) : (
        view.scripts.map((s) => (
          <div className="tl-playdebug__script" key={s.behaviorId} data-behavior={s.behaviorId}>
            <div className="tl-prop__caption">{s.behaviorId}</div>
            {s.properties.map((p) => (
              <div className="tl-comp__field" key={p.key} data-debug-key={p.key} data-visibility={p.visibility} title={`${p.key} (${p.type}, ${p.visibility})`}>
                <span className="tl-comp__name">{p.label}</span>
                <span className="tl-comp__value" data-debug-value={p.key}>
                  {text(p.value)}
                </span>
                <span className="tl-comp__type">{p.visibility === 'private' ? 'private' : ''}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
