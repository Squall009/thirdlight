/** Types for browser-env.mjs (the Chromium launch environment on this host). */
export function browserLibs(): string | undefined;
export function browserLaunchEnv(): NodeJS.ProcessEnv;
export function gpuAvailable(): boolean;
export const GPU_ARGS: string[];
export const SOFTWARE_GL_ARGS: string[];
export const SOFTWARE_WEBGPU_ARGS: string[];
