/**
 * The one brush cursor every Scene-view brush draws: laid on the surface
 * under the pointer (a terrain's ground, a block layer's tops), it shows
 *
 * - an outer ring at the brush's size, with a dark line just outside it so
 *   it reads on bright ground;
 * - a dashed inner ring where the falloff has dropped to half strength;
 * - a fill whose opacity is the dab's weight there — strength × falloff,
 *   × the noise mask when the brush paints through one, so the fill shows
 *   where the mask lets paint through;
 * - a dot at the centre.
 *
 * It lies on the ground (following the height under each point) or, given
 * a normal, flat on the plane of a wall or a prop's face.
 *
 * While a stroke is in flight only the rings show, so the fill never hides
 * the stroke's own preview under it.
 *
 * Amber (`--brush`) to add or paint, red (`--brush-erase`) while inverting
 * or erasing, grey (`--text-dim`) when the tool cannot act. The colours come
 * from the editor's stylesheet tokens, so they are defined once.
 *
 * Beside it, the readout (`BrushHud`): a small label by the cursor while the
 * size or strength is dragged in the view or changed by keys.
 *
 * Drawn only: never picked, never depth-tested (it lies on the surface).
 *
 * Browser-only (three.js, DOM).
 */
import * as THREE from 'three';
import { brushFalloff, brushHalfRadius, brushMask, type BrushFalloff, type BrushMask } from '@thirdlight/runtime';

/** What the cursor shows. */
export interface BrushCursorLook {
  falloff: BrushFalloff;
  hardness: number;
  /** The dab's strength (0–1): the fill's opacity at full weight. */
  strength: number;
  /** The mask the fill multiplies by (null: none). */
  mask: BrushMask | null;
  /** paint: amber; erase: red; off: grey (the tool cannot act). */
  state: 'paint' | 'erase' | 'off';
}

/** Where the cursor lies: its centre (world), its radius across x and z (world metres), the surface's height under a point. */
export interface BrushCursorPlace {
  centre: THREE.Vector3;
  rx: number;
  rz: number;
  /** The surface height (world y) at world (x, z) (null or absent: the centre's height). */
  heightAt?: (x: number, z: number) => number | null;
  /** The world (x, z) of the frame the mask is anchored to (the target's origin). */
  maskOrigin?: readonly [number, number];
  /** Draw the fill (absent: yes). A stroke in flight leaves it out: the rings frame the paint being laid, the fill would hide it. */
  fill?: boolean;
  /**
   * Lay it flat on a plane facing this way (a wall, a prop's face) instead of
   * on the ground: `rx` is its radius, `heightAt` is not read, and the mask is
   * read in the world at each point (x, z and the height), as vertex paint's.
   */
  normal?: THREE.Vector3;
}

const RING_SEGMENTS = 96;
const DASHES = 24;
const FILL_RINGS = 24;
const FILL_SEGMENTS = 72;
/** The fill's opacity at full weight and strength (the ground stays readable under it). */
const FILL_ALPHA = 0.3;
/** Lifted off the surface so the lines do not flicker into it. */
const LIFT = 0.04;

/** A stylesheet colour token (`--brush`), or white where there is no stylesheet: the Scene-view overlays take the editor's colours from one place. */
export function tokenColour(name: string): THREE.Color {
  const v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = new THREE.Color(1, 1, 1);
  if (v !== '') c.setStyle(v, THREE.SRGBColorSpace);
  return c;
}

export class BrushCursor {
  private readonly root = new THREE.Group();
  private readonly outer: THREE.Line;
  private readonly halo: THREE.Line;
  private readonly inner: THREE.LineSegments;
  private readonly dot: THREE.Line;
  private readonly fill: THREE.Mesh;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly haloMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  private readonly fillMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private readonly colours: Record<BrushCursorLook['state'], THREE.Color>;
  private look: BrushCursorLook = { falloff: 'smooth', hardness: 0.5, strength: 0.5, mask: null, state: 'paint' };

  constructor(parent: THREE.Object3D, name = 'brush-cursor') {
    this.root.name = name;
    this.root.visible = false;
    this.colours = { paint: tokenColour('--brush'), erase: tokenColour('--brush-erase'), off: tokenColour('--text-dim') };
    this.lineMat = new THREE.LineBasicMaterial({ color: this.colours.paint, transparent: true, depthTest: false, depthWrite: false });
    const strip = (n: number): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      return g;
    };
    // Closed by repeating the first point (three's renderers draw no line loops).
    this.outer = new THREE.Line(strip(RING_SEGMENTS + 1), this.lineMat);
    this.halo = new THREE.Line(strip(RING_SEGMENTS + 1), this.haloMat);
    this.inner = new THREE.LineSegments(strip(DASHES * 2), this.lineMat);
    this.dot = new THREE.Line(strip(13), this.lineMat);
    const fillGeo = strip(1 + FILL_RINGS * FILL_SEGMENTS);
    fillGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array((1 + FILL_RINGS * FILL_SEGMENTS) * 4), 4));
    const index: number[] = [];
    for (let s = 0; s < FILL_SEGMENTS; s++) index.push(0, 1 + s, 1 + ((s + 1) % FILL_SEGMENTS));
    for (let r = 1; r < FILL_RINGS; r++) {
      for (let s = 0; s < FILL_SEGMENTS; s++) {
        const a = 1 + (r - 1) * FILL_SEGMENTS + s;
        const b = 1 + (r - 1) * FILL_SEGMENTS + ((s + 1) % FILL_SEGMENTS);
        const c = a + FILL_SEGMENTS;
        const d = b + FILL_SEGMENTS;
        index.push(a, c, b, b, c, d);
      }
    }
    fillGeo.setIndex(index);
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.renderOrder = 19;
    this.halo.renderOrder = 20;
    for (const l of [this.outer, this.inner, this.dot]) l.renderOrder = 21;
    for (const o of [this.fill, this.halo, this.outer, this.inner, this.dot]) {
      o.frustumCulled = false;
      o.raycast = () => undefined;
    }
    this.root.add(this.fill, this.halo, this.outer, this.inner, this.dot);
    parent.add(this.root);
  }

  /** What it shows (colour, falloff ring, fill). */
  setLook(look: BrushCursorLook): void {
    this.look = look;
    this.lineMat.color.copy(this.colours[look.state]);
  }

  /** The cursor's colour now (tests read it). */
  state(): BrushCursorLook['state'] {
    return this.look.state;
  }

  hide(): void {
    this.root.visible = false;
  }

  visible(): boolean {
    return this.root.visible;
  }

  /** Lay the cursor on the surface at `p`. */
  place(p: BrushCursorPlace): void {
    const at = this.placer(p);
    const ring = (attr: THREE.BufferAttribute, k: number, n: number, closed: boolean): void => {
      for (let i = 0; i < n; i++) {
        const a = ((closed ? i % (n - 1) : i) / (closed ? n - 1 : n)) * Math.PI * 2;
        at(Math.cos(a) * k, Math.sin(a) * k, this.tmp);
        attr.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      }
      attr.needsUpdate = true;
    };
    ring(this.outer.geometry.getAttribute('position') as THREE.BufferAttribute, 1, RING_SEGMENTS + 1, true);
    // The halo just outside the ring (a pixel or so at working distances).
    ring(this.halo.geometry.getAttribute('position') as THREE.BufferAttribute, 1.015, RING_SEGMENTS + 1, true);
    ring(this.dot.geometry.getAttribute('position') as THREE.BufferAttribute, Math.min(0.035, 0.25 / Math.max(p.rx, 1e-3)), 13, true);
    // The inner ring, dashed: every other segment of a circle at the half-strength radius.
    const half = brushHalfRadius(this.look.falloff, this.look.hardness);
    const inner = this.inner.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < DASHES; i++) {
      for (let e = 0; e < 2; e++) {
        const a = ((i + e * 0.5) / DASHES) * Math.PI * 2;
        at(Math.cos(a) * half, Math.sin(a) * half, this.tmp);
        inner.setXYZ(i * 2 + e, this.tmp.x, this.tmp.y, this.tmp.z);
      }
    }
    inner.needsUpdate = true;
    this.inner.visible = half < 0.999;
    this.fill.visible = p.fill !== false && this.look.strength > 0;
    if (this.fill.visible) this.drawFill(p, at);
    for (const o of [this.outer, this.halo, this.inner, this.dot, this.fill]) o.geometry.computeBoundingSphere();
    this.root.visible = true;
  }

  private readonly tmp = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();

  /** Where a point (dx, dz) of the unit disc lies in the world (written into `out`): on the ground under it, or on the plane. */
  private placer(p: BrushCursorPlace): (dx: number, dz: number, out: THREE.Vector3) => void {
    const { centre: c, rx, rz } = p;
    const n = p.normal;
    if (n === undefined) {
      return (dx, dz, out) => {
        const x = c.x + dx * rx;
        const z = c.z + dz * rz;
        out.set(x, (p.heightAt?.(x, z) ?? c.y) + LIFT, z);
      };
    }
    // Two directions across the plane (any pair at right angles to the normal).
    this.u.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    this.v.copy(n).cross(this.u).normalize();
    const u = this.u;
    const v = this.v;
    return (dx, dz, out) => out.copy(c).addScaledVector(u, dx * rx).addScaledVector(v, dz * rx).addScaledVector(n, LIFT);
  }

  /** The fill: each vertex's opacity is the dab's weight there (falloff × strength × mask). */
  private drawFill(p: BrushCursorPlace, at: (dx: number, dz: number, out: THREE.Vector3) => void): void {
    const pos = this.fill.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.fill.geometry.getAttribute('color') as THREE.BufferAttribute;
    const { r, g, b } = this.colours[this.look.state];
    const look = this.look;
    const [mx, mz] = p.maskOrigin ?? [0, 0];
    const onPlane = p.normal !== undefined;
    const q = this.tmp;
    const put = (i: number, dx: number, dz: number, d: number): void => {
      at(dx, dz, q);
      pos.setXYZ(i, q.x, q.y, q.z);
      let w = brushFalloff(d * d, 1, look.falloff, look.hardness) * look.strength;
      if (look.mask !== null && w > 0) w *= onPlane ? brushMask(look.mask, q.x - mx, q.z - mz, q.y) : brushMask(look.mask, q.x - mx, q.z - mz);
      col.setXYZW(i, r, g, b, w * FILL_ALPHA);
    };
    put(0, 0, 0, 0);
    for (let ring = 1; ring <= FILL_RINGS; ring++) {
      const d = ring / FILL_RINGS;
      for (let s = 0; s < FILL_SEGMENTS; s++) {
        const a = (s / FILL_SEGMENTS) * Math.PI * 2;
        put(1 + (ring - 1) * FILL_SEGMENTS + s, Math.cos(a) * d, Math.sin(a) * d, d);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const o of [this.outer, this.halo, this.inner, this.dot, this.fill]) o.geometry.dispose();
    this.lineMat.dispose();
    this.haloMat.dispose();
    this.fillMat.dispose();
  }
}

/**
 * The brush's readout by the cursor: a bold value in the brush colour and a
 * faint detail ("Size 18.0 m  F · drag to resize · click to set"). A DOM
 * label over the Scene view's canvas, wherever the canvas is lent.
 */
export class BrushHud {
  private el: HTMLDivElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `ghost`: the readout of a shape being drawn (the block editor's), in the state colour rather than the brush's; `pick`: what a click would select, the same look. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly kind: 'brush' | 'ghost' | 'pick' = 'brush',
  ) {}

  /** Show `value` and `detail` by the screen point (client px); `ms`: hide after that long (absent: until hidden). */
  show(at: { x: number; y: number }, value: string, detail: string, ms?: number): void {
    const host = this.canvas.parentElement;
    if (host === null) return;
    if (this.el === null || this.el.parentElement !== host) {
      this.el?.remove();
      this.el = document.createElement('div');
      this.el.className = this.kind === 'brush' ? 'tl-brush-hud' : 'tl-brush-hud tl-brush-hud--ghost';
      this.el.setAttribute('role', 'status');
      this.el.setAttribute('aria-label', this.kind === 'ghost' ? 'shape readout' : this.kind === 'pick' ? 'pick readout' : 'brush readout');
      host.appendChild(this.el);
    }
    const el = this.el;
    el.replaceChildren();
    const b = document.createElement('b');
    b.textContent = value;
    const small = document.createElement('small');
    small.textContent = detail;
    el.append(b, small);
    const box = host.getBoundingClientRect();
    el.style.left = `${Math.round(at.x - box.left + 24)}px`;
    el.style.top = `${Math.round(at.y - box.top - 34)}px`;
    el.hidden = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = ms === undefined ? null : setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.el !== null) this.el.hidden = true;
  }

  dispose(): void {
    this.hide();
    this.el?.remove();
    this.el = null;
  }
}
