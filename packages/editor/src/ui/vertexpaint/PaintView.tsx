/**
 * What the vertex paint editor lays over the Scene view while it shows, in
 * every rail mode: the brush armed on the object (Paint and Channels; the
 * Material mode only looks; with no tool, Navigate, it shows the channel
 * view but paints nothing and a drag orbits), the channel view's chips (Final, then what each
 * channel means; V cycles them) and, when the material reads no paint, a
 * toast saying so with Make it paintable.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';

import { isTyping } from '../workspace/EditorWindow';
import { Segmented } from '../editmode/controls';
import { useToolArmed } from '../editmode/edit-tool';
import { Toast } from '../editmode/Banner';
import type { EditModeView } from '../editmode/modes';
import { setUpLayered } from '../palette/MaterialLayers';
import { useVertexPaint } from './vertex-paint-column';

/** The rail modes the brush paints in. */
const PAINTING_MODES: readonly string[] = ['paint', 'channels'];

export function VertexPaintView({ entity, mode, host }: EditModeView): JSX.Element {
  const vp = useVertexPaint(entity, host);
  const { channels, paintable, target, store, state, setState } = vp;
  const views = channels.views;
  const view = views.some((v) => v.channel === state.view) ? state.view : null;
  const armed = PAINTING_MODES.includes(mode);
  const navigate = !useToolArmed();
  // A locked object says why on a press; a material without paint says so in the toast already.
  const offReason = vp.locked ? `${entity.name} is locked (unlock it in the Hierarchy).` : undefined;
  const arm = host.paint.arm;
  const key = `${entity.id}|${armed}|${navigate}|${target.channel}|${(target.channels ?? []).join()}|${target.erases === true}|${paintable}|${view}|${offReason}`;
  useEffect(() => {
    arm(armed ? { entityId: entity.id, store, target, paintable, ...(offReason !== undefined ? { offReason } : {}), view, navigate } : null);
    // `key` names everything the brush is armed with.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the target object is rebuilt each draw; `key` names its content
  }, [key, arm, store]);
  useEffect(() => () => arm(null), [arm]);

  // V cycles the channel view (captured before the shell's keys, as the palette's digits are).
  const latest = useRef({ views, view, setState });
  latest.current = { views, view, setState };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.code !== 'KeyV' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null) return;
      const q = latest.current;
      const i = q.views.findIndex((v) => v.channel === q.view);
      e.preventDefault();
      q.setState({ view: q.views[(i + 1) % q.views.length]!.channel });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const [busy, setBusy] = useState(false);
  const makePaintable = async (): Promise<void> => {
    setBusy(true);
    try {
      await setUpLayered(host.palette, entity.id, entity.name, channels.material, undefined, vp.slots);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {channels.meaning !== 'none' && (
        <div className="tl-vp-chips" title="The channel view: one channel of the paint as grey (white: full), or the material as drawn. V cycles.">
          <Segmented small aria="channel view" options={views.map((v) => ({ id: v.channel === null ? 'final' : String(v.channel), label: v.label }))} value={view === null ? 'final' : String(view)} onChange={(id) => setState({ view: id === 'final' ? null : Number(id) })} />
        </div>
      )}
      {channels.meaning === 'none' && !vp.locked && (
        <Toast aria="painting is off" action={{ label: 'Make it paintable', onClick: () => void makePaintable(), busy }}>
          Painting is off: <b>{channels.material?.name ?? entity.name}</b> {channels.material === null ? 'wears no material that reads' : "doesn't read"} paint.
        </Toast>
      )}
    </>
  );
}
