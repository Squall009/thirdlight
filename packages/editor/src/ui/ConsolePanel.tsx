/**
 * Phase 25.9: the Console (bottom dock) — the running Play's script logs and
 * errors, newest last, each with where it happened in the project's own
 * sources: the behavior or library file, line and column (the backend maps
 * the compiled position with the build's source maps). A location opens that
 * file in its code editor tab at the line; an error also lists the script
 * frames it passed through.
 *
 * It reads the Play's diagnostics (the same route `tl_diagnostics` uses)
 * about once a second while it is shown and a Play runs, and keeps the last
 * entries after the Play stops.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { consoleEntriesOf, describeCompiled, describeLocation, type ConsoleEntry, type SourceLocation } from '../session/source-location';

interface Props {
  /** The running Play (null: none). */
  playSessionId: string | null;
  /** Read the Play's diagnostics (the backend relay). */
  fetchDiagnostics: (playSessionId: string) => Promise<{ ok: true; diagnostics: unknown } | { ok: false; message: string }>;
  onOpenSource: (loc: SourceLocation) => void;
}

const POLL_MS = 1000;

function levelOf(e: ConsoleEntry): 'info' | 'warn' | 'error' {
  if (e.code !== 'behavior_log') return 'error';
  return e.reason === 'warn' ? 'warn' : e.reason === 'info' ? 'info' : 'error';
}

export function ConsolePanel({ playSessionId, fetchDiagnostics, onOpenSource }: Props): JSX.Element {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [from, setFrom] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const busy = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (playSessionId === null || busy.current) return;
    busy.current = true;
    try {
      const r = await fetchDiagnostics(playSessionId);
      if (r.ok) {
        setEntries(consoleEntriesOf(r.diagnostics));
        setFrom(playSessionId);
        setStatus('');
      } else setStatus(r.message);
    } finally {
      busy.current = false;
    }
  }, [playSessionId, fetchDiagnostics]);

  useEffect(() => {
    if (playSessionId === null) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [playSessionId, refresh]);

  const where = (loc: SourceLocation, label: string): JSX.Element => (
    <button className="tl-console__where" aria-label={label} data-path={loc.path} data-line={loc.line} onClick={() => onOpenSource(loc)} title="Open this line in its code editor tab">
      {describeLocation(loc)}
    </button>
  );

  return (
    <div className="tl-panel tl-console" aria-label="console">
      <div className="tl-panel__title">
        Console
        <span className="tl-prop__caption">
          {playSessionId !== null ? ' · Play running' : from !== null ? ' · from the last Play' : ' · start Play to see script logs and errors'}
          {status !== '' ? ` · ${status}` : ''}
        </span>
        <button className="tl-btn tl-btn--small" disabled={playSessionId === null} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="tl-inspector__empty">No script logs or errors.</div>
      ) : (
        <ul className="tl-console__list" aria-label="console entries">
          {entries.map((e, i) => {
            const level = levelOf(e);
            return (
              <li key={`${i}-${e.stepIndex ?? ''}-${e.code}`} className={`tl-console__entry tl-console__entry--${level}`} data-level={level} data-code={e.code}>
                <span className="tl-console__level">{level}</span>
                {e.stepIndex !== undefined && <span className="tl-console__step">step {e.stepIndex}</span>}
                <span className="tl-console__message">{e.message}</span>
                {e.source !== undefined ? where(e.source, 'source location') : e.at !== undefined ? <span className="tl-console__compiled" title="a compiled position without a source map">{describeCompiled(e.at)}</span> : null}
                {e.sources !== undefined && e.sources.length > 1 && (
                  <ul className="tl-console__frames" aria-label="script frames">
                    {e.sources.slice(1).map((s, k) => (
                      <li key={k}>called from {s !== null ? where(s, 'frame location') : '(no source map)'}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
