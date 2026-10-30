const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebNNRunner, escapeHtml, safeHttpUrl } = require('../src/util');

const payload = '<img src=x onerror="alert(1)">';

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
