/**
 * Phase 14.6: "clips for rig of <asset>" on a model asset — an
 * animation-only file (clips, no mesh needed) whose clips play on another
 * model with the same bone names. The editor lists the animated bones the
 * chosen rig does not have (they stay still on it); the choice is one
 * `setAssetOptions {clipsFor}` (one undo).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

interface Props {
  assetId: string;
  clipsFor: string | null;
  /** Models that can be rigs (not this one, not clips-only themselves). */
  rigs: { assetId: string; displayName: string }[];
  onChange: (rig: string | null) => void;
  /** The animated bones the rig lacks (null = the files are not loaded). */
  missingBones: (clipAssetId: string, rigAssetId: string) => Promise<string[] | null>;
}

export function ClipsForField(p: Props): JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setNote(null);
    if (p.clipsFor === null) return;
    void p.missingBones(p.assetId, p.clipsFor).then((missing) => {
      if (!live || missing === null) return;
      setNote(missing.length === 0 ? 'every animated bone is in the rig' : `bones missing in the rig (they stay still): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}`);
    });
    return () => {
      live = false;
    };
  }, [p.assetId, p.clipsFor]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tl-field" title="An animation-only file: its clips play on another model with the same bone names">
      <span className="tl-field__label">clips for rig of</span>
      <select className="tl-input" aria-label="clips for rig of" value={p.clipsFor ?? ''} onChange={(e) => p.onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">— its own nodes —</option>
        {p.clipsFor !== null && !p.rigs.some((r) => r.assetId === p.clipsFor) && <option value={p.clipsFor}>{p.clipsFor}</option>}
        {p.rigs.map((r) => (
          <option key={r.assetId} value={r.assetId}>
            {r.displayName}
          </option>
        ))}
      </select>
      {note !== null && (
        <small className="tl-hint" aria-label="clips for rig check">
          {note}
        </small>
      )}
    </div>
  );
}
