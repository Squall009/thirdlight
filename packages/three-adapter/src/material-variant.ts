/**
 * Material variants: a material drawn with a different program for some
 * draws (a local-light mode, reading the surface cache, blending projected
 * decals) without touching `mesh.material`. A variant is a shallow copy of
 * the material's own values on the material's class, plus its own marks
 * and a program key that adds its tag; its values are copied from the
 * material again once per render call, so a colour, a texture or a version
 * bump reaches it before it draws.
 *
 * Why a copy and not `Object.create(material)`: three reads some forty
 * material values per draw (its pipeline and refresh checks). Objects whose
 * prototype is a material each have a hidden class of their own, so with a
 * variant per material those reads go megamorphic and walk prototypes; on
 * the village that cost ~2 ms of main thread a frame. A copy on the
 * material's class shares one hidden class with every variant of its class
 * made with the same marks.
 */
import type * as THREE from 'three/webgpu';

type Keyed = THREE.Material & { customProgramCacheKey(): string };

/** A variant's bookkeeping (own, never copied: three's cache key skips `_` names). */
interface VariantState {
  _tlVariantOf: THREE.Material;
  _tlVariantCall: number;
  /** Its own values, put back over the material's after each copy: listeners, program key, marks. */
  _tlVariantOwn: Readonly<Record<string, unknown>>;
}

type Variant = Keyed & Record<string, unknown> & VariantState;

/**
 * A variant of `material` with `marks` (own values its builds read) and a
 * program key of the material's plus `tag`. Marks are given in a fixed set
 * and order per kind of variant, so its variants keep one shape.
 */
export function makeMaterialVariant(material: THREE.Material, marks: Readonly<Record<string, unknown>>, tag: string): THREE.Material {
  const base = material as Keyed;
  const v = Object.create(Object.getPrototypeOf(base) as object) as Variant;
  const own: Record<string, unknown> = {
    // Own listeners: three's render objects listen for the variant's dispose, never the material's.
    _listeners: {},
    ...marks,
    customProgramCacheKey: function variantKey(): string {
      return `${base.customProgramCacheKey()}${tag}`;
    },
  };
  Object.assign(v, own);
  v._tlVariantOf = base;
  v._tlVariantCall = -1;
  v._tlVariantOwn = own;
  // Values three made unlisted (its id, accessors such as a physical material's reflectivity).
  for (const name of Object.getOwnPropertyNames(base)) {
    const d = Object.getOwnPropertyDescriptor(base, name)!;
    if (!d.enumerable && !(name in own)) Object.defineProperty(v, name, d);
  }
  syncMaterialVariant(v, -1);
  return v;
}

/**
 * Copy the material's own values onto its variant, once per render call
 * `call` (-1: now). `Object.assign` copies them in the material's order on
 * V8's fast path (a loop over the keys cost ~3× as much on the village);
 * the variant's own values and bookkeeping are put back after.
 */
export function syncMaterialVariant(variant: THREE.Material, call: number): void {
  const v = variant as Variant;
  if (call !== -1 && v._tlVariantCall === call) return;
  const of = v._tlVariantOf;
  const own = v._tlVariantOwn;
  Object.assign(v, of, own);
  v._tlVariantOf = of;
  v._tlVariantCall = call;
  v._tlVariantOwn = own;
}

/** The material a variant is drawn for (null: `material` is no variant). */
export function variantSource(material: THREE.Material): THREE.Material | null {
  return (material as Partial<VariantState>)._tlVariantOf ?? null;
}

/** A renderer's render call count (three's `info.calls`; -1 when it has none: copy at every draw). */
export function renderCallOf(renderer: unknown): number {
  return (renderer as { info?: { calls?: number } }).info?.calls ?? -1;
}

/**
 * Each material's variants of one kind, by a small number per variant
 * (`code`: no string is built per draw), each made for a `stamp`: what it
 * reads that can be made anew (a surface cache's textures, the decals'
 * generation). A kept variant with another stamp is disposed, so three lets
 * go of its draws, and made again; a material's dispose disposes its variants.
 */
export class MaterialVariants {
  private readonly byMaterial = new WeakMap<THREE.Material, Map<number, { stamp: unknown; variant: THREE.Material }>>();
  /** Variants made so far (diagnostics). */
  made = 0;

  /** The kept variant of `material` under `code` made for `stamp`, its values copied for render call `call` (null: none kept for it). */
  find(material: THREE.Material, code: number, stamp: unknown, call: number): THREE.Material | null {
    const byCode = this.byMaterial.get(material);
    const kept = byCode?.get(code);
    if (kept === undefined) return null;
    if (kept.stamp === stamp) {
      syncMaterialVariant(kept.variant, call);
      return kept.variant;
    }
    byCode!.delete(code);
    kept.variant.dispatchEvent({ type: 'dispose' });
    return null;
  }

  /** Make and keep the variant of `material` under `code` for `stamp` (`makeMaterialVariant`'s marks and tag), copied for render call `call`. */
  make(material: THREE.Material, code: number, stamp: unknown, marks: Readonly<Record<string, unknown>>, tag: string, call: number): THREE.Material {
    const v = makeMaterialVariant(material, marks, tag);
    if (call !== -1) syncMaterialVariant(v, call);
    let byCode = this.byMaterial.get(material);
    if (byCode === undefined) {
      byCode = new Map();
      this.byMaterial.set(material, byCode);
      material.addEventListener('dispose', () => {
        const made = this.byMaterial.get(material);
        this.byMaterial.delete(material);
        for (const m of made?.values() ?? []) m.variant.dispatchEvent({ type: 'dispose' });
      });
    }
    byCode.set(code, { stamp, variant: v });
    this.made += 1;
    return v;
  }
}
