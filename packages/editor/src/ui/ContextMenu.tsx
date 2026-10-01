/**
 * A context menu (right-click) at the pointer: the same menu entries as the
 * menu bar's (label, shortcut, disabled with the reason, submenus). Escape,
 * a click elsewhere or choosing an item closes it.
 *
 * Browser-only (React).
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { MenuEntry } from './MenuBar';

export function ContextMenu(p: { at: { x: number; y: number }; items: MenuEntry[]; label: string; onClose: () => void }): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(p.at);
  const { onClose } = p;
  // Kept inside the page (a click near the right or bottom edge opens it to the left or above).
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(0, Math.min(p.at.x, window.innerWidth - r.width - 2)), y: Math.max(0, Math.min(p.at.y, window.innerHeight - r.height - 2)) });
  }, [p.at]);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) onClose();
    };
    // Capture phase: while the menu is open its Escape is the menu's (it must not also clear the selection).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  // The submenu path open (`/Create/Graph`): a submenu shows while its path is this one or leads to it.
  const [sub, setSub] = useState<string>('');
  const shown = (key: string): boolean => sub === key || sub.startsWith(`${key}/`);
  const renderItems = (items: MenuEntry[], path: string): JSX.Element[] =>
    items.map((it, i) => {
      if (it === 'separator') return <div key={`${path}-sep-${i}`} className="tl-menu__sep" role="separator" />;
      const key = `${path}/${it.label}`;
      if (it.items !== undefined && it.disabled !== true) {
        return (
          <div
            key={key}
            className="tl-menu__item tl-menu__item--sub"
            role="menuitem"
            tabIndex={-1}
            aria-label={it.label}
            aria-haspopup="menu"
            aria-expanded={shown(key)}
            onMouseEnter={() => setSub(key)}
            onClick={(e) => {
              e.stopPropagation();
              setSub(key);
            }}
          >
            <span>{it.label}</span>
            <span className="tl-menu__arrow">▸</span>
            {shown(key) && (
              <div className="tl-menu" role="menu" aria-label={it.label}>
                {renderItems(it.items, key)}
              </div>
            )}
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
          // Leaving a submenu for an item beside it closes that submenu.
          onMouseEnter={() => setSub(path)}
          onClick={() => {
            onClose();
            it.onSelect?.();
          }}
        >
          <span>{it.label}</span>
          {it.shortcut ? <span className="tl-menu__shortcut">{it.shortcut}</span> : null}
        </button>
      );
    });
  return (
    <div ref={root} className={`tl-menu tl-context-menu${pos.y > window.innerHeight / 2 ? ' tl-context-menu--up' : ''}`} role="menu" aria-label={p.label} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {renderItems(p.items, '')}
    </div>
  );
}
