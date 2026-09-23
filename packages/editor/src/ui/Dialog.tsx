/** A small modal dialog (Escape or the close button dismisses it). */
import { useEffect, type JSX, type ReactNode } from 'react';

export function Dialog(p: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);
  return (
    <div className="tl-dialog__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="tl-dialog" role="dialog" aria-modal="true" aria-label={p.title}>
        <div className="tl-dialog__head">
          <span>{p.title}</span>
          <button className="tl-btn tl-btn--small" onClick={p.onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="tl-dialog__body">{p.children}</div>
      </div>
    </div>
  );
}
