/**
 * Phase 23.10: the engine's pause panel for a game without the platformer
 * flow (a game with game modes that plays as a scene). Shown while the game
 * is paused in a mode whose `pauseScreen` is not set; a project replaces it
 * with its own UI document (the mode's `pauseScreen`, drawn by the UI layer
 * with the engine actions resume / restart).
 *
 * Plain DOM, text only, two buttons (Resume, Restart), keyboard/gamepad
 * navigable through the host's ui edges and clickable; styled through the
 * CSSOM (the Play page's content security policy refuses style attributes
 * and inline style elements). Genre-neutral: no title, lives or score.
 */
import type { HostDom, HostDomNode } from './hud';

export interface PausePanel {
  show(): void;
  hide(): void;
  readonly shown: boolean;
  /** The frame's ui edges while shown: up/down move, submit presses, cancel resumes. */
  handleEdges(edges: { up: boolean; down: boolean; submit: boolean; cancel: boolean }): void;
  /** The focused button (observations). */
  readonly focus: 'resume' | 'restart';
  dispose(): void;
}

type Styled = HostDomNode & { style?: { cssText?: string } };

function css(node: HostDomNode, text: string): void {
  const s = node as Styled;
  if (s.style !== undefined) s.style.cssText = text;
  else node.setAttribute?.('style', text);
}

export function createPausePanel(dom: HostDom, container: HostDomNode, actions: { resume(): void; restart(): void }): PausePanel {
  const root = dom.createElement('div');
  root.setAttribute?.('data-tl-pause-panel', '');
  root.setAttribute?.('role', 'dialog');
  root.setAttribute?.('aria-label', 'Paused');
  const box = dom.createElement('div');
  const title = dom.createElement('div');
  title.textContent = 'Paused';
  const items: { id: 'resume' | 'restart'; el: HostDomNode }[] = (['resume', 'restart'] as const).map((id) => {
    const el = dom.createElement('button');
    el.textContent = id === 'resume' ? 'Resume' : 'Restart';
    el.setAttribute?.('data-tl-pause-item', id);
    el.setAttribute?.('type', 'button');
    return { id, el };
  });
  box.appendChild(title);
  for (const it of items) box.appendChild(it.el);
  root.appendChild(box);
  let shown = false;
  let index = 0;
  const run = (id: 'resume' | 'restart'): void => (id === 'resume' ? actions.resume() : actions.restart());
  const handlers = items.map((it) => {
    const h = (): void => run(it.id);
    it.el.addEventListener?.('click', h);
    return h;
  });
  const paint = (): void => {
    css(root, `position:fixed;inset:0;display:${shown ? 'flex' : 'none'};align-items:center;justify-content:center;background:#0008;z-index:6;font-family:system-ui,sans-serif`);
    css(box, 'min-width:220px;padding:20px 24px;border-radius:12px;background:#1b2330;color:#f4f1e8;display:flex;flex-direction:column;gap:8px;text-align:center;box-shadow:0 10px 40px #0008');
    css(title, 'font-size:22px;margin-bottom:6px');
    items.forEach((it, i) => {
      css(it.el, `font:inherit;font-size:16px;padding:8px 14px;border-radius:8px;cursor:pointer;color:inherit;background:${i === index ? '#ffffff26' : '#ffffff10'};border:2px solid ${i === index ? '#f4f1e8' : 'transparent'}`);
      it.el.setAttribute?.('aria-selected', i === index ? 'true' : 'false');
    });
  };
  paint();
  container.appendChild(root);
  return {
    show(): void {
      shown = true;
      index = 0;
      paint();
    },
    hide(): void {
      shown = false;
      paint();
    },
    get shown(): boolean {
      return shown;
    },
    get focus(): 'resume' | 'restart' {
      return items[index]!.id;
    },
    handleEdges(e): void {
      if (!shown) return;
      if (e.up || e.down) {
        index = (index + (e.down ? 1 : items.length - 1)) % items.length;
        paint();
      }
      if (e.submit) run(items[index]!.id);
      else if (e.cancel) actions.resume();
    },
    dispose(): void {
      items.forEach((it, i) => it.el.removeEventListener?.('click', handlers[i]!));
      root.remove();
    },
  };
}
