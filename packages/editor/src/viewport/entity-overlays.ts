/**
 * What the Scene view draws on an entity that the game does not: its icon
 * billboard, a light's reach or cone and a directional light's direction, a
 * spawn's facing and a fog volume's box.
 *
 * Each entity's overlays are one group handed to the scene adapter
 * (`attachOverlay`), which hangs it on the entity's node: it moves with the
 * entity's world matrix, hides with it, and stays on when the adapter
 * realizes the entity again. The adapter places the group's drawables with
 * their offset baked when the group is attached, so a change of an
 * overlay's own transform (an icon refitted to a new aspect) attaches the
 * group again.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import type { SceneAdapter } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';
import { lightGizmo } from './helper-shapes';
import { fitSprite, iconKindFor, makeIconSprite, setSpriteSelected, type IconKind, type IconTable } from './icons';

/** Marks an overlay group (bounds and outlines leave it out). */
export const OVERLAY_KEY = 'tlOverlay';

/**
 * What an entity's overlays are built from — its kind, its light (type,
 * direction, range, cone, mode) and whether it has a fog volume or is a
 * spawn (with its facing). A change rebuilds them; sizes and colours update in place.
 */
function buildKeyOf(e: ProjectedEntity): string {
  const l = e.light;
  const facing = e.playerSpawn === true ? ((e.components['playerSpawn'] as { yaw?: number } | undefined)?.yaw ?? null) : null;
  return JSON.stringify([e.kind, l === undefined ? null : [l.type, l.direction ?? null, l.range ?? null, l.angle ?? null, l.mode ?? null], e.fogVolume !== undefined, e.playerSpawn === true, facing]);
}

interface Built {
  readonly group: THREE.Group;
  key: string;
  icon: THREE.Sprite | null;
  fog: THREE.LineSegments | null;
}

export interface EntityOverlayHost {
  adapter(): SceneAdapter | null;
  /** The view's aspect (icons stay square on screen). */
  aspect(): number;
  requestRender(): void;
}

export class EntityOverlays {
  private readonly host: EntityOverlayHost;
  private readonly built = new Map<string, Built>();
  private gizmos = { icons: true, lights: true };
  private selectedId: string | null = null;
  private iconTable: IconTable = [];

  constructor(host: EntityOverlayHost) {
    this.host = host;
  }

  /** Build or update an entity's overlays (none for what the adapter draws itself: boxes, models, folders). */
  sync(e: ProjectedEntity): void {
    const key = buildKeyOf(e);
    let b = this.built.get(e.id);
    if (b !== undefined && b.key !== key) {
      this.remove(e.id);
      b = undefined;
    }
    if (b === undefined) {
      const made = this.build(e, key);
      if (made === null) return;
      b = made;
      this.built.set(e.id, b);
      this.host.adapter()?.attachOverlay?.(e.id, b.group);
    }
    this.refresh(e, b);
  }

  /** The entity is gone: its overlays go. */
  remove(id: string): void {
    const b = this.built.get(id);
    if (b === undefined) return;
    this.built.delete(id);
    this.host.adapter()?.detachOverlay?.(id, b.group);
    b.group.traverse((o) => {
      const m = o as THREE.Mesh;
      // The icon textures are shared and kept; geometries and materials are each overlay's own.
      if (m.geometry !== undefined && !(o instanceof THREE.Sprite)) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
  }

  ids(): IterableIterator<string> {
    return this.built.keys();
  }

  /** The descriptors' icon table (which component shows which icon): icons follow it. */
  setIconTable(table: IconTable, entities: readonly ProjectedEntity[]): void {
    this.iconTable = table;
    for (const e of entities) {
      const b = this.built.get(e.id);
      if (b !== undefined) this.refresh(e, b);
    }
  }

  /** The Gizmos menu: icons and light ranges shown or not. */
  setGizmos(g: { icons: boolean; lights: boolean }): void {
    this.gizmos = { ...g };
    for (const b of this.built.values()) {
      if (b.icon !== null) b.icon.visible = g.icons;
      b.group.traverse((o) => {
        if (o.userData['gizmo'] === 'light') o.visible = g.lights;
      });
    }
  }

  /** The selected entity's icon wears its selected artwork. */
  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    const before = this.selectedId === null ? undefined : this.built.get(this.selectedId);
    if (before?.icon) setSpriteSelected(before.icon, false, () => this.host.requestRender());
    this.selectedId = id;
    const now = id === null ? undefined : this.built.get(id);
    if (now?.icon) setSpriteSelected(now.icon, true, () => this.host.requestRender());
  }

  /** The view's aspect changed: icons are refitted, and their groups attached again (their offsets are baked). */
  refit(): void {
    const aspect = this.host.aspect();
    const adapter = this.host.adapter();
    for (const [id, b] of this.built) {
      if (b.icon === null) continue;
      fitSprite(b.icon, aspect);
      adapter?.detachOverlay?.(id, b.group);
      adapter?.attachOverlay?.(id, b.group);
    }
  }

  /** A new adapter (another renderer backend): every group is attached to it. */
  attachAll(adapter: SceneAdapter): void {
    for (const [id, b] of this.built) adapter.attachOverlay?.(id, b.group);
  }

  dispose(): void {
    for (const id of [...this.built.keys()]) this.remove(id);
  }

  private build(e: ProjectedEntity, key: string): Built | null {
    if (e.kind === 'folder' || e.kind === 'model' || e.kind === 'box') return null;
    const group = new THREE.Group();
    group.name = `overlay:${e.id}`;
    group.userData[OVERLAY_KEY] = true;
    const b: Built = { group, key, icon: null, fog: null };
    if (e.light !== undefined) {
      // A directional light shows its direction.
      if (e.light.type === 'directional' && e.light.direction !== undefined) {
        const d = e.light.direction;
        const len = 2;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(d[0] * len, d[1] * len, d[2] * len)]), new THREE.LineBasicMaterial({ color: 0xffe27a }));
        line.name = e.id;
        // A light's direction is one of its gizmos (the Gizmos menu's light ranges).
        line.userData = { lightKind: 'directional', gizmo: 'light' };
        line.visible = this.gizmos.lights;
        group.add(line);
      }
      // A point light shows its reach, a spot light its cone.
      if ((e.light.type === 'point' || e.light.type === 'spot') && e.light.mode !== 'baked') {
        const g = lightGizmo(e);
        g.userData['gizmo'] = 'light';
        g.visible = this.gizmos.lights;
        group.add(g);
      }
      b.icon = this.addIcon(group, e);
      return b;
    }
    // An empty entity: a spawn icon when it is a player spawn, an axis cross otherwise.
    b.icon = this.addIcon(group, e);
    // A spawn's facing, as an arrow (its yaw, degrees about +Y, 0 = +Z).
    const yaw = e.playerSpawn === true ? (e.components['playerSpawn'] as { yaw?: number } | undefined)?.yaw : undefined;
    if (typeof yaw === 'number') {
      const r = (yaw * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(r), 0, Math.cos(r));
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      const tip = dir.clone().multiplyScalar(0.8);
      const back = dir.clone().multiplyScalar(0.55);
      const up = new THREE.Vector3(0, 0.18, 0);
      const arrow = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), tip, tip, back.clone().add(up), tip, back.clone().sub(up), tip, back.clone().addScaledVector(side, 0.18), tip, back.clone().addScaledVector(side, -0.18)]),
        new THREE.LineBasicMaterial({ color: 0xffc857, depthTest: false }),
      );
      arrow.name = `spawn-yaw:${yaw}`;
      arrow.renderOrder = 10;
      group.add(arrow);
    }
    // A fog volume shows its box.
    if (e.fogVolume !== undefined) {
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(e.fogVolume.size[0], e.fogVolume.size[1], e.fogVolume.size[2])),
        new THREE.LineBasicMaterial({ color: new THREE.Color(e.fogVolume.color), transparent: true, opacity: 0.7 }),
      );
      box.name = e.id;
      box.userData = { fogVolumeSize: e.fogVolume.size.join(',') };
      group.add(box);
      b.fog = box;
    }
    return b;
  }

  private addIcon(group: THREE.Group, e: ProjectedEntity): THREE.Sprite {
    const kind = iconKindFor(e, this.iconTable);
    const sprite = makeIconSprite(kind, () => this.host.requestRender());
    sprite.name = e.id;
    sprite.userData['iconKind'] = kind;
    sprite.visible = this.gizmos.icons;
    fitSprite(sprite, this.host.aspect());
    if (this.selectedId === e.id) setSpriteSelected(sprite, true, () => this.host.requestRender());
    group.add(sprite);
    return sprite;
  }

  /** What changes in place: the icon's kind (a component added or removed), the fog box's size and colour. */
  private refresh(e: ProjectedEntity, b: Built): void {
    if (b.icon !== null) {
      const kind: IconKind = iconKindFor(e, this.iconTable);
      if (b.icon.userData['iconKind'] !== kind) {
        const adapter = this.host.adapter();
        adapter?.detachOverlay?.(e.id, b.group);
        b.group.remove(b.icon);
        b.icon.material.dispose();
        b.icon = this.addIcon(b.group, e);
        adapter?.attachOverlay?.(e.id, b.group);
      }
    }
    if (b.fog !== null && e.fogVolume !== undefined) {
      const size = e.fogVolume.size.join(',');
      if (b.fog.userData['fogVolumeSize'] !== size) {
        b.fog.geometry.dispose();
        b.fog.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(e.fogVolume.size[0], e.fogVolume.size[1], e.fogVolume.size[2]));
        b.fog.userData['fogVolumeSize'] = size;
      }
      (b.fog.material as THREE.LineBasicMaterial).color.set(e.fogVolume.color);
    }
  }
}
