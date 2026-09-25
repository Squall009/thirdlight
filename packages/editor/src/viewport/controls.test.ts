/**
 * Phase 21.5: OrbitControls disposed after its canvas left the page must not
 * leave its Control-key listeners on the document (they would keep the
 * controls, the canvas and the closed pane's whole tree alive).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { describe, expect, it } from 'vitest';

import { disposeOrbitControls } from './controls';

type L = { type: string; fn: unknown };
function target(): { listeners: L[]; addEventListener(t: string, fn: unknown): void; removeEventListener(t: string, fn: unknown): void } {
  const listeners: L[] = [];
  return {
    listeners,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

describe('disposeOrbitControls', () => {
  it('removes the document key listeners even when the canvas is already detached', () => {
    const doc = target();
    const canvas = { ...target(), style: {} as Record<string, string>, ownerDocument: doc, attached: true, getRootNode(): unknown {
      return canvas.attached ? doc : canvas;
    } };
    const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas as unknown as HTMLElement);
    expect(doc.listeners.filter((l) => l.type === 'keydown')).toHaveLength(1);
    // React removed the canvas before the cleanup ran: its root node is itself now.
    canvas.attached = false;
    disposeOrbitControls(controls);
    expect(doc.listeners.filter((l) => l.type === 'keydown' || l.type === 'keyup')).toHaveLength(0);
  });
});
