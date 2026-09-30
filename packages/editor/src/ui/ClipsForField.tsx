/**
 * "clips for rig of <asset>" on a model asset — an
 * animation-only file (clips, no mesh needed) whose clips play on another
 * model with the same bone names. The editor lists the animated bones the
 * chosen rig does not have (they stay still on it); the choice is one
 * `setAssetOptions {clipsFor}` (one undo).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

import { MODEL_KINDS, RefPicker } from './catalog/RefPicker';

interface Props {
  assetId: string;
  clipsFor: string | null;
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
  }, [p.assetId, p.clipsFor]); // eslint-disable-line react-hooks/exhaustive-deps -- reloads when the asset or its clip source changes; the loader prop is a new closure each render
  return (
    <div className="tl-field" title="An animation-only file: its clips play on another model with the same bone names">
      <span className="tl-field__label">clips for rig of</span>
      <RefPicker aria="clips for rig of" kinds={MODEL_KINDS} value={p.clipsFor ?? ''} none="— its own nodes —" onPick={(id) => id !== p.assetId && p.onChange(id === '' ? null : id)} />
      {note !== null && (
        <small className="tl-hint" aria-label="clips for rig check">
          {note}
        </small>
      )}
    </div>
  );
}
