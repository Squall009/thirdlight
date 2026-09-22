/**
 * Packet 38 probe A — browser capability baseline.
 *
 * Runs in the real local Chrome. Every value is measured in the browser; the
 * results are read back by `run.mjs` from `window.__probe`. Nothing here is
 * simulated: the canvas pixels are read from the WebGL framebuffer, the audio
 * context is a real AudioContext, and the gamepad reading is a real
 * `navigator.getGamepads()` call.
 */
import * as THREE from 'three';

interface Results {
  [key: string]: unknown;
}

const R: Results = {};
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${String(e.reason)}`));
(window as unknown as { __probe: Results }).__probe = R;

// Real key and visibility records (the driver dispatches real CDP input and
// opens a second target to hide this page).
const keys: string[] = [];
const visibilitySeen: string[] = [];
window.addEventListener('keydown', (e) => keys.push(e.code));
window.addEventListener('keyup', (e) => keys.push(`up:${e.code}`));
document.addEventListener('visibilitychange', () => visibilitySeen.push(document.visibilityState));
(window as unknown as { __keys: string[] }).__keys = keys;
(window as unknown as { __visibilitySeen: string[] }).__visibilitySeen = visibilitySeen;

const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

void (async () => {
  await step('env', () => {
    R['userAgent'] = navigator.userAgent;
    R['hardwareConcurrency'] = navigator.hardwareConcurrency;
    R['deviceMemoryGb'] = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null;
    R['secureContext'] = window.isSecureContext;
    R['crossOriginIsolated'] = window.crossOriginIsolated;
    R['visibilityState'] = document.visibilityState;
    R['devicePixelRatio'] = window.devicePixelRatio;
  });

  await step('webgl2', () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const gl = c.getContext('webgl2');
    R['webgl2'] = gl !== null;
    if (gl === null) return;
    R['glVersion'] = gl.getParameter(gl.VERSION);
    R['glRenderer'] = gl.getParameter(gl.RENDERER);
    R['glVendor'] = gl.getParameter(gl.VENDOR);
    R['glslVersion'] = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    R['maxTextureSize'] = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    R['maxRenderbufferSize'] = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    R['unmaskedRenderer'] = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    R['colorBufferFloat'] = gl.getExtension('EXT_color_buffer_float') !== null;
    R['compressedTextureS3tc'] = gl.getExtension('WEBGL_compressed_texture_s3tc') !== null;
  });

  await step('three', () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'three-canvas';
    canvas.width = 480;
    canvas.height = 300;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    R['threeRevision'] = THREE.REVISION;
    R['rendererIsWebGL2'] = renderer.capabilities.isWebGL2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setSize(480, 300, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101820);
    const cam = new THREE.PerspectiveCamera(45, 480 / 300, 0.1, 100);
    cam.position.set(0, 1.2, 12);
    cam.lookAt(0, 0.5, 0);
    const ground = new THREE.Mesh(new THREE.BoxGeometry(20, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.9 }));
    ground.position.set(0, -0.25, 0);
    ground.receiveShadow = true;
    scene.add(ground);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd8b13a }));
    box.position.set(-0.6, 0.5, 0);
    box.castShadow = true;
    scene.add(box);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    scene.add(key);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    renderer.render(scene, cam);
    R['shadowMapAllocated'] = key.shadow.map !== null && key.shadow.map !== undefined;
    R['shadowMapSize'] = [key.shadow.mapSize.x, key.shadow.mapSize.y];
    R['drawCalls'] = renderer.info.render.calls;
    R['triangles'] = renderer.info.render.triangles;
    R['glError'] = renderer.getContext().getError();
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    R['lowLeftPixel'] = Array.from(px);
    R['canvasPngBytes'] = canvas.toDataURL('image/png').length;
    // keep presenting frames so nothing depends on a single-frame buffer
    let frames = 0;
    const loop = (): void => {
      if (frames++ < 120) {
        renderer.render(scene, cam);
        requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
  });

  await step('audio', async () => {
    const audio: Results = {};
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    audio['hasAudioContext'] = Ctor !== undefined;
    if (Ctor === undefined) {
      R['audio'] = audio;
      return;
    }
    const ctx = new Ctor();
    audio['initialState'] = ctx.state;
    audio['sampleRate'] = ctx.sampleRate;
    audio['baseLatency'] = ctx.baseLatency;
    audio['maxChannelCount'] = ctx.destination.maxChannelCount;
    // A real user gesture is delivered by the driver before this probe runs.
    const resumed = await Promise.race([ctx.resume().then(() => 'resolved'), new Promise((r) => setTimeout(() => r('timeout'), 1500))]);
    audio['resumeResult'] = resumed;
    audio['stateAfterResume'] = ctx.state;
    const sr = 48000;
    const n = Math.floor(sr / 2);
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ascii = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i += 1) dv.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    ascii(36, 'data');
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) dv.setInt16(44 + i * 2, Math.round(Math.sin((i / sr) * 2 * Math.PI * 440) * 8000), true);
    try {
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      audio['decodedChannels'] = decoded.numberOfChannels;
      audio['decodedLength'] = decoded.length;
      audio['decodedDuration'] = decoded.duration;
      audio['decodedSampleRate'] = decoded.sampleRate;
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      const analyser = ctx.createAnalyser();
      src.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      let ended = false;
      src.onended = () => {
        ended = true;
      };
      src.start();
      const data = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        analyser.getFloatTimeDomainData(data);
        for (const v of data) peak = Math.max(peak, Math.abs(v));
      }
      audio['playStarted'] = true;
      audio['onendedWithin200ms'] = ended;
      audio['stateAfterPlay'] = ctx.state;
      audio['analyserPeak'] = peak;
      audio['analyserMeaning'] =
        'peak of an AnalyserNode downstream of the gain node; a silent or absent output device can still leave this 0';
    } catch (e) {
      audio['decodeError'] = e instanceof Error ? e.message : String(e);
    }
    await ctx.close();
    audio['stateAfterClose'] = ctx.state;
    R['audio'] = audio;
  });

  await step('gamepad', () => {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
    R['gamepadApiPresent'] = pads !== null;
    R['gamepadCount'] = pads === null ? -1 : Array.from(pads).filter((p) => p !== null).length;
    R['gamepadEventsSeen'] = (window as unknown as { __gamepadEvents?: number }).__gamepadEvents ?? 0;
    R['hasGamepadEvent'] = 'ongamepadconnected' in window;
  });

  await step('iframe-policy', async () => {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    R['hasPermissionsPolicy'] = policy !== undefined;
    R['permissionsPolicyGamepad'] = policy?.allowsFeature?.('gamepad') ?? null;
    R['permissionsPolicyFullscreen'] = policy?.allowsFeature?.('fullscreen') ?? null;
    const frame = document.createElement('iframe');
    frame.setAttribute('allow', "gamepad 'none'");
    frame.srcdoc = '<!doctype html><html><body>framed</body></html>';
    document.body.appendChild(frame);
    await new Promise((r) => setTimeout(r, 300));
    const win = frame.contentWindow as (Window & { isSecureContext?: boolean }) | null;
    R['iframeSecureContext'] = win?.isSecureContext ?? null;
    R['iframeGamepadCount'] = win !== null && typeof win.navigator.getGamepads === 'function' ? Array.from(win.navigator.getGamepads()).filter((p) => p !== null).length : -1;
    frame.remove();
  });

  await step('hidden-tab', () => {
    // Recorders are installed at module scope; the driver opens a second target
    // (which really hides this page) and reads the values back.
    R['visibilityStateAtProbe'] = document.visibilityState;
    R['visibilityListenerInstalled'] = true;
  });

  await step('storage-caps', () => {
    R['webCryptoSubtle'] = typeof crypto?.subtle?.digest === 'function';
    R['wasmCompilePresent'] = typeof WebAssembly?.compile === 'function';
    R['requestAnimationFramePresent'] = typeof requestAnimationFrame === 'function';
    R['structuredClonePresent'] = typeof structuredClone === 'function';
  });

  R['errors'] = errors;
  (window as unknown as { __done: boolean }).__done = true;
})();
