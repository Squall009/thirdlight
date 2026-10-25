/**
 * How far the physical sky's clouds have travelled: along the scene's global
 * wind, at its speed (the gust pattern's metres per second), from the sky's
 * `cloudTime` (seconds of travel already behind them when the clock starts).
 *
 * Under a steady wind the travel is a function of the clock alone,
 * `velocity × (cloudTime + seconds)`, so a run (or a replay) starts on the
 * same sky and shows the same sky at the same second. When the wind or the
 * start changes, the travel so far is kept and the new velocity carries on
 * from there: the clouds never jump across the sky. Wind zones are local
 * ground wind; clouds read only the global wind.
 */

/** The global wind as the clouds read it (`windValues` of the scene's wind: a unit direction, metres per second). */
export interface CloudWind {
  readonly dirX: number;
  readonly dirZ: number;
  readonly speed: number;
}

export class CloudDrift {
  private started = false;
  /** The clock and the travel at the last change; the velocity since. */
  private anchorS = 0;
  private anchorX = 0;
  private anchorZ = 0;
  private vx = 0;
  private vz = 0;
  private startS = 0;

  /**
   * The travel (x, z metres) at clock `seconds` under `wind`, with `cloudTime`
   * the sky's start. Written into `out` (allocation-free per frame).
   */
  at(seconds: number, wind: CloudWind, cloudTime: number, out: [number, number] = [0, 0]): [number, number] {
    const speed = Number.isFinite(wind.speed) ? Math.max(0, wind.speed) : 0;
    const vx = wind.dirX * speed;
    const vz = wind.dirZ * speed;
    const start = Number.isFinite(cloudTime) ? cloudTime : 0;
    if (!this.started) {
      this.started = true;
      this.anchorS = seconds;
      this.anchorX = vx * (start + seconds);
      this.anchorZ = vz * (start + seconds);
      this.vx = vx;
      this.vz = vz;
      this.startS = start;
    } else if (vx !== this.vx || vz !== this.vz || start !== this.startS) {
      // Keep the travel so far; a moved start moves the clouds as if the clock had.
      const dt = start - this.startS;
      this.anchorX += this.vx * (seconds - this.anchorS) + vx * dt;
      this.anchorZ += this.vz * (seconds - this.anchorS) + vz * dt;
      this.anchorS = seconds;
      this.vx = vx;
      this.vz = vz;
      this.startS = start;
    }
    out[0] = this.anchorX + this.vx * (seconds - this.anchorS);
    out[1] = this.anchorZ + this.vz * (seconds - this.anchorS);
    return out;
  }
}
