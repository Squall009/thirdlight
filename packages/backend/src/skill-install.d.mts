/** Types of `skill-install.mjs` (plain JavaScript so the project tool runs it without a build). */
export declare const SKILL_SOURCE_DIR: string;
export declare const SKILL_INSTALL_DIR: string;
export declare const SKILL_RECORD: string;
export declare const SKILL_STAMP_KEY: string;

export declare function skillStamp(text: string): string | null;

export interface EngineSkill {
  dir: string;
  files: Map<string, Buffer>;
  digests: Record<string, string>;
  digest: string;
  stamp: string | null;
}
export declare function engineSkill(engineRoot: string): EngineSkill;

export interface SkillStatus {
  state: 'missing' | 'modified' | 'outdated' | 'current';
  target: string;
  modified: string[];
  installedStamp: string | null;
  engineStamp: string | null;
}
export declare function skillStatus(engineRoot: string, folder: string): SkillStatus;

export interface SkillInstall {
  action: 'installed' | 'updated' | 'unchanged' | 'refused';
  modified: string[];
  target: string;
  stamp: string | null;
}
export declare function installSkill(engineRoot: string, folder: string, opts?: { force?: boolean }): SkillInstall;
