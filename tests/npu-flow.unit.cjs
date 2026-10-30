const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelRunner, expandModelCases } = require('../src/model');

// A fake page that mimics the webnn-samples image_classification UI on a WebNN NPU device:
// selecting NPU disables float32 and re-selects float16 asynchronously (as upstream's device handler
// does after its preferred-layout query), and models are offered per data type.
function fakeImageClassificationPage({ buildDataType = dataType => dataType, label = 'lesser panda, red panda' } = {}) {
    const state = { device: null, dataType: 'float32', model: null, pending: 0, constants: {}, result: null, clickedDevices: [] };
    const models = { float32: ['mobilenet', 'squeezenet', 'resnet50v2'], float16: ['mobilenet', 'squeezenet', 'resnet50v2', 'resnet50v1', 'efficientnet'] };
    const available = id => {
        if (['cpu', 'gpu', 'npu'].includes(id)) return true;
        if (id === 'float32') return state.device !== 'npu';
        if (id === 'float16') return true;
        if (id === 'uint8') return false;
        return (models[state.dataType] || []).includes(id);
    };
    const click = id => {
        if (['cpu', 'gpu', 'npu'].includes(id)) {
            state.clickedDevices.push(id);
            state.device = id;
            state.model = null;
            state.pending = 1;
            // The handler finishes after a context creation and then re-selects the data type.
            setTimeout(() => { state.dataType = id === 'npu' ? 'float16' : 'float32'; state.pending = 0; }, 30);
        } else if (['float32', 'float16', 'uint8'].includes(id)) {
            if (available(id)) state.dataType = id;
        } else if (available(id)) {
            state.model = id;
            state.constants[buildDataType(state.dataType)] = 50;
            state.result = { label, prob: '99.22%' };
        }
    };
    const locator = selector => {
        const id = (/\[id="([^"]+)"\]/.exec(selector) || [])[1];
        const loc = { first: () => loc, count: async () => 1, click: async () => click(id) };
        return loc;
    };
    const page = {
        state,
        addInitScript: async () => {},
        goto: async () => { Object.assign(state, { device: 'cpu', dataType: 'float32', model: null, result: null, constants: {} }); },
        isClosed: () => false,
        on() {}, off() {}, removeListener() {},
        locator,
        waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))),
        waitForFunction: async () => ({ jsonValue: async () => (state.result ? { compute: '5.00 ms' } : { error: 'no result' }) }),
        evaluate: async (fn, arg) => {
            const source = fn.toString();
            if (fn.name === 'readSampleStateInPage') {
                return { pending: state.pending, controls: `${state.device}|${state.dataType}|${state.model}` };
            }
            if (fn.name === 'installGraphCaptureInPage') { state.constants = {}; return; }
            if (source.includes('offsetParent')) return available(arg);
            if (source.includes('.checked')) return state.dataType === arg;
            if (source.includes("innerText = ''")) return;
            if (source.includes('loadTime')) return { load: '1 ms', build: '2 ms', compute: '5.00 ms' };
            if (source.includes('__webnnConstantTypes')) return state.constants;
            if (source.includes('label0')) return state.result || {};
            throw new Error(`Unexpected evaluate: ${source.slice(0, 80)}`);
        }
    };
    return page;
}

async function withEnv(env, fn) {
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('NPU image classification run: fp16 variants pass, float32 is skipped before the browser', async () => {
    await withEnv({ DEVICE: 'npu', MODEL_CASE: 'ic-sample,ic-sample:mobilenet-fp32+resnet50v1-fp16', MODEL_VARIANTS: 'default' }, async () => {
        const page = fakeImageClassificationPage();
        const runner = new ModelRunner(page);
        const results = await runner.runModelTests();
        assert.deepEqual(results.map(r => [r.testName, r.result]), [
            ['Image Classification [MobileNet V2 / float16]', 'PASS'],
            ['Image Classification [MobileNet V2 / float32]', 'SKIP'],
            ['Image Classification [ResNet50 V1 / float16]', 'PASS']
        ]);
        assert.match(results[0].details, /Top-1: lesser panda.*Graph constants: float16 x50/);
        assert.match(results[1].details, /No WebNN NPU support in this variant/);
        assert.deepEqual(page.state.clickedDevices, ['npu', 'npu'], 'both runnable variants selected the NPU');
    });
});

test('NPU image classification run: a data type the NPU UI disables is a dynamic SKIP', async () => {
    await withEnv({ DEVICE: 'npu' }, async () => {
        const runner = new ModelRunner(fakeImageClassificationPage());
        // Bypass the declared devices to exercise the runner's own availability check.
        const [item] = expandModelCases(runner.models, { filter: 'ic-sample:mobilenet-fp32', device: 'cpu' });
        const results = [];
        await runner.runSampleImageClassification(results, item.caseDef, item.caseDef.variant);
        assert.equal(results[0].result, 'SKIP');
        assert.match(results[0].details, /does not offer float32 on WebNN NPU/);
    });
});

test('the data type is chosen only after the async device handler re-selects its default', async () => {
    await withEnv({ DEVICE: 'gpu' }, async () => {
        const page = fakeImageClassificationPage();
        const runner = new ModelRunner(page);
        const [item] = expandModelCases(runner.models, { filter: 'ic-sample:mobilenet-fp16', device: 'gpu' });
        const results = [];
        await runner.runSampleImageClassification(results, item.caseDef, item.caseDef.variant);
        assert.equal(results[0].result, 'PASS');
        assert.match(results[0].details, /Graph constants: float16 x50/);
    });
});

test('NPU image classification run fails when the graph ignores the float16 selection', async () => {
    await withEnv({ DEVICE: 'npu' }, async () => {
        const runner = new ModelRunner(fakeImageClassificationPage({ buildDataType: () => 'float32' }));
        const [item] = expandModelCases(runner.models, { filter: 'ic-sample:mobilenet-fp16', device: 'npu' });
        await assert.rejects(runner.runSampleImageClassification([], item.caseDef, item.caseDef.variant),
            /Selected float16 but the graph was built from float32 x50 constants/);
    });
});

test('NPU image classification run fails on a wrong top-1 class', async () => {
    await withEnv({ DEVICE: 'npu' }, async () => {
        const runner = new ModelRunner(fakeImageClassificationPage({ label: 'giant panda, panda' }));
        const [item] = expandModelCases(runner.models, { filter: 'ic-sample:mobilenet-fp16', device: 'npu' });
        await assert.rejects(runner.runSampleImageClassification([], item.caseDef, item.caseDef.variant),
            /Expected top-1 class "lesser panda" but got "giant panda, panda"/);
    });
});
