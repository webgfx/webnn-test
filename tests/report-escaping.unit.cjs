const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebNNRunner, escapeHtml, safeHttpUrl, formatTextResult, assertTestResults } = require('../src/util');

const payload = '<img src=x onerror="alert(1)">';

test('text results preserve model failure diagnostics and skip reasons', () => {
    assert.equal(formatTextResult({
        testName: 'Stem', result: 'ERROR', fullText: 'Mix mismatch\nrelative MAE 0.9999',
        subcases: { total: 1, passed: 0, failed: 1 }
    }), 'Stem: ERROR [0/1]\n  details: Mix mismatch\n    relative MAE 0.9999');
    assert.equal(formatTextResult({
        testName: 'SDXL', result: 'SKIP', details: 'No NPU support'
    }), 'SDXL: SKIP\n  details: No NPU support');
    assert.equal(formatTextResult({
        testName: 'WPT', result: 'FAIL', perfSummary: 'npu',
        failedSubtests: [{ name: 'add', status: 'FAIL' }]
    }), 'WPT: FAIL\n  perf: npu\n  - add: FAIL');
});

test('recorded failures fail the run while passes and unsupported cases do not', () => {
    assert.doesNotThrow(() => assertTestResults([{ result: 'PASS' }, { result: 'SKIP' }]));
    for (const result of ['ERROR', 'FAIL', 'UNKNOWN']) {
        assert.throws(() => assertTestResults([
            { testName: 'Working', result: 'PASS' },
            { testName: 'Broken', result, fullText: 'Device lost' }
        ]), /1 test case\(s\) failed:\nBroken: .*?\n  details: Device lost/);
    }
    assert.throws(() => assertTestResults([
        { testName: 'Partial', result: 'PASS', subcases: { total: 2, passed: 1, failed: 1 } }
    ]), /Partial/);
    assert.throws(() => assertTestResults([{ testName: 'Error', result: 'PASS', hasErrors: true }]), /Error/);
});

test('escapeHtml neutralizes markup and attribute quotes', () => {
    assert.equal(escapeHtml(payload), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(escapeHtml("a & 'b'"), 'a &amp; &#39;b&#39;');
    assert.equal(escapeHtml(42), '42');
});

test('safeHttpUrl keeps http(s) links and drops other schemes', () => {
    assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(safeHttpUrl('javascript:alert(1)'), '#');
    assert.equal(safeHttpUrl('not a url'), '#');
});

test('HTML report and subcase table escape page-derived result text', () => {
    const results = [{
        testName: `Model ${payload}`,
        testUrl: 'javascript:alert(1)',
        result: 'FAIL',
        details: `Answer: ${payload}`,
        fullText: `boom ${payload}`,
        hasErrors: true,
        subcases: { total: 1, passed: 0, failed: 1 },
        suite: 'model',
        device: 'gpu',
        previousResult: 'PASS',
        failedSubtests: [{ name: payload, status: payload, message: payload }],
        perfMetrics: { [payload]: { durationMs: 1, model: payload }, 'webnn.inference': [{ durationMs: 2, model: payload }] }
    }];
    const runner = new WebNNRunner(null);
    const html = runner.generateHtmlReport(['model'], null, results, null, 1, 1, null,
        { name: 'Chrome', channel: 'Canary', version: '1' }, null);
    assert.ok(!html.includes(payload), 'no raw payload in the report');
    assert.ok(html.includes(escapeHtml(payload)), 'payload is rendered as text');
    assert.ok(!html.includes('href="javascript:'), 'no javascript: links');

    const table = runner.generateSubcaseTable(['model'], results);
    assert.ok(!table.includes(payload));
    assert.ok(table.includes(escapeHtml(`Model ${payload}`)));
});
