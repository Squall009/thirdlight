/**
 * Object icons: what an object is, shown on its hierarchy row and as its
 * Scene view billboard (cameras, lights, spawns and other objects without a
 * mesh are screen-sized billboards with a rounded backing disc for
 * legibility and a ring when selected). Which icon an object shows comes
 * from the component descriptors, so a component added to the engine names
 * its own icon and its place in the one priority order.
 */
import * as THREE from 'three';
import type { ComponentIcon, DescriptorRegistry, IconCondition, IconCount, IconVariant } from '@thirdlight/project-model';

export type IconKind = ComponentIcon | 'empty';

/** The artwork per icon (served next to the editor page; see tools/icons/editor-icons.tsv for how each was made). */
export const ICON_FILES: Readonly<Record<IconKind, string>> = {
  camera: './icons/camera.png',
  spawn: './icons/spawn.png',
  sun: './icons/sun.png',
  ambient: './icons/ambient.png',
  point: './icons/light-point.png',
  spot: './icons/light-spot.png',
  area: './icons/light-area.png',
  hemisphere: './icons/light-hemisphere.png',
  terrain: './icons/objects/terrain.webp',
  blocks: './icons/objects/blocks.webp',
  building: './icons/objects/building.webp',
  river: './icons/objects/river.webp',
  road: './icons/objects/road.webp',
  spline: './icons/objects/spline.webp',
  decal: './icons/objects/decal.webp',
  instances: './icons/objects/instances.webp',
  probes: './icons/objects/probes.webp',
  fog: './icons/fog.png',
  effect: './icons/kinds/effect.webp',
  audio: './icons/audio-source.png',
  patrol: './icons/objects/patrol.webp',
  mover: './icons/mover.png',
  switch: './icons/switch.png',
  collectible: './icons/collectible.png',
  sensor: './icons/sensor.png',
  hitbox: './icons/objects/hitbox.webp',
  health: './icons/objects/health.webp',
  prefab: './icons/prefab.png',
  model: './icons/model.png',
  box: './icons/box.png',
  empty: './icons/empty.png',
};

/** One component that gives an object its icon: its own icon and type name, the variants by value, the tooltip's count. */
export interface IconRow {
  readonly component: string;
  readonly icon: IconKind;
  readonly label: string;
  readonly variants: readonly IconVariant[];
  readonly count?: IconCount;
}

/** The components that name an icon, in the registry's icon order (most specific first). */
export type IconTable = readonly IconRow[];

/** The icon table of a descriptor registry: components with an icon, in the registry's icon order. */
export function iconTableOf(reg: DescriptorRegistry | null): IconTable {
  if (reg === null) return [];
  const order = reg.icons ?? [];
  const rank = (icon: string): number => {
    const i = order.indexOf(icon as (typeof order)[number]);
    return i < 0 ? order.length : i;
  };
  return reg.components
    .filter((c) => c.icon !== undefined && ICON_FILES[c.icon] !== undefined)
    .map((c) => ({
      component: c.name,
      icon: c.icon as IconKind,
      label: c.label,
      variants: (c.iconVariants ?? []).filter((v) => ICON_FILES[v.icon] !== undefined),
      ...(c.iconCount !== undefined ? { count: c.iconCount } : {}),
    }))
    .sort((a, b) => rank(a.icon) - rank(b.icon));
}

function valueAt(v: unknown, path: string): unknown {
  let cur = v;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function conditionHolds(value: unknown, c: IconCondition): boolean {
  const at = valueAt(value, c.path);
  if (c.in === undefined) return at !== undefined && at !== null;
  return c.in.includes(at as never);
}

function countOf(value: unknown, c: IconCount): string | null {
  const at = valueAt(value, c.path);
  const n = Array.isArray(at) ? at.length : typeof at === 'number' ? at : typeof at === 'object' && at !== null ? Object.keys(at).length : 0;
  return n > 0 ? `${n} ${n === 1 ? c.one : c.many}` : null;
}

/** What an object shows: its icon, the type name and (when its component counts something) the count. */
export interface ObjectIcon {
  readonly kind: IconKind;
  readonly label: string;
  readonly count: string | null;
}

/**
 * The icon an object shows (Scene view billboards, hierarchy rows): the
 * first component of the table it carries, by that component's value
 * variants, else a plain empty object.
 */
export function objectIconFor(e: { components?: Readonly<Record<string, unknown>> }, table: IconTable): ObjectIcon {
  const comps = e.components ?? {};
  for (const row of table) {
    const value = comps[row.component];
    if (value === undefined) continue;
    const count = row.count !== undefined ? countOf(value, row.count) : null;
    for (const v of row.variants) if (v.when.every((c) => conditionHolds(value, c))) return { kind: v.icon, label: v.label, count };
    return { kind: row.icon, label: row.label, count };
  }
  return { kind: 'empty', label: 'Empty object', count: null };
}

/** The icon kind alone (see `objectIconFor`). */
export function iconKindFor(e: { components?: Readonly<Record<string, unknown>> }, table: IconTable): IconKind {
  return objectIconFor(e, table).kind;
}

/** The tooltip naming an object's type ("Terrain · 4 tiles"). */
export function iconTitle(icon: ObjectIcon): string {
  return icon.count !== null ? `${icon.label} · ${icon.count}` : icon.label;
}

/** An icon as an image source. */
export function iconSrc(kind: IconKind): string {
  return ICON_FILES[kind];
}

const cache = new Map<string, THREE.Texture>();

/** Draw the disc, the artwork and (when selected) the ring onto a canvas. */
function compose(size: number, art: HTMLImageElement | null, selected: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const u = size / 64;
  g.fillStyle = 'rgba(20,23,28,.82)';
  g.beginPath();
  g.arc(32 * u, 32 * u, 26 * u, 0, Math.PI * 2);
  g.fill();
  // Missing artwork (a failed load) still leaves the disc, so the object stays visible and pickable.
  if (art !== null) {
    const inset = 14 * u;
    g.drawImage(art, inset, inset, size - 2 * inset, size - 2 * inset);
  }
  if (selected) {
    g.strokeStyle = '#4c8dff';
    g.lineWidth = 4 * u;
    g.beginPath();
    g.arc(32 * u, 32 * u, 29 * u, 0, Math.PI * 2);
    g.stroke();
  }
  return c;
}

const artwork = new Map<IconKind, Promise<HTMLImageElement | null>>();
function loadArt(kind: IconKind): Promise<HTMLImageElement | null> {
  const hit = artwork.get(kind);
  if (hit) return hit;
  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = ICON_FILES[kind];
  });
  artwork.set(kind, p);
  return p;
}

/** The texture for one icon (loaded once; `onLoad` fires when it is drawable). */
export function iconTexture(kind: IconKind, selected: boolean, onLoad?: () => void): THREE.Texture {
  const key = `${kind}:${selected ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  void loadArt(kind).then((art) => {
    canvas.getContext('2d')!.drawImage(compose(128, art, selected), 0, 0);
    tex.needsUpdate = true;
    onLoad?.();
  });
  return tex;
}

/** Screen-space size of an icon billboard (fraction of the viewport height). */
export const ICON_SCREEN_SIZE = 0.075;

/** A billboard sprite for one icon; constant screen size (see `fitSprite`). */
export function makeIconSprite(kind: IconKind, onLoad?: () => void): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: iconTexture(kind, false, onLoad), sizeAttenuation: false, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  sprite.userData.iconKind = kind;
  return sprite;
}

/**
 * Size an icon billboard. A sprite that ignores distance is square in view
 * space and the projection applies the aspect, so equal sides stay square on
 * screen at any viewport shape.
 */
export function fitSprite(sprite: THREE.Sprite): void {
  sprite.scale.set(ICON_SCREEN_SIZE, ICON_SCREEN_SIZE, 1);
}

/** Swap an icon sprite between its normal and selected artwork. */
export function setSpriteSelected(sprite: THREE.Sprite, selected: boolean, onLoad?: () => void): void {
  const kind = sprite.userData.iconKind as IconKind | undefined;
  if (kind === undefined) return;
  (sprite.material as THREE.SpriteMaterial).map = iconTexture(kind, selected, onLoad);
  (sprite.material as THREE.SpriteMaterial).needsUpdate = true;
}
