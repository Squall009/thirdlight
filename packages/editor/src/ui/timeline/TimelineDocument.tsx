/**
 * A timeline's editor window tab ("Timeline: <name>").
 *
 * - The timeline's own fields (name, duration, skip action, play on start /
 *   on a signal) and its binding slots (a name and a default object).
 * - A track list beside a time ruler with zoom; keys (and clips, a key with a
 *   duration) are drawn on each track's lane and dragged along the ruler.
 *   A drag edits a local copy and sends one `setTimeline` when the pointer is
 *   released (one command, one undo step per gesture); field edits in the key
 *   inspector are one command each.
 * - Scrubbing: a click or drag on the ruler moves the playhead; play/pause
 *   runs it in real time. The Scene view previews the timeline at that time
 *   (transforms and the live camera, evaluated by the runtime's own
 *   `evaluateTimelineAt`); animator tracks show the state their keys lead to
 *   (the runtime's AnimatorMachine run from 0 to the playhead); the other
 *   tracks show their keys as markers. Nothing plays sound or effects here.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { AnimatorController, TimelineAsset, TimelineKey, TimelineTrack, TimelineTrackType } from '@thirdlight/project-model';
import { AnimatorMachine, evaluateTimelineAt, TIMELINE_EASINGS, TIMELINE_TARGET_TRACKS, TIMELINE_TRACK_TYPES, type AnimatorControllerLike } from '@thirdlight/runtime';
import { AUDIO_KINDS, RefPicker, useFirstEntry } from '../catalog/RefPicker';

export interface TimelineEntityLike {
  id: string;
  name: string;
  position: readonly number[];
  rotation: readonly number[];
  scale: readonly number[];
  components: Readonly<Record<string, unknown>>;
}

export interface TimelinePreviewValue {
  time: number;
  transforms: ReadonlyMap<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>;
  camera: { entityId: string; progress: number | null } | null;
}

export interface TimelineDocumentProps {
  timelineId: string;
  timelines: readonly TimelineAsset[];
  entities: readonly TimelineEntityLike[];
  effects: readonly { id: string; name: string }[];
  /** The project's input action names (wait keys, the skip action). */
  actions: readonly string[];
  animators: readonly AnimatorController[];
  /** The project's game mode ids (mode keys). */
  modes: readonly string[];
  error: string | null;
  onSave: (timeline: TimelineAsset) => Promise<boolean>;
  onPreview: (preview: TimelinePreviewValue | null) => void;
}

/** Keys snap to the fixed step of 60 Hz (the runtime counts keys in steps). */
const SNAP = 60;
const snap = (t: number): number => Math.round(t * SNAP) / SNAP;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

const TYPE_LABEL: Record<TimelineTrackType, string> = {
  camera: 'Camera',
  transform: 'Transform',
  animator: 'Animator',
  audio: 'Audio',
  dialogue: 'Dialogue',
  effect: 'Effect',
  activation: 'Activation',
  signal: 'Signal',
  fade: 'Fade',
  letterbox: 'Letterbox',
  wait: 'Wait for input',
  material: 'Material',
  environment: 'Environment',
  mode: 'Game mode',
};

/** A new timeline: five seconds, no slots or tracks yet. */
export function newTimeline(timelineId: string, name: string): TimelineAsset {
  return { timelineId, name, duration: 5, tracks: [] };
}

function keyLabel(t: TimelineTrack, k: TimelineKey): string {
  switch (t.type) {
    case 'camera':
      return k.release === true ? 'release' : (k.camera ?? '');
    case 'animator':
      return `${k.kind ?? ''} ${k.name ?? ''}`;
    case 'audio':
      return `${k.kind ?? ''} ${k.asset ?? ''}`;
    case 'signal':
      return k.name ?? '';
    case 'wait':
      return k.action ?? '';
    case 'effect':
      return k.effect ?? '';
    case 'dialogue':
      return k.dialogue ?? '';
    case 'activation':
      return k.active === true ? 'on' : 'off';
    case 'environment':
      return k.preset ?? '';
    case 'mode':
      return k.mode ?? '';
    default:
      return typeof k.value === 'number' ? String(round3(k.value)) : typeof k.value === 'string' ? k.value : '';
  }
}

/** The animator state and parameters a track's keys lead to at `time` (the runtime's machine, stepped at 60 Hz). */
function animatorAt(controller: AnimatorController | undefined, track: TimelineTrack, time: number): string {
  if (controller === undefined) return 'no animator on the bound object';
  try {
    const m = new AnimatorMachine(controller as unknown as AnimatorControllerLike);
    const steps = Math.round(time * SNAP);
    const keys = track.keys.map((k) => ({ k, s: Math.round(k.time * SNAP) }));
    for (let s = 0; s <= steps; s += 1) {
      for (const { k, s: ks } of keys) {
        if (ks !== s) continue;
        if (k.kind === 'set' && k.value !== undefined) m.set(k.name ?? '', k.value as number | boolean);
        else if (k.kind === 'trigger') m.trigger(k.name ?? '');
        else if (k.kind === 'play') m.play(k.name ?? '', k.fade ?? 0, k.layer ?? 0);
      }
      if (s < steps) m.step(1 / SNAP);
    }
    return `state ${m.stateName(0)}`;
  } catch (e) {
    return `cannot evaluate: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function TimelineDocument(props: TimelineDocumentProps): JSX.Element {
  const stored = props.timelines.find((t) => t.timelineId === props.timelineId) ?? null;
  const [draft, setDraft] = useState<TimelineAsset | null>(null);
  const [time, setTime] = useState(0);
  const [zoom, setZoom] = useState(80);
  const [selected, setSelected] = useState<{ trackId: string; index: number } | null>(null);
  const firstSound = useFirstEntry(AUDIO_KINDS).first;
  const [playing, setPlaying] = useState(false);
  const [addType, setAddType] = useState<TimelineTrackType>('transform');
  const [localError, setLocalError] = useState<string | null>(null);
  const drag = useRef<{ trackId: string; index: number; x0: number; t0: number; moved: boolean; base: TimelineAsset } | null>(null);
  const scrubbing = useRef(false);
  const tl = draft ?? stored;
  const timeRef = useRef(0);
  timeRef.current = time;
  const onPreview = props.onPreview;

  // The Scene view shows the timeline at the playhead while the tab is open.
  useEffect(() => {
    if (tl === null) return;
    const p = evaluateTimelineAt(tl, Math.min(time, tl.duration));
    onPreview({ time, transforms: p.transforms, camera: p.camera });
  }, [tl, time, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);

  // Play/pause: the playhead runs in real time to the end.
  useEffect(() => {
    if (!playing || tl === null) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const next = timeRef.current + dt;
      if (next >= tl.duration) {
        timeRef.current = tl.duration;
        setTime(tl.duration);
        setPlaying(false);
        return;
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tl]);

  const entityName = useMemo(() => new Map(props.entities.map((e) => [e.id, e.name])), [props.entities]);

  if (tl === null) return <p className="tl-hint">The timeline "{props.timelineId}" is not in this project (it may still be loading).</p>;
  const slots = tl.slots ?? [];
  const width = Math.max(200, tl.duration * zoom);

  const save = async (next: TimelineAsset): Promise<boolean> => {
    setLocalError(null);
    const ok = await props.onSave(next);
    return ok;
  };
  const withTrack = (trackId: string, f: (t: TimelineTrack) => TimelineTrack): TimelineAsset => ({ ...tl, tracks: tl.tracks.map((t) => (t.trackId === trackId ? f(t) : t)) });
  const selTrack = selected !== null ? tl.tracks.find((t) => t.trackId === selected.trackId) : undefined;
  const selKey = selTrack !== undefined && selected !== null ? selTrack.keys[selected.index] : undefined;

  const boundEntity = (slot: string | undefined): TimelineEntityLike | undefined => {
    const id = slots.find((s) => s.name === slot)?.entity;
    return id === undefined ? undefined : props.entities.find((e) => e.id === id);
  };

  const defaultKey = (t: TimelineTrack, at: number): TimelineKey | string => {
    const time = round3(snap(Math.min(at, tl.duration)));
    switch (t.type) {
      case 'camera':
        return slots.length > 0 ? { time, camera: slots[0]!.name } : 'add a slot bound to a virtual camera first';
      case 'transform': {
        const e = boundEntity(t.target);
        if (e === undefined) return 'bind the track\'s slot to an object first';
        return { time, position: [e.position[0] ?? 0, e.position[1] ?? 0, e.position[2] ?? 0], rotation: [e.rotation[0] ?? 0, e.rotation[1] ?? 0, e.rotation[2] ?? 0, e.rotation[3] ?? 1] };
      }
      case 'animator':
        return { time, kind: 'set', name: 'speed', value: 1 };
      case 'audio':
        return firstSound !== null ? { time, kind: 'music', asset: firstSound, fade: 1 } : { time, kind: 'release' };
      case 'dialogue':
        return { time, dialogue: 'dialogue' };
      case 'effect':
        return props.effects.length > 0 ? { time, effect: props.effects[0]!.id } : 'the project has no effects';
      case 'activation':
        return { time, active: false };
      case 'signal':
        return { time, name: 'cue' };
      case 'fade':
        return { time, value: 1 };
      case 'letterbox':
        return { time, value: 0.12 };
      case 'wait':
        return { time, action: props.actions[0] ?? 'confirm' };
      case 'material':
        return { time, value: 0 };
      case 'environment':
        return { time, preset: 'preset' };
      case 'mode':
        return props.modes.length > 0 ? { time, mode: props.modes[0]! } : 'the project has no game modes';
    }
  };

  const addTrack = (): void => {
    if (TIMELINE_TARGET_TRACKS.includes(addType) && slots.length === 0) {
      setLocalError('add a slot first: this track acts on a bound object');
      return;
    }
    let n = tl.tracks.length + 1;
    while (tl.tracks.some((t) => t.trackId === `track-${n}`)) n += 1;
    const track: TimelineTrack = { trackId: `track-${n}`, type: addType, keys: [], ...(TIMELINE_TARGET_TRACKS.includes(addType) ? { target: slots[0]!.name } : {}), ...(addType === 'material' ? { param: 'value' } : {}) };
    void save({ ...tl, tracks: [...tl.tracks, track] });
  };

  const addKey = (): void => {
    if (selTrack === undefined) {
      setLocalError('select a track (click its lane) first');
      return;
    }
    const k = defaultKey(selTrack, time);
    if (typeof k === 'string') {
      setLocalError(k);
      return;
    }
    const index = [...selTrack.keys, k].sort((a, b) => a.time - b.time).indexOf(k);
    void save(withTrack(selTrack.trackId, (t) => ({ ...t, keys: [...t.keys, k].sort((a, b) => a.time - b.time) }))).then((ok) => ok && setSelected({ trackId: selTrack.trackId, index }));
  };

  const deleteKey = (): void => {
    if (selTrack === undefined || selected === null) return;
    void save(withTrack(selTrack.trackId, (t) => ({ ...t, keys: t.keys.filter((_, i) => i !== selected.index) }))).then((ok) => ok && setSelected(null));
  };

  const setKey = (patch: Partial<TimelineKey> & Record<string, unknown>): void => {
    if (selTrack === undefined || selected === null || selKey === undefined) return;
    const next: Record<string, unknown> = { ...selKey, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete next[k];
    void save(withTrack(selTrack.trackId, (t) => ({ ...t, keys: t.keys.map((k, i) => (i === selected.index ? (next as unknown as TimelineKey) : k)) })));
  };

  // ---- pointer gestures ---------------------------------------------------------------

  const timeAt = (el: HTMLElement, clientX: number): number => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(tl.duration, (clientX - r.left) / zoom));
  };
  const onRulerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    scrubbing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPlaying(false);
    setTime(timeAt(e.currentTarget, e.clientX));
  };
  const onRulerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (scrubbing.current) setTime(timeAt(e.currentTarget, e.clientX));
  };
  const onRulerUp = (): void => {
    scrubbing.current = false;
  };

  const onKeyDown = (e: ReactPointerEvent<HTMLDivElement>, t: TimelineTrack, index: number): void => {
    e.stopPropagation();
    setSelected({ trackId: t.trackId, index });
    drag.current = { trackId: t.trackId, index, x0: e.clientX, t0: t.keys[index]!.time, moved: false, base: tl };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onKeyMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null) return;
    const nt = round3(snap(Math.max(0, Math.min(d.base.duration, d.t0 + (e.clientX - d.x0) / zoom))));
    if (!d.moved && Math.abs(e.clientX - d.x0) < 2) return;
    d.moved = true;
    setDraft({ ...d.base, tracks: d.base.tracks.map((t) => (t.trackId === d.trackId ? { ...t, keys: t.keys.map((k, i) => (i === d.index ? { ...k, time: nt } : k)) } : t)) });
  };
  const onKeyUp = (): void => {
    const d = drag.current;
    drag.current = null;
    if (d === null || !d.moved || draft === null) return;
    const moved = draft.tracks.find((t) => t.trackId === d.trackId)!.keys[d.index]!;
    const sorted = [...draft.tracks.find((t) => t.trackId === d.trackId)!.keys].sort((a, b) => a.time - b.time);
    const next = { ...draft, tracks: draft.tracks.map((t) => (t.trackId === d.trackId ? { ...t, keys: sorted } : t)) };
    // One command for the whole gesture.
    void save(next).then((ok) => {
      setDraft(null);
      if (ok) setSelected({ trackId: d.trackId, index: sorted.indexOf(moved) });
    });
  };

  // ---- rendering ----------------------------------------------------------------------

  const ticks: JSX.Element[] = [];
  const stepS = zoom >= 160 ? 0.25 : zoom >= 60 ? 1 : zoom >= 25 ? 2 : 5;
  for (let s = 0; s <= tl.duration + 1e-9; s += stepS) {
    ticks.push(
      <span key={s} className="tl-timeline__tick" style={{ position: 'absolute', left: s * zoom, top: 0, bottom: 0, borderLeft: '1px solid #5a6270', fontSize: 10, paddingLeft: 2, color: '#aab' }}>
        {round3(s)}
      </span>,
    );
  }
  const playhead = <div className="tl-timeline__playhead" style={{ position: 'absolute', left: Math.min(time, tl.duration) * zoom, top: 0, bottom: 0, width: 0, borderLeft: '2px solid #f2b544', pointerEvents: 'none' }} />;
  const slotSelect = (value: string | undefined, onChange: (v: string) => void, label: string): JSX.Element => (
    <select className="tl-input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {slots.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name}
        </option>
      ))}
    </select>
  );
  const num = (label: string, value: number | undefined, onChange: (v: number | undefined) => void, step = 0.01): JSX.Element => (
    <label className="tl-timeline__field">
      {label}
      <input
        className="tl-input"
        aria-label={`Key ${label}`}
        type="number"
        step={step}
        defaultValue={value ?? ''}
        key={`${label}:${value ?? ''}:${selected?.trackId}:${selected?.index}`}
        onBlur={(e) => {
          const v = e.target.value.trim() === '' ? undefined : Number(e.target.value);
          if (v !== value && (v === undefined || Number.isFinite(v))) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
  const text = (label: string, value: string | undefined, onChange: (v: string | undefined) => void): JSX.Element => (
    <label className="tl-timeline__field">
      {label}
      <input
        className="tl-input"
        aria-label={`Key ${label}`}
        defaultValue={value ?? ''}
        key={`${label}:${value ?? ''}:${selected?.trackId}:${selected?.index}`}
        onBlur={(e) => {
          const v = e.target.value.trim() === '' ? undefined : e.target.value.trim();
          if (v !== value) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
  const choice = (label: string, value: string | undefined, options: readonly string[], onChange: (v: string | undefined) => void): JSX.Element => (
    <label className="tl-timeline__field">
      {label}
      <select className="tl-input" aria-label={`Key ${label}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  const flag = (label: string, value: boolean | undefined, onChange: (v: boolean) => void): JSX.Element => (
    <label className="tl-timeline__field">
      <input type="checkbox" aria-label={`Key ${label}`} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
  const vec = (label: string, value: readonly number[] | undefined, n: number, onChange: (v: number[] | undefined) => void): JSX.Element =>
    text(`${label} (${n} numbers)`, value?.map((v) => String(round3(v))).join(', '), (s) => {
      if (s === undefined) return onChange(undefined);
      const parts = s.split(/[\s,]+/).filter((x) => x !== '').map(Number);
      if (parts.length === n && parts.every((x) => Number.isFinite(x))) onChange(parts);
      else setLocalError(`${label}: ${n} numbers`);
    });

  const keyInspector = (): JSX.Element | null => {
    if (selTrack === undefined || selKey === undefined) return <p className="tl-hint">Select a key to edit it. Drag keys along the ruler; the playhead's time is where new keys go.</p>;
    const t = selTrack;
    const k = selKey;
    const f: JSX.Element[] = [num('time', k.time, (v) => v !== undefined && setKey({ time: round3(snap(v)) }))];
    switch (t.type) {
      case 'camera':
        f.push(
          <label key="cam" className="tl-timeline__field">camera {slotSelect(k.camera, (v) => setKey({ camera: v || undefined }), 'Key camera')}</label>,
          flag('release', k.release, (v) => setKey(v ? { release: true, camera: undefined } : { release: undefined, camera: slots[0]?.name })),
          choice('blend', k.blend, ['cut', 'linear', 'eased'], (v) => setKey({ blend: v as TimelineKey['blend'] })),
          num('blendTime', k.blendTime, (v) => setKey({ blendTime: v })),
          vec('rail progress', k.progress, 2, (v) => setKey({ progress: v as [number, number] | undefined })),
          choice('easing', k.easing, TIMELINE_EASINGS, (v) => setKey({ easing: v as TimelineKey['easing'] })),
        );
        break;
      case 'transform': {
        const e = boundEntity(t.target);
        f.push(
          vec('position', k.position, 3, (v) => setKey({ position: v as [number, number, number] | undefined })),
          vec('rotation', k.rotation, 4, (v) => setKey({ rotation: v as [number, number, number, number] | undefined })),
          vec('scale', k.scale, 3, (v) => setKey({ scale: v as [number, number, number] | undefined })),
          choice('easing', k.easing, TIMELINE_EASINGS, (v) => setKey({ easing: v as TimelineKey['easing'] })),
          <button key="cap" className="tl-btn tl-btn--small" disabled={e === undefined} onClick={() => e !== undefined && setKey({ position: [e.position[0] ?? 0, e.position[1] ?? 0, e.position[2] ?? 0], rotation: [e.rotation[0] ?? 0, e.rotation[1] ?? 0, e.rotation[2] ?? 0, e.rotation[3] ?? 1], scale: [e.scale[0] ?? 1, e.scale[1] ?? 1, e.scale[2] ?? 1] })}>
            Capture the object's transform
          </button>,
        );
        break;
      }
      case 'animator':
        f.push(
          choice('kind', k.kind, ['set', 'trigger', 'play'], (v) => setKey({ kind: v as TimelineKey['kind'], ...(v === 'set' ? { value: 0 } : { value: undefined }), ...(v !== 'play' ? { fade: undefined, layer: undefined } : {}) })),
          text('name', k.name, (v) => setKey({ name: v })),
        );
        if (k.kind === 'set') f.push(text('value (number or true/false)', k.value === undefined ? undefined : String(k.value), (v) => setKey({ value: v === 'true' ? true : v === 'false' ? false : Number(v ?? 0) })));
        if (k.kind === 'play') f.push(num('fade', k.fade, (v) => setKey({ fade: v })));
        break;
      case 'audio':
        f.push(
          choice('kind', k.kind, ['music', 'release', 'stinger', 'sfx'], (v) => setKey({ kind: v as TimelineKey['kind'], ...(v === 'release' ? { asset: undefined } : { asset: k.asset ?? firstSound ?? undefined }), ...(v !== 'sfx' ? { loop: undefined, duration: undefined, at: undefined } : {}) })),
          <label key="asset" className="tl-timeline__field">
            asset
            <RefPicker aria="Key asset" kinds={AUDIO_KINDS} value={k.asset ?? ''} none="—" onPick={(v) => setKey({ asset: v === '' ? undefined : v })} />
          </label>,
          num('fade', k.fade, (v) => setKey({ fade: v })),
          num('volume', k.volume, (v) => setKey({ volume: v })),
        );
        if (k.kind === 'sfx') f.push(flag('loop', k.loop, (v) => setKey({ loop: v ? true : undefined })), num('duration', k.duration, (v) => setKey({ duration: v })));
        break;
      case 'dialogue':
        f.push(text('dialogue', k.dialogue, (v) => setKey({ dialogue: v })), text('node', k.node, (v) => setKey({ node: v })), flag('wait', k.wait !== false, (v) => setKey({ wait: v ? undefined : false })));
        break;
      case 'effect':
        f.push(choice('effect', k.effect, props.effects.map((x) => x.id), (v) => setKey({ effect: v })), num('duration', k.duration, (v) => setKey({ duration: v })), <label key="at" className="tl-timeline__field">at {slotSelect(k.at, (v) => setKey({ at: v || undefined }), 'Key at')}</label>, vec('position', k.position, 3, (v) => setKey({ position: v as [number, number, number] | undefined })));
        break;
      case 'activation':
        f.push(flag('active', k.active, (v) => setKey({ active: v })));
        break;
      case 'signal':
        f.push(text('name', k.name, (v) => setKey({ name: v })), choice('on skip', k.onSkip, ['fire', 'drop'], (v) => setKey({ onSkip: v as TimelineKey['onSkip'] })));
        break;
      case 'fade':
        f.push(num('value', typeof k.value === 'number' ? k.value : undefined, (v) => setKey({ value: v })), text('color', k.color, (v) => setKey({ color: v })), choice('easing', k.easing, TIMELINE_EASINGS, (v) => setKey({ easing: v as TimelineKey['easing'] })));
        break;
      case 'letterbox':
        f.push(num('value', typeof k.value === 'number' ? k.value : undefined, (v) => setKey({ value: v })), choice('easing', k.easing, TIMELINE_EASINGS, (v) => setKey({ easing: v as TimelineKey['easing'] })));
        break;
      case 'wait':
        f.push(choice('action', k.action, props.actions.includes(k.action ?? '') ? props.actions : [...props.actions, ...(k.action !== undefined ? [k.action] : [])], (v) => setKey({ action: v })), num('timeout', k.timeout, (v) => setKey({ timeout: v })));
        break;
      case 'material':
        f.push(
          text('value (number, n numbers or #rrggbb)', Array.isArray(k.value) ? k.value.join(', ') : k.value === undefined ? undefined : String(k.value), (v) => {
            if (v === undefined) return;
            if (/^#[0-9a-f]{6}$/.test(v)) return setKey({ value: v });
            const parts = v.split(/[\s,]+/).filter((x) => x !== '').map(Number);
            if (parts.every((x) => Number.isFinite(x))) setKey({ value: parts.length === 1 ? parts[0] : parts });
          }),
          choice('easing', k.easing, TIMELINE_EASINGS, (v) => setKey({ easing: v as TimelineKey['easing'] })),
        );
        break;
      case 'mode':
        f.push(choice('mode', k.mode, props.modes, (v) => setKey({ mode: v })), choice('blend', k.blend, ['cut', 'linear', 'eased'], (v) => setKey({ blend: v as TimelineKey['blend'] })), num('blendTime', k.blendTime, (v) => setKey({ blendTime: v })));
        break;
      case 'environment':
        f.push(text('preset', k.preset, (v) => setKey({ preset: v })), num('blendTime', k.blendTime, (v) => setKey({ blendTime: v })));
        break;
    }
    return (
      <div className="tl-timeline__inspector" aria-label="Key inspector" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <strong>
          {TYPE_LABEL[t.type]} key {selected!.index + 1}
        </strong>
        {f}
      </div>
    );
  };

  const controllerOf = (slot: string | undefined): AnimatorController | undefined => {
    const e = boundEntity(slot);
    const id = (e?.components['animator'] as { controller?: string } | undefined)?.controller;
    return props.animators.find((a) => a.controllerId === id);
  };

  return (
    <div className="tl-timeline tl-timeline-doc" data-timeline-id={tl.timelineId}>
      <div className="tl-timeline__head" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input className="tl-input" aria-label="Timeline name" defaultValue={tl.name} key={`name:${tl.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== tl.name && void save({ ...tl, name: e.target.value.trim() })} />
        <label>
          Duration (s){' '}
          <input className="tl-input" aria-label="Timeline duration" type="number" step={0.1} min={0.1} defaultValue={tl.duration} key={`dur:${tl.duration}`} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== tl.duration && void save({ ...tl, duration: Number(e.target.value) })} />
        </label>
        <label>
          Skip action{' '}
          <select className="tl-input" aria-label="Timeline skip action" value={tl.skipAction ?? ''} onChange={(e) => void save({ ...tl, skipAction: e.target.value === '' ? undefined : e.target.value })}>
            <option value="">none</option>
            {props.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" aria-label="Timeline plays on start" checked={tl.playOnStart === true} onChange={(e) => void save({ ...tl, playOnStart: e.target.checked ? true : undefined })} /> Play when a run starts
        </label>
        <label>
          Play on signal{' '}
          <input className="tl-input" aria-label="Timeline play on signal" defaultValue={tl.playOnSignal ?? ''} key={`sig:${tl.playOnSignal ?? ''}`} onBlur={(e) => e.target.value.trim() !== (tl.playOnSignal ?? '') && void save({ ...tl, playOnSignal: e.target.value.trim() === '' ? undefined : e.target.value.trim() })} />
        </label>
      </div>
      <div className="tl-timeline__slots" aria-label="Timeline slots" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong>Slots</strong>
        {slots.map((s, i) => (
          <span key={s.name} className="tl-timeline__slot" data-slot={s.name}>
            <input className="tl-input" aria-label={`Slot ${i + 1} name`} defaultValue={s.name} key={`slot:${s.name}`} style={{ width: 90 }} onBlur={(e) => e.target.value.trim() !== s.name && e.target.value.trim() !== '' && void save({ ...tl, slots: slots.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })} />
            <select className="tl-input" aria-label={`Slot ${s.name} object`} value={s.entity ?? ''} onChange={(e) => void save({ ...tl, slots: slots.map((x, j) => (j === i ? { name: x.name, ...(e.target.value !== '' ? { entity: e.target.value } : {}) } : x)) })}>
              <option value="">unbound</option>
              {props.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </span>
        ))}
        <button
          className="tl-btn tl-btn--small"
          onClick={() => {
            let n = slots.length + 1;
            while (slots.some((s) => s.name === `slot${n}`)) n += 1;
            void save({ ...tl, slots: [...slots, { name: `slot${n}` }] });
          }}
        >
          Add slot
        </button>
      </div>
      <div className="tl-timeline__bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="tl-btn tl-btn--small" aria-label={playing ? 'Pause preview' : 'Play preview'} onClick={() => (playing ? setPlaying(false) : (setTime((t) => (t >= tl.duration ? 0 : t)), setPlaying(true)))}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span aria-label="Timeline time" data-time={round3(time)}>
          {time.toFixed(2)} s / {tl.duration} s
        </span>
        <label>
          Zoom <input type="range" aria-label="Timeline zoom" min={20} max={400} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <select className="tl-input" aria-label="New track type" value={addType} onChange={(e) => setAddType(e.target.value as TimelineTrackType)}>
          {TIMELINE_TRACK_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <button className="tl-btn tl-btn--small" onClick={addTrack}>
          Add track
        </button>
        <button className="tl-btn tl-btn--small" onClick={addKey} disabled={selTrack === undefined}>
          Add key at playhead
        </button>
        <button className="tl-btn tl-btn--small" onClick={deleteKey} disabled={selKey === undefined}>
          Delete key
        </button>
        <button
          className="tl-btn tl-btn--small"
          onClick={() => {
            let n = (tl.markers ?? []).length + 1;
            while ((tl.markers ?? []).some((m) => m.name === `marker${n}`)) n += 1;
            void save({ ...tl, markers: [...(tl.markers ?? []), { name: `marker${n}`, time: round3(snap(time)) }] });
          }}
        >
          Add marker
        </button>
      </div>
      {(props.error !== null || localError !== null) && (
        <p className="tl-error" role="alert">
          {localError ?? props.error}
        </p>
      )}
      <div className="tl-timeline__body" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', border: '1px solid #3b4252', minHeight: 120 }}>
        <div style={{ height: 24, borderBottom: '1px solid #3b4252', padding: '2px 6px' }}>Tracks</div>
        <div style={{ overflowX: 'auto' }}>
          <div className="tl-timeline__ruler" aria-label="Timeline ruler" style={{ position: 'relative', width, height: 24, borderBottom: '1px solid #3b4252', cursor: 'col-resize', userSelect: 'none' }} onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
            {ticks}
            {(tl.markers ?? []).map((m) => (
              <span key={m.name} className="tl-timeline__marker" data-marker={m.name} title={m.name} style={{ position: 'absolute', left: m.time * zoom - 4, bottom: 0, width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '8px solid #ff7f9e' }} />
            ))}
            {playhead}
          </div>
        </div>
        {tl.tracks.map((t) => {
          const needsTarget = TIMELINE_TARGET_TRACKS.includes(t.type);
          const isSel = selected?.trackId === t.trackId;
          return [
            <div key={`${t.trackId}:h`} className={`tl-timeline__track-head${isSel ? ' is-active' : ''}`} data-track-id={t.trackId} style={{ display: 'flex', gap: 4, alignItems: 'center', height: 30, padding: '0 4px', borderBottom: '1px solid #2e3440', fontSize: 12 }}>
              <span style={{ minWidth: 70 }}>{t.name ?? TYPE_LABEL[t.type]}</span>
              {needsTarget && slotSelect(t.target, (v) => v !== '' && void save(withTrack(t.trackId, (x) => ({ ...x, target: v }))), `Track ${t.trackId} target`)}
              {t.type === 'material' && (
                <input className="tl-input" aria-label={`Track ${t.trackId} parameter`} style={{ width: 60 }} defaultValue={t.param ?? ''} key={`p:${t.param}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== t.param && void save(withTrack(t.trackId, (x) => ({ ...x, param: e.target.value.trim() })))} />
              )}
              {t.type === 'camera' && (
                <select className="tl-input" aria-label={`Track ${t.trackId} end`} value={t.end ?? 'release'} onChange={(e) => void save(withTrack(t.trackId, (x) => ({ ...x, end: e.target.value === 'keep' ? 'keep' : undefined })))}>
                  <option value="release">release at end</option>
                  <option value="keep">keep at end</option>
                </select>
              )}
              {(t.type === 'fade' || t.type === 'letterbox') && (
                <label title="keep the last value after the end">
                  <input type="checkbox" aria-label={`Track ${t.trackId} hold`} checked={t.hold === true} onChange={(e) => void save(withTrack(t.trackId, (x) => ({ ...x, hold: e.target.checked ? true : undefined })))} /> hold
                </label>
              )}
              <label title="mute">
                <input type="checkbox" aria-label={`Track ${t.trackId} muted`} checked={t.muted === true} onChange={(e) => void save(withTrack(t.trackId, (x) => ({ ...x, muted: e.target.checked ? true : undefined })))} /> mute
              </label>
              <button className="tl-btn tl-btn--small" aria-label={`Delete track ${t.trackId}`} onClick={() => void save({ ...tl, tracks: tl.tracks.filter((x) => x.trackId !== t.trackId) }).then(() => setSelected(null))}>
                ×
              </button>
            </div>,
            <div key={`${t.trackId}:l`} style={{ overflowX: 'hidden' }}>
              <div
                className="tl-timeline__lane"
                data-lane={t.trackId}
                style={{ position: 'relative', width, height: 30, borderBottom: '1px solid #2e3440', background: isSel ? 'rgba(143,180,255,0.08)' : undefined }}
                onPointerDown={() => setSelected({ trackId: t.trackId, index: -1 })}
              >
                {t.type === 'animator' && (
                  <span className="tl-timeline__eval" data-animator-eval={t.trackId} style={{ position: 'absolute', right: 4, top: 2, fontSize: 10, color: '#8fb4ff', pointerEvents: 'none' }}>
                    {animatorAt(controllerOf(t.target), t, Math.min(time, tl.duration))}
                  </span>
                )}
                {t.keys.map((k, i) => {
                  const sel = isSel && selected?.index === i;
                  const clip = k.duration !== undefined;
                  return (
                    <div
                      key={i}
                      className={`tl-timeline__key${sel ? ' is-selected' : ''}`}
                      data-track-id={t.trackId}
                      data-key-index={i}
                      data-time={k.time}
                      title={`${round3(k.time)} s ${keyLabel(t, k)}`}
                      role="button"
                      aria-label={`${t.trackId} key ${i + 1} at ${round3(k.time)} s`}
                      onPointerDown={(e) => onKeyDown(e, t, i)}
                      onPointerMove={onKeyMove}
                      onPointerUp={onKeyUp}
                      style={{
                        position: 'absolute',
                        left: k.time * zoom - (clip ? 0 : 6),
                        top: 7,
                        width: clip ? Math.max(12, (k.duration ?? 0) * zoom) : 12,
                        height: 16,
                        background: sel ? '#f2b544' : clip ? '#5e81ac' : '#8fb4ff',
                        transform: clip ? undefined : 'rotate(45deg) scale(0.8)',
                        borderRadius: clip ? 3 : 2,
                        cursor: 'ew-resize',
                        touchAction: 'none',
                        fontSize: 9,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        color: '#111',
                      }}
                    >
                      {clip ? keyLabel(t, k) : ''}
                    </div>
                  );
                })}
                {playhead}
              </div>
            </div>,
          ];
        })}
      </div>
      {tl.tracks.length === 0 && <p className="tl-hint">No tracks yet: add slots for the objects it acts on, then add tracks.</p>}
      {keyInspector()}
      <p className="tl-hint">
        Scene view preview at {time.toFixed(2)} s:{' '}
        {(() => {
          const p = evaluateTimelineAt(tl, Math.min(time, tl.duration));
          const moved = [...p.transforms.keys()].map((id) => entityName.get(id) ?? id);
          return `${moved.length > 0 ? `moves ${moved.join(', ')}` : 'no moves'}; camera ${p.camera !== null ? (entityName.get(p.camera.entityId) ?? p.camera.entityId) : 'none'}${p.fade !== null ? `; fade ${round3(p.fade.value)}` : ''}${p.letterbox !== null ? `; letterbox ${round3(p.letterbox)}` : ''}. Sound, effects, signals and dialogue play in Play only.`;
        })()}
      </p>
    </div>
  );
}
