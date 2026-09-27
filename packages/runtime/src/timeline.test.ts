/**
 * Phase 23.17: the sequencer's track evaluation, easing, bindings, wait-for-input,
 * skip end states and events, over a recording fake host.
 */
import { describe, expect, it } from 'vitest';

import { canonicalTimeline, validateTimeline, type ModelErrorV2, type TimelineAsset } from '@thirdlight/project-model';

import type { ActionFrame } from './actions';
import { evaluateTimelineAt, timelineEase, transformTrackAt, valueTrackAt, TimelineSystem, type TimelineHost, type TimelineTransformPose } from './timeline';

const HZ = 60;

function fakeHost(): { host: TimelineHost; log: string[]; poses: Map<string, TimelineTransformPose>; visible: Map<string, boolean>; signals: Set<string>; forced: { id: string | null; blend: unknown }[]; progress: Map<string, number>; materials: Map<string, unknown>; playingSounds: Set<number> } {
  const log: string[] = [];
  const poses = new Map<string, TimelineTransformPose>();
  const visible = new Map<string, boolean>();
  const signals = new Set<string>();
  const forced: { id: string | null; blend: unknown }[] = [];
  const progress = new Map<string, number>();
  const materials = new Map<string, unknown>();
  const playingSounds = new Set<number>();
  let handle = 0;
  const host: TimelineHost = {
    writeTransform: (id, pose) => {
      if (id === 'missing') return false;
      poses.set(id, { ...poses.get(id), ...pose });
      return true;
    },
    cameraOverride: (id, blend) => void forced.push({ id, blend }),
    cameraProgress: (id, p) => void progress.set(id, p),
    cameraActivate: (id) => void log.push(`activate ${id}`),
    animator: (id) =>
      id === 'actor'
        ? {
            set: (n, v) => (log.push(`set ${n}=${String(v)}`), true),
            trigger: (n) => (log.push(`trigger ${n}`), true),
            play: (st, fade) => (log.push(`play ${st} ${fade}`), true),
          }
        : null,
    audio: {
      music: (a, f) => void log.push(`music ${a} ${f}`),
      releaseMusic: (f) => void log.push(`release ${f}`),
      stinger: (a) => (log.push(`stinger ${a}`), ++handle),
      play: (a) => {
        log.push(`sfx ${a}`);
        playingSounds.add(++handle);
        return handle;
      },
      stop: (h, f) => {
        log.push(`stop sound ${h} ${f}`);
        playingSounds.delete(h);
      },
      playing: (h) => playingSounds.has(h),
    },
    effects: { play: (e) => (log.push(`effect ${e}`), ++handle), stop: (h) => void log.push(`stop effect ${h}`) },
    setVisible: (id, v) => void visible.set(id, v),
    emitSignal: (n) => void log.push(`signal ${n}`),
    signaled: (n) => signals.has(n),
    setMaterial: (id, p, v) => (materials.set(`${id}.${p}`, v), true),
    switchMode: (m, t) => (log.push(`mode ${m} ${t.blend ?? ''}`), m !== 'nope'),
    warn: (m) => void log.push(`warn ${m}`),
  };
  return { host, log, poses, visible, signals, forced, progress, materials, playingSounds };
}

/** A neutral six-shot sequence over 3 s. */
function sequence(): TimelineAsset {
  return canonicalTimeline({
    timelineId: 'intro',
    name: 'Intro',
    duration: 3,
    slots: [{ name: 'actor', entity: 'actor' }, { name: 'camA', entity: 'cam-a' }, { name: 'camB', entity: 'cam-b' }, { name: 'rail', entity: 'cam-rail' }],
    markers: [{ name: 'halfway', time: 1.5 }],
    skipAction: 'skip',
    tracks: [
      {
        trackId: 'cams',
        type: 'camera',
        keys: [
          { time: 0, camera: 'camA' },
          { time: 0.5, camera: 'camB', blend: 'eased', blendTime: 0.25 },
          { time: 1, camera: 'rail', progress: [0, 1] },
          { time: 2, camera: 'camA', blend: 'linear', blendTime: 0.5 },
        ],
        endBlend: 'eased',
        endBlendTime: 0.5,
      },
      { trackId: 'move', type: 'transform', target: 'actor', keys: [{ time: 0, position: [0, 0, 0] }, { time: 2, position: [4, 0, 0], easing: 'easeInOut' }] },
      { trackId: 'anim', type: 'animator', target: 'actor', keys: [{ time: 0.2, kind: 'set', name: 'speed', value: 1 }, { time: 0.4, kind: 'trigger', name: 'wave' }, { time: 2.5, kind: 'set', name: 'speed', value: 0 }, { time: 2.6, kind: 'play', name: 'Idle', fade: 0.2 }] },
      { trackId: 'music', type: 'audio', keys: [{ time: 0, kind: 'music', asset: 'calm', fade: 0.5 }, { time: 1.5, kind: 'stinger', asset: 'hit' }, { time: 2.2, kind: 'music', asset: 'tense', fade: 1 }, { time: 2.4, kind: 'sfx', asset: 'door' }] },
      { trackId: 'sig', type: 'signal', keys: [{ time: 1.5, name: 'gate_open' }, { time: 2.8, name: 'cosmetic', onSkip: 'drop' }] },
      { trackId: 'vis', type: 'activation', target: 'actor', keys: [{ time: 2.9, active: false }] },
      { trackId: 'fade', type: 'fade', keys: [{ time: 0, value: 1 }, { time: 0.5, value: 0 }, { time: 2.5, value: 0 }, { time: 3, value: 1, color: '#102030' }] },
      { trackId: 'bars', type: 'letterbox', keys: [{ time: 0, value: 0.12 }] },
    ],
  });
}

function frame(stepIndex: number, pressed: string[] = []): ActionFrame {
  return { stepIndex, moveX: 0, jump: 'none', actions: Object.fromEntries(pressed.map((n) => [n, { v: 1, p: 'pressed' as const }])) } as ActionFrame;
}

describe('phase 23.17: timeline data', () => {
  it('validates a neutral sequence and refuses unbound slots, bad keys and out-of-range times', () => {
    const errors: ModelErrorV2[] = [];
    validateTimeline(sequence(), '', errors);
    expect(errors).toEqual([]);
    const bad = structuredClone(sequence()) as unknown as Record<string, unknown>;
    (bad['tracks'] as Record<string, unknown>[])[1]!['target'] = 'nobody';
    ((bad['tracks'] as Record<string, unknown>[])[0]!['keys'] as Record<string, unknown>[])[0]!['time'] = 9;
    ((bad['tracks'] as Record<string, unknown>[])[2]!['keys'] as Record<string, unknown>[])[0]!['bogus'] = 1;
    const e2: ModelErrorV2[] = [];
    validateTimeline(bad, '', e2);
    expect(e2.map((e) => e.code).sort()).toEqual(['field_unexpected', 'field_value', 'reference_missing'].sort());
  });

  it('canonical form sorts keys by time (stable) and markers', () => {
    const c = canonicalTimeline({ timelineId: 'a', name: 'A', duration: 2, tracks: [{ trackId: 't', type: 'signal', keys: [{ time: 1, name: 'b' }, { time: 0.5, name: 'a' }, { time: 1, name: 'c' }] }] });
    expect(c.tracks[0]!.keys.map((k) => k.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('phase 23.17: evaluation', () => {
  it('easing curves', () => {
    expect(timelineEase('linear', 0.25)).toBe(0.25);
    expect(timelineEase('easeIn', 0.5)).toBe(0.25);
    expect(timelineEase('easeOut', 0.5)).toBe(0.75);
    expect(timelineEase('easeInOut', 0.25)).toBe(0.125);
    expect(timelineEase('step', 0.99)).toBe(0);
    expect(timelineEase('step', 1)).toBe(1);
  });

  it('transform, value and colour tracks; nothing before the first key; the last value after the last', () => {
    const tl = sequence();
    const move = tl.tracks.find((t) => t.trackId === 'move')!;
    expect(transformTrackAt(move, 1).position![0]).toBeCloseTo(2, 9); // easeInOut at the middle
    expect(transformTrackAt(move, 0.5).position![0]).toBeCloseTo(4 * 0.125, 9);
    expect(transformTrackAt(move, 2.7).position).toEqual([4, 0, 0]);
    const fade = tl.tracks.find((t) => t.trackId === 'fade')!;
    expect(valueTrackAt(fade, 0.25)).toBeCloseTo(0.5, 9);
    expect(valueTrackAt(fade, 2.75)).toBeCloseTo(0.5, 9);
    const late = { trackId: 'x', type: 'material' as const, target: 'actor', param: 'tint', keys: [{ time: 1, value: '#000000' }, { time: 2, value: '#ff0080' }] };
    expect(valueTrackAt(late, 0.5)).toBeUndefined();
    expect(valueTrackAt(late, 1.5)).toBe('#800040');
    const p = evaluateTimelineAt(tl, 1.5);
    expect(p.camera).toEqual({ entityId: 'cam-rail', progress: 0.5 });
    expect(p.transforms.get('actor')!.position![0]).toBeCloseTo(4 * (1 - 2 * 0.25 * 0.25), 9);
    expect(p.markers).toEqual(['halfway']);
    // Bindings: another actor.
    const other = evaluateTimelineAt(tl, 1, new Map([['actor', 'someone'], ['camA', 'cam-a']]));
    expect([...other.transforms.keys()]).toEqual(['someone']);
  });
});

describe('phase 23.17: the system', () => {
  it('plays to the end: cameras with their blends, keys in order, markers and events, the end releases the camera', () => {
    const f = fakeHost();
    const sys = new TimelineSystem([sequence()], HZ, f.host);
    const h = sys.play('intro');
    expect(h).toBe(1);
    const events: string[] = [];
    for (let s = 1; s <= 3 * HZ + 2; s += 1) {
      sys.step(s, frame(s));
      for (const e of sys.events()) events.push(`${e.kind}:${e.name}${e.reason}@${e.stepIndex}`);
    }
    expect(events).toEqual(['started:@1', 'marker:halfway@91', `ended:finished@${3 * HZ + 1}`]);
    expect(f.forced.map((x) => x.id)).toEqual(['cam-a', 'cam-b', 'cam-rail', 'cam-a', null]);
    expect(f.forced[1]!.blend).toEqual({ blend: 'eased', time: 0.25 });
    expect(f.forced[4]!.blend).toEqual({ blend: 'eased', time: 0.5 });
    // The rail rode its key's span (0 → 1) until the next cut.
    expect(f.progress.get('cam-rail')).toBeCloseTo(59 / 60, 9);
    expect(f.log.filter((l) => !l.startsWith('warn'))).toEqual(['music calm 0.5', 'set speed=1', 'trigger wave', 'stinger hit', 'signal gate_open', 'music tense 1', 'sfx door', 'set speed=0', 'play Idle 0.2', 'signal cosmetic']);
    expect(f.visible.get('actor')).toBe(false);
    expect(f.poses.get('actor')!.position).toEqual([4, 0, 0]);
    expect(sys.state(h)).toBe('ended');
    // The fade is cleared at the end (no hold); the screen view shows none.
    expect(sys.view()!.screen.opacity).toBe(0);
  });

  it('skip mid-way applies the end states: final camera released by a cut, transforms at the end, the last music, remaining signals except dropped ones, no stingers/sfx/triggers', () => {
    const f = fakeHost();
    const sys = new TimelineSystem([sequence()], HZ, f.host);
    const h = sys.play('intro');
    for (let s = 1; s <= 40; s += 1) sys.step(s, frame(s));
    f.log.length = 0;
    sys.skip(h);
    sys.step(41, frame(41));
    expect(f.log.filter((l) => !l.startsWith('warn'))).toEqual(['signal gate_open', 'music tense 1', 'set speed=0', 'play Idle 0']);
    expect(f.poses.get('actor')!.position).toEqual([4, 0, 0]);
    expect(f.visible.get('actor')).toBe(false);
    expect(f.forced.at(-1)).toEqual({ id: null, blend: { blend: 'cut', time: 0 } });
    expect(sys.events().map((e) => `${e.kind}${e.reason}`)).toEqual(['endedskipped']);
    expect(sys.state(h)).toBe('ended');
  });

  it('skip stops the sounds the timeline started; the skip action skips too', () => {
    const f = fakeHost();
    const sys = new TimelineSystem([sequence()], HZ, f.host);
    sys.play('intro');
    for (let s = 1; s <= 150; s += 1) sys.step(s, frame(s));
    expect(f.playingSounds.size).toBe(1); // the door sfx (2.4 s)
    sys.step(151, frame(151, ['skip']));
    expect(f.log).toContain('stop sound 2 0.1');
    expect(sys.view()!.playing).toEqual([]);
  });

  it('wait-for-input holds the time until the action is pressed (or the timeout)', () => {
    const f = fakeHost();
    const tl = canonicalTimeline({
      timelineId: 'talk',
      name: 'Talk',
      duration: 1,
      tracks: [
        { trackId: 'w', type: 'wait', keys: [{ time: 0.5, action: 'confirm' }, { time: 0.75, action: 'confirm', timeout: 0.1 }] },
        { trackId: 's', type: 'signal', keys: [{ time: 0.6, name: 'after' }] },
      ],
    });
    const sys = new TimelineSystem([tl], HZ, f.host);
    const h = sys.play('talk');
    for (let s = 1; s <= 200; s += 1) sys.step(s, frame(s));
    expect(sys.state(h)).toBe('waiting');
    expect(sys.time(h)).toBeCloseTo(0.5, 9);
    expect(f.log).not.toContain('signal after');
    sys.step(201, frame(201, ['confirm']));
    expect(sys.state(h)).toBe('playing');
    let steps = 0;
    while (sys.state(h) !== 'ended' && steps < 400) sys.step(202 + steps, frame(202 + (steps++)));
    expect(f.log).toContain('signal after');
    // The second wait timed out after 6 steps: 0.25 s + 0.1 s + 0.25 s ≈ 36 steps (plus the end step).
    expect(steps).toBeGreaterThan(30);
    expect(steps).toBeLessThan(45);
  });

  it('bindings from the play call override the slot defaults; pause holds, seek jumps without firing keys', () => {
    const f = fakeHost();
    const sys = new TimelineSystem([sequence()], HZ, f.host);
    const h = sys.play('intro', { actor: 'actor', camA: 'cam-z' });
    sys.step(1, frame(1));
    expect(f.forced.at(-1)!.id).toBe('cam-z');
    sys.pause(h);
    for (let s = 2; s <= 20; s += 1) sys.step(s, frame(s));
    expect(sys.state(h)).toBe('paused');
    expect(sys.time(h)).toBe(0);
    sys.resume(h);
    sys.seek(h, 2.2);
    f.log.length = 0;
    sys.step(21, frame(21));
    expect(sys.time(h)).toBeCloseTo(2.2, 9);
    expect(f.log.filter((l) => !l.startsWith('warn'))).toEqual([]);
    expect(f.forced.at(-1)).toEqual({ id: 'cam-z', blend: { blend: 'cut', time: 0 } });
  });

  it('plays on a signal and when a run starts; reset stops everything', () => {
    const f = fakeHost();
    const a = canonicalTimeline({ timelineId: 'a', name: 'A', duration: 1, playOnStart: true, tracks: [] });
    const b = canonicalTimeline({ timelineId: 'b', name: 'B', duration: 1, playOnSignal: 'go', tracks: [] });
    const sys = new TimelineSystem([a, b], HZ, f.host);
    sys.step(1, null);
    expect(sys.isPlaying('a')).toBe(true);
    expect(sys.isPlaying('b')).toBe(false);
    f.signals.add('go');
    sys.step(2, null);
    expect(sys.isPlaying('b')).toBe(true);
    sys.reset();
    expect(sys.isPlaying('a')).toBe(false);
    f.signals.clear();
    sys.step(3, null);
    expect(sys.isPlaying('a')).toBe(true);
  });

  it('mode keys switch the game mode; skip applies only the last remaining one (cut)', () => {
    const f = fakeHost();
    const tl = canonicalTimeline({ timelineId: 'm', name: 'M', duration: 2, tracks: [{ trackId: 'modes', type: 'mode', keys: [{ time: 0.5, mode: 'cutscene', blend: 'eased' }, { time: 1, mode: 'explore' }, { time: 1.5, mode: 'battle', blend: 'linear' }] }] });
    const sys = new TimelineSystem([tl], HZ, f.host);
    const h = sys.play('m');
    for (let s = 1; s <= 32; s += 1) sys.step(s, frame(s));
    expect(f.log).toEqual(['mode cutscene eased']);
    sys.skip(h);
    sys.step(33, frame(33));
    expect(f.log.slice(1)).toEqual(['mode explore cut', 'mode battle cut']);
  });

  it('same inputs, same state: two systems agree step by step', () => {
    const run = (): string[] => {
      const f = fakeHost();
      const sys = new TimelineSystem([sequence()], HZ, f.host);
      sys.play('intro');
      const out: string[] = [];
      for (let s = 1; s <= 200; s += 1) {
        sys.step(s, frame(s, s === 120 ? ['skip'] : []));
        out.push(sys.digestState() ?? '');
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
