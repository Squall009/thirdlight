/**
 * Small builders for field descriptors, shared by the component and content
 * block descriptor tables.
 */

import { type AssetRefFieldDescriptor, type BoolFieldDescriptor, type ColorFieldDescriptor, type DescriptorAssetKind, type DescriptorRefTarget, type DescriptorScalar, type EntityRefFieldDescriptor, type EnumFieldDescriptor, type EnumOption, type FieldCondition, type FieldDescriptor, type IntFieldDescriptor, type JsonFieldDescriptor, type ListFieldDescriptor, type MapFieldDescriptor, type NumberFieldDescriptor, type ObjectFieldDescriptor, type RefFieldDescriptor, type SceneRefFieldDescriptor, type SignalFieldDescriptor, type StringFieldDescriptor, type VecFieldDescriptor } from './descriptor-types';

// ---- small builders ------------------------------------------------------------

type Opts<T extends FieldDescriptor> = Omit<T, 'type' | 'key' | 'label' | 'tooltip'>;

export const num = (key: string, label: string, tooltip: string, o: Opts<NumberFieldDescriptor> = {}): NumberFieldDescriptor => ({ type: 'number', key, label, tooltip, ...o });
export const int = (key: string, label: string, tooltip: string, o: Opts<IntFieldDescriptor> = {}): IntFieldDescriptor => ({ type: 'int', key, label, tooltip, step: 1, ...o });
export const bool = (key: string, label: string, tooltip: string, o: Opts<BoolFieldDescriptor> = {}): BoolFieldDescriptor => ({ type: 'bool', key, label, tooltip, ...o });
const opts = (values: readonly string[], labels: Readonly<Record<string, string>> = {}): EnumOption[] => values.map((v) => ({ value: v, label: labels[v] ?? v.charAt(0).toUpperCase() + v.slice(1) }));
export const enm = (key: string, label: string, tooltip: string, values: readonly string[], o: Opts<EnumFieldDescriptor> | (Omit<Opts<EnumFieldDescriptor>, 'options'> & { labels?: Readonly<Record<string, string>> }) = {}): EnumFieldDescriptor => {
  const { labels, ...rest } = o as Omit<Opts<EnumFieldDescriptor>, 'options'> & { labels?: Readonly<Record<string, string>> };
  return { type: 'enum', key, label, tooltip, options: opts(values, labels), ...rest };
};
export const vec2 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec2', key, label, tooltip, labels: ['x', 'y'], ...o });
export const vec3 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec3', key, label, tooltip, labels: ['x', 'y', 'z'], ...o });
export const color = (key: string, label: string, tooltip: string, o: Opts<ColorFieldDescriptor> = {}): ColorFieldDescriptor => ({ type: 'color', key, label, tooltip, ...o });
export const asset = (key: string, label: string, tooltip: string, kinds: readonly DescriptorAssetKind[], o: Omit<Opts<AssetRefFieldDescriptor>, 'kinds'> = {}): AssetRefFieldDescriptor => ({ type: 'assetRef', key, label, tooltip, kinds, ...o });
export const entity = (key: string, label: string, tooltip: string, o: Opts<EntityRefFieldDescriptor> = {}): EntityRefFieldDescriptor => ({ type: 'entityRef', key, label, tooltip, ...o });
export const scene = (key: string, label: string, tooltip: string, o: Opts<SceneRefFieldDescriptor> = {}): SceneRefFieldDescriptor => ({ type: 'sceneRef', key, label, tooltip, ...o });
export const ref = (key: string, label: string, tooltip: string, target: DescriptorRefTarget, o: Omit<Opts<RefFieldDescriptor>, 'target'> = {}): RefFieldDescriptor => ({ type: 'ref', key, label, tooltip, target, ...o });
export const signal = (key: string, label: string, tooltip: string, o: Opts<SignalFieldDescriptor> = {}): SignalFieldDescriptor => ({ type: 'signal', key, label, tooltip, ...o });
export const str = (key: string, label: string, tooltip: string, o: Opts<StringFieldDescriptor> = {}): StringFieldDescriptor => ({ type: 'string', key, label, tooltip, ...o });
export const obj = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[], o: Omit<Opts<ObjectFieldDescriptor>, 'fields'> = {}): ObjectFieldDescriptor => ({ type: 'object', key, label, tooltip, fields, ...o });
export const list = (key: string, label: string, tooltip: string, item: FieldDescriptor, o: Omit<Opts<ListFieldDescriptor>, 'item'> = {}): ListFieldDescriptor => ({ type: 'list', key, label, tooltip, item, ...o });
export const map = (key: string, label: string, tooltip: string, keyLabel: string, value: FieldDescriptor, o: Omit<Opts<MapFieldDescriptor>, 'value' | 'keyLabel'> = {}): MapFieldDescriptor => ({ type: 'map', key, label, tooltip, keyLabel, value, ...o });
export const json = (key: string, label: string, tooltip: string, o: Opts<JsonFieldDescriptor> = {}): JsonFieldDescriptor => ({ type: 'json', key, label, tooltip, ...o });
export const when = (key: string, ...values: DescriptorScalar[]): FieldCondition => ({ key, in: values });

/** The id syntax every stored id uses. */
export const ID = { format: 'id' as const, minLength: 1, maxLength: 64 };
/** A display name: 1–128 characters, no control characters. */
export const NAME = { format: 'name' as const, minLength: 1, maxLength: 128 };