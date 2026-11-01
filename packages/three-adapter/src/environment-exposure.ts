/**
 * The exposure the environment renderer draws with: the look's fixed
 * exposure, or — while the camera on screen has auto-exposure — the adapted
 * one, stepped each drawn frame toward what the meter last read
 * (exposure-meter.ts; the maths in runtime auto-exposure.ts).
 *
 * The exposure is the renderer's `toneMappingExposure`, which bloom's
 * bright-pass and the tone mapping both read, so bloom calms as the
 * exposure falls. The meter runs only while a look adapts; the stack keeps
 * the scene in a texture for it while any loaded camera has auto-exposure,
 * so a camera switch rebuilds nothing.
 */
import { adaptExposure, exposureRange, meteredLogLuminance, targetExposure, type ExposureLook } from '@thirdlight/runtime';

import { ExposureMeter, METER_HEIGHT, METER_WIDTH, type MeterSource } from './exposure-meter';

/** The longest frame adaptation steps over (a stall or a hidden tab does not jump the exposure). */
const MAX_STEP_S = 0.25;

/** What the renderer reports of the exposure (`diagnostics().exposure`). */
export interface ExposureDiagnostics {
  /** The exposure drawn last. */
  readonly value: number;
  /** Where it is heading (null: no reading yet, or no camera adapts). */
  readonly target: number | null;
  /** The meter is built (a loaded camera has auto-exposure) and how many readings it returned. */
  readonly metering: boolean;
  readonly readings: number;
}

export class EnvironmentExposure {
  private look: ExposureLook | null = null;
  private loaded = false;
  private meter: ExposureMeter | null = null;
  private current: number | null = null;
  private target: number | null = null;
  private lastAt: number | null = null;
  private lastReading = 0;

  /** The camera's look on screen (null: none adapts) and whether any loaded camera has auto-exposure. */
  set(look: ExposureLook | null, loaded: boolean): void {
    this.look = look;
    this.loaded = loaded || look !== null;
    if (!this.loaded && this.meter !== null) {
      this.meter.dispose();
      this.meter = null;
      this.lastReading = 0;
    }
  }

  /** The stack keeps the scene's colour in a texture for the meter. */
  wanted(): boolean {
    return this.loaded;
  }

  /** The exposure to draw this frame with (`fixed`: the look's), after `now` (ms) — set on the renderer. */
  apply(renderer: { toneMappingExposure: number }, fixed: number, now: number): void {
    const dt = this.lastAt === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const look = this.look;
    if (look === null) {
      this.current = null;
      this.target = null;
      renderer.toneMappingExposure = fixed;
      return;
    }
    const [lo, hi] = exposureRange(look, fixed);
    const m = this.meter;
    if (m !== null && m.latest !== null && m.readings !== this.lastReading) {
      this.lastReading = m.readings;
      const l = meteredLogLuminance(m.latest, METER_WIDTH, METER_HEIGHT, look.center, 4);
      if (l !== null) this.target = targetExposure(l, look.compensation);
    }
    const from = this.current ?? fixed;
    this.current = adaptExposure(from, this.target ?? from, lo, hi, look.brighten, look.darken, dt);
    renderer.toneMappingExposure = this.current;
  }

  /** After a frame drawn through the stack: meter its scene colour while a look adapts. */
  afterFrame(renderer: unknown, source: () => MeterSource | null): void {
    if (this.look === null || !(this.look.auto > 0)) return;
    const s = source();
    if (s === null) return;
    this.meter ??= new ExposureMeter();
    this.meter.measure(renderer, s);
  }

  diagnostics(drawn: number): ExposureDiagnostics {
    return { value: this.current ?? drawn, target: this.look === null ? null : this.target, metering: this.loaded, readings: this.meter?.readings ?? 0 };
  }

  dispose(): void {
    this.meter?.dispose();
    this.meter = null;
    this.lastReading = 0;
  }
}
