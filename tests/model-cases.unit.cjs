const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
    ModelRunner,
    parseModelCaseFilter,
    expandModelCases,
    parseProbability,
    checkTopLabel,
    checkDetections,
    checkFaceLandmarks,
    checkFaceMatches,
    checkStyleBuilds,
    checkImageStats,
    checkGraphDataType,
    checkTextResponse,
    findRepeatedPhrase,
    checkFraction,
    checkMaskOverlay,
    envelopeCorrelation,
    checkDenoisedAudio,
    checkWebNNPerf
} = require('../src/model');

const models = {
    plain: { name: 'Plain', url: 'u', type: 'sample', devices: ['cpu', 'gpu'] },
    multi: {
        name: 'Multi',
        url: 'u',
        type: 'sample',
        variants: {
            a: { label: 'A', devices: ['cpu', 'gpu'] },
            b: { label: 'B' }
        },
        defaultVariant: { default: 'a', npu: 'b' }
    },
    hidden: { name: 'Hidden', url: 'u', type: 'preview', optIn: true, variants: { x: { label: 'X' } } }
};

const runnable = items => items.map(i => i.error ? `error:${i.key}` : `${i.key}${i.variantId ? `:${i.variantId}` : ''}${i.skipReason ? ' (skip)' : ''}`);

test('model case filter parses keys and plus-separated variants', () => {
    assert.equal(parseModelCaseFilter(''), null);
    assert.deepEqual(parseModelCaseFilter(' OD:TinyYolov2-fp16+ssd , lenet,'), [
        { key: 'od', variants: ['tinyyolov2-fp16', 'ssd'] },
        { key: 'lenet', variants: null }
    ]);
});

test('default run includes one default variant per non opt-in case', () => {
    assert.deepEqual(runnable(expandModelCases(models, { device: 'gpu' })), ['plain', 'multi:a']);
    assert.deepEqual(runnable(expandModelCases(models, { device: 'npu' })), ['plain (skip)', 'multi:b']);
});

test('variant mode all expands every variant and skips unsupported devices', () => {
    assert.deepEqual(runnable(expandModelCases(models, { variantMode: 'all', device: 'npu' })),
        ['plain (skip)', 'multi:a (skip)', 'multi:b']);
});

test('opt-in cases run only when named', () => {
    assert.deepEqual(runnable(expandModelCases(models, { filter: 'hidden', device: 'gpu' })), ['hidden:x']);
    assert.deepEqual(runnable(expandModelCases(models, { filter: 'hidden', variantMode: 'all', device: 'gpu' })), ['hidden:x']);
});

test('explicit variants override the variant mode; unknown cases and variants are errors', () => {
    assert.deepEqual(runnable(expandModelCases(models, { filter: 'multi:b', variantMode: 'all', device: 'gpu' })), ['multi:b']);
    const items = expandModelCases(models, { filter: 'nope,multi:zzz,plain:a', device: 'gpu' });
    assert.deepEqual(runnable(items), ['error:nope', 'error:multi', 'error:plain']);
    assert.match(items[0].error, /Unknown test case: nope/);
    assert.match(items[1].error, /Unknown variant "zzz" for multi\. Available: a, b/);
});

test('overlapping filters run each case variant once', () => {
    assert.deepEqual(runnable(expandModelCases(models, { filter: 'multi,multi:a+a+b,plain,plain', device: 'gpu' })),
        ['multi:a', 'multi:b', 'plain']);
    assert.deepEqual(runnable(expandModelCases(models, { filter: 'multi,multi:b', variantMode: 'all', device: 'gpu' })),
        ['multi:a', 'multi:b']);
});

test('a failing case is reported even after a passing case with the same name', async () => {
    const previous = { DEVICE: process.env.DEVICE, MODEL_CASE: process.env.MODEL_CASE, MODEL_TIMEOUT: process.env.MODEL_TIMEOUT };
    process.env.DEVICE = 'gpu';
    process.env.MODEL_CASE = 'one,two';
    process.env.MODEL_TIMEOUT = '5';
    try {
        const page = { isClosed: () => true, on() {}, off() {}, removeListener() {} };
        const runner = new ModelRunner(page);
        const timeouts = [];
        runner.ensurePage = async () => {};
        runner.runTestWithSessionCheck = async (fn, restart, options) => { timeouts.push(options.timeoutMs); await fn(); };
        const pass = (results, caseDef) => { results.push({ testName: caseDef.name, result: 'PASS', subcases: { total: 1, passed: 1, failed: 0 } }); };
        const fail = async (results, caseDef) => {
            pass(results, caseDef);
            throw new Error('boom');
        };
        runner.models = {
            one: { name: 'Same', url: 'u', type: 'sample', timeoutMs: 60000, func: pass },
            two: { name: 'Same', url: 'u', type: 'sample', func: fail }
        };
        const results = await runner.runModelTests();
        assert.deepEqual(results.map(r => r.result), ['PASS', 'ERROR']);
        assert.match(results[1].fullText, /boom/);
        assert.ok(results.every(r => r.executionTime !== undefined));
        assert.deepEqual(timeouts, [5000, 5000]);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a timed-out case cannot append late results or retain diagnostic listeners', async () => {
    const previous = { DEVICE: process.env.DEVICE, MODEL_CASE: process.env.MODEL_CASE };
    process.env.DEVICE = 'npu';
    process.env.MODEL_CASE = 'slow,working';
    try {
        const page = Object.assign(new EventEmitter(), { isClosed: () => true });
        const runner = new ModelRunner(page);
        runner.ensurePage = async () => {};
        let finishSlowCase;
        let slowTask;
        runner.runTestWithSessionCheck = async fn => {
            if (!slowTask) {
                slowTask = fn();
                throw new Error('Test hard timeout');
            }
            await fn();
        };
        runner.models = {
            slow: { name: 'Slow', url: 'u', type: 'preview', func: async results => {
                await new Promise(resolve => { finishSlowCase = resolve; });
                results.push({ testName: 'Late success', result: 'PASS' });
            } },
            working: { name: 'Working', url: 'u', type: 'preview', func: async results => {
                assert.equal(page.listenerCount('response'), 1, 'only the active case is listening');
                finishSlowCase();
                await slowTask;
                results.push({ testName: 'Working', result: 'PASS' });
            } }
        };
        const results = await runner.runModelTests();
        assert.deepEqual(results.map(result => [result.testName, result.result]), [
            ['Slow', 'ERROR'], ['Working', 'PASS']
        ]);
        for (const event of ['console', 'pageerror', 'requestfailed', 'response']) {
            assert.equal(page.listenerCount(event), 0);
        }
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('expanded items carry a per-variant test name and the variant definition', () => {
    const [item] = expandModelCases(models, { filter: 'multi:b', device: 'cpu' });
    assert.equal(item.caseDef.name, 'Multi [B]');
    assert.equal(item.caseDef.variantId, 'b');
    assert.equal(item.caseDef.variant.label, 'B');
    assert.equal(item.skipReason, null);
    assert.match(expandModelCases(models, { filter: 'multi:a', device: 'npu' })[0].skipReason, /No WebNN NPU support in this variant \(supported: cpu, gpu\)/);
});

test('model failures keep bounded browser and network diagnostics without leaking into later cases', async () => {
    const previous = { DEVICE: process.env.DEVICE, MODEL_CASE: process.env.MODEL_CASE };
    process.env.DEVICE = 'npu';
    process.env.MODEL_CASE = 'broken,working';
    try {
        const page = Object.assign(new EventEmitter(), { isClosed: () => true });
        const runner = new ModelRunner(page);
        runner.ensurePage = async () => {};
        runner.runTestWithSessionCheck = async fn => fn();
        runner.models = {
            broken: { name: 'Broken', url: 'u', type: 'preview', func: async () => {
                for (let i = 0; i < 15; i++) {
                    page.emit('console', { type: () => 'error', text: () => `message ${i} ${'x'.repeat(2000)}` });
                }
                page.emit('response', { status: () => 404, url: () => 'https://example.com/model.onnx' });
                page.emit('requestfailed', { url: () => 'https://example.com/weights', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
                page.emit('pageerror', new Error('device lost'));
                throw new Error('Load timed out');
            } },
            working: { name: 'Working', url: 'u', type: 'preview', func: async (results, caseDef) => {
                results.push({ testName: caseDef.name, result: 'PASS' });
            } }
        };
        const results = await runner.runModelTests();
        assert.deepEqual(results.map(result => result.result), ['ERROR', 'PASS']);
        assert.match(results[0].fullText, /Load timed out\n/);
        assert.match(results[0].fullText, /HTTP 404: https:\/\/example.com\/model.onnx/);
        assert.match(results[0].fullText, /Request failed: .*net::ERR_FAILED/);
        assert.match(results[0].fullText, /Page error: device lost/);
        assert.ok(!results[0].fullText.includes('message 0 '));
        assert.ok(results[0].fullText.length <= 11000);
        assert.equal(results[1].fullText, undefined);
        for (const event of ['console', 'pageerror', 'requestfailed', 'response']) {
            assert.equal(page.listenerCount(event), 0);
        }
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('registered model cases have valid devices and default variants', () => {
    const runner = new ModelRunner(null);
    for (const [key, model] of Object.entries(runner.models)) {
        assert.equal(typeof model.func, 'function', `${key} runner`);
        for (const device of model.devices) assert.ok(['cpu', 'gpu', 'npu'].includes(device), `${key} device ${device}`);
        for (const device of ['cpu', 'gpu', 'npu']) {
            for (const item of expandModelCases(runner.models, { filter: key, device })) {
                assert.equal(item.error, undefined, `${key} on ${device}: ${item.error}`);
            }
            for (const item of expandModelCases(runner.models, { filter: key, variantMode: 'all', device })) {
                assert.equal(item.error, undefined, `${key} on ${device}: ${item.error}`);
            }
        }
    }
    const defaultKeys = expandModelCases(runner.models, { device: 'gpu' }).map(i => i.key);
    for (const key of ['ic-sample', 'nsnet2', 'rnnoise', 'selfie', 'fld', 'fr', 'sd15', 'sdturbo']) {
        assert.ok(defaultKeys.includes(key), `${key} runs by default`);
    }
    assert.ok(!defaultKeys.includes('zimage'), 'zimage is opt-in');
});

test('probability parsing accepts percentages and fractions', () => {
    assert.equal(parseProbability('99.22%'), 0.9922);
    assert.equal(parseProbability('0.650055468'), 0.650055468);
    assert.equal(parseProbability('9.5e-1'), 0.95);
    assert.ok(Number.isNaN(parseProbability('n/a')));
});

test('probability parsing is strict so exponents and trailing text cannot hide out-of-range values', () => {
    assert.equal(parseProbability('1e+2'), 100);
    assert.equal(parseProbability('1E2'), 100);
    assert.ok(Number.isNaN(parseProbability('0.5 extra')));
    assert.ok(Number.isNaN(parseProbability('p=0.5')));
    assert.throws(() => checkTopLabel('tiger', '1e+2', 'tiger'), /not in \(0, 1\]/);
    assert.equal(checkTopLabel('tiger', '5e+1%', 'tiger'), 0.5);
});

test('style transfer must build exactly the requested style once', () => {
    checkStyleBuilds(['self-portrait'], 'self-portrait');
    assert.throws(() => checkStyleBuilds(['starry-night', 'self-portrait'], 'self-portrait'), /Expected one self-portrait model build, got: starry-night, self-portrait/);
    assert.throws(() => checkStyleBuilds(['starry-night'], 'self-portrait'), /got: starry-night/);
    assert.throws(() => checkStyleBuilds([], 'bedroom'), /got: none/);
});

test('top-1 label check matches case-insensitively and validates the probability', () => {
    assert.equal(checkTopLabel('lesser panda, red panda', '99.30%', 'Lesser Panda'), 0.993);
    assert.equal(checkTopLabel('tiger, Panthera tigris', '0.92', 'tiger'), 0.92);
    assert.equal(checkTopLabel('3', '100.00%', '3'), 1);
    assert.throws(() => checkTopLabel('tiger cat', '0.9', 'tiger, Panthera'), /Expected top-1 class/);
    assert.throws(() => checkTopLabel('tiger', '', 'tiger'), /not in \(0, 1\]/);
    assert.throws(() => checkTopLabel('tiger', '150%', 'tiger'), /not in \(0, 1\]/);
});

test('top-1 label check requires a whole ImageNet alias, not a substring', () => {
    assert.throws(() => checkTopLabel('tiger cat', '0.9', 'tiger'), /Expected top-1 class "tiger" but got "tiger cat"/);
    assert.throws(() => checkTopLabel('giant panda, panda, panda bear', '0.9', 'lesser panda'), /Expected top-1 class/);
    assert.throws(() => checkTopLabel('13', '0.9', '3'), /Expected top-1 class/);
});

test('detection check requires labelled boxes including the expected class', () => {
    const calls = { strokeRect: 2, fillText: ['person: 0.96', 'kite: 0.87'] };
    assert.deepEqual(checkDetections(calls, 'person').map(d => d.label), ['person', 'kite']);
    assert.throws(() => checkDetections({ strokeRect: 0, fillText: [] }, 'person'), /No objects/);
    assert.throws(() => checkDetections({ strokeRect: 2, fillText: ['person: 0.9'] }, 'person'), /2 boxes but 1 labels/);
    assert.throws(() => checkDetections({ strokeRect: 1, fillText: ['dog: 0.9'] }, 'person'), /Expected a "person"/);
    assert.throws(() => checkDetections({ strokeRect: 1, fillText: ['person: 1.5'] }, 'person'), /out of range/);
    assert.throws(() => checkDetections({ strokeRect: 1, fillText: ['person'] }, 'person'), /Unexpected detection label/);
});

test('face landmark check requires the expected faces with 68 points each', () => {
    assert.deepEqual(checkFaceLandmarks({ strokeRect: 2, arc: 136 }, 2), { faces: 2, points: 136 });
    assert.throws(() => checkFaceLandmarks({ strokeRect: 1, arc: 68 }, 2), /Expected 2 faces/);
    assert.throws(() => checkFaceLandmarks({ strokeRect: 2, arc: 100 }, 2), /Expected 136 landmarks/);
    assert.throws(() => checkFaceLandmarks(undefined, 2), /detected 0/);
});

test('canvas checks reject geometry that was not drawn because it was non-finite', () => {
    assert.throws(() => checkFaceLandmarks({ strokeRect: 2, arc: 0, invalid: 136 }, 2), /136 face boxes or landmarks had non-finite coordinates/);
    assert.throws(() => checkDetections({ strokeRect: 1, fillText: ['person: 0.9'], invalid: 1 }, 'person'), /non-finite/);
    const target = { strokeRect: 4, fillText: ['1', '2', '3', '4'] };
    assert.throws(() => checkFaceMatches(target, { strokeRect: 4, fillText: ['4', '3', '2', '1'], invalid: 1 }, 4), /search face boxes or labels had non-finite/);
});

test('canvas capture counts non-finite draws as invalid instead of drawn', () => {
    const { installCanvasCaptureInPage } = require('../src/model');
    const calls = [];
    class Context {
        constructor(id) { this.canvas = { id }; }
        drawImage() {}
        strokeRect(...args) { calls.push(['strokeRect', ...args]); }
        arc(...args) { calls.push(['arc', ...args]); }
        fillText(...args) { calls.push(['fillText', ...args]); }
    }
    const previous = { window: global.window, CanvasRenderingContext2D: global.CanvasRenderingContext2D };
    global.window = {};
    global.CanvasRenderingContext2D = Context;
    try {
        installCanvasCaptureInPage();
        const ctx = new Context('out');
        ctx.arc(1, 2, 2, 0, 2 * Math.PI);
        ctx.arc(NaN, 2, 2, 0, 2 * Math.PI);
        ctx.strokeRect(0, 0, Infinity, 5);
        ctx.strokeRect(0, 0, 5, 5);
        ctx.fillText('person: 0.9', 1, 2);
        ctx.fillText('kite: 0.5', NaN, 2);
        assert.deepEqual(global.window.__webnnCanvasCalls.out, { strokeRect: 1, arc: 1, fillText: ['person: 0.9'], invalid: 3 });
        assert.equal(calls.length, 6, 'original drawing calls still run');
    } finally {
        global.window = previous.window;
        global.CanvasRenderingContext2D = previous.CanvasRenderingContext2D;
    }
});

test('face recognition check requires every search face to match a distinct target', () => {
    const target = { strokeRect: 4, fillText: ['1', '2', '3', '4'] };
    assert.deepEqual(checkFaceMatches(target, { strokeRect: 4, fillText: ['4', '3', '2', '1'] }, 4), [4, 3, 2, 1]);
    assert.throws(() => checkFaceMatches(target, { strokeRect: 4, fillText: ['4', 'X', '2', '1'] }, 4), /Not every face/);
    assert.throws(() => checkFaceMatches(target, { strokeRect: 4, fillText: ['1', '1', '2', '3'] }, 4), /same target/);
    assert.throws(() => checkFaceMatches(target, { strokeRect: 3, fillText: ['1', '2', '3'] }, 4), /detected 4 and 3/);
    assert.throws(() => checkFaceMatches(target, { strokeRect: 4, fillText: ['1', '2', '3', '5'] }, 4), /Not every face/);
});

test('graph data type check requires constants of the selected type', () => {
    assert.equal(checkGraphDataType({ float16: 52, int64: 2 }, 'float16'), 'float16 x52, int64 x2');
    assert.throws(() => checkGraphDataType({ float32: 52 }, 'float16'), /Selected float16 but the graph was built from float32 x52 constants/);
    assert.throws(() => checkGraphDataType(undefined, 'float32'), /built from none constants/);
});

// Runs the in-page image analyzer in Node with stub Image/canvas globals over raw RGBA pixels.
async function analyzeRawImages(images, args) {
    const { analyzeImagesInPage } = require('../src/model');
    const previous = { Image: global.Image, document: global.document };
    global.Image = class {
        set src(value) { this.pixels = images[value.replace('data:image/png;base64,', '')]; this.width = this.pixels.width; this.height = this.pixels.height; }
        async decode() {}
    };
    global.document = {
        createElement: () => {
            let drawn = null;
            return { getContext: () => ({ drawImage: img => { drawn = img; }, getImageData: () => ({ data: drawn.pixels.data }) }) };
        }
    };
    try {
        return await analyzeImagesInPage(args);
    } finally {
        global.Image = previous.Image;
        global.document = previous.document;
    }
}

function rgba(width, height, pixel) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([...pixel(i), 255], i * 4);
    return { width, height, data };
}

test('mask check fails for identical before/after screenshots', async () => {
    const image = rgba(10, 10, i => [200, 150 + (i % 50), 100]);
    const diff = await analyzeRawImages({ before: image, after: image }, { a: 'after', b: 'before', alpha: 0.3 });
    assert.equal(diff.changed, 0);
    assert.ok(diff.overlay > 0.5, 'the recovered overlay of an unchanged image is the image itself');
    assert.throws(() => checkMaskOverlay(diff), /No mask was rendered: only 0\.0% of pixels changed/);
});

test('mask check accepts a 30% mask blend and measures the masked area', async () => {
    const before = rgba(10, 10, i => [200, 150 + (i % 50), 100]);
    // A white mask over the first 20 pixels, black elsewhere, blended at alpha 0.3.
    const after = rgba(10, 10, i => [0, 1, 2].map(c => Math.round(0.7 * before.data[i * 4 + c] + 0.3 * (i < 20 ? 255 : 0))));
    const diff = await analyzeRawImages({ before, after }, { a: 'after', b: 'before', alpha: 0.3 });
    assert.ok(diff.changed >= 0.8);
    assert.equal(checkMaskOverlay(diff), 0.2);
    assert.throws(() => checkMaskOverlay({ changed: 0.98, overlay: 0.001 }), /Segmented mask area 0\.1% is outside/);
});

test('context tracking counts in-flight createContext calls until they settle', async () => {
    const { trackContextCreationInPage } = require('../src/model');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousWindow = global.window;
    const pending = [];
    const ml = {
        createContext(options) {
            if (options === 'throw') throw new Error('sync');
            return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        }
    };
    Object.defineProperty(globalThis, 'navigator', { value: { ml }, configurable: true, writable: true });
    global.window = {};
    try {
        trackContextCreationInPage();
        trackContextCreationInPage();
        const first = navigator.ml.createContext({ deviceType: 'gpu' });
        const second = navigator.ml.createContext({ deviceType: 'gpu' });
        assert.equal(window.__webnnPendingContexts, 2);
        assert.throws(() => navigator.ml.createContext('throw'), /sync/);
        assert.equal(window.__webnnPendingContexts, 2);
        pending[0].resolve('ctx');
        assert.equal(await first, 'ctx');
        assert.equal(window.__webnnPendingContexts, 1);
        pending[1].reject(new Error('no npu'));
        await assert.rejects(second, /no npu/);
        assert.equal(window.__webnnPendingContexts, 0);
    } finally {
        if (original) Object.defineProperty(globalThis, 'navigator', original);
        else delete globalThis.navigator;
        global.window = previousWindow;
    }
});

test('sample idle wait requires no pending contexts and stable controls', async () => {
    const states = [
        { pending: 1, controls: 'cpu:1' },
        { pending: 1, controls: 'cpu:1' },
        { pending: 0, controls: 'gpu:1,float32:1' },
        { pending: 0, controls: 'gpu:1,float16:1' }
    ];
    let reads = 0;
    const page = {
        evaluate: async () => states[Math.min(reads++, states.length - 1)],
        waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms))
    };
    const runner = new ModelRunner(page);
    await runner.waitForSampleIdle({ timeout: 2000, quietMs: 30, interval: 5 });
    assert.ok(reads > states.length, 'waits until the last state has been stable for quietMs');

    const busy = new ModelRunner({ evaluate: async () => ({ pending: 1, controls: 'x' }), waitForTimeout: page.waitForTimeout });
    await assert.rejects(busy.waitForSampleIdle({ timeout: 60, quietMs: 10, interval: 5 }), /did not settle within 0\.06s \(1 context creations pending\)/);
});

test('image and fraction checks reject blank output and out-of-band values', () => {
    assert.ok(checkImageStats({ width: 10, height: 10, std: 40 }, 'Image'));
    assert.throws(() => checkImageStats({ width: 10, height: 10, std: 0.5 }, 'Image'), /looks blank/);
    assert.throws(() => checkImageStats({ width: 0, height: 10, std: 40 }, 'Image'), /empty/);
    assert.equal(checkFraction('Foreground', 0.35, 0.05, 0.9), 0.35);
    assert.throws(() => checkFraction('Foreground', 0.99, 0.05, 0.9), /Foreground 99\.0% is outside 5\.0%-90\.0%/);
    assert.throws(() => checkFraction('Foreground', NaN, 0.05, 0.9), /outside/);
});

test('envelope correlation finds a lagged match', () => {
    const a = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.ok(envelopeCorrelation(a, a) > 0.999);
    assert.ok(envelopeCorrelation(a, [0, ...a]) > 0.999);
    assert.ok(envelopeCorrelation(a, [...a].reverse()) < -0.9);
});

test('denoised audio must keep duration and speech while removing some energy', () => {
    const envelope = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
    const original = { duration: 16.2, rms: 0.115, nonFinite: 0, envelope };
    const denoised = { duration: 17, rms: 0.105, nonFinite: 0, envelope: envelope.map(v => v * 0.9) };
    const { ratio, correlation } = checkDenoisedAudio(original, denoised);
    assert.ok(ratio > 0.9 && ratio < 0.92);
    assert.ok(correlation > 0.999);
    assert.throws(() => checkDenoisedAudio(original, { ...denoised, nonFinite: 3 }), /non-finite/);
    assert.throws(() => checkDenoisedAudio(original, { ...denoised, duration: 5 }), /duration/);
    assert.throws(() => checkDenoisedAudio(original, { ...denoised, rms: 0.001 }), /nearly silent/);
    assert.throws(() => checkDenoisedAudio(original, { ...denoised, rms: 0.115 }), /No noise was removed/);
    assert.throws(() => checkDenoisedAudio(original, { ...denoised, envelope: [...envelope].reverse() }), /no longer follows/);
});

test('text response check rejects empty, degenerate, and wrong answers', () => {
    assert.equal(checkTextResponse('Arr, 2 + 2\n\n= 4, matey!', /\b4\b/), 'Arr, 2 + 2 = 4, matey!');
    assert.equal(checkTextResponse('2 + 2 is 2 + 2.'), '2 + 2 is 2 + 2.');
    assert.throws(() => checkTextResponse('  \n '), /empty response/);
    assert.throws(() => checkTextResponse('!!!!!!!!!!!!!!!!!!!!'), /degenerate output/);
    assert.throws(() => checkTextResponse('David decant storeakk Bal-In108btbtbtbtbtbtbtbtbtbt', /4/), /degenerate output \("btbtbtbtbtbtbtbt/);
    assert.throws(() => checkTextResponse('2 + 2 is 2 + 2.', /\b4\b/), /Expected an answer matching/);
});

test('text response check rejects repeated words and phrases', () => {
    assert.throws(() => checkTextResponse('four '.repeat(20), /\b4\b|\bfour\b/i), /repeats "four"/);
    assert.throws(() => checkTextResponse('The answer is 4. '.repeat(6), /\b4\b/), /repeats "the answer is 4"/);
    assert.equal(findRepeatedPhrase('2 + 2 = 4. Two plus two equals four, so the answer is 4.'), null);
    assert.equal(findRepeatedPhrase('yes yes yes yes yes'), null);
    assert.equal(findRepeatedPhrase('ok go ok go ok go ok go ok go ok go'), 'ok go');
});

test('WebNN perf check requires successful entries on the requested provider and device', () => {
    const entries = [
        { name: 'webnn.model.fetch' },
        { name: 'webnn.session.create', provider: 'webnn', device: 'gpu' },
        ...Array.from({ length: 25 }, (_, i) => ({ name: 'webnn.inference', model: 'unet', iteration: i, provider: 'webnn', device: 'gpu' }))
    ];
    checkWebNNPerf(entries, 'gpu', ['webnn.session.create', { name: 'webnn.inference', model: 'unet', min: 25 }]);
    assert.throws(() => checkWebNNPerf(entries, 'gpu', [{ name: 'webnn.inference', model: 'unet', min: 26 }]), /x26, got 25/);
    assert.throws(() => checkWebNNPerf(entries, 'gpu', ['webnn.context.create']), /Missing successful WebNN GPU metric: webnn.context.create/);
    assert.throws(() => checkWebNNPerf(entries, 'npu', ['webnn.session.create']), /Expected WebNN NPU but webnn.session.create ran on webnn gpu/);
    assert.throws(() => checkWebNNPerf([{ name: 'webnn.inference', provider: 'wasm', device: 'gpu' }], 'gpu', []), /ran on wasm gpu/);
    assert.throws(() => checkWebNNPerf([{ name: 'webnn.inference', model: 'unet', error: 'boom', provider: 'webnn', device: 'gpu' }], 'gpu', []), /webnn.inference \(unet\) failed: boom/);
});
