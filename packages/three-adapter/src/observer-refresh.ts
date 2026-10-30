/**
 * The one hook on three's `NodeMaterial.setupObserver`: the features whose
 * draws read what three's refresh check does not know of (an instance set's
 * GPU copies, copies culled on the GPU, the see-through mask's subject bits)
 * each add a rule that answers a full refresh when their own state changed.
 *
 * three updates an object's own uniforms and bindings only when the
 * observer it made for the build sees a change it knows of. Each rule wraps
 * that answer for the builds it is about. They compose in one fixed order,
 * whichever feature a page starts first: a rule that keeps a record per
 * render object always sees the draw (the inner ones), and see-through,
 * which stops at an inner full refresh, asks last.
 */
import type * as THREE from 'three';
import { NodeMaterial, type NodeBuilder } from 'three/webgpu';

/** What an observer's `needsRefresh` is asked about: one render object (an object drawn by a camera). */
export interface RefreshDraw {
  readonly object: THREE.Object3D;
  readonly camera: THREE.Camera;
}

/** An observer's answer for a draw: a `RenderObjectRefreshType`, or 0 for none. */
export type NeedsRefresh = (renderObject: RefreshDraw, frame: unknown) => number;

/** A feature's rule: `needs` wrapped for a build of `material`, or null when the build is not the feature's. */
export type RefreshRule = (needs: NeedsRefresh, builder: NodeBuilder, material: THREE.Material) => NeedsRefresh | null;

/** The rules' order, innermost first. */
const RULE_ORDER = ['culled-copies', 'gpu-copies', 'see-through'] as const;

const rules: (RefreshRule | undefined)[] = RULE_ORDER.map(() => undefined);
/** Whether three's observer step was there to hook (null: not looked yet). */
let hooked: boolean | null = null;

/**
 * Add a feature's refresh rule (a second call for the same feature replaces
 * it). Returns whether three has the observer step: without it the feature's
 * draws refresh only when three refreshes them for its own reasons.
 */
export function addRefreshRule(feature: (typeof RULE_ORDER)[number], rule: RefreshRule): boolean {
  rules[RULE_ORDER.indexOf(feature)] = rule;
  return hookObserver();
}

function hookObserver(): boolean {
  if (hooked !== null) return hooked;
  const proto = NodeMaterial.prototype as unknown as { setupObserver?: (this: THREE.Material, builder: NodeBuilder) => unknown };
  const observe = proto.setupObserver;
  hooked = typeof observe === 'function';
  if (typeof observe !== 'function') return false;
  proto.setupObserver = function setupObserverWithRules(builder) {
    const observer = observe.call(this, builder) as { needsRefresh?: NeedsRefresh } | null;
    if (observer === null || typeof observer !== 'object' || typeof observer.needsRefresh !== 'function') return observer;
    let needs: NeedsRefresh = observer.needsRefresh.bind(observer);
    let wrapped = false;
    for (const rule of rules) {
      const w = rule?.(needs, builder, this) ?? null;
      if (w === null) continue;
      needs = w;
      wrapped = true;
    }
    // A build no rule is about keeps three's own method.
    if (wrapped) observer.needsRefresh = needs;
    return observer;
  };
  return true;
}
