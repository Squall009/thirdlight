/**
 * The assembly rule sets a thread knows, by id. A derive job names its rule
 * set by reference (id, version, radius), so every worker must know the
 * same built-in sets without any module having to be imported for its side
 * effects: the package is side-effect free, so the built-in sets are listed
 * here rather than registering themselves.
 */
import { PLACEHOLDER_RULES, type AssemblyRuleSet } from './assembly';
import { TERRAIN_RULES } from './terrain-rules';

const RULE_SETS = new Map<string, AssemblyRuleSet>([PLACEHOLDER_RULES, TERRAIN_RULES].map((r) => [r.id, r]));

/** Registers a rule set (a later catalogue, or a test's); an id may hold one version at a time. */
export function registerAssemblyRules(rules: AssemblyRuleSet): void {
  if (!Number.isInteger(rules.version) || rules.version < 1) throw new RangeError(`rule set ${rules.id}: version ${rules.version}`);
  if (!Number.isInteger(rules.radius) || rules.radius < 0) throw new RangeError(`rule set ${rules.id}: radius ${rules.radius}`);
  RULE_SETS.set(rules.id, rules);
}

/** The rule set a reference names, or a refusal when the id is unknown or its version or radius differ. */
export function assemblyRules(ref: { readonly id: string; readonly version: number; readonly radius?: number }): AssemblyRuleSet {
  const rules = RULE_SETS.get(ref.id);
  if (rules === undefined) throw new RangeError(`unknown assembly rule set ${ref.id}`);
  if (rules.version !== ref.version) throw new RangeError(`assembly rule set ${ref.id} is version ${rules.version}, not ${ref.version}`);
  if (ref.radius !== undefined && ref.radius !== rules.radius) throw new RangeError(`assembly rule set ${ref.id} has radius ${rules.radius}, not ${ref.radius}`);
  return rules;
}

/** Every rule set a worker knows (the built-in sets and each one registered): what the radius conformance check runs over. */
export function registeredAssemblyRules(): AssemblyRuleSet[] {
  return [...RULE_SETS.values()];
}
