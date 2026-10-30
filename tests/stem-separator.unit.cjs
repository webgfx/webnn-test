const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelRunner, validateStemWav, parseSampleCount, parseMixError, checkStemMix } = require('../src/model');

function wav(samples = [0.25, -0.5, 0, 0]) {
    const buffer = Buffer.alloc(44 + samples.length * 4);
    buffer.write('RIFF');
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(3, 20);
    buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(44100, 24);
    buffer.writeUInt32LE(44100 * 8, 28);
    buffer.writeUInt16LE(8, 32);
    buffer.writeUInt16LE(32, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length * 4, 40);
    samples.forEach((value, i) => buffer.writeFloatLE(value, 44 + i * 4));
    return buffer;
}

test('stem WAV validation returns interleaved samples from both channels', () => {
    assert.deepEqual([...validateStemWav(wav([0, 0.5, -0.25, 0]), 2)], [0, 0.5, -0.25, 0]);
});

test('stem WAV validation rejects invalid format, truncation and wrong duration', () => {
    assert.throws(() => validateStemWav(Buffer.alloc(10), 2), /stereo float32/);
    const pcm = wav();
    pcm.writeUInt16LE(1, 20);
    assert.throws(() => validateStemWav(pcm, 2), /stereo float32/);
    const wrongRate = wav();
    wrongRate.writeUInt32LE(16000, 24);
    assert.throws(() => validateStemWav(wrongRate, 2), /stereo float32/);
    assert.throws(() => validateStemWav(wav().subarray(0, 48), 2), /length/);
    assert.throws(() => validateStemWav(wav(), 3), /length/);
});

test('stem WAV validation rejects NaN and infinity in either channel', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
        assert.throws(() => validateStemWav(wav([0, value]), 1), /non-finite/);
    }
});

test('sample count parsing accepts locale digit grouping', () => {
    for (const text of ['89,523 samples (2.03s)', '89.523 samples (2,03s)', '89\u202f523 samples (2,03s)', '89523 samples']) {
        assert.equal(parseSampleCount(text), 89523);
    }
    assert.throws(() => parseSampleCount('unknown'), /sample count/);
});

test('mix error parsing reads the page exponent and rejects missing or invalid values', () => {
    assert.equal(parseMixError('Stem statistics sum-of-stems vs mix MAE: 1.234e-5 (small ≈ correct overlap-add)'), 1.234e-5);
    for (const text of ['Stem statistics', 'sum-of-stems vs mix MAE: NaN', 'sum-of-stems vs mix MAE: Infinity']) {
        assert.throws(() => parseMixError(text), /MAE/);
    }
});

test('stem mix check normalizes MAE by the summed stem level', () => {
    const stems = [[0.25, -0.5], [0.25, -0.5], [0, 0], [0, 0]];
    assert.equal(checkStemMix(stems, 0.375, 0.5), 0.5);
    assert.throws(() => checkStemMix(stems, 0.4, 0.5), /do not match the input mix/);
    assert.throws(() => checkStemMix([[0], [0], [0], [0]], 0), /silent/);
});

test('Stem Separator skips WebNN CPU rather than falling back to WASM', async () => {
    const previous = { DEVICE: process.env.DEVICE, MODEL_CASE: process.env.MODEL_CASE };
    process.env.DEVICE = 'cpu';
    process.env.MODEL_CASE = 'stem';
    try {
        // A skipped case never touches the page.
        const runner = new ModelRunner(null);
        const results = await runner.runModelTests();
        assert.equal(results.length, 1);
        assert.equal(results[0].result, 'SKIP');
        assert.deepEqual(results[0].subcases, { total: 0, passed: 0, failed: 0 });
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
