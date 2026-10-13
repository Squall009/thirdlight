/**
 * The brush keys and in-view drags every Scene-view brush shares, on the
 * tool's settings store (`session/brush.ts`), so a key means the same in
 * the terrain editor, vertex paint and the instance brush:
 *
 * - `[` / `]` size, Shift with them strength, X switches paint and erase
 *   (the readout by the cursor says what changed);
 * - F then a drag resizes in the view (the size follows the surface's
 *   distance from where it began), Shift+F the strength (the pointer's
 *   travel); a click sets it, Esc puts it back;
 * - Ctrl held inverts the next stroke (the tool asks `inverted()` and turns
 *   its cursor red while it is held).
 *
 * The tool keeps its own pointer handling and asks this first: a press,
 * move, Esc or leave that belongs to an F drag is taken here.
 *
 * Browser-only (DOM, three.js vectors).
 */
import type * as THREE from 'three';

import { brushSummary, dragStrength, roundSize, stepSize, stepStrength, type BrushSettings, type BrushStore, type BrushUse } from '../session/brush';
import { brushKeyAction } from '../session/edit-keys';
import { BrushHud } from './brush-cursor';

/** How long the readout stays after a key changed the brush. */
export const HUD_KEY_MS = 1200;

export interface BrushControlHost {
  readonly canvas: HTMLCanvasElement;
  /** The surface under a client point (F measures the size on it), or null. */
  surfaceAt(clientX: number, clientY: number): THREE.Vector3 | null;
  /** The size F drags: twice this distance between two surface points (absent: straight-line). */
  distance?(a: THREE.Vector3, b: THREE.Vector3): number;
  /** Ctrl went down or up (the cursor's colour follows). */
  ctrlChanged(): void;
}

export class BrushControl {
  private store: BrushStore | null = null;
  private uses: readonly BrushUse[] = [];
  private ctrl = false;
  private armed = false;
  /** F / Shift+F: what is dragged, its value before (Esc puts it back), the surface point and pointer it began at. */
  private adjust: { what: 'size' | 'strength'; before: BrushSettings; anchor: THREE.Vector3 | null; from: { x: number; y: number } } | null = null;
  /** The last pointer position over the view (client px) and the surface under it. */
  private pointer: { x: number; y: number } | null = null;
  private at: THREE.Vector3 | null = null;
  private readonly hud: BrushHud;
  private readonly onCtrl = (e: KeyboardEvent): void => {
    if (e.key !== 'Control' && e.key !== 'Meta') return;
    this.setCtrl(e.type === 'keydown');
  };
  private readonly onBlur = (): void => this.setCtrl(false);

  constructor(private readonly host: BrushControlHost) {
    this.hud = new BrushHud(host.canvas);
  }

  /** The settings the keys change and the settings the tool uses (null: none). */
  setStore(store: BrushStore | null, uses: readonly BrushUse[]): void {
    this.store = store;
    this.uses = uses;
  }

  /** Listen for Ctrl while the tool is armed (and stop, with the readout hidden, when it is not). */
  arm(on: boolean): void {
    if (on === this.armed) return;
    this.armed = on;
    if (on) {
      window.addEventListener('keydown', this.onCtrl);
      window.addEventListener('keyup', this.onCtrl);
      window.addEventListener('blur', this.onBlur);
      return;
    }
    window.removeEventListener('keydown', this.onCtrl);
    window.removeEventListener('keyup', this.onCtrl);
    window.removeEventListener('blur', this.onBlur);
    this.ctrl = false;
    this.adjust = null;
    this.hud.hide();
  }

  /** Whether a stroke begun now inverts (the brush's invert, flipped while Ctrl is held). */
  inverted(): boolean {
    const b = this.store?.get();
    return b !== undefined && this.uses.includes('invert') && b.invert !== this.ctrl;
  }

  /** An F / Shift+F drag is in flight. */
  adjusting(): boolean {
    return this.adjust !== null;
  }

  /** A move over the view (`at`: the surface under it): true when an F drag took it. Ctrl is read off the event too. */
  move(e: PointerEvent, at: THREE.Vector3 | null): boolean {
    this.pointer = { x: e.clientX, y: e.clientY };
    this.setCtrl(e.ctrlKey || e.metaKey);
    if (this.adjust === null) {
      this.at = at;
      return false;
    }
    this.drag(e.clientX, e.clientY);
    return true;
  }

  /** A press: true when it ends an F drag (a click sets what was dragged). */
  press(): boolean {
    if (this.adjust === null) return false;
    this.adjust = null;
    this.hud.hide();
    return true;
  }

  /** Esc: an F drag's value put back (true when there was one). */
  cancel(): boolean {
    const a = this.adjust;
    if (a === null) return false;
    this.adjust = null;
    this.hud.hide();
    this.store?.set({ size: a.before.size, strength: a.before.strength });
    return true;
  }

  /** The pointer left the view: false while an F drag goes on (the tool keeps its cursor), else the readout goes. */
  leave(): boolean {
    if (this.adjust !== null) return false;
    this.pointer = null;
    this.at = null;
    this.hud.hide();
    return true;
  }

  /** A brush key (the edit mode's key map routes it here); true when taken. */
  key(e: KeyboardEvent): boolean {
    const store = this.store;
    if (store === null) return false;
    const a = brushKeyAction(e, this.uses);
    if (a === null) return false;
    const b = store.get();
    if (a.kind === 'size') store.set({ size: stepSize(b.size, a.dir, store.bounds) });
    else if (a.kind === 'strength') store.set({ strength: stepStrength(b.strength, a.dir) });
    else if (a.kind === 'invert') store.set({ invert: !b.invert });
    else {
      if (this.pointer === null) return true;
      this.adjust = { what: a.kind === 'resize' ? 'size' : 'strength', before: b, anchor: this.at?.clone() ?? null, from: { ...this.pointer } };
      this.showAdjust();
      return true;
    }
    if (this.pointer !== null) this.hud.show(this.pointer, this.value(a.kind === 'strength' ? 'strength' : 'size'), a.kind === 'invert' ? (store.get().invert ? 'inverted (X)' : 'not inverted (X)') : brushSummary(store.get(), this.uses), HUD_KEY_MS);
    return true;
  }

  dispose(): void {
    this.arm(false);
    this.hud.dispose();
  }

  private setCtrl(held: boolean): void {
    if (held === this.ctrl) return;
    this.ctrl = held;
    this.host.ctrlChanged();
  }

  /** F / Shift+F while dragging: the size follows the surface distance from where it began; the strength, the pointer's travel. */
  private drag(x: number, y: number): void {
    const a = this.adjust!;
    const store = this.store;
    if (store === null) return;
    if (a.what === 'size') {
      const at = a.anchor === null ? null : this.host.surfaceAt(x, y);
      if (at !== null && a.anchor !== null) {
        const d = this.host.distance?.(at, a.anchor) ?? at.distanceTo(a.anchor);
        store.set({ size: Math.max(store.bounds.size[0], Math.min(store.bounds.size[1], roundSize(2 * d))) });
      }
    } else store.set({ strength: dragStrength(a.before.strength, x - a.from.x, y - a.from.y) });
    this.showAdjust();
  }

  private value(what: 'size' | 'strength'): string {
    const b = this.store?.get();
    if (b === undefined) return '';
    return what === 'size' ? `Size ${roundSize(b.size).toFixed(b.size < 1 ? 2 : b.size < 10 ? 1 : 0)} m` : `Strength ${Math.round(b.strength * 100)} %`;
  }

  private showAdjust(): void {
    const a = this.adjust;
    if (a === null || this.pointer === null) return;
    this.hud.show(this.pointer, this.value(a.what), a.what === 'size' ? 'F · drag to resize · click to set · Esc puts it back' : 'Shift+F · drag to set the strength · click to set · Esc puts it back');
  }
}
