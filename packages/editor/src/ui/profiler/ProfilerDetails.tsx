/**
 * The profiler panel's detail views of one profile: the selected frame's
 * breakdown (every thread's spans in it as a tree), the tier's budget table
 * (and the frame arbiter's slices), the counters, and the kept spikes.
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { PROFILE_CATEGORY_COLOURS, PROFILE_CATEGORY_LABELS, PROFILE_LANE_LABELS, PROFILE_LANES, type ProfileBreakdown, type ProfileReport, type ProfileSpike } from '@thirdlight/game-host/profile-view';

const ms = (v: number): string => v.toFixed(2);
const mib = (b: number | null | undefined): string => (typeof b === 'number' && b >= 0 ? `${(b / 1048576).toFixed(1)} MiB` : '—');
const count = (n: number | null | undefined): string => (typeof n !== 'number' ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)} k` : String(n));

function Swatch({ category }: { category: keyof typeof PROFILE_CATEGORY_COLOURS }): JSX.Element {
  return <span className="tl-prof__swatch" style={{ background: PROFILE_CATEGORY_COLOURS[category] }} aria-hidden />;
}

/** Every category's colour and name. */
export function ProfilerLegend(): JSX.Element {
  return (
    <div className="tl-prof__legend" aria-label="categories">
      {(Object.keys(PROFILE_CATEGORY_COLOURS) as (keyof typeof PROFILE_CATEGORY_COLOURS)[]).map((c) => (
        <span key={c} className="tl-prof__legend-item">
          <Swatch category={c} />
          {PROFILE_CATEGORY_LABELS[c]}
        </span>
      ))}
    </div>
  );
}

/** The selected frame: each thread's spans (name indented by nesting, category, ms, own ms). */
export function FrameBreakdown({ breakdown, frame }: { breakdown: ProfileBreakdown; frame: number }): JSX.Element {
  return (
    <div className="tl-prof__breakdown" data-testid="profiler-breakdown" data-frame={frame}>
      <div className="tl-prof__caption">
        Frame {frame}: {ms(breakdown.to - breakdown.from)} ms to the next{breakdown.long ? ' — long frame' : ''}
        {breakdown.ticks.length > 0 ? ` · simulation tick${breakdown.ticks.length > 1 ? 's' : ''} ${breakdown.ticks.join(', ')}` : ' · no simulation tick in it'}
      </div>
      {PROFILE_LANES.map((lane) => (
        <table key={lane} className="tl-prof__table" aria-label={`${PROFILE_LANE_LABELS[lane]} spans`} data-thread={lane}>
          <thead>
            <tr>
              <th className="tl-prof__name">{PROFILE_LANE_LABELS[lane]}</th>
              <th>category</th>
              <th className="tl-prof__num">ms</th>
              <th className="tl-prof__num">own ms</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.threads[lane].length === 0 ? (
              <tr>
                <td colSpan={4} className="tl-prof__none">
                  nothing recorded in this frame
                </td>
              </tr>
            ) : (
              breakdown.threads[lane].map((r, i) => (
                <tr key={i} data-span-name={r.name}>
                  <td className="tl-prof__name" style={{ paddingLeft: 6 + r.depth * 14 }}>
                    <Swatch category={r.category} />
                    {r.name}
                    {r.lane !== undefined ? <span className="tl-prof__dim"> · worker {r.lane}</span> : null}
                  </td>
                  <td className="tl-prof__dim">{PROFILE_CATEGORY_LABELS[r.category]}</td>
                  <td className="tl-prof__num">{ms(r.ms)}</td>
                  <td className="tl-prof__num">{ms(r.selfMs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      ))}
    </div>
  );
}

/** The tier's budget per thread and category beside the use over the kept frames; over-budget rows marked. Then the arbiter's slices. */
export function BudgetTable({ report }: { report: ProfileReport }): JSX.Element {
  const b = report.budget;
  return (
    <div>
      <div className="tl-prof__caption">
        The {b.tier} tier's budget at {b.hz} Hz ({b.intervalMs.toFixed(1)} ms a frame), against the mean and worst own time a frame over the kept frames. Job workers: one worker's frame.
      </div>
      <table className="tl-prof__table" aria-label="frame budget" data-testid="profiler-budget" data-tier={b.tier}>
        <thead>
          <tr>
            <th className="tl-prof__name">category</th>
            <th className="tl-prof__num">budget</th>
            <th className="tl-prof__num">mean</th>
            <th className="tl-prof__num">worst</th>
            <th className="tl-prof__use">use</th>
          </tr>
        </thead>
        {PROFILE_LANES.map((lane) => (
          <tbody key={lane}>
            <tr className="tl-prof__group">
              <td colSpan={5}>{PROFILE_LANE_LABELS[lane]} (ms a frame)</td>
            </tr>
          {b.rows.filter((r) => r.thread === lane).map((r) => {
            const over = r.use !== null && r.use > 1;
            return (
              <tr key={`${r.thread}/${r.category}`} className={over ? 'is-over' : undefined} data-thread={r.thread} data-category={r.category} data-over={over ? 'true' : 'false'}>
                <td className="tl-prof__name">
                  <Swatch category={r.category} />
                  {PROFILE_CATEGORY_LABELS[r.category]}
                </td>
                <td className="tl-prof__num">{ms(r.budgetMs)}</td>
                <td className="tl-prof__num">{ms(r.meanMs)}</td>
                <td className="tl-prof__num">{ms(r.worstMs)}</td>
                <td className="tl-prof__use">
                  {r.use === null ? (
                    <span className="tl-prof__dim">no budget</span>
                  ) : (
                    <>
                      <span className="tl-prof__meter">
                        <span style={{ width: `${Math.min(100, r.use * 100)}%` }} />
                      </span>
                      {Math.round(r.use * 100)} %{over ? ' over' : ''}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
          </tbody>
        ))}
      </table>
      <div className="tl-prof__caption">
        GPU plan (shares of a frame, compared with pass shares): {Object.entries(b.gpu).map(([c, v]) => `${PROFILE_CATEGORY_LABELS[c as keyof typeof PROFILE_CATEGORY_LABELS] ?? c} ${Math.round((v ?? 0) * 100)} %`).join(' · ')}
      </div>
      <table className="tl-prof__table" aria-label="frame arbiter slices" data-testid="profiler-slices">
        <thead>
          <tr>
            <th className="tl-prof__name">time slice</th>
            <th>thread</th>
            <th>category</th>
            <th className="tl-prof__num">ms now</th>
          </tr>
        </thead>
        <tbody>
          {report.slices.map((s) => (
            <tr key={s.id}>
              <td className="tl-prof__name">{s.id}</td>
              <td className="tl-prof__dim">{PROFILE_LANE_LABELS[s.thread]}</td>
              <td className="tl-prof__dim">{PROFILE_CATEGORY_LABELS[s.category]}</td>
              <td className="tl-prof__num">{s.msNow === null ? '—' : ms(s.msNow)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Draws, triangles, instances, memory, voxel counts, queues, and the profiler's own cost. */
export function Counters({ report }: { report: ProfileReport }): JSX.Element {
  const c = report.counters;
  const last = c.frames.at(-1);
  const rows: [string, string][] = [
    ['draw calls (last frame)', count(last?.drawCalls ?? c.stats?.drawCalls)],
    ['triangles (last frame)', count(last?.triangles ?? c.stats?.triangles)],
    ['instance copies (in view)', c.instances === null ? '—' : `${count(c.instances.copies)} (${count(c.instances.inView)})`],
    ['page heap', mib(last?.heapBytes)],
    ['textures on the GPU', c.stats === null ? '—' : `${mib(c.stats.textureBytes)} of ${mib(c.stats.textureBudgetBytes)}`],
    ['geometry', mib(c.stats?.geometryBytes)],
    ['GPU resources', c.gpuResources === null ? '—' : `${c.gpuResources.geometries} geometries · ${c.gpuResources.textures} textures · ${c.gpuResources.programs} programs`],
    ['voxel chunks drawn', count(c.voxels?.chunks)],
    ['voxel instances · triangles', c.voxels === null ? '—' : `${count(c.voxels.instances)} · ${count(c.voxels.triangles)}`],
    ['far field on the GPU', mib(c.voxels?.farGpuBytes)],
    ['voxel batches waiting', count(c.voxels?.batchesWaiting)],
    ['stored copies as table rows', c.copyRows == null ? 'off' : `${count(c.copyRows.sets)} sets · ${count(c.copyRows.rows)} rows · ${count(c.copyRows.inView)} in view of ${count(c.copyRows.listed)} listed · ${count(c.copyRows.drawn)} drawn`],
    ['interaction field', c.interaction == null ? 'off' : `${count(c.interaction.stamps)} stamps · ${c.interaction.live ? 'read' : 'idle'} · ${mib(c.interaction.bytes)}`],
    ['job queues', c.queues === null ? '—' : `${c.queues.workers} workers · ${c.queues.queued} queued · ${c.queues.backgroundQueued} background · ${c.queues.inFlight} running`],
    ['GPU room', report.gpu.room === 'headroom meter' ? 'measured by the headroom bench (node tools/voxel-bench/run.mjs headroom): it takes minutes and loads the GPU' : 'not measurable on this page'],
    ['profiler cost', `${report.cost.pageSpansPerFrame.toFixed(1)} page spans a frame at ${Math.round(report.cost.nsPerSpan)} ns`],
  ];
  return (
    <table className="tl-prof__table tl-prof__kv" aria-label="counters" data-testid="profiler-counters">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="tl-prof__dim">{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The kept long frames, newest first; opening one shows what every thread was doing over it. */
export function SpikeList({ report, open }: { report: ProfileReport; open: (s: ProfileSpike) => void }): JSX.Element {
  const spikes = [...report.spikes].reverse();
  if (spikes.length === 0) return <div className="tl-prof__none">No long frames kept. A frame is kept when it misses the cap by half a frame, or a thread's own work passes a frame.</div>;
  const reason = { interval: 'missed frame', page: 'page work past a frame', sim: 'simulation tick past a frame' } as const;
  return (
    <ul className="tl-prof__spikes" aria-label="spikes" data-testid="profiler-spikes">
      {spikes.map((s) => {
        const worst = [...s.threads.page, ...s.threads.sim].flatMap((f) => f.spans).sort((a, b) => b.ms - a.ms)[0];
        return (
          <li key={s.at}>
            <button className="tl-btn tl-btn--small" onClick={() => open(s)} title="Show what every thread was doing over this frame">
              Open
            </button>
            <span className="tl-prof__spike-ms">{ms(s.ms)} ms</span>
            <span className="tl-prof__dim">
              {reason[s.reason]} (limit {ms(s.thresholdMs)}) · {((report.at - s.at) / 1000).toFixed(0)} s before the read
              {worst !== undefined ? ` · longest span ${worst.name} ${ms(worst.ms)} ms` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
