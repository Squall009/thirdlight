/**
 * The menu bar (File / Edit / GameObject / Component / Window / Help): every
 * editor action the backend offers, reachable by mouse. Menus are data; the
 * app owns the actions. Keyboard: Escape closes, arrows move, Enter selects.
 */
import { useEffect, useRef, useState, type JSX } from 'react';

import { Logo } from './Logo';

export interface MenuItem {
  label: string;
  /** Shown right-aligned (informational; the app binds the keys). */
  shortcut?: string;
  disabled?: boolean;
  /** Why it is disabled (tooltip). */
  reason?: string;
  onSelect?: () => void;
  /** A submenu. */
  items?: MenuEntry[];
}
export type MenuEntry = MenuItem | 'separator';
export interface Menu {
  label: string;
  items: MenuEntry[];
}

/** Fullscreen state of the page (the Fullscreen API; false where unsupported). */
function useFullscreen(): { full: boolean; supported: boolean; toggle: () => void } {
  const supported = typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function';
  const [full, setFull] = useState(() => typeof document !== 'undefined' && document.fullscreenElement !== null);
  useEffect(() => {
    const on = (): void => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggle = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };
  return { full, supported, toggle };
}

export function MenuBar(p: { menus: Menu[] }): JSX.Element {
  const fs = useFullscreen();
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(null);
    };
    // Capture phase: while a menu is open, its keys are the menu's (Escape
    // must not also clear the editor selection).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(null);
        setSub(null);
      }
      if (e.key === 'ArrowLeft') setOpen((o) => (o === null ? null : (o + p.menus.length - 1) % p.menus.length));
      if (e.key === 'ArrowRight') setOpen((o) => (o === null ? null : (o + 1) % p.menus.length));
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, p.menus.length]);

  const close = (): void => {
    setOpen(null);
    setSub(null);
  };

  const renderItems = (items: MenuEntry[], path: string): JSX.Element => (
    <div className="tl-menu" role="menu">
      {items.map((it, i) => {
        if (it === 'separator') return <div key={`${path}-sep-${i}`} className="tl-menu__sep" role="separator" />;
        const key = `${path}/${it.label}`;
        if (it.items) {
          return (
            <div key={key} className="tl-menu__item tl-menu__item--sub" role="menuitem" aria-label={it.label} aria-haspopup="menu" aria-expanded={sub === key} onMouseEnter={() => setSub(key)} onClick={(e) => { e.stopPropagation(); setSub(key); }}>
              <span>{it.label}</span>
              <span className="tl-menu__arrow">▸</span>
              {sub === key && renderItems(it.items, key)}
            </div>
          );
        }
        return (
          <button
            key={key}
            className="tl-menu__item"
            role="menuitem"
            aria-label={it.label}
            disabled={it.disabled === true}
            title={it.disabled ? it.reason : undefined}
            onMouseEnter={() => setSub((s) => (s !== null && s.startsWith(`${path}/`) && !key.startsWith(s) ? null : s))}
            onClick={() => {
              close();
              it.onSelect?.();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut ? <span className="tl-menu__shortcut">{it.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="tl-menubar" role="menubar" ref={root}>
      <span className="tl-menubar__brand"><Logo size={20} /></span>
      {p.menus.map((m, i) => (
        <div key={m.label} className={`tl-menubar__menu${open === i ? ' is-open' : ''}`}>
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className="tl-menubar__title"
            onClick={() => (open === i ? close() : (setOpen(i), setSub(null)))}
            onMouseEnter={() => {
              if (open !== null && open !== i) {
                setOpen(i);
                setSub(null);
              }
            }}
          >
            {m.label}
          </button>
          {open === i && renderItems(m.items, m.label)}
        </div>
      ))}
      <span className="tl-menubar__spacer" />
      {fs.supported && (
        <button
          className="tl-menubar__icon"
          onClick={fs.toggle}
          title={fs.full ? 'Exit full screen (Esc)' : 'Full screen'}
          aria-label={fs.full ? 'Exit full screen' : 'Full screen'}
          aria-pressed={fs.full}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {fs.full ? (
              <path d="M6 1.5V6H1.5M10 1.5V6h4.5M6 14.5V10H1.5M10 14.5V10h4.5" />
            ) : (
              <path d="M1.5 6V1.5H6M14.5 6V1.5H10M1.5 10v4.5H6M14.5 10v4.5H10" />
            )}
          </svg>
        </button>
      )}
    </div>
  );
}
