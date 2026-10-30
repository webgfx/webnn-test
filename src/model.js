
const { WebNNRunner, WebNNPerfCollector } = require('./util');
const { expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const ALL_DEVICES = ['cpu', 'gpu', 'npu'];
const SAMPLES_URL = 'https://webmachinelearning.github.io/webnn-samples/';
const PREVIEW_URL = 'https://microsoft.github.io/webnn-developer-preview/demos/';
const MINUTE = 60000;
const DEFAULT_CASE_TIMEOUT = 10 * MINUTE;

// webnn-samples report every error through ui.addAlert(); info alerts are not failures.
const SAMPLE_ALERT = '#container > .alert:not(.alert-info)';

// WebNN/ORT console errors that mean a preview cannot finish; fail fast instead of waiting out timeouts.
const LOAD_ERROR_PATTERNS = [
  'failed to create session',
  'failed to create context',
  'session initialization failed',
  'out of memory',
  'unrecognized graph input',
];

// The page reports sum-of-stems vs mix MAE; normalize by the summed output level.
const MAX_RELATIVE_STEM_MIX_ERROR = 0.1;

function validateStemWav(buffer, expectedSamples) {
  if (buffer.length < 44 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      buffer.readUInt32LE(16) !== 16 ||
      buffer.readUInt16LE(20) !== 3 ||
      buffer.readUInt16LE(22) !== 2 ||
      buffer.readUInt32LE(24) !== 44100 ||
      buffer.readUInt16LE(34) !== 32 ||
      buffer.toString('ascii', 36, 40) !== 'data') {
    throw new Error('Expected a 44100 Hz stereo float32 WAV');
  }
  const dataBytes = buffer.readUInt32LE(40);
  if (dataBytes !== expectedSamples * 8 || buffer.length !== 44 + dataBytes ||
      buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new Error('Stem WAV length does not match the input audio');
  }
  const samples = new Float32Array(expectedSamples * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = buffer.readFloatLE(44 + i * 4);
    if (!Number.isFinite(sample)) throw new Error('Stem WAV contains non-finite samples');
    samples[i] = sample;
  }
  return samples;
}

function parseSampleCount(text) {
  const match = /^\s*([\d\s.,'\u00a0\u202f]+?)\s*samples\b/.exec(text || '');
  const value = match ? Number(match[1].replace(/\D/g, '')) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Could not read the sample count from "${text}"`);
  }
  return value;
}

function parseMixError(text) {
  const match = /sum-of-stems vs mix MAE:\s*(\S+)/.exec(text || '');
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Could not read the sum-of-stems vs mix MAE from "${text}"`);
  }
  return value;
}

function checkStemMix(stems, mixError, maxRelativeError = MAX_RELATIVE_STEM_MIX_ERROR) {
  let level = 0;
  for (let i = 0; i < stems[0].length; i++) {
    let sum = 0;
    for (const stem of stems) sum += stem[i];
    level += Math.abs(sum);
  }
  level /= stems[0].length;
  if (level === 0) throw new Error('All four separated stems are silent');
  const relativeError = mixError / level;
  if (relativeError > maxRelativeError) {
    throw new Error(`Summed stems do not match the input mix: relative MAE ${relativeError.toFixed(4)} exceeds ${maxRelativeError}`);
  }
  return relativeError;
}

// --- Case and variant selection ---

function currentDevice() {
  return (process.env.DEVICE || 'cpu').toLowerCase();
}

// "lenet,od:tinyyolov2-fp16+ssdmobilenetv1-fp16" -> [{ key, variants }]
function parseModelCaseFilter(filter) {
  if (!filter || !filter.trim()) return null;
  return filter.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [key, variants] = entry.split(':');
    return {
      key: key.trim().toLowerCase(),
      variants: variants === undefined ? null : variants.split('+').map(v => v.trim().toLowerCase()).filter(Boolean)
    };
  });
}

function resolveDefaultVariant(modelDef, device) {
  const value = modelDef.defaultVariant;
  if (!value || typeof value === 'string') return value || Object.keys(modelDef.variants)[0];
  return value[device] || value.default;
}

function caseTestName(modelDef, variant) {
  return variant ? `${modelDef.name} [${variant.label}]` : modelDef.name;
}

/**
 * Expands the model case filter into runnable (case, variant) items.
 * Without a filter every non opt-in case runs. A bare key runs its default variant
 * (every variant when variantMode is 'all'); key:a+b runs the named variants.
 * Items whose case or variant does not support the device carry a skipReason.
 */
function expandModelCases(models, { filter = null, variantMode = 'default', device = 'cpu' } = {}) {
  const entries = parseModelCaseFilter(filter) ||
    Object.keys(models).filter(key => !models[key].optIn).map(key => ({ key, variants: null }));
  const items = [];
  const seen = new Set();
  for (const { key, variants } of entries) {
    const modelDef = models[key];
    if (!modelDef) {
      items.push({ key, error: `Unknown test case: ${key}` });
      continue;
    }
    const available = Object.keys(modelDef.variants || {});
    let ids;
    if (available.length === 0) {
      if (variants && variants.length) {
        items.push({ key, error: `Test case ${key} has no variants (requested: ${variants.join(', ')})` });
        continue;
      }
      ids = [null];
    } else if (variants && variants.length) {
      ids = variants;
    } else {
      ids = variantMode === 'all' ? available : [resolveDefaultVariant(modelDef, device)];
    }
    for (const variantId of ids) {
      const variant = variantId === null ? null : modelDef.variants[variantId];
      if (variantId !== null && !variant) {
        items.push({ key, error: `Unknown variant "${variantId}" for ${key}. Available: ${available.join(', ')}` });
        continue;
      }
      // Overlapping filters (e.g. "od,od:tinyyolov2-fp32") run each case variant once.
      const id = `${key}:${variantId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const caseDef = { ...modelDef, key, variantId, variant, name: caseTestName(modelDef, variant) };
      const devices = (variant && variant.devices) || modelDef.devices || ALL_DEVICES;
      const skipReason = devices.includes(device) ? null :
        `No WebNN ${device.toUpperCase()} support in this ${variant ? 'variant' : modelDef.type} (supported: ${devices.join(', ')})`;
      items.push({ key, variantId, caseDef, skipReason });
    }
  }
  return items;
}

function passResult(caseDef, testUrl, details, extra = {}) {
  return {
    testName: caseDef.name,
    testUrl,
    result: 'PASS',
    details,
    subcases: { total: 1, passed: 1, failed: 0 },
    suite: 'model',
    ...extra
  };
}

function skipResult(caseDef, reason, testUrl = caseDef.url) {
  return {
    testName: caseDef.name,
    testUrl,
    result: 'SKIP',
    details: reason,
    subcases: { total: 0, passed: 0, failed: 0 },
    suite: 'model'
  };
}

// --- Output validators (pure; unit-tested in tests/model-cases.unit.cjs) ---

// "99.22%" -> 0.9922, "0.65" -> 0.65, "9.5e-1" -> 0.95; anything else (e.g. "1e+2", "0.5 extra") is
// parsed strictly so an out-of-range or malformed value cannot pass as a smaller number.
function parseProbability(text) {
  const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(%)?\s*$/i.exec(text || '');
  if (!match) return NaN;
  const value = Number(match[1]);
  return match[2] ? value / 100 : value;
}

// ImageNet labels list comma-separated aliases ("tiger, Panthera tigris"); one alias must equal the
// expected class, so "tiger cat" does not satisfy "tiger".
function checkTopLabel(label, probability, expected) {
  const text = (label || '').trim();
  const aliases = text.toLowerCase().split(',').map(alias => alias.trim()).filter(Boolean);
  if (!aliases.includes(expected.trim().toLowerCase())) {
    throw new Error(`Expected top-1 class "${expected}" but got "${text || '(empty)'}"`);
  }
  const value = parseProbability(probability);
  if (!(value > 0 && value <= 1)) {
    throw new Error(`Top-1 probability "${probability}" is not in (0, 1]`);
  }
  return value;
}

// Detection labels are drawn as "<label>: <score>".
function parseDetections(texts) {
  return texts.map(text => {
    const match = /^(.+):\s*(\d+(?:\.\d+)?)$/.exec(String(text).trim());
    if (!match) throw new Error(`Unexpected detection label "${text}"`);
    return { label: match[1].trim(), score: Number(match[2]) };
  });
}

// Style transfer must build exactly the requested style once (no redundant default-style build).
function checkStyleBuilds(builds, expectedStyle) {
  if (builds.length !== 1 || builds[0] !== expectedStyle) {
    throw new Error(`Expected one ${expectedStyle} model build, got: ${builds.join(', ') || 'none'}`);
  }
}

// Canvas ignores non-finite coordinates, so such draws are counted separately and fail the case.
function checkFiniteGeometry(calls, what) {
  const invalid = (calls && calls.invalid) || 0;
  if (invalid > 0) throw new Error(`${invalid} ${what} had non-finite coordinates and were not drawn`);
}

function checkDetections(calls, expectedLabel) {
  checkFiniteGeometry(calls, 'detection boxes or labels');
  const boxes = (calls && calls.strokeRect) || 0;
  const detections = parseDetections((calls && calls.fillText) || []);
  if (boxes < 1) throw new Error('No objects were detected');
  if (detections.length !== boxes) {
    throw new Error(`Drew ${boxes} boxes but ${detections.length} labels`);
  }
  const outOfRange = detections.find(d => !(d.score > 0 && d.score <= 1));
  if (outOfRange) throw new Error(`Detection score out of range: ${outOfRange.label}: ${outOfRange.score}`);
  if (!detections.some(d => d.label === expectedLabel)) {
    throw new Error(`Expected a "${expectedLabel}" detection, got: ${detections.map(d => d.label).join(', ')}`);
  }
  return detections;
}

function checkFaceLandmarks(calls, expectedFaces, pointsPerFace = 68) {
  checkFiniteGeometry(calls, 'face boxes or landmarks');
  const faces = (calls && calls.strokeRect) || 0;
  const points = (calls && calls.arc) || 0;
  if (faces !== expectedFaces) throw new Error(`Expected ${expectedFaces} faces, detected ${faces}`);
  if (points !== faces * pointsPerFace) {
    throw new Error(`Expected ${faces * pointsPerFace} landmarks for ${faces} faces, drew ${points}`);
  }
  return { faces, points };
}

// Search faces are labelled with the 1-based index of the matching target face, or "X".
function checkFaceMatches(target, search, expectedFaces) {
  checkFiniteGeometry(target, 'target face boxes or labels');
  checkFiniteGeometry(search, 'search face boxes or labels');
  const targetFaces = (target && target.strokeRect) || 0;
  const searchFaces = (search && search.strokeRect) || 0;
  const labels = (search && search.fillText) || [];
  if (targetFaces !== expectedFaces || searchFaces !== expectedFaces) {
    throw new Error(`Expected ${expectedFaces} target and search faces, detected ${targetFaces} and ${searchFaces}`);
  }
  if (labels.length !== searchFaces) throw new Error(`Drew ${searchFaces} search faces but ${labels.length} labels`);
  const matches = labels.map(label => (/^\d+$/.test(String(label).trim()) ? Number(label) : null));
  if (matches.some(m => m === null || m < 1 || m > targetFaces)) {
    throw new Error(`Not every face was recognized: ${labels.join(', ')}`);
  }
  if (new Set(matches).size !== matches.length) {
    throw new Error(`Several faces matched the same target: ${labels.join(', ')}`);
  }
  return matches;
}

// The first word sequence (1-4 words) that repeats back-to-back at least minRepeats times, or null.
function findRepeatedPhrase(text, maxWords = 4, minRepeats = 6) {
  const words = (text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  for (let n = 1; n <= maxWords; n++) {
    for (let i = 0; i + n * minRepeats <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      let repeats = 1;
      while (i + (repeats + 1) * n <= words.length &&
             words.slice(i + repeats * n, i + (repeats + 1) * n).join(' ') === phrase) {
        repeats++;
      }
      if (repeats >= minRepeats) return phrase;
    }
  }
  return null;
}

// LLM responses must be non-empty, not degenerate (e.g. "!!!!", "btbtbt", or "four four four"
// loops), and, when expectedAnswer is given, contain it.
function checkTextResponse(response, expectedAnswer = null) {
  const text = (response || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The model returned an empty response');
  const loop = /(.{1,4}?)\1{7,}/.exec(text);
  if (loop) throw new Error(`The model produced degenerate output ("${loop[0].slice(0, 40)}"): ${text.slice(0, 200)}`);
  const phrase = findRepeatedPhrase(text);
  if (phrase) throw new Error(`The model produced degenerate output (repeats "${phrase}"): ${text.slice(0, 200)}`);
  if (expectedAnswer && !expectedAnswer.test(text)) {
    throw new Error(`Expected an answer matching ${expectedAnswer}, got: ${text.slice(0, 200)}`);
  }
  return text;
}

// The graph's constants must include the selected data type; otherwise the sample silently ran
// another precision (e.g. a float16 selection building float32 weights).
function checkGraphDataType(constantTypes, expected) {
  const types = constantTypes || {};
  const summary = Object.entries(types).map(([type, count]) => `${type} x${count}`).join(', ') || 'none';
  if (!types[expected]) {
    throw new Error(`Selected ${expected} but the graph was built from ${summary} constants`);
  }
  return summary;
}

function checkImageStats(stats, name, minStd = 5) {
  if (!stats || !(stats.width > 0 && stats.height > 0)) throw new Error(`${name} is empty`);
  if (!(stats.std >= minStd)) {
    throw new Error(`${name} looks blank (luma std ${Number(stats.std).toFixed(2)} < ${minStd})`);
  }
  return stats;
}

function checkFraction(name, value, min, max) {
  if (!(value >= min && value <= max)) {
    throw new Error(`${name} ${(value * 100).toFixed(1)}% is outside ${(min * 100).toFixed(1)}%-${(max * 100).toFixed(1)}%`);
  }
  return value;
}

// SAM blends its mask over the whole image, so nearly every pixel changes. Require that change
// before trusting the recovered overlay: for identical screenshots the "overlay" is just the image.
function checkMaskOverlay(diff, { minChanged = 0.25, minArea = 0.01, maxArea = 0.95 } = {}) {
  if (!(diff && diff.changed >= minChanged)) {
    throw new Error(`No mask was rendered: only ${((diff && diff.changed || 0) * 100).toFixed(1)}% of pixels changed after the click (need ${(minChanged * 100).toFixed(0)}%)`);
  }
  return checkFraction('Segmented mask area', diff.overlay, minArea, maxArea);
}

// Best Pearson correlation of two RMS envelopes, allowing the second to lag by up to maxLag frames.
function envelopeCorrelation(a, b, maxLag = 5) {
  let best = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    const n = Math.min(a.length, b.length - lag);
    if (n < 2) break;
    let meanA = 0, meanB = 0;
    for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i + lag]; }
    meanA /= n; meanB /= n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - meanA, y = b[i + lag] - meanB;
      ab += x * y; aa += x * x; bb += y * y;
    }
    if (aa > 0 && bb > 0) best = Math.max(best, ab / Math.sqrt(aa * bb));
  }
  return best;
}

function checkDenoisedAudio(original, denoised, { minRmsRatio = 0.2, maxRmsRatio = 0.99, minCorrelation = 0.7 } = {}) {
  if (denoised.nonFinite > 0) throw new Error(`Denoised audio has ${denoised.nonFinite} non-finite samples`);
  if (Math.abs(denoised.duration - original.duration) > Math.max(1, original.duration * 0.1)) {
    throw new Error(`Denoised duration ${denoised.duration.toFixed(2)}s does not match the input ${original.duration.toFixed(2)}s`);
  }
  if (!(original.rms > 0)) throw new Error('Input audio is silent');
  const ratio = denoised.rms / original.rms;
  if (!(ratio >= minRmsRatio)) throw new Error(`Denoised audio is nearly silent (RMS ratio ${ratio.toFixed(3)})`);
  if (ratio > maxRmsRatio) throw new Error(`No noise was removed (RMS ratio ${ratio.toFixed(3)} > ${maxRmsRatio})`);
  const correlation = envelopeCorrelation(original.envelope, denoised.envelope);
  if (!(correlation >= minCorrelation)) {
    throw new Error(`Denoised audio no longer follows the input (envelope correlation ${correlation.toFixed(3)} < ${minCorrelation})`);
  }
  return { ratio, correlation };
}

/**
 * Verifies [WebNN:Perf] entries prove the work ran on WebNN with the requested device, so a
 * silent fallback to WASM/WebGPU fails. Requirements are names or { name, model, min }.
 */
function checkWebNNPerf(entries, device, requirements) {
  const label = `WebNN ${device.toUpperCase()}`;
  const failed = entries.find(e => e.error);
  if (failed) throw new Error(`${failed.name}${failed.model ? ` (${failed.model})` : ''} failed: ${failed.error}`);
  const wrong = entries.find(e => (e.provider && e.provider !== 'webnn') || (e.device && e.device !== device));
  if (wrong) {
    throw new Error(`Expected ${label} but ${wrong.name} ran on ${wrong.provider || '?'} ${wrong.device || '?'}`);
  }
  for (const requirement of requirements) {
    const { name, model, min = 1 } = typeof requirement === 'string' ? { name: requirement } : requirement;
    const count = entries.filter(e => e.name === name && (!model || e.model === model) &&
      e.provider === 'webnn' && e.device === device).length;
    if (count < min) {
      throw new Error(`Missing successful ${label} metric: ${name}${model ? ` (${model})` : ''}${min > 1 ? ` x${min}, got ${count}` : ''}`);
    }
  }
}

// --- In-page helpers (serialized into page.evaluate; must stay self-contained) ---

// Luma stats for screenshot `a`, plus how it differs from `b`: `changed` pixels, `brighter` pixels,
// and, when `a` is `b` with an overlay blended at `alpha`, the fraction where that overlay is non-black.
async function analyzeImagesInPage({ a, b, alpha }) {
  const load = async base64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    return img;
  };
  const pixels = (img, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const first = await load(a);
  const width = first.width, height = first.height, count = width * height;
  const p = pixels(first, width, height);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < p.length; i += 4) {
    const luma = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    sum += luma;
    sum2 += luma * luma;
  }
  const mean = sum / count;
  const result = { width, height, mean, std: Math.sqrt(Math.max(0, sum2 / count - mean * mean)) };
  if (b) {
    const q = pixels(await load(b), width, height);
    let changed = 0, brighter = 0, overlay = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) >= 24) changed++;
      const delta = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) -
        (0.299 * q[i] + 0.587 * q[i + 1] + 0.114 * q[i + 2]);
      if (delta >= 8) brighter++;
      if (alpha) {
        let strongest = 0;
        for (let c = 0; c < 3; c++) strongest = Math.max(strongest, (p[i + c] - (1 - alpha) * q[i + c]) / alpha);
        if (strongest >= 64) overlay++;
      }
    }
    result.changed = changed / count;
    result.brighter = brighter / count;
    if (alpha) result.overlay = overlay / count;
  }
  return result;
}

// Duration, RMS, and 20 ms RMS envelope of the original and denoised audio, resampled to 16 kHz.
async function analyzeDenoiseInPage() {
  const context = new OfflineAudioContext(1, 1, 16000);
  const decode = async url => {
    const audio = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const data = audio.getChannelData(0);
    const frame = 320;
    let sum = 0, nonFinite = 0;
    for (const value of data) {
      if (Number.isFinite(value)) sum += value * value;
      else nonFinite++;
    }
    const envelope = [];
    for (let i = 0; i + frame <= data.length; i += frame) {
      let energy = 0;
      for (let j = i; j < i + frame; j++) if (Number.isFinite(data[j])) energy += data[j] * data[j];
      envelope.push(Math.sqrt(energy / frame));
    }
    return { duration: audio.duration, rms: Math.sqrt(sum / data.length), nonFinite, envelope };
  };
  return {
    original: await decode(document.querySelector('#original-audio').src),
    denoised: await decode(document.querySelector('#denoised-audio').src)
  };
}

// Counts in-flight navigator.ml.createContext() calls (installed as an init script so calls made
// while the page loads are seen), letting the harness wait for a sample's asynchronous device
// handlers, such as preferred-layout queries, to finish.
function trackContextCreationInPage() {
  if (typeof navigator === 'undefined' || !navigator.ml || navigator.ml.__webnnTracked) return;
  navigator.ml.__webnnTracked = true;
  window.__webnnPendingContexts = 0;
  const create = navigator.ml.createContext;
  navigator.ml.createContext = function (...args) {
    window.__webnnPendingContexts++;
    let result;
    try {
      result = create.apply(this, args);
    } catch (e) {
      window.__webnnPendingContexts--;
      throw e;
    }
    return Promise.resolve(result).finally(() => { window.__webnnPendingContexts--; });
  };
}

// Pending context creations plus a fingerprint of the sample's selection controls.
function readSampleStateInPage() {
  const selector = '#deviceTypeBtns input, #backendBtns input, #dataTypeBtns input, #modelBtns input, ' +
    '#resolutionType input, #fdModelBtns input';
  const controls = [...document.querySelectorAll(selector)].map(input => {
    const label = input.closest('label') || input;
    const disabled = input.disabled || label.classList.contains('disabled') || label.hasAttribute('disabled');
    return `${input.id}:${input.checked ? 1 : 0}${disabled ? 'd' : ''}${label.offsetParent ? 'v' : 'h'}`;
  }).join(',');
  return { pending: window.__webnnPendingContexts || 0, controls };
}

// Records 2D canvas annotations per canvas id. A drawImage starts a new frame, so only the
// latest frame's boxes, labels, and keypoints are kept. Calls with non-finite geometry (which
// canvas silently ignores) are counted as `invalid` instead of as drawn.
function installCanvasCaptureInPage() {
  window.__webnnCanvasCalls = {};
  const proto = CanvasRenderingContext2D.prototype;
  if (proto.__webnnCaptured) return;
  proto.__webnnCaptured = true;
  const drawImage = proto.drawImage;
  proto.drawImage = function (...args) {
    if (this.canvas && this.canvas.id && window.__webnnCanvasCalls) delete window.__webnnCanvasCalls[this.canvas.id];
    return drawImage.apply(this, args);
  };
  // Numeric arguments that must be finite for the call to draw anything.
  const geometry = { strokeRect: [0, 1, 2, 3], arc: [0, 1, 2, 3, 4], fillText: [1, 2] };
  for (const fn of Object.keys(geometry)) {
    const original = proto[fn];
    proto[fn] = function (...args) {
      const id = this.canvas && this.canvas.id;
      if (id && window.__webnnCanvasCalls) {
        const calls = window.__webnnCanvasCalls[id] = window.__webnnCanvasCalls[id] ||
          { strokeRect: 0, arc: 0, fillText: [], invalid: 0 };
        if (!geometry[fn].every(i => Number.isFinite(Number(args[i])))) calls.invalid++;
        else if (fn === 'fillText') calls.fillText.push(String(args[0]));
        else calls[fn]++;
      }
      return original.apply(this, args);
    };
  }
}

const STYLE_VARIANTS = {
  'starry-night': 'The Starry Night',
  'self-portrait': 'Self-Portrait',
  'bedroom': 'The Bedroom',
  'sunflowers-bew': 'Sunflowers',
  'red-vineyards': 'The Red Vineyards',
  'sien-with-a-cigar': 'Sien with a Cigar',
  'la-campesinos': 'La Campesinos',
  'soup-distribution': 'Soup Distribution',
  'wheatfield_with_crows': 'Wheatfield with Crows'
};

// Counts the data types of the constants (weights) every WebNN graph is built from, so a sample
// that ignores its data type selection is caught. Handles constant(descriptor, buffer) and the
// scalar constant(type, value) overload.
function installGraphCaptureInPage() {
  window.__webnnConstantTypes = {};
  if (typeof MLGraphBuilder === 'undefined' || MLGraphBuilder.prototype.__webnnCaptured) return;
  MLGraphBuilder.prototype.__webnnCaptured = true;
  const constant = MLGraphBuilder.prototype.constant;
  MLGraphBuilder.prototype.constant = function (...args) {
    const first = args[0];
    const type = typeof first === 'string' ? first : first && (first.dataType || first.type);
    if (type && window.__webnnConstantTypes) {
      window.__webnnConstantTypes[type] = (window.__webnnConstantTypes[type] || 0) + 1;
    }
    return constant.apply(this, args);
  };
}

class ModelRunner extends WebNNRunner {
  constructor(page) {
    super(page);
    // Each case: name, url, type, devices, optional variants/defaultVariant/optIn/timeoutMs, and runner func.
    // See README "Adding a sample" and expandModelCases() for the selection rules.
    this.models = {
      // webnn-samples
      'lenet': {
        name: 'LeNet Digit Recognition',
        url: `${SAMPLES_URL}lenet/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        func: this.runModelLenet
      },
      'segmentation': {
        name: 'Semantic Segmentation (DeepLab V3 MobileNet V2)',
        url: `${SAMPLES_URL}semantic_segmentation/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        func: this.runModelSemanticSegmentation
      },
      'style': {
        name: 'Fast Style Transfer',
        url: `${SAMPLES_URL}style_transfer/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        variants: Object.fromEntries(Object.entries(STYLE_VARIANTS).map(([id, label]) => [id, { label }])),
        defaultVariant: 'starry-night',
        func: this.runModelStyleTransfer
      },
      'od': {
        name: 'Object Detection',
        url: `${SAMPLES_URL}object_detection/`,
        type: 'sample',
        devices: ALL_DEVICES,
        // NPU only offers float16.
        variants: {
          'tinyyolov2-fp32': { label: 'Tiny YOLO V2 / float32', model: 'tinyyolov2', dataType: 'float32', devices: ['cpu', 'gpu'] },
          'tinyyolov2-fp16': { label: 'Tiny YOLO V2 / float16', model: 'tinyyolov2', dataType: 'float16' },
          'ssdmobilenetv1-fp32': { label: 'SSD MobileNet V1 / float32', model: 'ssdmobilenetv1', dataType: 'float32', devices: ['cpu', 'gpu'] },
          'ssdmobilenetv1-fp16': { label: 'SSD MobileNet V1 / float16', model: 'ssdmobilenetv1', dataType: 'float16' }
        },
        defaultVariant: { default: 'tinyyolov2-fp32', npu: 'tinyyolov2-fp16' },
        expectedLabel: 'person',
        func: this.runModelObjectDetection
      },
      'ic-sample': {
        name: 'Image Classification',
        url: `${SAMPLES_URL}image_classification/`,
        type: 'sample',
        devices: ALL_DEVICES,
        variants: {
          'mobilenet-fp32': { label: 'MobileNet V2 / float32', model: 'mobilenet', dataType: 'float32', devices: ['cpu', 'gpu'] },
          'mobilenet-fp16': { label: 'MobileNet V2 / float16', model: 'mobilenet', dataType: 'float16' },
          'mobilenet-uint8': { label: 'MobileNet V2 / uint8', model: 'mobilenet', dataType: 'uint8', devices: ['cpu', 'gpu'] },
          'squeezenet-fp32': { label: 'SqueezeNet / float32', model: 'squeezenet', dataType: 'float32', devices: ['cpu', 'gpu'] },
          // No squeezenet-fp16: the sample builds SqueezeNet without the selected data type (always float32).
          'resnet50v2-fp32': { label: 'ResNet50 V2 / float32', model: 'resnet50v2', dataType: 'float32', devices: ['cpu', 'gpu'] },
          'resnet50v2-fp16': { label: 'ResNet50 V2 / float16', model: 'resnet50v2', dataType: 'float16' },
          'resnet50v1-fp16': { label: 'ResNet50 V1 / float16', model: 'resnet50v1', dataType: 'float16' },
          'efficientnet-fp16': { label: 'EfficientNet / float16', model: 'efficientnet', dataType: 'float16' }
        },
        defaultVariant: { default: 'mobilenet-fp32', npu: 'mobilenet-fp16' },
        expectedLabel: 'lesser panda',
        func: this.runSampleImageClassification
      },
      'nsnet2': {
        name: 'Noise Suppression (NSNet2)',
        url: `${SAMPLES_URL}nsnet2/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        audioId: 'babble',
        func: this.runSampleDenoiser
      },
      'rnnoise': {
        name: 'Noise Suppression (RNNoise)',
        url: `${SAMPLES_URL}rnnoise/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        audioId: 'voice1',
        // The WASM pre/post-processing runtime must be ready before denoising.
        readyConsole: 'WASM Runtime Ready.',
        func: this.runSampleDenoiser
      },
      'selfie': {
        name: 'Selfie Segmentation',
        url: `${SAMPLES_URL}selfie_segmentation/`,
        type: 'sample',
        devices: ALL_DEVICES,
        variants: {
          'general-fp16': { label: 'General 256x256 / float16', resolution: 'general', dataType: 'float16' },
          'general-fp32': { label: 'General 256x256 / float32', resolution: 'general', dataType: 'float32' },
          'landscape-fp16': { label: 'Landscape 256x144 / float16', resolution: 'landscape', dataType: 'float16' },
          'landscape-fp32': { label: 'Landscape 256x144 / float32', resolution: 'landscape', dataType: 'float32' }
        },
        defaultVariant: 'general-fp16',
        func: this.runSampleSelfieSegmentation
      },
      'fld': {
        name: 'Facial Landmark Detection',
        url: `${SAMPLES_URL}facial_landmark_detection/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        expectedFaces: 2,
        func: this.runSampleFacialLandmarks
      },
      'fr': {
        name: 'Face Recognition',
        url: `${SAMPLES_URL}face_recognition/`,
        type: 'sample',
        devices: ['cpu', 'gpu'],
        expectedFaces: 4,
        func: this.runSampleFaceRecognition
      },
      // WebNN Developer Preview
      'ic': {
        name: 'WebNN Developer Preview Image Classification',
        url: `${PREVIEW_URL}image-classification/`,
        type: 'preview',
        devices: ALL_DEVICES,
        variants: {
          'mobilenet-v2': { label: 'MobileNet V2' },
          'resnet-50': { label: 'ResNet-50' },
          'efficientnet-lite4': { label: 'EfficientNet Lite4' }
        },
        defaultVariant: 'resnet-50',
        expectedLabel: 'tiger',
        func: this.runModelImageClassification
      },
      'sam': {
        name: 'WebNN Developer Preview Segment Anything',
        url: `${PREVIEW_URL}segment-anything/`,
        type: 'preview',
        devices: ALL_DEVICES,
        variants: {
          'sam_b': { label: 'ViT-B float16' },
          'sam_b_int8': { label: 'ViT-B int8' }
        },
        defaultVariant: 'sam_b',
        func: this.runModelSam
      },
      'whisper': {
        name: 'WebNN Developer Preview Whisper Base',
        url: `${PREVIEW_URL}whisper-base/`,
        type: 'preview',
        devices: ALL_DEVICES,
        variants: {
          'float16': { label: 'float16' },
          'float32': { label: 'float32' }
        },
        defaultVariant: 'float16',
        func: this.runModelWhisper
      },
      'stem': {
        name: 'WebNN Developer Preview Stem Separator',
        url: `${PREVIEW_URL}stem-separator/`,
        type: 'preview',
        // The sample has no WebNN CPU option; never substitute WASM or its auto cascade.
        devices: ['gpu', 'npu'],
        func: this.runModelStemSeparator
      },
      'sdxl': {
        name: 'WebNN Developer Preview SDXL Turbo',
        url: `${PREVIEW_URL}sdxl-turbo/`,
        type: 'preview',
        // Upstream disables NPU and links only the GPU demo.
        devices: ['gpu'],
        timeoutMs: 45 * MINUTE,
        func: this.runModelSdxl
      },
      'sd15': {
        name: 'WebNN Developer Preview Stable Diffusion 1.5',
        url: `${PREVIEW_URL}stable-diffusion-1.5/`,
        type: 'preview',
        devices: ['gpu', 'npu'],
        timeoutMs: 60 * MINUTE,
        func: this.runModelStableDiffusion15
      },
      'sdturbo': {
        name: 'WebNN Developer Preview SD-Turbo',
        url: `${PREVIEW_URL}sd-turbo/`,
        type: 'preview',
        devices: ['gpu', 'npu'],
        timeoutMs: 60 * MINUTE,
        func: this.runModelSdTurbo
      },
      'phi': {
        name: 'WebNN Developer Preview Text Generation',
        url: `${PREVIEW_URL}text-generation/`,
        type: 'preview',
        devices: ALL_DEVICES,
        variants: {
          'phi4mini': { label: 'Phi-4 Mini' },
          'tinyllama': { label: 'TinyLlama 1.1B' },
          // Too small to answer reliably; only checked for a coherent, non-degenerate response.
          'qwen2': { label: 'Qwen2 0.5B', expectAnswer: false },
          'deepseekr1': { label: 'DeepSeek R1 Distill Qwen 1.5B' }
        },
        defaultVariant: 'phi4mini',
        timeoutMs: 30 * MINUTE,
        func: this.runModelPhi
      },
      'zimage': {
        name: 'WebNN Developer Preview Z-Image-Turbo',
        url: `${PREVIEW_URL}z-image-turbo/`,
        type: 'preview',
        // Work in progress upstream (not linked from the index, NPU unsupported): run only by name.
        optIn: true,
        devices: ['gpu'],
        variants: {
          '512': { label: '512x512' },
          '1024': { label: '1024x1024' }
        },
        defaultVariant: '512',
        timeoutMs: 90 * MINUTE,
        func: this.runModelZImageTurbo
      }
    };
  }

  async runModelTests(onFirstCaseComplete) {
    console.log('[Info] Running MODEL suite...');

    const device = currentDevice();
    const filter = process.env.MODEL_CASE || '';
    const variantMode = (process.env.MODEL_VARIANTS || 'default').toLowerCase();
    console.log(filter ? `Running specific model cases: ${filter}` : 'Running all model test cases');
    console.log(`[Info] Model variants: ${variantMode}`);

    const items = expandModelCases(this.models, { filter, variantMode, device });
    const results = [];
    let runtimeChecked = false;

    for (const item of items) {
      if (item.error) {
        console.warn(`[Warning] ${item.error}`);
        results.push({
          testName: `Model: ${item.key}`,
          result: 'ERROR',
          hasErrors: true,
          fullText: item.error,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'model'
        });
        continue;
      }

      const caseDef = item.caseDef;
      if (item.skipReason) {
        console.log(`[Skip] ${caseDef.name}: ${item.skipReason}`);
        results.push(skipResult(caseDef, item.skipReason));
        continue;
      }

      const startTime = Date.now();
      const resultsBefore = results.length;
      const caseResults = [];
      let infinityErrorDetected = false;
      let stopDiagnostics = () => {};
      const diagnostics = [];
      const remember = text => {
        diagnostics.push(String(text).slice(0, 1000));
        if (diagnostics.length > 10) diagnostics.shift();
      };
      // --model-timeout (MODEL_TIMEOUT, seconds) overrides each case's own watchdog.
      const modelTimeoutSec = Number(process.env.MODEL_TIMEOUT);
      const timeoutMs = modelTimeoutSec > 0 ? modelTimeoutSec * 1000 : (caseDef.timeoutMs || DEFAULT_CASE_TIMEOUT);

      try {
        await this.runTestWithSessionCheck(async () => {
             const casePage = this.page;
             const caseRunner = Object.create(this);
             caseRunner.page = casePage;
             // Setup console listener for infinity checks (common in preview)
             const consoleListener = async (msg) => {
                if (msg.type() === 'error') remember(`Console: ${msg.text()}`);
                if (msg.text().includes('Found infinity in logits')) {
                  console.error(`[Fail] [Auto-Fail] "Found infinity in logits" detected. Quitting case...`);
                  infinityErrorDetected = true;
                  try { await casePage.close(); } catch (e) {}
                }
             };
             const pageErrorListener = error => remember(`Page error: ${error.message}`);
             const requestFailedListener = request => remember(`Request failed: ${request.url()} (${request.failure()?.errorText || 'unknown error'})`);
             const responseListener = response => {
               if (response.status() >= 400) remember(`HTTP ${response.status()}: ${response.url()}`);
             };
             casePage.on('console', consoleListener);
             casePage.on('pageerror', pageErrorListener);
             casePage.on('requestfailed', requestFailedListener);
             casePage.on('response', responseListener);

             stopDiagnostics = () => {
                casePage.off('console', consoleListener);
                casePage.off('pageerror', pageErrorListener);
                casePage.off('requestfailed', requestFailedListener);
                casePage.off('response', responseListener);
             };
             await caseDef.func.call(caseRunner, caseResults, caseDef, caseDef.variant);
        }, true, { timeoutMs });
        for (const result of caseResults) {
          if (!['PASS', 'SKIP'].includes(result.result) || result.hasErrors || result.subcases?.failed > 0) {
            result.fullText = [
              result.fullText || result.details || `Model case returned ${result.result}`,
              ...diagnostics
            ].join('\n');
            result.hasErrors = true;
          }
        }
        results.push(...caseResults);
      } catch (error) {
        if (infinityErrorDetected) {
            error.message = "Found infinity in logits";
        }

        console.error(`[Fail] Error running model case ${caseDef.name}:`, error.message);

        const fullText = [error.message, ...diagnostics].join('\n');
        results.push({
          testName: caseDef.name,
          testUrl: caseDef.url,
          result: 'ERROR',
          errors: [{ text: fullText }],
          fullText,
          hasErrors: true,
          subcases: { total: 1, passed: 0, failed: 1 },
          suite: 'model'
        });
      } finally {
        stopDiagnostics();
      }

      // Add execution time to the result this case produced
      if (results.length > resultsBefore) {
        const lastRes = results[results.length - 1];
        if (!lastRes.executionTime) {
            lastRes.executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
        }
      }

      // A skipped case never loads ORT, so inspect modules after the first case that ran.
      if (!runtimeChecked && results[results.length - 1]?.result !== 'SKIP' && onFirstCaseComplete) {
          runtimeChecked = true;
          await onFirstCaseComplete();
      }

      // Pause between tests and navigate away to release WebNN resources
      if (!this.page.isClosed()) {
         try { await this.page.goto('about:blank', { waitUntil: 'load', timeout: 5000 }); } catch(e) {}
         try { await this.page.waitForTimeout(2000); } catch(e) {}
      } else {
         // Page/browser crashed during the test — ensure recovery before next test
         console.log('[Info] Page closed after test, ensuring browser is available for next test...');
         try { await this.ensurePage(); } catch(e) {
           console.log('[Warning] Could not recover page, will try restartBrowserAndContext...');
           try {
             const instance = await this.restartBrowserAndContext(null);
             this.page = instance.page;
           } catch(e2) {
             console.error(`[Error] Browser recovery failed: ${e2.message}`);
           }
         }
      }
    }

    return results;
  }

  // --- Shared helpers ---

  async openSample(url) {
    await this.ensureContextTracking();
    console.log(`Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 2 * MINUTE });
    // Samples select a default device on load; let that initialization settle before overriding it.
    await this.waitForSampleIdle();
  }

  async ensureContextTracking() {
    this.trackedPages = this.trackedPages || new WeakSet();
    if (this.trackedPages.has(this.page)) return;
    await this.page.addInitScript(trackContextCreationInPage);
    this.trackedPages.add(this.page);
  }

  // Waits until no WebNN context creation is pending and the sample's selection controls have not
  // changed for quietMs, so asynchronous device handlers cannot override later selections.
  async waitForSampleIdle({ timeout = MINUTE, quietMs = 500, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const state = await this.page.evaluate(readSampleStateInPage);
      if (last === null || state.controls !== last.controls || state.pending !== last.pending) {
        last = state;
        stableSince = Date.now();
      } else if (state.pending === 0 && Date.now() - stableSince >= quietMs) {
        return;
      }
      await this.page.waitForTimeout(interval);
    }
    throw new Error(`Sample controls did not settle within ${timeout / 1000}s (${last && last.pending} context creations pending)`);
  }

  // Radio options are hidden inputs inside Bootstrap toggle labels.
  async clickSampleOption(id) {
    const selector = `[id="${id}"]`;
    const label = this.page.locator(`label:has(> ${selector})`).first();
    if (await label.count() > 0) {
      await label.click();
    } else {
      await this.page.locator(selector).first().click();
    }
  }

  async sampleOptionAvailable(id) {
    return this.page.evaluate(optionId => {
      const input = document.getElementById(optionId);
      if (!input) return false;
      const label = input.closest('label') || input;
      return !!label.offsetParent && !input.disabled &&
        !label.classList.contains('disabled') && !label.hasAttribute('disabled');
    }, id);
  }

  // Pushes a SKIP result when the sample hides or disables an option for this device/layout.
  async skipIfUnavailable(results, caseDef, id, description) {
    if (await this.sampleOptionAvailable(id)) return false;
    const reason = `The sample does not offer ${description}`;
    console.log(`[Skip] ${caseDef.name}: ${reason}`);
    results.push(skipResult(caseDef, reason));
    return true;
  }

  // scheme 'type': #cpu/#gpu/#npu; scheme 'backend': #webnn_cpu/#webnn_gpu.
  async selectSampleDevice(scheme, device) {
    const id = scheme === 'backend' ? `webnn_${device}` : device;
    if (!(await this.sampleOptionAvailable(id))) {
      throw new Error(`The sample does not offer WebNN ${device.toUpperCase()} (#${id})`);
    }
    await this.clickSampleOption(id);
    await this.waitForSampleIdle();
  }

  // Selects a data type once the device handler has settled, and waits for the UI to apply it.
  async selectSampleDataType(dataType) {
    await this.clickSampleOption(dataType);
    await this.waitForSampleIdle();
    if (!(await this.page.evaluate(id => document.getElementById(id)?.checked, dataType))) {
      throw new Error(`The sample did not keep the ${dataType} selection`);
    }
  }

  async resetSampleResult() {
    await this.page.evaluate(() => {
      for (const id of ['loadTime', 'buildTime', 'computeTime']) {
        const element = document.getElementById(id);
        if (element) element.innerText = '';
      }
    });
  }

  async readSampleTimes() {
    return this.page.evaluate(() => {
      const text = id => (document.getElementById(id)?.innerText || '').trim() || 'N/A';
      return { load: text('loadTime'), build: text('buildTime'), compute: text('computeTime') };
    });
  }

  // Waits until the sample shows a fresh compute time with the progress UI hidden; fails on alerts.
  async waitForSampleResult(timeout = 5 * MINUTE) {
    const handle = await this.page.waitForFunction(alertSelector => {
      const alert = document.querySelector(alertSelector);
      if (alert) return { error: alert.innerText.trim() };
      const compute = document.getElementById('computeTime')?.innerText || '';
      const progress = document.getElementById('progressmodel');
      const busy = progress && getComputedStyle(progress).display !== 'none';
      return /\d/.test(compute) && !busy ? { compute } : null;
    }, SAMPLE_ALERT, { timeout, polling: 250 });
    const state = await handle.jsonValue();
    if (state.error) throw new Error(`Sample error: ${state.error}`);
    return this.readSampleTimes();
  }

  async sampleAlert() {
    return this.page.evaluate(selector => document.querySelector(selector)?.innerText.trim() || null, SAMPLE_ALERT);
  }

  async installCanvasCapture() {
    await this.page.evaluate(installCanvasCaptureInPage);
  }

  async installGraphCapture() {
    await this.page.evaluate(installGraphCaptureInPage);
  }

  // Verifies the sample built its graph with the variant's data type; returns a summary for details.
  async verifyGraphDataType(dataType) {
    return checkGraphDataType(await this.page.evaluate(() => window.__webnnConstantTypes), dataType);
  }

  async readCanvasCalls() {
    return this.page.evaluate(() => window.__webnnCanvasCalls || {});
  }

  async screenshot(selector) {
    const png = await this.page.locator(selector).first().screenshot({ timeout: 30000 });
    return png.toString('base64');
  }

  async imageStats(selector) {
    return this.page.evaluate(analyzeImagesInPage, { a: await this.screenshot(selector) });
  }

  async imageDiff(a, b, options = {}) {
    return this.page.evaluate(analyzeImagesInPage, { a, b, ...options });
  }

  // Fails fast on WebNN/ORT console errors and failed perf entries; call check() inside polling loops
  // and dispose() when done.
  watchConsoleErrors(tag, patterns = LOAD_ERROR_PATTERNS, perfCollector = null) {
    const watcher = { error: null };
    const page = this.page;
    const listener = msg => {
      if (msg.type() !== 'error' || watcher.error) return;
      const lower = msg.text().toLowerCase();
      if (patterns.some(pattern => lower.includes(pattern))) {
        watcher.error = msg.text();
        console.log(`[${tag}] Detected error: ${msg.text()}`);
      }
    };
    page.on('console', listener);
    watcher.check = (what = 'Model load') => {
      if (watcher.error) throw new Error(`${what} failed: ${watcher.error}`);
      const failed = perfCollector && perfCollector.getEntries().find(e => e.error);
      if (failed) throw new Error(`${what} failed: ${failed.name}${failed.model ? ` (${failed.model})` : ''}: ${failed.error}`);
    };
    watcher.dispose = () => {
      try { page.removeListener('console', listener); } catch (e) {}
    };
    return watcher;
  }

  // Lines the preview demos log as failures in their #log panel.
  async previewLogErrors() {
    return this.page.evaluate(() => (document.querySelector('#log')?.innerText || '')
      .split('\n').filter(line => line.includes('[Error]') || line.includes('failed, ')));
  }

  // Polls fn until it returns a truthy value; onTick may throw to abort early.
  async pollUntil(fn, { timeout, interval = 500, onTick = null }) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (onTick) await onTick();
      const value = await fn();
      if (value) return value;
      await this.page.waitForTimeout(interval);
    }
    if (onTick) await onTick();
    return null;
  }

  // Asserts the collected perf entries ran on WebNN with the requested device; returns the summary.
  checkPerf(perfCollector, device, requirements, tag) {
    checkWebNNPerf(perfCollector.getEntries(), device, requirements);
    const perfSummary = perfCollector.toCompactString();
    if (perfSummary) console.log(`[WebNN:Perf] ${tag} metrics: ${perfSummary}`);
    return { perfMetrics: perfCollector.getSummary(), perfSummary };
  }

  // --- webnn-samples ---

  async runModelLenet(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);

    // The sample draws a random MNIST digit; pin Math.random so the expected class is known.
    const predictions = [];
    let times = null;
    for (const [index, digit] of [3, 7].entries()) {
      await this.page.evaluate(d => {
        Math.random = () => (d + 0.5) / 10;
        for (const id of ['label0', 'prob0']) {
          const element = document.getElementById(id);
          if (element) element.innerText = '';
        }
      }, digit);
      if (index === 0) {
        await this.selectSampleDevice('backend', device);
      } else {
        await this.page.locator('#next').click();
      }
      await expect(this.page.locator('#predict')).toBeEnabled({ timeout: 2 * MINUTE });
      await this.page.waitForTimeout(500);
      await this.page.locator('#predict').click();
      const handle = await this.page.waitForFunction(alertSelector => {
        const alert = document.querySelector(alertSelector);
        if (alert) return { error: alert.innerText.trim() };
        const label = document.getElementById('label0')?.innerText.trim();
        return label ? {
          label,
          prob: document.getElementById('prob0')?.innerText.trim(),
          build: document.getElementById('buildTime')?.innerText.trim(),
          inference: document.getElementById('inferenceTime')?.innerText.trim()
        } : null;
      }, SAMPLE_ALERT, { timeout: MINUTE, polling: 250 });
      const prediction = await handle.jsonValue();
      if (prediction.error) throw new Error(`Sample error: ${prediction.error}`);
      if (prediction.label !== String(digit)) {
        throw new Error(`Expected digit ${digit} but LeNet predicted "${prediction.label}" (${prediction.prob})`);
      }
      checkTopLabel(prediction.label, prediction.prob, String(digit));
      predictions.push(`${digit} (${prediction.prob})`);
      times = prediction;
    }

    console.log(`Got LeNet predictions: ${predictions.join(', ')}`);
    results.push(passResult(caseDef, caseDef.url,
      `Predicted digits ${predictions.join(', ')}. ${times.build}, ${times.inference}`,
      { subcases: { total: 2, passed: 2, failed: 0 } }));
  }

  async runModelSemanticSegmentation(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('backend', device);
    await this.resetSampleResult();
    await this.clickSampleOption('deeplabv3mnv2');
    const times = await this.waitForSampleResult();
    await this.page.waitForTimeout(500);

    // The renderer lists every class present in the segmentation map.
    const classes = await this.page.evaluate(() => [...document.querySelectorAll('.labels-wrapper .seg-label')]
      .map(element => element.innerText.replace('\u2b24', '').trim()));
    if (!classes.includes('person')) {
      throw new Error(`Expected a "person" segment, got: ${classes.join(', ') || '(none)'}`);
    }
    checkImageStats(await this.imageStats('#outputCanvas'), 'Segmentation output');

    console.log(`Got Semantic Segmentation classes: ${classes.join(', ')}`);
    results.push(passResult(caseDef, caseDef.url,
      `Classes: ${classes.join(', ')}. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runModelStyleTransfer(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    // With no backend chosen the sample only records the clicked style, so selecting the backend
    // afterwards builds just that style; the sample logs "- Model ID: <style> -" for each build.
    await this.page.locator(`[id="${caseDef.variantId}"]`).click();
    const builds = [];
    const buildListener = msg => {
      const match = /- Model ID: (\S+) -/.exec(msg.text());
      if (match) builds.push(match[1]);
    };
    this.page.on('console', buildListener);
    let times;
    try {
      await this.resetSampleResult();
      await this.selectSampleDevice('backend', device);
      times = await this.waitForSampleResult();
    } finally {
      this.page.removeListener('console', buildListener);
    }
    checkStyleBuilds(builds, caseDef.variantId);
    await this.page.waitForTimeout(500);

    const input = await this.screenshot('#inputCanvas');
    const output = await this.screenshot('#outputCanvas');
    const diff = await this.imageDiff(output, input);
    checkImageStats(diff, 'Stylized output');
    checkFraction('Pixels changed by the style', diff.changed, 0.2, 1);

    results.push(passResult(caseDef, caseDef.url,
      `${(diff.changed * 100).toFixed(1)}% of pixels restyled. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runModelObjectDetection(results, caseDef, variant) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('type', device);
    if (await this.skipIfUnavailable(results, caseDef, variant.dataType, `${variant.dataType} on WebNN ${device.toUpperCase()}`)) return;
    await this.selectSampleDataType(variant.dataType);
    if (await this.skipIfUnavailable(results, caseDef, variant.model, `${variant.label} for this device's layout`)) return;

    await this.installCanvasCapture();
    await this.installGraphCapture();
    await this.resetSampleResult();
    await this.clickSampleOption(variant.model);
    const times = await this.waitForSampleResult();
    await this.page.waitForTimeout(500);
    const constants = await this.verifyGraphDataType(variant.dataType);

    const calls = (await this.readCanvasCalls()).outputCanvas;
    const detections = checkDetections(calls, caseDef.expectedLabel);
    const summary = detections.map(d => `${d.label} ${d.score.toFixed(2)}`).join(', ');
    console.log(`Got detections: ${summary}`);
    results.push(passResult(caseDef, caseDef.url,
      `Detections: ${summary}. Graph constants: ${constants}. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runSampleImageClassification(results, caseDef, variant) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('type', device);
    if (await this.skipIfUnavailable(results, caseDef, variant.dataType, `${variant.dataType} on WebNN ${device.toUpperCase()}`)) return;
    await this.selectSampleDataType(variant.dataType);
    // Models are shown only for the data types and layout the device supports.
    if (await this.skipIfUnavailable(results, caseDef, variant.model, `${variant.label} for this device's layout`)) return;

    await this.installGraphCapture();
    await this.resetSampleResult();
    await this.clickSampleOption(variant.model);
    const times = await this.waitForSampleResult();
    const constants = await this.verifyGraphDataType(variant.dataType);
    const top = await this.page.evaluate(() => ({
      label: document.getElementById('label0')?.innerText.trim(),
      prob: document.getElementById('prob0')?.innerText.trim()
    }));
    checkTopLabel(top.label, top.prob, caseDef.expectedLabel);

    console.log(`Got top-1: ${top.label} (${top.prob})`);
    results.push(passResult(caseDef, caseDef.url,
      `Top-1: ${top.label} (${top.prob}). Graph constants: ${constants}. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runSampleDenoiser(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    const runtimeReady = caseDef.readyConsole ? this.page.waitForEvent('console', {
      predicate: msg => msg.text().includes(caseDef.readyConsole),
      timeout: 2 * MINUTE
    }) : null;
    // Awaited below; keep it from becoming an unhandled rejection if navigation fails first.
    if (runtimeReady) runtimeReady.catch(() => {});
    await this.openSample(caseDef.url);
    if (runtimeReady) await runtimeReady;

    const waitForModelReady = async () => {
      const ready = await (await this.page.waitForFunction(alertSelector => {
        const alert = document.querySelector(alertSelector);
        if (alert) return { error: alert.innerText.trim() };
        const info = document.getElementById('info')?.innerText || '';
        return /is ready/i.test(info) ? { info } : null;
      }, SAMPLE_ALERT, { timeout: 3 * MINUTE, polling: 250 })).jsonValue();
      if (ready.error) throw new Error(`Sample error: ${ready.error}`);
    };
    // The page may auto-select WebNN CPU on load and build that model; let it finish first so its
    // "ready" status cannot be mistaken for the requested backend's.
    const backendId = `webnn_${device}`;
    const selected = await this.page.evaluate(() => document.querySelector('#backendBtns input:checked')?.id || null);
    if (selected) await waitForModelReady();
    if (selected !== backendId) {
      await this.page.evaluate(() => {
        const info = document.getElementById('info');
        if (info) info.innerHTML = '';
      });
      await this.selectSampleDevice('backend', device);
      await waitForModelReady();
    }

    await this.page.locator('#choose-audio').click();
    await this.page.locator(`[id="${caseDef.audioId}"]`).click();
    const done = await (await this.page.waitForFunction(alertSelector => {
      const alert = document.querySelector(alertSelector);
      if (alert) return { error: alert.innerText.trim() };
      const info = document.getElementById('denoise-info')?.innerText || '';
      const src = document.getElementById('denoised-audio')?.src || '';
      return src.startsWith('blob:') && /Done\./.test(info) ? { info } : null;
    }, SAMPLE_ALERT, { timeout: 5 * MINUTE, polling: 250 })).jsonValue();
    if (done.error) throw new Error(`Sample error: ${done.error}`);

    const { original, denoised } = await this.page.evaluate(analyzeDenoiseInPage);
    const { ratio, correlation } = checkDenoisedAudio(original, denoised);
    const timing = (done.info.match(/Done\.[^\n]*/) || [''])[0].trim();
    console.log(`[Denoise] RMS ratio ${ratio.toFixed(3)}, envelope correlation ${correlation.toFixed(3)}`);
    results.push(passResult(caseDef, caseDef.url,
      `Denoised ${caseDef.audioId}: ${denoised.duration.toFixed(2)}s, RMS ratio ${ratio.toFixed(3)}, envelope correlation ${correlation.toFixed(3)}. ${timing}`));
  }

  async runSampleSelfieSegmentation(results, caseDef, variant) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('type', device);
    if (await this.skipIfUnavailable(results, caseDef, variant.dataType, `${variant.dataType} on WebNN ${device.toUpperCase()}`)) return;
    await this.selectSampleDataType(variant.dataType);

    // Inference starts only once a resolution type is chosen.
    await this.installGraphCapture();
    await this.resetSampleResult();
    await this.clickSampleOption(variant.resolution);
    const times = await this.waitForSampleResult();
    await this.page.waitForTimeout(1000);
    const constants = await this.verifyGraphDataType(variant.dataType);

    // Swapping the background re-renders the same mask: unchanged pixels are the person.
    const first = await this.screenshot('#outputCanvas');
    await this.page.locator('[id="01-img"]').click();
    await this.page.waitForTimeout(1500);
    const second = await this.screenshot('#outputCanvas');
    const diff = await this.imageDiff(first, second);
    checkImageStats(diff, 'Segmentation output');
    const foreground = checkFraction('Foreground', 1 - diff.changed, 0.05, 0.9);

    results.push(passResult(caseDef, caseDef.url,
      `Foreground ${(foreground * 100).toFixed(1)}%. Graph constants: ${constants}. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runSampleFacialLandmarks(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('backend', device);
    await this.installCanvasCapture();
    await this.resetSampleResult();
    // Selecting the face detector starts the detect -> landmark pipeline.
    await this.clickSampleOption('ssdmobilenetv2face');
    const times = await this.waitForSampleResult();
    await this.page.waitForTimeout(500);

    const { faces, points } = checkFaceLandmarks((await this.readCanvasCalls()).outputCanvas, caseDef.expectedFaces);
    results.push(passResult(caseDef, caseDef.url,
      `${faces} faces, ${points} landmarks. Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  async runSampleFaceRecognition(results, caseDef) {
    const device = currentDevice();
    console.log(`Running sample test: ${caseDef.name} on ${device.toUpperCase()}`);
    await this.openSample(caseDef.url);
    await this.selectSampleDevice('backend', device);
    await this.installCanvasCapture();
    await this.resetSampleResult();
    await this.clickSampleOption('ssdmobilenetv2face');
    const times = await this.waitForSampleResult();
    await this.page.waitForTimeout(1000);

    const calls = await this.readCanvasCalls();
    const matches = checkFaceMatches(calls.targetCanvasShow, calls.searchCanvasShow, caseDef.expectedFaces);
    results.push(passResult(caseDef, caseDef.url,
      `Recognized ${matches.length}/${caseDef.expectedFaces} faces (matches ${matches.join(', ')}). Load: ${times.load}, Build: ${times.build}, Inference: ${times.compute}`));
  }

  // --- WebNN Developer Preview ---

  async runModelImageClassification(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}&model=${caseDef.variantId}&run=5`;
    const perfCollector = new WebNNPerfCollector();

    try {
      console.log(`Running preview test: ${caseDef.name} on ${device}`);
      console.log(`Navigating to: ${testUrl}`);
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(3000);

      const classifyButton = this.page.locator('#classify, button:has-text("Classify")').first();
      if (await classifyButton.isVisible().catch(() => false)) {
        await classifyButton.click();
        console.log('[Success] Clicked Classify button');
      } else {
        console.log('Classify button not found, assuming auto-run from URL params');
      }

      const latency = await this.pollUntil(() => this.page.evaluate(() => {
        const text = (document.querySelector('#latency')?.textContent || '').trim();
        const value = parseFloat((text.match(/\d+(?:\.\d+)?/) || ['0'])[0]);
        return value > 0 ? text : null;
      }), { timeout: 5 * MINUTE });
      if (!latency) throw new Error('Latency did not appear in #latency');

      const top = await this.page.evaluate(() => ({
        label: document.querySelector('#label1')?.innerText.trim(),
        score: document.querySelector('#score1')?.innerText.trim()
      }));
      checkTopLabel(top.label, top.score, caseDef.expectedLabel);
      const perf = this.checkPerf(perfCollector, device, ['webnn.inference'], 'IC');

      results.push(passResult(caseDef, testUrl,
        `Top-1: ${top.label} (${Number(top.score).toFixed(3)}). Latency: ${latency.includes('ms') ? latency : `${latency} ms`}`, perf));
    } finally {
      perfCollector.stop();
    }
  }

  async runModelSdxl(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('SDXL', LOAD_ERROR_PATTERNS, perfCollector);
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      const loadButton = this.page.locator('button', { hasText: 'Load Models' });
      await loadButton.waitFor({ state: 'visible', timeout: 30000 });
      await expect(loadButton).toBeEnabled({ timeout: 2 * MINUTE });
      await loadButton.click();
      console.log('[Success] Clicked Load Models');

      const generateButton = this.page.locator('button', { hasText: 'Generate Image' });
      const ready = await this.pollUntil(async () =>
        await generateButton.isVisible().catch(() => false) && await generateButton.isEnabled().catch(() => false),
        { timeout: 30 * MINUTE, onTick: () => errors.check() });
      if (!ready) throw new Error('Generate Image button did not become visible/enabled');
      const loadErrors = await this.previewLogErrors();
      if (loadErrors.length) throw new Error(`Model load failed: ${loadErrors.join(' | ')}`);

      console.log('[Success] Models loaded. Clicking Generate Image...');
      await generateButton.click();

      const totalTime = await this.pollUntil(async () => {
        const text = ((await this.page.locator('#total_data').textContent().catch(() => '')) || '').trim();
        return text && text !== '...' && /\d/.test(text) ? text : null;
      }, { timeout: 10 * MINUTE, onTick: () => errors.check('Generation') });
      if (!totalTime) throw new Error('Result text did not appear or invalid');
      const runErrors = await this.previewLogErrors();
      if (runErrors.length) throw new Error(`Generation failed: ${runErrors.join(' | ')}`);

      for (let i = 0; i < 4; i++) {
        checkImageStats(await this.imageStats(`#img_canvas_${i}`), `Image ${i + 1}`);
      }
      const perf = this.checkPerf(perfCollector, device, ['webnn.session.create', 'webnn.inference'], 'SDXL');
      results.push(passResult(caseDef, testUrl, `Generated 4 images. Total time: ${totalTime}`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelPhi(results, caseDef, variant) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}&model=${caseDef.variantId}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('TextGen', [
      ...LOAD_ERROR_PATTERNS,
      "failed to execute 'readtensor' on 'mlcontext'",
      'tensor has been destroyed or context is lost'
    ], perfCollector);
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      // The demo loads the model on page init; #send-button is enabled once it is ready.
      const sendBtn = this.page.locator('#send-button');
      console.log('Waiting for model to load (#send-button to become enabled)...');
      await sendBtn.waitFor({ state: 'visible', timeout: 15 * MINUTE });
      const loaded = await this.pollUntil(() => sendBtn.isEnabled().catch(() => false),
        { timeout: 20 * MINUTE, onTick: () => errors.check() });
      if (!loaded) throw new Error('Model did not finish loading (#send-button stayed disabled)');
      console.log('Model loaded. Send button is enabled.');

      const userInput = this.page.locator('#user-input');
      const testPrompt = 'What is 2 + 2?';
      await userInput.click();
      await userInput.fill(testPrompt).catch(async () => {
        // contenteditable divs may not support fill(), use keyboard input
        await userInput.pressSequentially(testPrompt, { delay: 30 });
      });
      await sendBtn.click();
      console.log(`Sent prompt "${testPrompt}", waiting for the response...`);

      // A copy button is added to the response once generation completes successfully.
      const outcome = await this.pollUntil(() => this.page.evaluate(() => {
        const outers = document.querySelectorAll('.response-message-outer');
        const last = outers[outers.length - 1];
        if (!last) return null;
        if (last.querySelector('.copy-button')) return { done: true };
        const send = document.querySelector('#send-button');
        return send && !send.disabled && !last.querySelector('.dots') ? { done: false } : null;
      }), { timeout: 10 * MINUTE, interval: 1000, onTick: () => errors.check('Inference') });
      if (!outcome) throw new Error('Response did not complete within 10 minutes');
      if (!outcome.done) throw new Error('Text generation stopped without completing the response');

      const response = checkTextResponse(await this.page.locator('.response-message').last().innerText(),
        variant.expectAnswer === false ? null : /\b4\b|\bfour\b/i);
      const perfText = ((await this.page.locator('#performance-indicator').innerText().catch(() => '')) || '').trim();
      console.log(`Response: ${response.slice(0, 200)}`);
      const perf = this.checkPerf(perfCollector, device,
        ['webnn.session.create', 'webnn.inference.first'], variant.label);

      results.push(passResult(caseDef, testUrl,
        `Answer: ${response.slice(0, 120)}. Performance: ${perfText.replace(/\n/g, ', ')}`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelSam(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}&model=${caseDef.variantId}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('SAM', LOAD_ERROR_PATTERNS, perfCollector);
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      // The canvas is shown once both SAM models are downloaded and compiled.
      console.log('Waiting for canvas (model loading may take a while)...');
      const canvas = this.page.locator('#img_canvas');
      await canvas.waitFor({ state: 'visible', timeout: 5 * MINUTE });

      // The encoder processes the default image; the cursor leaves "wait" when it is done.
      console.log('Waiting for encoder to finish processing default image...');
      const encoderReady = await this.pollUntil(async () => (await canvas.evaluate(el => el.style.cursor)) !== 'wait',
        { timeout: 5 * MINUTE, onTick: () => errors.check() });
      if (!encoderReady) throw new Error('Encoder did not finish processing the image in time');

      const before = await this.screenshot('#img_canvas');
      console.log('Clicking on canvas to trigger segmentation...');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Canvas bounding box not found');
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const latency = await this.pollUntil(async () => {
        const text = await this.page.locator('#decoder_latency').innerText().catch(() => '');
        return text && /\d/.test(text) && !text.includes('...') ? text : null;
      }, { timeout: MINUTE, onTick: () => errors.check('Inference') });
      if (!latency) throw new Error('Latency not displayed in #decoder_latency');
      await this.page.waitForTimeout(500);

      // The decoder blends its mask image over the picture at 30% alpha; recover it to measure the mask.
      const diff = await this.imageDiff(await this.screenshot('#img_canvas'), before, { alpha: 0.3 });
      checkMaskOverlay(diff);
      const perf = this.checkPerf(perfCollector, device, ['webnn.session.create', 'webnn.inference'], 'SAM');
      results.push(passResult(caseDef, testUrl,
        `Mask covers ${(diff.overlay * 100).toFixed(1)}% of the image (${(diff.changed * 100).toFixed(1)}% of pixels changed). Decoder latency: ${latency} ms`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelWhisper(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}&datatype=${caseDef.variantId}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('Whisper', [...LOAD_ERROR_PATTERNS, 'error · '], perfCollector);
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      // The demo loads the model on page init; #file-upload is enabled once it is ready.
      const fileUpload = this.page.locator('#file-upload');
      console.log('Waiting for model to load (#file-upload to become enabled)...');
      await fileUpload.waitFor({ state: 'attached', timeout: 5 * MINUTE });
      // isDisabled() can hang while ORT compiles the session and blocks the page's event loop.
      const modelReady = await this.pollUntil(async () => {
        try {
          return !(await Promise.race([
            fileUpload.isDisabled(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('isDisabled timeout')), 10000))
          ]));
        } catch (e) {
          if (e.message === 'isDisabled timeout') {
            console.log('[Whisper] Page JS unresponsive, ORT session may be compiling...');
            return false;
          }
          throw e;
        }
      }, { timeout: 5 * MINUTE, onTick: () => errors.check() });
      if (!modelReady) throw new Error('Whisper model failed to load (file-upload stayed disabled)');
      console.log('Model loaded. Controls are enabled.');

      const wavPath = path.join(__dirname, '..', 'assets', 'test.wav');
      if (!fs.existsSync(wavPath)) throw new Error(`Test WAV file not found: ${wavPath}`);
      await fileUpload.setInputFiles(wavPath);
      console.log('Uploaded WAV file. Waiting for transcription...');

      const latencyText = await this.pollUntil(async () => {
        const text = await this.page.locator('#latency').innerText().catch(() => '');
        return text && text.includes('100') ? text : null;
      }, { timeout: MINUTE, onTick: () => errors.check('Transcription') });
      const transcription = await this.page.locator('#outputText').textContent().catch(() => '');
      console.log(`Transcription result: "${transcription}"`);
      if (!latencyText) throw new Error('Transcription did not complete (latency never reached 100%)');

      // assets/test.wav says "What's the weather like?"
      const expectedWords = "What's the weather like?".toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const lower = (transcription || '').toLowerCase();
      const matchedWords = expectedWords.filter(w => lower.includes(w));
      const transcriptionOk = matchedWords.length >= 2;
      console.log(`[Whisper] Word match: ${matchedWords.length}/${expectedWords.length} (${matchedWords.join(', ') || 'none'})`);
      const perf = this.checkPerf(perfCollector, device, ['webnn.session.create', 'webnn.inference'], 'Whisper');

      results.push({
        testName: caseDef.name,
        testUrl,
        result: transcriptionOk ? 'PASS' : 'FAIL',
        details: `Transcription: ${transcription || '(blank)'}. ${latencyText} | Words matched: ${matchedWords.length}/${expectedWords.length} (${matchedWords.join(', ') || 'none'})`,
        ...perf,
        subcases: { total: 1, passed: transcriptionOk ? 1 : 0, failed: transcriptionOk ? 0 : 1 },
        suite: 'model'
      });
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelStemSeparator(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}`;
    const backendLabel = `WebNN ${device.toUpperCase()}`;
    const perfCollector = new WebNNPerfCollector();
    const timeout = 300000;
    const pageError = selector => this.page.evaluate(errorSelector => {
      const error = document.querySelector(errorSelector)?.textContent.trim();
      if (!error) return null;
      const log = (document.querySelector('#log')?.innerText || '').trim().split('\n').slice(-5).join('\n');
      return log ? `${error}\n${log}` : error;
    }, selector);

    try {
      perfCollector.start(this.page);
      console.log(`Running preview test: ${caseDef.name} on ${device}`);
      await this.page.goto(testUrl, { waitUntil: 'domcontentloaded' });
      await expect(this.page.locator('#load-btn')).toBeEnabled({ timeout });
      await this.page.locator('#backend-select').selectOption(`webnn-${device}`);
      await this.page.locator('#load-btn').click();
      await this.page.waitForFunction(() =>
        document.querySelector('#status')?.textContent.includes('Session loaded with') ||
        document.querySelector('#status .badge-error'), null, { timeout });
      const loadError = await pageError('#status .badge-error');
      if (loadError) throw new Error(`Model load failed: ${loadError}`);
      await expect(this.page.locator('#status')).toHaveText(`Session loaded with ${backendLabel}`);

      const fileUpload = this.page.locator('#audio-file');
      await expect(fileUpload).toBeEnabled();
      await fileUpload.setInputFiles(path.join(__dirname, '..', 'assets', 'test.wav'));
      await expect(this.page.locator('#infer-btn')).toBeEnabled({ timeout });
      const expectedSamples = parseSampleCount(await this.page.locator('#audio-info tr')
        .filter({ hasText: 'Total samples @ 44.1kHz' }).locator('td').textContent());

      await this.page.locator('#infer-btn').click();
      await this.page.locator('#infer-result .result-ok, #infer-result .badge-error')
        .waitFor({ state: 'visible', timeout });
      const inferenceError = await pageError('#infer-result .badge-error');
      if (inferenceError) throw new Error(`Separation failed: ${inferenceError}`);
      await expect(this.page.locator('#infer-result .result-ok')).toContainText(backendLabel);
      await expect(this.page.locator('#stem-grid .track')).toHaveCount(4);
      await expect(this.page.locator('#download-all-btn')).toBeEnabled();

      const stems = [];
      for (const stem of ['drums', 'bass', 'other', 'vocals']) {
        const button = this.page.getByTitle(`Download test.${stem}.wav`, { exact: true });
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          button.click()
        ]);
        if (download.suggestedFilename() !== `test.${stem}.wav`) {
          throw new Error(`Unexpected ${stem} download: ${download.suggestedFilename()}`);
        }
        const failure = await download.failure();
        if (failure) throw new Error(`${stem} download failed: ${failure}`);
        const buffer = fs.readFileSync(await download.path());
        stems.push(validateStemWav(buffer, expectedSamples));
      }
      const mixError = parseMixError(await this.page.locator('#stem-stats').textContent());
      const relativeMixError = checkStemMix(stems, mixError);
      console.log(`[Stem] Sum-of-stems vs mix MAE ${mixError.toExponential(3)}, relative ${relativeMixError.toFixed(4)}`);

      const perf = this.checkPerf(perfCollector, device, ['webnn.session.create', 'webnn.inference'], 'Stem Separator');
      results.push(passResult(caseDef, testUrl,
        `${backendLabel}: validated drums, bass, other, vocals (stereo float32 WAV, 44100 Hz, ${expectedSamples} samples); sum-of-stems vs mix MAE ${mixError.toExponential(3)} (relative ${relativeMixError.toFixed(4)}).`,
        perf));
    } finally {
      perfCollector.stop();
    }
  }

  async runModelStableDiffusion15(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('SD1.5', LOAD_ERROR_PATTERNS, perfCollector);
    // The demo shows load and generation exceptions in #error.
    const pageError = async what => {
      errors.check(what);
      const text = ((await this.page.locator('#error').textContent().catch(() => '')) || '').trim();
      if (text) throw new Error(`${what} failed: ${text}`);
    };
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      const loadButton = this.page.locator('#load_models');
      await expect(loadButton).toBeEnabled({ timeout: 2 * MINUTE });
      const seed = await this.page.locator('#user_seed').inputValue().catch(() => '?');
      await loadButton.click();
      console.log('[Success] Clicked Load Models');

      const generateButton = this.page.locator('#generate_next_image');
      const ready = await this.pollUntil(() => generateButton.isEnabled().catch(() => false),
        { timeout: 40 * MINUTE, interval: 1000, onTick: () => pageError('Model load') });
      if (!ready) throw new Error('Generate Image did not become enabled');

      console.log(`[Success] Models loaded. Generating with seed ${seed}...`);
      await generateButton.click();
      const totalRun = await this.pollUntil(async () => {
        const text = ((await this.page.locator('#totalrun').textContent().catch(() => '')) || '').trim();
        return /^\d+(\.\d+)?$/.test(text) && Number(text) > 0 ? text : null;
      }, { timeout: 15 * MINUTE, interval: 1000, onTick: () => pageError('Generation') });
      if (!totalRun) throw new Error('Generation did not finish (#totalrun stayed empty)');

      const nsfw = ((await this.page.locator('#nsfw').textContent().catch(() => '')) || '').trim();
      if (nsfw) throw new Error(`Safety checker flagged the default prompt: ${nsfw}`);
      checkImageStats(await this.imageStats('#canvas'), 'Generated image');
      // A fixed 25-step schedule: the UNet must run 25 times on WebNN.
      const perf = this.checkPerf(perfCollector, device, [
        'webnn.session.create',
        { name: 'webnn.inference', model: 'unet', min: 25 }
      ], 'SD1.5');
      results.push(passResult(caseDef, testUrl, `Generated a 512x512 image with seed ${seed}. Total run: ${totalRun} ms`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelSdTurbo(results, caseDef) {
    const device = currentDevice();
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('SD-Turbo', LOAD_ERROR_PATTERNS, perfCollector);
    // SD-Turbo enables Generate even if a model failed to load; failures only reach #log.
    const logError = async what => {
      errors.check(what);
      const lines = await this.previewLogErrors();
      if (lines.length) throw new Error(`${what} failed: ${lines.join(' | ')}`);
    };
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      const loadButton = this.page.locator('#load');
      await expect(loadButton).toBeEnabled({ timeout: 2 * MINUTE });
      await loadButton.click();
      console.log('[Success] Clicked Load Models');

      const generateButton = this.page.locator('#generate');
      const ready = await this.pollUntil(() => generateButton.isEnabled().catch(() => false),
        { timeout: 40 * MINUTE, interval: 1000, onTick: () => logError('Model load') });
      if (!ready) throw new Error('Generate Image did not become enabled');
      await logError('Model load');

      console.log('[Success] Models loaded. Generating 4 images...');
      await generateButton.click();
      const totals = await this.pollUntil(() => this.page.evaluate(() => {
        const values = [1, 2, 3, 4].map(i => (document.querySelector(`#runTotal${i}`)?.textContent || '').trim());
        return values.every(v => /^\d+(\.\d+)?$/.test(v)) ? values : null;
      }), { timeout: 15 * MINUTE, interval: 1000, onTick: () => logError('Generation') });
      if (!totals) throw new Error('Generation did not finish (#runTotal1-4 stayed empty)');

      for (let i = 0; i < 4; i++) {
        checkImageStats(await this.imageStats(`#img_canvas_${i}`), `Image ${i + 1}`);
      }
      const perf = this.checkPerf(perfCollector, device, ['webnn.session.create', 'webnn.inference'], 'SD-Turbo');
      results.push(passResult(caseDef, testUrl, `Generated 4 images. Run totals: ${totals.map(t => `${t} ms`).join(', ')}`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }

  async runModelZImageTurbo(results, caseDef) {
    const device = currentDevice();
    // The demo defaults to WebGPU, so always request the WebNN provider explicitly.
    const testUrl = `${caseDef.url}?provider=webnn&devicetype=${device}`;
    console.log(`Running preview test: ${caseDef.name} on ${device}`);
    console.log(`Navigating to: ${testUrl}`);

    const perfCollector = new WebNNPerfCollector();
    const errors = this.watchConsoleErrors('Z-Image', LOAD_ERROR_PATTERNS, perfCollector);
    const logError = async what => {
      errors.check(what);
      const lines = await this.previewLogErrors();
      if (lines.length) throw new Error(`${what} failed: ${lines.join(' | ')}`);
    };
    try {
      perfCollector.start(this.page);
      await this.page.goto(testUrl);
      await this.page.waitForLoadState('domcontentloaded');

      const loadButton = this.page.locator('#load');
      await expect(loadButton).toBeEnabled({ timeout: 3 * MINUTE });
      // Sessions are built for the resolution and prompt at load time; changing them later forces a rebuild.
      await this.page.locator('#resolution-select').selectOption(caseDef.variantId);
      await loadButton.click();
      console.log('[Success] Clicked Load Models');

      const generateButton = this.page.locator('#generate');
      const ready = await this.pollUntil(() => generateButton.isEnabled().catch(() => false),
        { timeout: 75 * MINUTE, interval: 2000, onTick: () => logError('Model load') });
      if (!ready) throw new Error('Generate Image did not become enabled');
      await logError('Model load');

      // A fixed seed makes the latents deterministic.
      await this.page.locator('#seed-input').fill('42');
      console.log('[Success] Models loaded. Generating with seed 42...');
      await generateButton.click();
      const finalTime = await this.pollUntil(() => this.page.evaluate(() => {
        const element = document.querySelector('#final-time');
        const text = (element?.textContent || '').trim();
        return element && getComputedStyle(element).display !== 'none' && /\d+(\.\d+)?ms/.test(text) ? text : null;
      }), { timeout: 15 * MINUTE, interval: 1000, onTick: () => logError('Generation') });
      if (!finalTime) throw new Error('Generation did not finish (#final-time stayed empty)');
      await logError('Generation');

      checkImageStats(await this.imageStats('#img_canvas'), 'Generated image');
      // This demo does not instrument session creation.
      const perf = this.checkPerf(perfCollector, device, ['webnn.model.fetch', 'webnn.inference'], 'Z-Image');
      results.push(passResult(caseDef, testUrl, `Generated a ${caseDef.variant.label} image with seed 42. Total time: ${finalTime}`, perf));
    } finally {
      errors.dispose();
      perfCollector.stop();
    }
  }
}

module.exports = {
  ModelRunner,
  validateStemWav,
  parseSampleCount,
  parseMixError,
  checkStemMix,
  parseModelCaseFilter,
  expandModelCases,
  parseProbability,
  checkTopLabel,
  parseDetections,
  checkDetections,
  checkFaceLandmarks,
  checkFaceMatches,
  checkStyleBuilds,
  findRepeatedPhrase,
  installCanvasCaptureInPage,
  trackContextCreationInPage,
  checkImageStats,
  checkGraphDataType,
  checkTextResponse,
  checkFraction,
  checkMaskOverlay,
  analyzeImagesInPage,
  envelopeCorrelation,
  checkDenoisedAudio,
  checkWebNNPerf
};