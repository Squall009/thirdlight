/**
 * What the host's WebGPU adapter offers, in the browser the perf runs draw
 * with (`node tools/perf/run.mjs gpu-features [--out FILE]`): the adapter's
 * name, its optional features and limits, the WGSL language features, and
 * which storage-texture formats a compute shader can bind write-only, read-only
 * and read-write (each one compiled and validated on a device made with every
 * feature the adapter has). Lighting work that leans on compute checks its
 * needs against this before it is built.
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/gpu-features-<time>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT } from './backend';
import { launchGpuBrowser, serveStatic } from './frame-run';

/** The storage-texture formats checked (core formats, then those the texture-format tiers add). */
const FORMATS = ['r32float', 'r32uint', 'rgba8unorm', 'rgba16float', 'rgba32float', 'rg32float', 'r16float', 'rg16float', 'rgba8uint', 'r8unorm', 'rg11b10ufloat', 'rgb10a2unorm'] as const;
const ACCESS = ['write', 'read', 'read_write'] as const;

/** Runs in the page: everything the report holds, or an error string. */
async function probe({ formats, access }: { formats: readonly string[]; access: readonly string[] }): Promise<Record<string, unknown>> {
  type Gpu = { requestAdapter(o?: unknown): Promise<any>; wgslLanguageFeatures?: Set<string> };
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
  if (gpu === undefined) return { error: 'navigator.gpu is missing' };
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) return { error: 'no adapter' };
  const features = [...adapter.features].sort();
  const limits: Record<string, number> = {};
  for (const k in adapter.limits) limits[k] = adapter.limits[k];
  const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: limits });
  const storage: Record<string, Record<string, string>> = {};
  for (const f of formats) {
    storage[f] = {};
    for (const a of access) {
      device.pushErrorScope('validation');
      const code = `@group(0) @binding(0) var t: texture_storage_2d<${f}, ${a}>;\n@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { ${a === 'write' ? '' : 'let v = textureLoad(t, id.xy);'} ${a === 'read' ? '_ = v;' : `textureStore(t, id.xy, ${a === 'write' ? 'vec4<' + (f.includes('uint') ? 'u32' : 'f32') + '>()' : 'v'});`} }`;
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      const msg = info.messages.find((m: { type: string }) => m.type === 'error');
      if (msg === undefined) device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const err = await device.popErrorScope();
      storage[f][a] = msg !== undefined ? `no (${String(msg.message).slice(0, 120)})` : err !== null ? `no (${String(err.message).slice(0, 120)})` : 'yes';
    }
  }
  const info = adapter.info ?? {};
  return {
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter },
    features,
    wgslLanguageFeatures: [...(gpu.wgslLanguageFeatures ?? [])].sort(),
    limits,
    storage,
    userAgent: navigator.userAgent,
  };
}

export async function runGpuFeaturesCli(argv: readonly string[]): Promise<void> {
  const i = argv.indexOf('--out');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = join(PERF_ROOT, 'runs', `gpu-features-${stamp}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>gpu</title>');
  const site = await serveStatic(root);
  const browser = await launchGpuBrowser({ vsync: true });
  let report: Record<string, unknown>;
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${site.url}/index.html`);
    report = await page.evaluate(probe, { formats: FORMATS, access: ACCESS });
  } finally {
    await browser.close();
    await site.close();
    rmSync(root, { recursive: true, force: true });
  }
  const out = i >= 0 ? argv[i + 1]! : join(PERF_ROOT, 'reports', `gpu-features-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ adapter: report['adapter'], features: report['features'], wgsl: report['wgslLanguageFeatures'] }));
  const l = (report['limits'] ?? {}) as Record<string, number>;
  console.log(`limits: ${['maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxBindGroups', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupStorageSize', 'maxComputeWorkgroupsPerDimension', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers', 'maxColorAttachmentBytesPerSample'].map((k) => `${k} ${l[k]}`).join(', ')}`);
  for (const [f, a] of Object.entries((report['storage'] ?? {}) as Record<string, Record<string, string>>)) console.log(`storage ${f}: ${Object.entries(a).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  if (report['error'] !== undefined) console.log(`gpu-features: ${String(report['error'])}`);
  console.log(`gpu-features: report ${out}`);
}
