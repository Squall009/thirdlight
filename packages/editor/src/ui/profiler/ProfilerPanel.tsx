/**
 * The Profiler (bottom dock): the running Play's frame profile, read from
 * the play page about twice a second while the tab shows (the page's
 * `read(after)`: only what arrived since the last read), kept here as the
 * page keeps it (the last frames of every thread) and shown as a timeline
 * of frames against the cap, the selected frame's breakdown, the tier's
 * budget table with the frame arbiter's slices, counters and the kept long
 * frames. Pause freezes the view; Save capture writes the profile as a file
 * (`version: 1`) and Open capture shows one again, marked as a file.
 * Measure GPU starts the play page's GPU measurement (game-host
 * gpu-measure.ts: about two minutes, the GPU loaded past its cap); its
 * progress shows in the bar and its ms per pass category in Budget.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  makeProfileCapture,
  parseProfileCapture,
  profileBreakdown,
  profileCaptureFileName,
  profileCaptureText,
  profileColumns,
  profileOfSpike,
  profileSpikeColumn,
  ProfileAccumulator,
  type ProfileCapture,
  type ProfileCursor,
  type ProfileReport,
  type ProfileSpike,
} from '@thirdlight/game-host/profile-view';

import { BudgetTable, Counters, FrameBreakdown, gpuMeasureNote, ProfilerLegend, SpikeList } from './ProfilerDetails';
import { ProfilerTimeline } from './ProfilerTimeline';

interface Props {
  /** The running Play (null: none). */
  playSessionId: string | null;
  /** One read of the Play's profile since `after` (the play session's bridge poll); `gpu` starts or stops the GPU measurement with it. */
  readProfile: (after?: ProfileCursor, gpu?: 'measure' | 'cancel') => Promise<Record<string, unknown> | null>;
}

const POLL_MS = 500;
type Tab = 'frame' | 'budget' | 'counters' | 'spikes';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'frame', label: 'Frame' },
  { id: 'budget', label: 'Budget' },
  { id: 'counters', label: 'Counters' },
  { id: 'spikes', label: 'Spikes' },
];

function saveFile(capture: ProfileCapture): void {
  const href = URL.createObjectURL(new Blob([profileCaptureText(capture)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = profileCaptureFileName(capture);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function ProfilerPanel({ playSessionId, readProfile }: Props): JSX.Element {
  const acc = useRef(new ProfileAccumulator());
  const [live, setLive] = useState<ProfileReport | null>(null);
  const meta = useRef<{ build: string | null; renderer: string | null }>({ build: null, renderer: null });
  const [paused, setPaused] = useState(false);
  const [file, setFile] = useState<{ name: string; capture: ProfileCapture } | null>(null);
  const [spike, setSpike] = useState<ProfileSpike | null>(null);
  /** The selected frame by its start (null: the newest). */
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('frame');
  const [status, setStatus] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const busy = useRef(false);
  const session = useRef<string | null>(null);
  /** A GPU measurement start or stop the next read carries. */
  const gpuAsk = useRef<'measure' | 'cancel' | null>(null);

  // A new Play starts a new profile.
  useEffect(() => {
    if (playSessionId !== null && playSessionId !== session.current) {
      session.current = playSessionId;
      acc.current.clear();
      setLive(null);
      setSelectedStart(null);
      setSpike(null);
    }
  }, [playSessionId]);

  const poll = useCallback(async (): Promise<void> => {
    if (playSessionId === null || busy.current) return;
    busy.current = true;
    try {
      const cursor = acc.current.cursor;
      const ask = gpuAsk.current;
      gpuAsk.current = null;
      const r = await readProfile(cursor ?? undefined, ask ?? undefined);
      if (session.current !== playSessionId) return;
      const report = r?.['report'] as ProfileReport | undefined;
      if (report === undefined || typeof report !== 'object' || report === null || !('seq' in report)) {
        setStatus('the play page did not answer');
        return;
      }
      meta.current = { build: typeof r!['build'] === 'string' ? (r!['build'] as string) : null, renderer: typeof r!['renderer'] === 'string' ? (r!['renderer'] as string) : null };
      acc.current.add(report);
      setLive(acc.current.report());
      setStatus('');
    } finally {
      busy.current = false;
    }
  }, [playSessionId, readProfile]);

  useEffect(() => {
    if (playSessionId === null || paused || file !== null) return;
    void poll();
    const t = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(t);
  }, [playSessionId, paused, file, poll]);

  const base = file !== null ? file.capture.report : live;
  const gpuState = base?.gpu.measure;
  const measuring = file === null && gpuState?.state === 'running';
  const askGpu = (what: 'measure' | 'cancel'): void => {
    gpuAsk.current = what;
    void poll();
  };
  const shown = base !== null && spike !== null ? profileOfSpike(base, spike) : base;
  const columns = useMemo(() => (shown === null ? [] : profileColumns(shown)), [shown]);
  const selectedIndex = useMemo(() => {
    if (columns.length === 0) return null;
    // A spike opens at its long frame.
    if (selectedStart === null) return (spike !== null ? profileSpikeColumn(columns, spike) : null) ?? columns.length - 1;
    const i = columns.findIndex((c) => c.from === selectedStart);
    return i >= 0 ? i : columns.length - 1;
  }, [columns, selectedStart, spike]);
  const selected = selectedIndex !== null ? columns[selectedIndex] : undefined;
  const breakdown = useMemo(() => (shown !== null && selected !== undefined ? profileBreakdown(shown, selected) : null), [shown, selected]);
  const readout = hover !== null ? columns[hover] : selected;

  const save = (): void => {
    if (file !== null) saveFile(file.capture);
    else if (live !== null) saveFile(makeProfileCapture(live, { build: meta.current.build, renderer: meta.current.renderer, source: 'editor' }));
  };
  const open = async (f: File): Promise<void> => {
    const parsed = parseProfileCapture(await f.text());
    if (!parsed.ok) {
      setStatus(`${f.name}: ${parsed.error}`);
      return;
    }
    setFile({ name: f.name, capture: parsed.capture });
    setSpike(null);
    setSelectedStart(null);
    setStatus('');
  };

  const where =
    file !== null
      ? `File ${file.name} · saved ${file.capture.header.date.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} from ${file.capture.header.source}${file.capture.header.renderer !== null ? `, ${file.capture.header.renderer}` : ''}`
      : playSessionId !== null
        ? paused
          ? 'Play running · paused'
          : 'Play running'
        : live !== null
          ? 'from the last Play'
          : 'start Play to profile it';
  return (
    <div className="tl-panel tl-prof" aria-label="profiler" data-mode={file !== null ? 'file' : 'live'} data-paused={paused ? 'true' : 'false'}>
      <div className="tl-prof__bar">
        <span className={`tl-prof__where${file !== null ? ' is-file' : ''}`} data-testid="profiler-where">
          {where}
        </span>
        {shown !== null && (
          <span className="tl-prof__dim">
            {shown.budget.tier} tier · {shown.frameRateCap !== null ? `cap ${shown.frameRateCap} fps` : 'no cap'} · frame {shown.intervalMs.toFixed(1)} ms · {shown.threads.page.length} frames
          </span>
        )}
        {spike !== null && (
          <span className="tl-prof__spike-note">
            spike of {spike.ms.toFixed(1)} ms: its own frames
            <button className="tl-btn tl-btn--small" onClick={() => setSpike(null)}>
              Back
            </button>
          </span>
        )}
        {status !== '' && <span className="tl-prof__status" role="status">{status}</span>}
        {gpuMeasureNote(gpuState) !== '' && (
          <span className="tl-prof__dim" data-testid="profiler-gpu-note" data-state={gpuState?.state ?? 'idle'}>
            {gpuMeasureNote(gpuState)}
          </span>
        )}
        <span className="tl-prof__actions">
          {file === null ? (
            <button className="tl-btn tl-btn--small" disabled={playSessionId === null} onClick={() => setPaused((p) => !p)} title={paused ? 'Read the Play again' : 'Freeze the view to inspect it'}>
              {paused ? 'Resume' : 'Pause'}
            </button>
          ) : (
            <button className="tl-btn tl-btn--small" onClick={() => setFile(null)} title="Back to the running Play's profile">
              Back to live
            </button>
          )}
          {file === null && (
            <button
              className="tl-btn tl-btn--small"
              disabled={playSessionId === null}
              data-testid="profiler-measure-gpu"
              onClick={() => askGpu(measuring ? 'cancel' : 'measure')}
              title={measuring ? 'Stop the GPU measurement' : 'Measure each pass\'s GPU ms: loads the GPU past its cap for about two minutes (WebGPU)'}
            >
              {measuring ? 'Stop measuring' : 'Measure GPU'}
            </button>
          )}
          <button className="tl-btn tl-btn--small" disabled={base === null} onClick={save} title="Save the profile as a capture file (JSON, version 1)">
            Save capture
          </button>
          <button className="tl-btn tl-btn--small" onClick={() => fileInput.current?.click()} title="Open a capture file to inspect it">
            Open capture…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="profiler-open"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f !== undefined) void open(f);
            }}
          />
        </span>
      </div>
      {shown === null ? (
        <div className="tl-inspector__empty">{playSessionId !== null ? 'Waiting for the first frames…' : 'Start Play to see every thread\'s time a frame, the budget and long frames. A capture file can be opened here too.'}</div>
      ) : (
        <div className="tl-prof__main">
          <div className="tl-prof__left">
            <ProfilerTimeline report={shown} columns={columns} slots={spike !== null ? 16 : undefined} selected={selectedIndex} onSelect={(i) => setSelectedStart(columns[i]?.from ?? null)} onHover={setHover} />
            <div className="tl-prof__readout" data-testid="profiler-readout">
              {readout === undefined
                ? ''
                : `frame ${readout.page.frame}${readout.intervalMs !== null ? ` · ${readout.intervalMs.toFixed(1)} ms to the next` : ''} · page ${readout.lanes.page.ms.toFixed(2)} ms · simulation ${readout.lanes.sim.ms.toFixed(2)} ms · jobs ${readout.lanes.jobs.ms.toFixed(2)} ms a worker${readout.long ? ' · long' : ''}`}
            </div>
            <ProfilerLegend />
          </div>
          <div className="tl-prof__right">
            <div className="tl-tabs tl-prof__tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tl-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.id === 'spikes' && shown.spikes.length > 0 ? <span className="tl-tab__count">{shown.spikes.length}</span> : null}
                </button>
              ))}
            </div>
            <div className="tl-prof__detail">
              {tab === 'frame' && breakdown !== null && selected !== undefined && <FrameBreakdown breakdown={breakdown} frame={selected.page.frame} />}
              {tab === 'budget' && <BudgetTable report={shown} />}
              {tab === 'counters' && <Counters report={shown} />}
              {tab === 'spikes' && (
                <SpikeList
                  report={base ?? shown}
                  open={(s) => {
                    setSpike(s);
                    setSelectedStart(null);
                    setTab('frame');
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
