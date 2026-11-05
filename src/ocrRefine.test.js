import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recognizeRegions } from '../ocr_refine.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = path.join(root, 'ocr_refine.mjs');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=';
const region = (id = 'field', kind = 'name') => ({ id, kind, image });
const checkModels = async () => {};

function stub(outputs = []) {
  const calls = { factory: [], parameters: [], images: [], terminated: 0 };
  const worker = {
    async setParameters(parameters) { calls.parameters.push(parameters); },
    async recognize(input) {
      calls.images.push(input);
      return outputs[calls.images.length - 1] ?? {};
    },
    async terminate() { calls.terminated++; },
  };
  const factory = async (...args) => {
    calls.factory.push(args);
    return worker;
  };
  return { calls, worker, factory };
}

function cli(input, script = helper) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI test timed out')); }, 10000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('uses absolute local models, single-line OCR, and resets numeric whitelist for every region', async () => {
  const { calls, factory } = stub();
  const kinds = ['day', 'name', 'year', 'month', 'number'];
  await recognizeRegions(kinds.map((kind, index) => region(`field${index}`, kind)), { createWorker: factory, checkModels });
  assert.equal(calls.factory.length, 1);
  const [languages, oem, options] = calls.factory[0];
  assert.equal(languages, 'ind+eng');
  assert.equal(oem, 1);
  assert.ok(path.isAbsolute(options.langPath));
  assert.equal(path.resolve(options.langPath), path.resolve(root));
  assert.equal(options.gzip, false);
  assert.equal(options.cacheMethod, 'none');
  assert.equal(options.logging, false);
  assert.equal(typeof options.logger, 'function');
  assert.equal(typeof options.errorHandler, 'function');
  assert.deepEqual(calls.parameters.map(parameters => parameters.tessedit_char_whitelist), ['0123456789', '', '0123456789', '', '']);
  for (const parameters of calls.parameters) {
    assert.equal(parameters.tessedit_pageseg_mode, '7');
    assert.equal(parameters.preserve_interword_spaces, '1');
    assert.equal(parameters.user_defined_dpi, '216');
  }
  assert.ok(calls.images.every(input => Buffer.isBuffer(input) && input.equals(Buffer.from(image.split(',')[1], 'base64'))));
  assert.equal(calls.terminated, 1);
});

test('returns only trimmed OCR output without fabricating or normalizing field values', async () => {
  const { factory } = stub([
    { data: { text: '  Example, A. B.-\n', confidence: 73.5 } },
    { data: { text: '  09 / XX  \n', confidence: 42 } },
    { data: { text: ' \n', confidence: 0 } },
    {},
    { data: { text: null, confidence: NaN } },
    { data: { text: 'high', confidence: 101 } },
    { data: { text: 'low', confidence: -1 } },
  ]);
  assert.deepEqual(await recognizeRegions([
    region('name'), region('day', 'day'), region('month', 'month'), region('year', 'year'), region('number', 'number'),
    region('high'), region('low'),
  ], { createWorker: factory, checkModels }), { results: [
    { id: 'name', text: 'Example, A. B.-', confidence: 73.5 },
    { id: 'day', text: '09 / XX', confidence: 42 },
    { id: 'month', text: '', confidence: 0 },
    { id: 'year', text: '', confidence: 0 },
    { id: 'number', text: '', confidence: 0 },
    { id: 'high', text: 'high', confidence: 100 },
    { id: 'low', text: 'low', confidence: 0 },
  ] });
});

test('validates the entire batch before creating a worker', async () => {
  const { calls, factory } = stub();
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  Buffer.from(image.split(',')[1], 'base64').copy(oversized);
  const invalid = [
    undefined, null, {}, Array.from({ length: 9 }, (_, index) => region(`field${index}`)),
    [null], [region('')], [region('../file')], [region('x'.repeat(65))],
    [region(), region()], [region('field', 'unknown')],
    [{ ...region(), image: 'https://example.invalid/image.png' }],
    [{ ...region(), image: 'file:///image.png' }],
    [{ ...region(), image: 'data:image/png;base64,' }],
    [{ ...region(), image: 'data:image/png;base64,!!!!' }],
    [{ ...region(), image: 'data:image/png;base64,aGVsbG8=' }],
    [{ ...region(), image: 'data:image/png;base64,' + oversized.toString('base64') }],
    [region('valid'), { ...region('invalid'), image: null }],
  ];
  for (const regions of invalid) {
    await assert.rejects(recognizeRegions(regions, {
      createWorker: factory,
      checkModels: async () => { assert.fail('Invalid input must not check models'); },
    }));
  }
  assert.equal(calls.factory.length, 0);
});

test('accepts at most eight regions and skips worker creation for an empty batch', async () => {
  const { calls, factory } = stub();
  assert.deepEqual(await recognizeRegions([], { createWorker: factory, checkModels }), { results: [] });
  assert.equal(calls.factory.length, 0);
  const result = await recognizeRegions(Array.from({ length: 8 }, (_, index) => region(`field${index}`)), { createWorker: factory, checkModels });
  assert.equal(result.results.length, 8);
  assert.equal(calls.terminated, 1);
});

for (const method of ['setParameters', 'recognize']) {
  test(`terminates the worker when ${method} fails without returning partial results`, async () => {
    const { calls, worker, factory } = stub();
    worker[method] = async () => { throw new Error(`${method} failed`); };
    await assert.rejects(recognizeRegions([region()], { createWorker: factory, checkModels }), new RegExp(`${method} failed`));
    assert.equal(calls.terminated, 1);
  });
}

test('propagates worker initialization failures', async () => {
  await assert.rejects(recognizeRegions([region()], {
    createWorker: async () => { throw new Error('initialization failed'); },
    checkModels,
  }), /initialization failed/);
});

test('CLI emits JSON only on success and errors only on stderr', async () => {
  assert.deepEqual(await cli('{"regions":[]}'), { code: 0, stdout: '{"results":[]}\n', stderr: '' });
  for (const input of ['not JSON', 'null', '{}', JSON.stringify({ regions: [{ ...region(), image: 'https://example.invalid/image.png' }] })]) {
    const result = await cli(input);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^OCR refinement failed:/);
  }
});

test('CLI fails on missing local models instead of attempting a download', async () => {
  // Keep the temporary helper under the project so its installed dependency resolves.
  const directory = await mkdtemp(path.join(root, '.ocr-refine-test-'));
  try {
    const script = path.join(directory, 'ocr_refine.mjs');
    await copyFile(helper, script);
    const result = await cli(JSON.stringify({ regions: [region()] }), script);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Required local model is missing or unreadable:/);
    assert.ok(result.stderr.includes(path.join(directory, 'ind.traineddata')));
    assert.doesNotMatch(result.stderr, /https?:\/\/|downloading/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
