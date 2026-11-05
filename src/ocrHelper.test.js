import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const helperSource = await readFile(new URL('./ocrHelper.js', import.meta.url), 'utf8');
const viewerSource = await readFile(new URL('./pdfViewer.js', import.meta.url), 'utf8');
// Load the actual text parsers without PDF.js/browser initialization or database access.
const parserSource = viewerSource.slice(
  viewerSource.indexOf('export function parseKUAFieldsFromText'),
  viewerSource.indexOf('export async function loadPDFFolder')
);
const parsers = await import(`data:text/javascript;base64,${Buffer.from(parserSource).toString('base64')}`);
let moduleId = 0;

async function setup(options = {}) {
  const calls = { requests: [], workers: 0, recognizes: [], crops: [], delays: [], cleared: 0 };
  let imageCount = 0;
  class MockImage {
    naturalWidth = 1200;
    naturalHeight = 1200;
    set src(value) {
      this.value = value;
      imageCount++;
      if (options.failImage?.(imageCount)) this.onerror();
      else this.onload();
    }
  }
  const bindings = {
    ...parsers,
    parseKUAFieldsFromText(...args) {
      assert.equal(args.length, 1, 'OCR must never pass filenames to the shared parser');
      return parsers.parseKUAFieldsFromText(...args);
    },
    fetch: async (url, init) => {
      calls.requests.push({ url, ...init });
      if (options.fetch) return options.fetch(url, init);
      throw new TypeError('Failed to fetch');
    },
    createWorker: async () => {
      calls.workers++;
      if (options.workerError) throw new Error(options.workerError);
      return {
        async recognize(image) {
          const index = calls.recognizes.length;
          calls.recognizes.push(image);
          return { data: { text: options.texts?.[index] || '', confidence: 85 } };
        }
      };
    },
    Image: MockImage,
    document: {
      createElement() {
        return {
          getContext: () => ({
            drawImage: (...args) => calls.crops.push(args.slice(1)),
            getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
            putImageData() {}
          }),
          toDataURL: () => `data:image/png;base64,crop${calls.crops.length}`
        };
      }
    },
    console: { warn() {} },
    setTimeout: (callback, delay) => {
      calls.delays.push(delay);
      return setTimeout(callback, options.fastTimeout ? 0 : delay);
    },
    clearTimeout: timer => {
      calls.cleared++;
      clearTimeout(timer);
    }
  };
  const key = `__ocrTest${moduleId++}`;
  globalThis[key] = bindings;
  const source = `const { createWorker, parseKUAFieldsFromText, extractNameFromColumnText, fetch, Image, document, console, setTimeout, clearTimeout } = globalThis['${key}'];\n` + helperSource
    .replace(/^import .* from 'tesseract\.js';\r?\n/m, '')
    .replace(/^import .* from '\.\/pdfViewer\.js';\r?\n/m, '');
  try {
    const helper = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    return { helper, calls };
  } finally {
    delete globalThis[key];
  }
}

const doc = {
  fileName: '1.pdf',
  dataURL: 'data:application/pdf;base64,not-an-image',
  pageImages: [1, 2, 3].map(n => ({ dataURL: `data:image/png;base64,page${n}` }))
};
const emptyFields = { noAkta: '', tglAkad: '', namaSuami: '', namaIstri: '' };
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
});

function assertEmpty(result) {
  for (const field of Object.keys(emptyFields)) assert.equal(result[field], '');
}

test('posts only the first two image data URLs and preserves local metadata', async () => {
  const payload = {
    success: true,
    data: { noAkta: '23/004/I/2020', tglAkad: '02-01-2020', namaSuami: 'ANDI', namaIstri: 'SITI' },
    rawText: 'document evidence',
    fieldDetails: { namaSuami: { confidence: 0.8, source: 'local-model' } },
    timings: { total: 1.2 },
    warnings: ['Periksa nama'],
    model: 'local-model'
  };
  const { helper, calls } = await setup({ fetch: async () => jsonResponse(payload) });
  const result = await helper.recognizeMultiPageAkta(doc);
  assert.deepEqual(JSON.parse(calls.requests[0].body), {
    fileName: '1.pdf', images: doc.pageImages.slice(0, 2).map(page => page.dataURL)
  });
  assert.equal(calls.requests[0].url, 'http://127.0.0.1:8000/api/extract');
  assert.equal(calls.requests[0].method, 'POST');
  assert.equal(calls.requests[0].headers['Content-Type'], 'application/json');
  assert.equal(calls.workers, 0);
  for (const [field, value] of Object.entries(payload.data)) assert.equal(result[field], value);
  for (const field of ['data', 'rawText', 'fieldDetails', 'timings', 'warnings', 'model']) {
    assert.deepEqual(result[field], payload[field]);
  }
  assert.equal(result.source, 'local');
  assert.equal(result.requiresReview, true);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(calls.delays, [45_000]);
  assert.equal(calls.cleared, 1);
});

for (const data of [emptyFields, {}, { namaSuami: 'ANDI' }]) {
  test(`successful empty/partial local data stays authoritative: ${JSON.stringify(data)}`, async () => {
    const { helper, calls } = await setup({ fetch: async () => jsonResponse({ success: true, data }) });
    const result = await helper.recognizeMultiPageAkta(doc);
    assert.equal(calls.workers, 0);
    for (const field of Object.keys(emptyFields)) assert.equal(result[field], data[field] || '');
    assert.equal(result.source, 'local');
    assert.equal(result.requiresReview, true);
    assert.ok(result.missingFields.length > 0);
  });
}

test('offline fallback never fabricates fields from a numeric filename', async () => {
  const { helper, calls } = await setup();
  const progress = [];
  const result = await helper.recognizeMultiPageAkta(doc, value => progress.push(value));
  assertEmpty(result);
  assert.equal(calls.workers, 1);
  assert.equal(result.source, 'tesseract');
  assert.equal(result.provenance.reason, 'network-error');
  assert.equal(result.requiresReview, true);
  assert.match(result.warnings[0], /Tesseract.*wajib ditinjau/);
  assert.ok(progress.some(value => value.status.includes('Tesseract')));
});

for (const status of [200, 503]) {
  test(`handles unavailable model/success false at HTTP ${status}`, async () => {
    const payload = { success: false, error: 'Model unavailable', warnings: ['Model belum dimuat'], timings: { total: 0 } };
    const { helper } = await setup({ fetch: async () => jsonResponse(payload, status) });
    const result = await helper.recognizeMultiPageAkta(doc);
    assertEmpty(result);
    assert.equal(result.source, 'tesseract');
    assert.deepEqual(result.localResponse, payload);
    assert.ok(result.warnings.includes('Model belum dimuat'));
    assert.ok(result.warnings.some(warning => warning.includes('Model unavailable')));
  });
}

test('non-JSON and invalid successful envelopes fall back explicitly', async () => {
  for (const response of [
    { ok: false, status: 502, json: async () => { throw new SyntaxError('not JSON'); } },
    jsonResponse({ success: true, data: null })
  ]) {
    const { helper } = await setup({ fetch: async () => response });
    const result = await helper.recognizeMultiPageAkta(doc);
    assert.equal(result.source, 'tesseract');
    assert.equal(result.provenance.reason, 'invalid-response');
    assertEmpty(result);
  }
});

for (const stallBody of [false, true]) {
  test(`45-second bound aborts ${stallBody ? 'stalled JSON body' : 'stalled fetch'}`, async () => {
    const { helper, calls } = await setup({
      fastTimeout: true,
      fetch: async () => stallBody
        ? { ok: true, status: 200, json: () => new Promise(() => {}) }
        : new Promise(() => {})
    });
    const result = await helper.recognizeMultiPageAkta(doc);
    assert.equal(result.provenance.reason, 'timeout');
    assert.equal(calls.requests[0].signal.aborted, true);
    assert.deepEqual(calls.delays, [45_000]);
    assert.equal(calls.cleared, 1);
  });
}

test('missing images/PDF bytes are not sent to the image-only API', async () => {
  const { helper, calls } = await setup();
  for (const input of [{}, { dataURL: doc.dataURL }]) {
    const result = await helper.recognizeMultiPageAkta(input);
    assertEmpty(result);
    assert.equal(result.source, 'none');
    assert.equal(result.requiresReview, true);
    assert.ok(result.warnings.length);
  }
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.workers, 0);
});

test('single image dataURL is accepted without assuming a PDF API', async () => {
  const { helper, calls } = await setup({ fetch: async () => jsonResponse({ success: true, data: emptyFields }) });
  await helper.recognizeMultiPageAkta({ fileName: 'scan.png', dataURL: doc.pageImages[0].dataURL });
  assert.deepEqual(JSON.parse(calls.requests[0].body).images, [doc.pageImages[0].dataURL]);
});

test('fallback extracts real OCR text without filename-based replacement', async () => {
  const text = 'Nomor Akta 23/004/I/2020\nTanggal Akad 02-01-2020\nNama Suami: ANDI\nNama Istri: SITI';
  const { helper } = await setup({ texts: [text] });
  const result = await helper.recognizeMultiPageAkta({ ...doc, pageImages: doc.pageImages.slice(0, 1) });
  assert.equal(result.noAkta, '23/004/I/2020');
  assert.equal(result.tglAkad, '02-01-2020');
  assert.equal(result.namaSuami, 'ANDI');
  assert.equal(result.namaIstri, 'SITI');
  assert.equal(result.rawText, text);
  assert.equal(result.fieldDetails.noAkta.source, 'tesseract');
});

test('missing husband name is not copied from the combined wife column', async () => {
  const { helper, calls } = await setup({ texts: ['', '', '', 'Nama lengkap: SITI'] });
  const result = await helper.recognizeMultiPageAkta(doc);
  assert.equal(result.namaSuami, '');
  assert.equal(result.namaIstri, 'SITI');
  const left = calls.crops[2];
  const right = calls.crops[3];
  assert.ok(left[0] + left[2] <= right[0], 'name crops must not overlap');
});

test('failed name crops do not OCR the original full page', async () => {
  const { helper, calls } = await setup({ failImage: count => count >= 3 });
  const result = await helper.recognizeMultiPageAkta(doc);
  assert.equal(calls.recognizes.length, 2);
  assert.equal(result.namaSuami, '');
  assert.equal(result.namaIstri, '');
});

test('Tesseract failure remains empty and carries review warnings', async () => {
  const { helper } = await setup({ workerError: 'OCR worker unavailable' });
  const result = await helper.recognizeMultiPageAkta(doc);
  assertEmpty(result);
  assert.equal(result.requiresReview, true);
  assert.ok(result.warnings.some(warning => warning.includes('OCR worker unavailable')));
});

for (const [payload, available] of [
  [{ status: 'ok', ocrAvailable: true }, true],
  [{ status: 'ok', ocrAvailable: false }, false],
  [{ status: 'ok' }, false],
  [{ status: 'ok', ocrAvailable: 'true' }, false],
  [{ status: 'error', ocrAvailable: true }, false],
  [null, false]
]) {
  test(`health requires status ok and boolean model availability: ${JSON.stringify(payload)}`, async () => {
    const { helper, calls } = await setup({ fetch: async () => jsonResponse(payload) });
    const result = await helper.checkLocalAIService();
    assert.equal(result.available, available);
    assert.equal(calls.requests[0].url, 'http://127.0.0.1:8000/health');
    assert.equal(calls.requests[0].method, 'GET');
    assert.equal(calls.requests[0].cache, 'no-store');
    assert.deepEqual(calls.delays, [2_000]);
    assert.equal(calls.cleared, 1);
    assert.equal(calls.workers, 0);
  });
}

test('health handles connection refused, HTTP errors and malformed JSON without throwing', async () => {
  for (const fetch of [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => jsonResponse({ status: 'ok', ocrAvailable: true }, 503),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } })
  ]) {
    const { helper, calls } = await setup({ fetch });
    assert.equal((await helper.checkLocalAIService()).available, false);
    assert.equal(calls.cleared, 1);
  }
});

for (const stallBody of [false, true]) {
  test(`health timeout bounds ${stallBody ? 'JSON body' : 'fetch'} and aborts within two seconds`, async () => {
    const { helper, calls } = await setup({
      fastTimeout: true,
      fetch: async () => stallBody
        ? { ok: true, json: () => new Promise(() => {}) }
        : new Promise(() => {})
    });
    assert.equal((await helper.checkLocalAIService()).available, false);
    assert.equal(calls.requests[0].signal.aborted, true);
    assert.deepEqual(calls.delays, [2_000]);
    assert.equal(calls.cleared, 1);
  });
}

test('health shares in-flight probes but refreshes after completion', async () => {
  let complete;
  const { helper, calls } = await setup({ fetch: () => new Promise(resolve => { complete = resolve; }) });
  const first = helper.checkLocalAIService();
  const overlapping = helper.checkLocalAIService();
  assert.equal(first, overlapping);
  assert.equal(calls.requests.length, 1);
  complete(jsonResponse({ status: 'ok', ocrAvailable: true }));
  assert.equal((await first).available, true);
  const next = helper.checkLocalAIService();
  assert.equal(calls.requests.length, 2);
  complete(jsonResponse({ status: 'ok', ocrAvailable: false }));
  assert.equal((await next).available, false);
});
