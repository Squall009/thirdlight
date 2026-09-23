/**
 * Viewport placeholder icons: cameras, lights, spawns and empty entities are
 * drawn as screen-sized billboards with a kind icon (a rounded backing disc
 * for legibility, a ring when selected). The artwork is inline SVG rendered
 * to textures once per kind; swapping the SVG strings for image files is the
 * only change needed to use generated icons later.
 */
import * as THREE from 'three';

export type IconKind = 'camera' | 'sun' | 'ambient' | 'spawn' | 'empty';

const GLYPHS: Record<IconKind, { color: string; body: string }> = {
  camera: {
    color: '#f2b544',
    body: '<rect x="14" y="22" width="26" height="20" rx="4" fill="none" stroke="C" stroke-width="4"/><path d="M40 28l10-5v18l-10-5z" fill="C"/><circle cx="27" cy="32" r="5" fill="none" stroke="C" stroke-width="3"/>',
  },
  sun: {
    color: '#ffe27a',
    body: '<circle cx="32" cy="32" r="8" fill="C"/><g stroke="C" stroke-width="4" stroke-linecap="round"><path d="M32 12v6M32 46v6M12 32h6M46 32h6M18 18l4 4M42 42l4 4M46 18l-4 4M18 46l4-4"/></g>',
  },
  ambient: {
    color: '#ffe27a',
    body: '<circle cx="32" cy="32" r="14" fill="none" stroke="C" stroke-width="3" opacity=".55"/><circle cx="32" cy="32" r="8" fill="C" opacity=".85"/><circle cx="32" cy="32" r="20" fill="none" stroke="C" stroke-width="2" opacity=".3"/>',
  },
  spawn: {
    color: '#6fe0b2',
    body: '<path d="M22 14v38" stroke="C" stroke-width="4" stroke-linecap="round"/><path d="M24 16h20l-6 8 6 8H24z" fill="C"/>',
  },
  empty: {
    color: '#9aa3b2',
    body: '<g stroke="C" stroke-width="3.5" stroke-linecap="round"><path d="M32 14v36M14 32h36"/></g><circle cx="32" cy="32" r="5" fill="none" stroke="C" stroke-width="3"/>',
  },
};

function svgFor(kind: IconKind, selected: boolean): string {
  const g = GLYPHS[kind];
  const ring = selected ? '<circle cx="32" cy="32" r="29" fill="none" stroke="#4c8dff" stroke-width="4"/>' : '';
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128">' +
    '<circle cx="32" cy="32" r="26" fill="#14171c" fill-opacity=".82"/>' +
    g.body.replace(/C/g, g.color) +
    ring +
    '</svg>'
  );
}

const cache = new Map<string, THREE.Texture>();

/** The texture for one icon (loaded once; `onLoad` fires when it is drawable). */
export function iconTexture(kind: IconKind, selected: boolean, onLoad?: () => void): THREE.Texture {
  const key = `${kind}:${selected ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(kind, selected))}`;
  const tex = new THREE.TextureLoader().load(url, () => onLoad?.());
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
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

/** Keep an icon square on screen for the current viewport aspect. */
export function fitSprite(sprite: THREE.Sprite, aspect: number): void {
  sprite.scale.set(ICON_SCREEN_SIZE / aspect, ICON_SCREEN_SIZE, 1);
}

/** Swap an icon sprite between its normal and selected artwork. */
export function setSpriteSelected(sprite: THREE.Sprite, selected: boolean, onLoad?: () => void): void {
  const kind = sprite.userData.iconKind as IconKind | undefined;
  if (kind === undefined) return;
  (sprite.material as THREE.SpriteMaterial).map = iconTexture(kind, selected, onLoad);
  (sprite.material as THREE.SpriteMaterial).needsUpdate = true;
}
