const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ModelRunner, expandModelCases } = require('../src/model');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Like a Playwright Locator with no action timeout: reads and state checks wait forever for a missing
// element. expect(locator).toBeEnabled() only needs the class name and _expect().
class Locator {
    constructor(find, selector) {
        this.find = find;
        this.selector = selector;
    }
    first() { return this; }
    attached() {
        const element = this.find();
        return element ? Promise.resolve(element) : new Promise(() => {});
    }
    async waitFor() { await this.attached(); }
    async isVisible() { return Boolean(this.find()); }
    async isEnabled() { return !(await this.attached()).disabled; }
    async textContent() { return (await this.attached()).textContent; }
    async innerText() { return (await this.attached()).textContent; }
    async click() { (await this.attached()).onClick(); }
    async screenshot() { return Buffer.from(this.selector); }
    async _expect() { return { matches: !(await this.attached()).disabled }; }
}

// A fake SDXL Turbo page. The 'new' layout shows each image's result in #data1-#data4, 'old' shows the
// total in #total_data, and 'none' shows neither. Canvases listed in `blank` screenshot as blank. With
// `failAt`, generating that image (0-based) fails the way the demo does: it logs an [Error] line to #log
// and leaves Generate Image disabled.
function fakeSdxlPage({
    layout = 'new',
    placeholder = '... ms',
    outputs = ['1234.5ms', '1240.25ms', '1251ms', '1262.75ms'],
    blank = [],
    failAt = null
} = {}) {
    const page = new EventEmitter();
    const elements = { log: { innerText: '' } };
    if (layout === 'new') for (let i = 1; i <= 4; i++) elements[`data${i}`] = { textContent: '' };
    if (layout === 'old') elements.total_data = { textContent: '' };
    const emitPerf = name => page.emit('console', {
        type: () => 'log',
        text: () => `[WebNN:Perf] ${JSON.stringify({ name, provider: 'webnn', device: 'gpu', durationMs: 1 })}`
    });

    const load = { textContent: 'Load Models', disabled: false };
    const generate = { textContent: 'Generate Image', disabled: true };
    load.onClick = () => {
        load.disabled = true;
        setTimeout(() => {
            emitPerf('webnn.session.create');
            generate.disabled = false;
        }, 10);
    };
    generate.onClick = async () => {
        generate.disabled = true;
        for (let i = 1; i <= 4; i++) if (elements[`data${i}`]) elements[`data${i}`].textContent = placeholder;
        if (elements.total_data) elements.total_data.textContent = '...';
        for (let j = 0; j < 4; j++) {
            await delay(5);
            if (j === failAt) {
                elements.log.innerText += "\n[Error] Error: Failed to execute 'readTensor' on 'MLContext'";
                return;
            }
            emitPerf('webnn.inference');
            if (elements[`data${j + 1}`]) elements[`data${j + 1}`].textContent = outputs[j];
        }
        if (elements.total_data) elements.total_data.textContent = '5000ms';
        // Re-enable late so a runner that ignores the button would check the images too early.
        await delay(50);
        generate.disabled = false;
    };

    const document = {
        querySelector: selector => (selector.startsWith('#') && elements[selector.slice(1)]) || null,
        querySelectorAll: selector => (selector === 'button' ? [load, generate] : [])
    };
    const find = (selector, options) => (options && options.hasText
        ? () => [load, generate].find(button => button.textContent.includes(options.hasText))
        : () => document.querySelector(selector));

    return Object.assign(page, {
        imagesCheckedWhileGenerating: 0,
        goto: async () => {},
        waitForLoadState: async () => {},
        isClosed: () => false,
        waitForTimeout: ms => delay(Math.min(ms, 10)),
        locator: (selector, options) => new Locator(find(selector, options), selector),
        evaluate: async (fn, arg) => {
            if (fn.name === 'analyzeImagesInPage') {
                if (generate.disabled) page.imagesCheckedWhileGenerating++;
                const selector = Buffer.from(arg.a, 'base64').toString();
                return { width: 512, height: 512, std: blank.includes(selector) ? 0 : 40 };
            }
            // Run the runner's in-page function against the fake DOM.
            globalThis.document = document;
            try {
                return fn(arg);
            } finally {
                delete globalThis.document;
            }
        }
    });
}

// Runs the sdxl case on WebNN GPU; pollTimeout caps every poll so a never-completing page fails fast.
async function runSdxl(page, { pollTimeout } = {}) {
    const previous = process.env.DEVICE;
    process.env.DEVICE = 'gpu';
    try {
        const runner = new ModelRunner(page);
        if (pollTimeout) {
            const pollUntil = runner.pollUntil;
            runner.pollUntil = function (fn, options) {
                return pollUntil.call(this, fn, { ...options, timeout: Math.min(options.timeout, pollTimeout) });
            };
        }
        const [item] = expandModelCases(runner.models, { filter: 'sdxl', device: 'gpu' });
        const results = [];
        await runner.runModelSdxl(results, item.caseDef);
        return results;
    } finally {
        if (previous === undefined) delete process.env.DEVICE;
        else process.env.DEVICE = previous;
    }
}

test('SDXL passes once #data1-#data4 show their times and Generate Image is enabled again', { timeout: 10000 }, async () => {
    const page = fakeSdxlPage();
    const [result] = await runSdxl(page);
    assert.equal(result.result, 'PASS');
    assert.equal(result.details, 'Generated 4 images. Image totals: 1234.5ms, 1240.25ms, 1251ms, 1262.75ms');
    assert.equal(page.imagesCheckedWhileGenerating, 0);
});

test('SDXL passes without per-image times when the page shows only image numbers', { timeout: 10000 }, async () => {
    const [result] = await runSdxl(fakeSdxlPage({ placeholder: '...', outputs: ['1', '2', '3', '4'] }));
    assert.equal(result.result, 'PASS');
    assert.equal(result.details, 'Generated 4 images. Per-image times not shown');
});

test('an NSFW-flagged SDXL image completes generation and the image checks still decide', { timeout: 10000 }, async () => {
    const outputs = ['1234.5ms', '1240.25ms', '1251ms · NSFW', '1262.75ms'];
    const [result] = await runSdxl(fakeSdxlPage({ outputs }));
    assert.equal(result.result, 'PASS');
    assert.equal(result.details,
        'Generated 4 images. Image totals: 1234.5ms, 1240.25ms, 1251ms, 1262.75ms. Safety checker flagged image 3');

    await assert.rejects(runSdxl(fakeSdxlPage({ outputs, blank: ['#img_canvas_2'] })), /Image 3 looks blank/);
});

test('SDXL still completes on the older page with a single #total_data', { timeout: 10000 }, async () => {
    const [result] = await runSdxl(fakeSdxlPage({ layout: 'old' }));
    assert.equal(result.result, 'PASS');
    assert.equal(result.details, 'Generated 4 images. Total time: 5000ms');
});

test('SDXL fails at the poll deadline instead of hanging when no result element exists', { timeout: 10000 }, async () => {
    // The last snapshot may be taken before or after the fake re-enables Generate Image.
    await assert.rejects(runSdxl(fakeSdxlPage({ layout: 'none' }), { pollTimeout: 200 }), {
        message: new RegExp('^Generation did not complete: #data1-#data4 / #total_data not populated ' +
            '\\(#data1-#data4: missing, missing, missing, missing; #total_data: missing; Generate Image (enabled|disabled)\\)$')
    });
});

test('SDXL fails fast with the logged error when generation throws and Generate Image stays disabled', { timeout: 10000 }, async () => {
    // Without the #log check the poll would run to its (capped) deadline and report "did not complete".
    await assert.rejects(runSdxl(fakeSdxlPage({ failAt: 1 }), { pollTimeout: 5000 }), {
        message: "Generation failed: [Error] Error: Failed to execute 'readTensor' on 'MLContext'"
    });
});

test('polled reads of a missing SAM, Whisper or SD 1.5 element return an empty string at once', { timeout: 10000 }, async () => {
    const page = fakeSdxlPage({ layout: 'none' });
    const runner = new ModelRunner(page);
    const pending = Symbol('pending');
    assert.equal(await Promise.race([page.locator('#latency').innerText(), delay(50).then(() => pending)]), pending,
        'a locator read waits for the missing element');
    for (const [selector, property] of [['#decoder_latency', 'innerText'], ['#latency', 'innerText'], ['#totalrun']]) {
        assert.equal(await runner.readText(selector, property), '', selector);
    }
});

test('pollUntil returns null at its deadline even if a call never settles', { timeout: 10000 }, async () => {
    const runner = new ModelRunner({ waitForTimeout: ms => delay(Math.min(ms, 10)) });
    const start = Date.now();
    assert.equal(await runner.pollUntil(() => new Promise(() => {}), { timeout: 50 }), null);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
});
