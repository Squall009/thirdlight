/**
 * Phase 19.1: the shape of a visual-script API node (data).
 *
 * Every `ctx` surface a behavior script reaches is offered as a node. The
 * table (`BEHAVIOR_API_NODES`, behavior-api.generated.ts) is GENERATED from
 * the runtime's `BehaviorContext` typings by `tools/gen-behavior-graph-api.mjs`,
 * so new script API shows up as nodes without hand-work (a unit test fails
 * when the typings change without regenerating). The behavior graph kind
 * builds its node definitions from these entries and the compiler emits each
 * call from them alone — neither has per-node code for API nodes.
 *
 * The runtime typings steer the generator with doc tags: `@graphNode <label>`
 * (or `@graphNode skip <reason>`), `@graphPure` (a query without side
 * effects: a data node evaluated where it is read; everything else is an
 * exec node run once in the flow), `@graphDefault <arg> <value>` (an inline
 * default), `@graphLabel <arg> <label>` (an argument's label), `@graphAsset
 * <arg> <kind>` (a text naming an asset of that kind) and
 * `@graphPhase <phase>` (an intent valid in one phase).
 */
import type { GraphValue } from './graph';

/** The value types of visual-script data ports. */
export type BehaviorDataType = 'number' | 'boolean' | 'string' | 'vector' | 'list' | 'map';

/** One argument of an API node: an input port with an inline value (a field), or a choice field. */
export interface BehaviorApiArg {
  /** The input port id and the id of its inline-value field. */
  id: string;
  label: string;
  /** The port type; `typed`: chosen per node with the field `<id>_type` (one of `types`). */
  type: BehaviorDataType | 'typed';
  types?: readonly BehaviorDataType[];
  /**
   * The inline value used when the input is not wired. Absent: the input has
   * no inline value — unwired, the argument is not given (undefined).
   */
  default?: GraphValue;
  /** A choice among these texts (a literal-union parameter): a field only, never a port. */
  options?: readonly string[];
  /** Text that must not be empty when the input is not wired. */
  required?: true;
  /** An entity id: empty means the entity carrying the script ("this object"). */
  self?: true;
  /** Optional text: empty means "not given". */
  omitEmpty?: true;
  /**
   * An object of optional numbers (`{x?, y?, z?}`) given as a vector: the
   * field `<id>_axes` chooses which components are set (`none` = not given,
   * offered when the object itself is optional).
   */
  axes?: readonly string[];
  /** A rest text parameter: the text is split at commas. */
  rest?: true;
  /** The text names an asset of this kind (the Inspector offers the project's assets of that kind). */
  asset?: string;
}

/** How one call argument is built from the node's arguments. */
export type BehaviorApiValue =
  /** An argument's value; `vec2`: a vector as `{x, y}`; `axes`: the chosen components as an object. */
  | { arg: string; as?: 'vec2' | 'axes' }
  | { const: string | number | boolean }
  /** An object (keys in this order; keys whose value is undefined are left out). */
  | { object: readonly (readonly [string, BehaviorApiValue])[] }
  /** A rest parameter: the argument's comma-separated text as separate arguments. */
  | { rest: string };

/** One step of the expression that starts at `ctx`. */
export type BehaviorApiStep =
  /** A member; `optional`: it may be absent (the next step reads it with `?.`). */
  | { prop: string; optional?: true }
  /** A call; `nullable`: its result may be null (the next step reads it with `?.`). */
  | { call: readonly BehaviorApiValue[]; nullable?: true };

/** One output of an API node, read from the call's result. */
export interface BehaviorApiOutput {
  id: string;
  label: string;
  /** `typed`: chosen per node with the field `<id>_type` (one of `types`). */
  type: BehaviorDataType | 'typed';
  types?: readonly BehaviorDataType[];
  /** The property path in the result ([] = the result itself). */
  path: readonly string[];
  /** A boolean: whether the result exists (neither null nor undefined). */
  found?: true;
}

export interface BehaviorApiNodeSpec {
  type: string;
  label: string;
  category: string;
  description: string;
  /** true: an exec node (runs once in the flow, its outputs keep the result); false: a data node (a query evaluated where it is read). */
  exec: boolean;
  /** `ctx` followed by these steps. */
  access: readonly BehaviorApiStep[];
  args: readonly BehaviorApiArg[];
  outputs: readonly BehaviorApiOutput[];
  /** The one phase the node may run in (an intent valid in one phase). */
  phase?: 'intent' | 'transform';
  /** The node moves the entity its argument of this id names (the script must own that transform). */
  moves?: string;
}
