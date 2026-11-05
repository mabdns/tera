import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { evaluateRecord, calculateSimilarity, normalizeDateToStandard } from './validation.js';

const mainSource = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const viewerSource = await readFile(new URL('./pdfViewer.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('./style.css', import.meta.url), 'utf8');
const withoutImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const fields = { noAkta: '17/002/I/2020', tglAkad: '02-01-2020', namaSuami: 'ALI bin UMAR', namaIstri: 'SITI binti HASAN' };
const empty = Object.fromEntries(Object.keys(fields).map(key => [key, '']));
const metadata = { sourceVersion: 2, source: 'local', warnings: ['Review scan'], fieldDetails: { namaSuami: { suggestions: ['ALI bin UMAR'] } }, timings: { total: 1 }, requiresReview: true };

function makeDoc(extracted = null) {
  return { id: 'pdf_folder__1.pdf', sourceVersion: 2, index: 0, num: 1, fileName: '1.pdf', fileSize: '1 KB', dataURL: 'data:image/png;base64,scan', pageImages: [{ dataURL: 'data:image/png;base64,scan' }], numPages: 1, extracted };
}

function makeRecord(doc = makeDoc()) {
  return { id: doc.id, sourceVersion: 2, fileName: doc.fileName, book: { ...empty }, entry: { ...empty }, statusVerifikasi: 'Belum Diperiksa', pdfDoc: doc };
}

function setupMain(options = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      handlers: {}, matches: {}, style: {}, dataset: {}, innerHTML: '', innerText: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelectorAll(selector) { return this.matches[selector] || []; },
      querySelector(selector) { return this.matches[selector]?.[0] || null; },
      appendChild() {}, setAttribute() {}, getAttribute() { return ''; },
      scrollTo() {}, scrollBy() {}
    });
    return elements.get(id);
  }
  const calls = { saved: [], notifications: [], ocr: 0, autoSaves: 0, timers: new Map(), windowEvents: {}, health: 0, viewed: [], scans: [] };
  let timerId = 0;
  const context = vm.createContext({
    console, localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, documentElement: element('root') },
    window: { addEventListener(event, handler) { calls.windowEvents[event] = handler; } },
    setTimeout(callback, delay) { const id = ++timerId; calls.timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { calls.timers.delete(id); },
    calculateSimilarity, normalizeDateToStandard,
    checkLocalAIService: async () => { calls.health++; return options.health ? options.health() : { available: false, reason: 'offline' }; },
    preRenderAdjacentDoc() {},
    alert: message => { throw new Error(`Unexpected alert: ${message}`); },
    recognizeMultiPageAkta: async () => {
      calls.ocr++;
      return options.ocrResult ?? { ...empty, ...metadata };
    },
    saveRenderedScanToDB: async (...args) => { calls.saved.push(plain(args)); },
    loadPDFFolder: async () => options.docs || [makeDoc()],
    getLoadedFolderName: () => '2016 - 11',
    savePDFFilesToDB: async () => {},
    renderPDFDocPage: async () => options.rendered || { extracted: options.vector || {} },
    evaluateRecord,
    getKuaVerifiedRecord: () => { throw new Error('Automatic database lookup is forbidden'); },
    cleanPersonName: () => { throw new Error('Backend names must not be rewritten'); },
    calls
  });
  vm.runInContext(withoutImports(mainSource), context);
  vm.runInContext(`
    const actualUpdateStats = updateStats;
    const actualRenderAll = renderAll;
    const actualRenderNavigation = renderNavigation;
    renderAll = () => {};
    renderNavigation = () => {};
    updateStats = () => {};
    refreshIcons = () => {};
    triggerAutoSave = () => { calls.autoSaves++; };
    showNotification = (...args) => calls.notifications.push(args);
  `, context);
  const api = vm.runInContext(`({ state, setupEvents, applyExtractionResult, mergeExtractedData,
    hasExtractedFields, needsAktaOCR, renderExtractionReview, renderProofreadingInspector,
    renderProofreadingTable, renderProofreadingDetail, selectTableRecord, setRecordFilter,
    renderDocumentViewer, initLocalAIStatusWatcher, renderAll: actualRenderAll,
    triggerFastOnDemandOCR, handlePDFFolderUpload, getFilteredRecords, approveRecord,
    updateStats: actualUpdateStats })`, context);
  // Existing OCR tests exercise the detail form; restoration tests explicitly select the table.
  api.initialProofreadTab = api.state.proofreadTab;
  api.state.proofreadTab = options.tab || 'detail';
  return { api, calls, element, context };
}

function setupViewer(options = {}) {
  const saves = [];
  const context = vm.createContext({
    console, URL,
    pdfjsLib: {
      GlobalWorkerOptions: {},
      getDocument: () => ({ promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 100, height: 100 }),
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: async () => ({ items: [{ str: options.text || 'Unrelated text' }] })
        })
      }) })
    },
    document: { createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/png;base64,scan' }) },
    loadRenderedScanFromDB: async () => options.cached || null,
    saveRenderedScanToDB: async (...args) => { saves.push(plain(args)); }
  });
  vm.runInContext(withoutImports(viewerSource).replaceAll('import.meta.url', "'file:///frontend/pdfViewer.js'"), context);
  const api = vm.runInContext('({ parseKUAFieldsFromText, restorePDFDocuments, renderPDFDocPage })', context);
  return { api, saves };
}

test('parser ignores numeric filenames and never invents Akta fields', () => {
  const { api } = setupViewer();
  for (const fileName of ['', '1.pdf', '251.pdf', '9999.pdf']) {
    assert.deepEqual(plain(api.parseKUAFieldsFromText('', fileName)), {});
    assert.deepEqual(plain(api.parseKUAFieldsFromText('Unrelated scan text', fileName)), {});
    const actual = api.parseKUAFieldsFromText('Nomor Akta 17/002/I/2020\nTanggal Akad 02-01-2020', fileName);
    assert.equal(actual.noAkta, fields.noAkta);
    assert.equal(actual.tglAkad, fields.tglAkad);
    assert.equal(actual.namaSuami, undefined);
    assert.equal(actual.namaIstri, undefined);
  }
});

test('folder upload initializes fields only from extraction, retaining administrative IDs', async () => {
  const docs = [makeDoc(), { ...makeDoc({ ...fields, ...metadata }), id: 'pdf_folder__2.pdf', num: 2, fileName: '2.pdf' }];
  const { api } = setupMain({ docs });
  await api.handlePDFFolderUpload([{ name: '1.pdf' }]);
  assert.deepEqual(plain(api.state.records[0].book), empty);
  assert.deepEqual(plain(api.state.records[0].entry), empty);
  assert.equal(api.state.records[0].noPorporasi, 'SB-2016-0001');
  assert.deepEqual(plain(api.state.records[1].book), fields);
  assert.ok(api.state.records.every(record => record.statusVerifikasi === 'Belum Diperiksa'));
});

test('partial/empty extraction preserves existing fields and persists all review metadata', () => {
  const { api, calls } = setupMain();
  const doc = makeDoc({ ...fields, sourceVersion: 2, source: 'pdf-text' });
  const record = makeRecord(doc);
  record.book = { ...fields };
  record.entry = { ...fields };
  api.applyExtractionResult(record, { ...empty, ...metadata });
  assert.deepEqual(record.book, fields);
  assert.deepEqual(record.entry, fields);
  for (const key of Object.keys(fields)) assert.equal(doc.extracted[key], fields[key]);
  for (const key of Object.keys(metadata)) assert.deepEqual(plain(doc.extracted[key]), metadata[key]);
  assert.deepEqual(plain(doc.extracted.latestFields), empty);
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0][4].latestFields, empty);
  assert.equal(api.hasExtractedFields(metadata), false);
  assert.equal(api.hasExtractedFields({ ...empty, ...metadata }), false);
});

test('pending extraction is not shown as clean until a manual verification decision', () => {
  const { api, element } = setupMain();
  const record = makeRecord(makeDoc({ ...fields, ...metadata }));
  record.book = { ...fields };
  record.entry = { ...fields };
  api.state.records = [record];
  api.state.spreadsheetLoaded = true;
  api.renderProofreadingInspector();
  assert.ok(element('proofread-content').innerHTML.includes('Hasil Ekstraksi — Belum Diperiksa'));
  api.updateStats();
  assert.equal(element('stat-clean').innerText, 0);
  api.state.filter = 'clean';
  assert.equal(api.getFilteredRecords().length, 0);
  assert.equal(api.approveRecord(record), true);
  assert.equal(record.approval.source, 'manual');
  assert.equal(api.getFilteredRecords().length, 1);
  api.updateStats();
  assert.equal(element('stat-clean').innerText, 1);
});

test('matching PDF upload leaves unread book fields blank and spreadsheet entry unchanged', async () => {
  const { api } = setupMain();
  const record = makeRecord();
  record.book.namaSuami = 'MANUAL NAME';
  record.entry = { ...fields };
  const beforeBook = plain(record.book);
  const beforeEntry = plain(record.entry);
  api.state.records = [record];
  api.state.spreadsheetLoaded = true;
  await api.handlePDFFolderUpload([{ name: '1.pdf' }]);
  assert.equal(record.pdfDoc.fileName, '1.pdf');
  assert.deepEqual(plain(record.book), beforeBook);
  assert.equal(record.book.noAkta, '');
  assert.deepEqual(plain(record.entry), beforeEntry);
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
});

test('PDF upload does not pair spreadsheet rows by row index or numeric filename', async () => {
  const { api } = setupMain();
  const record = makeRecord();
  record.fileName = '';
  record.pdfDoc = null;
  record.no = 1;
  record.entry = { ...fields };
  const beforeEntry = plain(record.entry);
  api.state.records = [record];
  api.state.spreadsheetLoaded = true;
  await api.handlePDFFolderUpload([{ name: '1.pdf' }]);
  assert.equal(record.pdfDoc, null);
  assert.equal(record.pairingRequired, true);
  assert.deepEqual(plain(record.book), empty);
  assert.deepEqual(plain(record.entry), beforeEntry);
  assert.equal(api.state.records.length, 2, 'The unmatched scan remains available independently');
  assert.equal(api.state.records[1].pdfDoc.fileName, '1.pdf');
});

test('nonempty backend suggestions do not overwrite manual book/entry data', () => {
  const { api } = setupMain();
  const record = makeRecord();
  record.book.namaSuami = 'MANUAL NAME';
  record.entry.namaIstri = 'MANUAL ENTRY';
  api.applyExtractionResult(record, { ...fields, ...metadata });
  assert.equal(record.book.namaSuami, 'MANUAL NAME');
  assert.equal(record.book.namaIstri, 'SITI binti HASAN');
  assert.equal(record.entry.namaIstri, 'MANUAL ENTRY');
  assert.equal(record.pdfDoc.extracted.namaSuami, 'ALI bin UMAR');
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
});

test('each of the four missing fields independently requires OCR', () => {
  const { api } = setupMain();
  assert.equal(api.needsAktaOCR(fields), false);
  for (const key of Object.keys(fields)) assert.equal(api.needsAktaOCR({ ...fields, [key]: '' }), true);
});

test('review banner escapes source, warnings, suggestions, field details and timings', () => {
  const { api } = setupMain();
  const malicious = '<img src=x onerror="alert(1)">';
  const html = api.renderExtractionReview({
    ...empty, source: malicious, warnings: [malicious], latestFields: { namaSuami: malicious },
    fieldDetails: { namaSuami: { suggestions: [malicious] } }, timings: { [malicious]: malicious }
  });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onerror="'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('bukan verifikasi'));
  assert.ok(html.includes('Rincian dan saran'));
});

test('on-demand OCR saves even empty results, and does not repeatedly retry on render', async () => {
  const { api, calls } = setupMain();
  const record = makeRecord();
  api.state.records = [record];
  api.triggerFastOnDemandOCR(record, record.pdfDoc, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.saved.length, 1);
  assert.equal(record.pdfDoc.extracted.source, 'local');
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
  api.triggerFastOnDemandOCR(record, record.pdfDoc, 0);
  assert.equal(calls.ocr, 1);
});

test('inspector OCR persists empty metadata and remains pending', async () => {
  const { api, element, calls } = setupMain();
  const record = makeRecord();
  api.state.records = [record];
  api.renderProofreadingInspector();
  await element('btn-trigger-single-ocr').handlers.click();
  assert.equal(calls.saved.length, 1);
  assert.equal(record.pdfDoc.extracted.requiresReview, true);
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
  assert.ok(element('proofread-content').innerHTML.includes('Review scan'));
});

test('toolbar OCR preserves manual fields and stores empty review metadata', async () => {
  const { api, element, calls } = setupMain();
  const record = makeRecord();
  record.book = { ...fields };
  api.state.records = [record];
  api.setupEvents();
  await element('tool-ocr').handlers.click();
  assert.deepEqual(record.book, fields);
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(plain(record.pdfDoc.extracted.warnings), metadata.warnings);
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
});

for (const missing of ['tglAkad', 'namaIstri']) {
  test(`batch OCR runs when only ${missing} is missing and preserves backend names`, async () => {
    const vector = { ...fields, ...metadata, source: 'pdf-text', [missing]: '' };
    const { api, calls, element } = setupMain({ vector, ocrResult: { ...fields, ...metadata } });
    const record = makeRecord();
    record.book.noAkta = 'MANUAL-NUMBER';
    record.entry.namaSuami = 'MANUAL ENTRY';
    api.state.records = [record];
    api.state.spreadsheetLoaded = true;
    api.setupEvents();
    await element('btn-batch-ocr').handlers.click();
    assert.equal(calls.ocr, 1);
    assert.equal(record.book.noAkta, 'MANUAL-NUMBER');
    assert.equal(record.book.namaSuami, 'ALI bin UMAR');
    assert.equal(record.book.namaIstri, 'SITI binti HASAN');
    assert.equal(record.entry.namaSuami, 'MANUAL ENTRY');
    assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
    assert.equal(record.pdfDoc.extracted.source, 'local');
  });
}

test('metadata-only batch results persist but do not count as successful extraction', async () => {
  const { api, element, calls } = setupMain({ vector: { sourceVersion: 2, source: 'pdf-text', requiresReview: true } });
  const record = makeRecord();
  api.state.records = [record];
  api.setupEvents();
  await element('btn-batch-ocr').handlers.click();
  assert.equal(calls.saved.length, 1);
  assert.ok(element('batch-ocr-status-text').innerText.includes('0 dari 1'));
  assert.deepEqual(plain(record.book), empty);
  assert.equal(record.pdfDoc.extracted.source, 'local');
});

test('batch partial merge does not clear vector fields with empty local fields', async () => {
  const { api, element } = setupMain({ vector: { noAkta: fields.noAkta, sourceVersion: 2, source: 'pdf-text' }, ocrResult: { ...empty, ...metadata, namaIstri: fields.namaIstri } });
  const record = makeRecord();
  api.state.records = [record];
  api.setupEvents();
  await element('btn-batch-ocr').handlers.click();
  assert.equal(record.book.noAkta, fields.noAkta);
  assert.equal(record.pdfDoc.extracted.noAkta, fields.noAkta);
  assert.equal(record.pdfDoc.extracted.latestFields.noAkta, '');
  assert.equal(record.pdfDoc.extracted.latestFields.namaIstri, fields.namaIstri);
});

test('IndexedDB and subsequent memory-cache renders retain latest OCR metadata', async () => {
  const cached = { ...makeDoc(), extracted: { ...empty, ...metadata } };
  const { api } = setupViewer({ cached });
  const doc = { ...makeDoc(), dataURL: null, pageImages: [] };
  api.restorePDFDocuments([doc], 'folder');
  const first = await api.renderPDFDocPage(0);
  assert.deepEqual(plain(first.extracted), cached.extracted);
  doc.extracted = { ...fields, ...metadata, warnings: ['Latest OCR'] };
  const second = await api.renderPDFDocPage(0);
  assert.deepEqual(plain(second.extracted.warnings), ['Latest OCR']);
  assert.deepEqual(plain(doc.extracted), plain(second.extracted));
});

for (const sourceVersion of [undefined, 1]) {
  test(`IndexedDB and memory caches reject legacy extraction (sourceVersion=${sourceVersion})`, async () => {
    const legacy = { ...fields, ...metadata };
    if (sourceVersion === undefined) delete legacy.sourceVersion;
    else legacy.sourceVersion = sourceVersion;
    const cached = { ...makeDoc(), extracted: legacy };
    const { api } = setupViewer({ cached });
    const doc = { ...makeDoc(legacy), dataURL: null, pageImages: [] };
    api.restorePDFDocuments([doc], 'folder');
    const first = await api.renderPDFDocPage(0);
    assert.equal(first.dataURL, cached.dataURL, 'The scan remains available for review');
    assert.equal(first.extracted, null);
    assert.equal(doc.extracted, null);
    assert.deepEqual(plain(doc.legacyExtracted), legacy);
    const second = await api.renderPDFDocPage(0);
    assert.equal(second.extracted, null);
    assert.equal(doc.extracted, null);
    assert.deepEqual(plain(doc.legacyExtracted), legacy);
  });
}

test('fresh PDF rendering persists only text-evidenced fields with review provenance', async () => {
  const { api, saves } = setupViewer();
  const doc = { ...makeDoc(), dataURL: null, pageImages: [], file: { arrayBuffer: async () => new ArrayBuffer(0) } };
  api.restorePDFDocuments([doc], '2016 - 11');
  const result = await api.renderPDFDocPage(0);
  assert.equal(result.extracted.noAkta, undefined);
  assert.equal(result.extracted.tglAkad, undefined);
  assert.equal(result.extracted.sourceVersion, 2);
  assert.equal(result.extracted.source, 'pdf-text');
  assert.equal(result.extracted.requiresReview, true);
  assert.deepEqual(saves[0][4], plain(result.extracted));
});

test('reference layout retains table/detail and AI status without report or theme controls', () => {
  for (const id of ['tab-btn-table', 'tab-btn-detail', 'ai-status-badge', 'btn-sync-all-fields']) {
    assert.ok(htmlSource.includes(`id="${id}"`));
  }
  for (const removed of ['btn-open-ba', 'modal-ba', 'btn-print-ba', 'btn-close-ba-modal', 'btn-toggle-theme', 'theme-icon']) {
    assert.ok(!htmlSource.includes(`id="${removed}"`));
    assert.ok(!mainSource.includes(`getElementById('${removed}')`));
  }
  assert.ok(!mainSource.includes('generateBeritaAcaraHTML'));
  assert.ok(htmlSource.includes('Proofreader & Validasi Spreadsheet'));
  assert.ok(htmlSource.includes('<span>Samakan Buku</span>'));
});

test('light theme is fixed before startup and old dark preferences are not consulted', () => {
  assert.match(htmlSource, /<html[^>]*data-theme="light"/);
  assert.ok(htmlSource.includes('<meta name="color-scheme" content="light"'));
  assert.ok(!mainSource.includes('verifakta-theme'));
  assert.ok(!mainSource.includes('state.theme'));
  assert.doesNotMatch(cssSource, /data-theme\s*=\s*["']dark["']/);
  assert.doesNotMatch(cssSource, /prefers-color-scheme:\s*dark/);
});

test('table styling keeps two-axis scrolling, sticky headings and an emerald selected row', () => {
  assert.match(cssSource, /\.proofread-table-container\s*\{[^}]*overflow:\s*auto/s);
  assert.match(cssSource, /\.proofread-doc-table thead th\s*\{[^}]*position:\s*sticky/s);
  assert.match(cssSource, /\.proofread-doc-table tbody tr\.row-active[^{]*\{[^}]*outline:\s*2px solid var\(--primary-500\)/s);
});

test('restored table renders eight columns, escapes values and counts pending OCR as issues without Excel', () => {
  const { api, element } = setupMain({ tab: 'table' });
  assert.equal(api.initialProofreadTab, 'table');
  const record = makeRecord(makeDoc({ ...fields, ...metadata }));
  record.fileName = '<img src=x>.pdf';
  record.book.namaSuami = '<script>bad</script>';
  api.state.records = [record];
  api.renderProofreadingInspector();
  const html = element('proofread-content').innerHTML;
  const headings = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(match => match[1].trim());
  assert.deepEqual(headings, ['No', 'Berkas Scan', 'No. Akta Nikah', 'Tgl Akad', 'Pengantin Pria', 'Pengantin Wanita', 'Status', 'Aksi']);
  assert.ok(html.includes('Belum Diperiksa'));
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
  assert.match(text, /Ada Selisih \/ Typo\s*\(1\)/);
  assert.match(text, /Valid \/ Cocok\s*\(0\)/);
  assert.ok(html.includes('Termasuk hasil OCR yang belum diperiksa'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.equal(element('table-tab-badge').innerText, 1);
  assert.equal(record.statusVerifikasi, 'Belum Diperiksa');
  api.updateStats();
  assert.equal(element('stat-errors').innerText, 1);
  assert.equal(element('count-issues').innerText, 1);
  api.state.filter = 'clean';
  api.renderProofreadingTable();
  assert.ok(!element('proofread-content').innerHTML.includes('class="doc-table-row'));
  assert.ok(element('proofread-content').innerHTML.includes('Tidak ada dokumen'));
});

test('table compares Scan/Excel values without mutating either side and keeps scroll', () => {
  const { api, element } = setupMain({ tab: 'table' });
  const record = makeRecord();
  record.book = { ...fields };
  record.entry = { ...fields, namaSuami: 'MANUAL EXCEL' };
  api.state.records = [record];
  api.state.spreadsheetLoaded = true;
  const before = plain(record);
  const scroll = { scrollTop: 250, scrollLeft: 135 };
  element('proofread-content').matches['.proofread-table-container'] = [scroll];
  api.renderProofreadingTable();
  const text = element('proofread-content').innerHTML.replace(/<[^>]*>/g, '');
  assert.match(text, /Scan:\s*ALI bin UMAR/);
  assert.match(text, /Excel:\s*MANUAL EXCEL/);
  assert.deepEqual(plain(record), before);
  assert.equal(scroll.scrollTop, 250);
  assert.equal(scroll.scrollLeft, 135);
});

test('filtered table row selection synchronizes PDF, navigation, active row and Detail', () => {
  const { api, element, calls, context } = setupMain({ tab: 'table' });
  const records = [1, 2, 3].map(n => makeRecord({ ...makeDoc(), fileName: `${n}.pdf`, id: `doc-${n}` }));
  records[1].pdfDoc.extracted = { ...fields, ...metadata };
  records[2].pdfDoc.extracted = { ...fields, ...metadata };
  api.state.records = records;
  api.state.spreadsheetLoaded = true;
  records[0].book = { ...fields };
  records[0].entry = { ...fields };
  assert.equal(api.approveRecord(records[0]), true);
  api.state.filter = 'issues';
  const activeRows = new Set();
  const rows = [1, 2].map(index => {
    const row = element(`row-${index}`);
    row.getAttribute = () => String(index);
    row.classList = {
      add(name) { if (name === 'row-active') activeRows.add(index); },
      remove(name) { if (name === 'row-active') activeRows.delete(index); }
    };
    return row;
  });
  const card = element('selected-doc-action-card');
  const title = element('selected-doc-title');
  card.matches['div[style*="font-weight: 700"]'] = [title];
  element('proofread-content').matches['.selected-doc-action-card'] = [card];
  element('proofread-content').matches['.doc-table-row'] = rows;
  vm.runInContext(`
    renderDocumentViewer = () => calls.viewed.push(getFilteredRecords()[state.currentIndex]?.pdfDoc.fileName);
    renderNavigation = actualRenderNavigation;
  `, context);
  api.renderProofreadingInspector();
  rows[1].handlers.click({ target: { closest: () => null } });
  assert.equal(api.state.currentIndex, 1, 'index is relative to filtered records, not all records');
  assert.equal(calls.viewed.at(-1), '3.pdf');
  assert.equal(element('input-jump-rec').value, 2);
  assert.match(title.innerHTML.replace(/<[^>]*>/g, ''), /Dokumen Terpilih:\s*3\.pdf/);
  assert.deepEqual([...activeRows], [2]);
  assert.equal(api.state.proofreadTab, 'table');
  api.setupEvents();
  element('tab-btn-detail').handlers.click();
  assert.ok(element('proofread-content').innerHTML.includes('3.pdf'));
  assert.ok(element('proofread-content').innerHTML.includes('Review scan'));
  element('btn-back-to-table').handlers.click();
  assert.equal(api.state.proofreadTab, 'table');
  rows[0].handlers.click({ target: { closest: () => ({}) } });
  assert.equal(api.state.proofreadTab, 'detail');
  assert.ok(element('proofread-content').innerHTML.includes('2.pdf'));
});

test('table and global filters share the same selected record and search scope', () => {
  const { api, element, context } = setupMain({ tab: 'table' });
  const records = [makeRecord(), makeRecord({ ...makeDoc(), fileName: '2.pdf' })];
  records[1].pdfDoc.extracted = { ...fields, ...metadata };
  api.state.records = records;
  api.state.spreadsheetLoaded = true;
  records[0].book = { ...fields };
  records[0].entry = { ...fields };
  assert.equal(api.approveRecord(records[0]), true);
  api.state.currentIndex = 1;
  vm.runInContext('renderDocumentViewer = () => {};', context);
  api.setRecordFilter('issues');
  assert.equal(api.getFilteredRecords()[api.state.currentIndex], records[1]);
  api.renderProofreadingTable();
  assert.ok(!element('proofread-content').innerHTML.includes('data-record-index="0"'));
  api.state.searchQuery = 'missing';
  api.renderProofreadingTable();
  assert.ok(!element('proofread-content').innerHTML.includes('selected-doc-action-card'));
  api.state.searchQuery = '';
  api.setRecordFilter('all');
  assert.equal(api.state.currentIndex, 1);
  assert.equal(api.getFilteredRecords()[api.state.currentIndex], records[1]);
});

test('lazy PDF rendering uses selected record identity after filtering, and ignores stale completion', async () => {
  let complete;
  const { api, element, calls, context } = setupMain();
  const hidden = makeRecord({ ...makeDoc(), index: 1 });
  const chosen = makeRecord({ ...makeDoc(), index: 0, fileName: '2.pdf', dataURL: null, pageImages: [] });
  chosen.pdfDoc.extracted = { ...fields, ...metadata };
  api.state.records = [hidden, chosen];
  api.state.spreadsheetLoaded = true;
  hidden.book = { ...fields };
  hidden.entry = { ...fields };
  assert.equal(api.approveRecord(hidden), true);
  api.state.pdfLoaded = true;
  api.state.pdfDocuments = [chosen.pdfDoc, hidden.pdfDoc];
  api.state.filter = 'issues';
  const renderedIndices = [];
  context.renderPDFDocPage = index => {
    renderedIndices.push(index);
    return new Promise(resolve => { complete = resolve; });
  };
  vm.runInContext('renderScanDocument = (target, doc) => calls.scans.push(doc.fileName); applyViewerTransform = () => {};', context);
  api.renderDocumentViewer();
  complete({ dataURL: 'scan', pageImages: [], numPages: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.scans, ['2.pdf']);
  assert.deepEqual(renderedIndices, [0], 'PDF index is independent of the record and filtered indices');
  api.renderDocumentViewer();
  api.state.filter = 'all';
  api.state.currentIndex = 0;
  element('cert-render-target').innerHTML = 'new selection';
  complete({ dataURL: 'scan' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.scans, ['2.pdf']);
  assert.equal(element('cert-render-target').innerHTML, 'new selection');
});

test('PDF dropdown maps full record indices into filtered selection, clearing filters only for a hidden document', () => {
  const { api, element } = setupMain();
  const records = [makeRecord(), makeRecord({ ...makeDoc(), fileName: '2.pdf' }), makeRecord({ ...makeDoc(), fileName: '3.pdf' })];
  for (const record of records.slice(1)) record.pdfDoc.extracted = { ...fields, ...metadata };
  api.state.records = records;
  api.state.spreadsheetLoaded = true;
  records[0].book = { ...fields };
  records[0].entry = { ...fields };
  assert.equal(api.approveRecord(records[0]), true);
  api.state.filter = 'issues';
  api.setupEvents();
  const choose = index => element('select-pdf-document').handlers.change({ target: { value: String(index) } });
  choose(2);
  assert.equal(api.state.currentIndex, 1);
  assert.equal(api.state.filter, 'issues');
  assert.equal(api.getFilteredRecords()[api.state.currentIndex], records[2]);
  api.state.searchQuery = '3.pdf';
  element('input-search').value = '3.pdf';
  choose(0);
  assert.equal(api.state.filter, 'all');
  assert.equal(api.state.searchQuery, '');
  assert.equal(element('input-search').value, '');
  assert.equal(api.getFilteredRecords()[api.state.currentIndex], records[0]);
});

test('table empty state and detail tab handle no matches without selecting a hidden record', () => {
  const { api, element } = setupMain({ tab: 'table' });
  api.renderProofreadingInspector();
  assert.ok(element('proofread-content').innerHTML.includes('Tabel Dokumen Belum Dimuat'));
  api.state.records = [makeRecord()];
  api.state.searchQuery = 'no-match';
  api.state.currentIndex = 999;
  api.renderProofreadingInspector();
  assert.ok(!element('proofread-content').innerHTML.includes('row-active'));
  api.setupEvents();
  element('tab-btn-detail').handlers.click();
  assert.ok(element('proofread-content').innerHTML.includes('Tidak ada data ditemukan'));
});

test('AI watcher probes initially, never overlaps clicks, polls every 15 seconds and handles model/offline transitions quietly', async () => {
  let finish;
  const { api, element, calls } = setupMain({ health: () => new Promise(resolve => { finish = resolve; }) });
  api.initLocalAIStatusWatcher();
  assert.equal(calls.health, 1);
  element('ai-status-badge').handlers.click();
  element('ai-status-badge').handlers.click();
  assert.equal(calls.health, 1);
  finish({ available: false, reason: 'model-unavailable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('ai-status-text').innerText, 'AI Lokal: Model Belum Siap');
  assert.equal(element('ai-status-badge').className, 'ai-status-badge offline');
  assert.equal(calls.timers.size, 1);
  const poll = [...calls.timers.values()][0];
  assert.equal(poll.delay, 15_000);
  poll.callback();
  finish({ available: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('ai-status-text').innerText, 'AI Lokal: Aktif');
  assert.equal(element('ai-status-badge').className, 'ai-status-badge online');
  element('ai-status-badge').handlers.click();
  finish({ available: false, reason: 'offline' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('ai-status-text').innerText, 'AI Lokal: Offline');
  assert.equal(calls.notifications.length, 0);
  calls.windowEvents.pagehide();
  assert.equal(calls.timers.size, 0);
  calls.windowEvents.pageshow();
  assert.equal(calls.health, 4);
  finish({ available: true });
  await new Promise(resolve => setImmediate(resolve));
});
