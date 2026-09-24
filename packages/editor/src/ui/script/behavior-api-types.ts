/**
 * Phase 16.3: the shape of one entry of the generated behavior API member
 * table (`behavior-api.generated.ts`, written by tools/gen-behavior-api.mjs).
 */
export interface BehaviorApiMember {
  name: string;
  kind: 'property' | 'method';
  /** The member's type (a property) or signature (a method) as TypeScript text. */
  detail: string;
  /** The key of the property's own type in the table (for `a.b.` chains). */
  type?: string;
  /** The key of a method's return type in the table (for `a.b().` chains). */
  returns?: string;
  optional?: true;
  /** The first paragraph of the member's doc comment. */
  doc?: string;
}
