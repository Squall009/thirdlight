/**
 * The probe debug view while the Gizmos menu shows it: it follows the
 * adapter's probe light (which comes with a bake and goes with it).
 *
 * Browser-only (three.js, the scene adapter).
 */
import { createProbeDebugView, type ProbeDebugView, type ProbeLighting, type SceneAdapter } from '@thirdlight/three-adapter';
import type * as THREE from 'three';

export class ProbeDebugOverlay {
  private shown: { light: ProbeLighting; view: ProbeDebugView } | null = null;

  constructor(private readonly overlay: THREE.Object3D) {}

  follow(adapter: SceneAdapter, on: boolean, root: HTMLElement): void {
    const light = on ? (adapter.probeLighting?.() ?? null) : null;
    if (this.shown !== null && this.shown.light !== light) {
      this.shown.view.dispose();
      this.shown = null;
    }
    if (light !== null && this.shown === null) {
      this.shown = { light, view: createProbeDebugView(light) };
      this.overlay.add(this.shown.view.object);
    }
    this.shown?.view.update();
    // Probes drawn, and of those the ones inside geometry (moved or filled; tests read them).
    const counts = `${this.shown?.view.count() ?? 0} ${this.shown?.view.invalid() ?? 0}`;
    if (root.getAttribute('data-probe-spheres') !== counts) root.setAttribute('data-probe-spheres', counts);
  }
}
