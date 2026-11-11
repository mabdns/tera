import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as XLSX from 'xlsx';
import { evaluateRecord, calculateSimilarity, normalizeDateToStandard } from './validation.js';
import { parseSpreadsheet } from './excelHelper.js';

const mainSource = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const withoutImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const fields = {
  noAkta: '17/002/I/2020', tglAkad: '02-01-2020',
  namaSuami: 'ALI bin UMAR', namaIstri: 'SITI binti HASAN'
};
const keys = Object.keys(fields);
const empty = Object.fromEntries(keys.map(key => [key, '']));
const metadata = { source: 'local', requiresReview: true, warnings: ['Periksa scan'], sourceVersion: 2 };

function makeDoc(index = 0, extracted = null, overrides = {}) {
  return {
    id: `pdf_folder__${index + 1}.pdf`, index, num: index + 1,
    fileName: `${index + 1}.pdf`, fileSize: '1 KB', numPages: 1,
    dataURL: 'data:image/png;base64,scan',
    pageImages: [{ pageNumber: 1, dataURL: 'data:image/png;base64,scan' }],
    extracted, ...overrides
  };
}

function makeRecord(doc = makeDoc(), overrides = {}) {
  return {
    id: doc.id, fileName: doc.fileName, pdfDoc: doc, sourceVersion: 2,
    book: { ...empty }, entry: { ...fields }, originalEntry: Object.freeze({ ...fields }),
    statusVerifikasi: 'Belum Diperiksa', ...overrides
  };
}

function spreadsheet(rows = [{ ...fields, fileName: '1.pdf' }]) {
  const headers = ['Nama File', 'Nomor Akta Nikah', 'Tanggal Akad Nikah', 'Nama Suami', 'Nama Istri'];
  const data = rows.map(row => [row.fileName ?? '', ...keys.map(key => row[key] ?? '')]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...data]), 'Akta');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}

// Run the real controller without its browser-only imports or DOMContentLoaded startup.
// Only IO/presentation scheduling is replaced; safety decisions and parsing remain real.
function setupMain(options = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      handlers: {}, matches: {}, attributes: {}, dataset: {}, style: {},
      innerHTML: '', innerText: '', value: '', disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelectorAll(selector) { return this.matches[selector] || []; },
      querySelector(selector) { return this.matches[selector]?.[0] || null; },
      getAttribute(name) { return this.attributes[name] ?? null; },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild() {}, scrollTo() {}, scrollBy() {}, click() {}
    });
    return elements.get(id);
  }
  const calls = { ocr: [], rendered: [], saved: [], autoSaves: 0, notifications: [], alerts: [], errors: [], reads: [] };
  const docs = options.docs || [makeDoc()];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console: { log() {}, warn: (...args) => calls.errors.push(args), error: (...args) => calls.errors.push(args) },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      documentElement: element('root')
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    FileReader: class {
      readAsArrayBuffer(file) {
        calls.reads.push(file.name);
        this.onload({ target: { result: file.buffer } });
      }
    },
    evaluateRecord, calculateSimilarity, normalizeDateToStandard, parseSpreadsheet,
    checkLocalAIService: async () => ({ available: false, reason: 'test: no network' }),
    recognizeMultiPageAkta: async (doc, _progress, mode) => {
      calls.ocr.push(doc.id);
      if (options.recognize) return options.recognize(doc, mode);
      return plain(options.ocrResult ?? { ...empty, ...metadata });
    },
    renderPDFDocPage: async index => {
      calls.rendered.push(index);
      assert.ok(docs.some(doc => doc.index === index), `Unknown PDF index ${index}`);
      return { ...docs.find(doc => doc.index === index), extracted: plain(options.vector ?? {}) };
    },
    preRenderAdjacentDoc() {},
    loadPDFFolder: async () => docs,
    getLoadedFolderName: () => '2020 - 1',
    savePDFFilesToDB: async () => {},
    saveRenderedScanToDB: async (...args) => { calls.saved.push(plain(args)); },
    alert: message => calls.alerts.push(message),
    calls
  });
  vm.runInContext(withoutImports(mainSource), context, { filename: 'main.js' });
  vm.runInContext(`
    renderAll = () => {};
    renderNavigation = () => {};
    updateStats = () => {};
    refreshIcons = () => {};
    triggerAutoSave = () => { calls.autoSaves++; };
    showNotification = (...args) => calls.notifications.push(args);
  `, context);
  const api = vm.runInContext(`({ state, setupEvents, evaluateVerification, isApproved,
    approveRecord, recordManualChange, applyExtractionResult, migrateLegacyRecord,
    findUniqueDocument, needsAktaOCR, triggerFastOnDemandOCR, handlePDFFolderUpload,
    renderProofreadingDetail, renderProofreadingTable })`, context);
  api.state.proofreadTab = 'detail';
  api.setupEvents();
  function uploadExcel(rows, name = 'reference.xlsx') {
    const buffer = spreadsheet(rows);
    element('file-input-excel').handlers.change({ target: { files: [{ name, buffer }], value: name } });
    assert.deepEqual(calls.alerts, [], 'Excel upload must not swallow an exception');
    assert.deepEqual(calls.errors, [], 'Upload must not log hidden failures');
    assert.equal(api.state.spreadsheetLoaded, true);
  }
  async function uploadPDF() {
    await api.handlePDFFolderUpload(docs.map(doc => ({ name: doc.fileName })));
    assert.deepEqual(calls.alerts, [], 'PDF upload must not swallow an exception');
    assert.deepEqual(calls.errors, []);
    assert.equal(api.state.pdfLoaded, true);
  }
  function select(record, loaded = true) {
    api.state.records = [record];
    api.state.pdfDocuments = record.pdfDoc ? [record.pdfDoc] : [];
    api.state.spreadsheetLoaded = loaded;
    api.state.currentIndex = 0;
  }
  return { api, calls, element, uploadExcel, uploadPDF, select };
}

function assertPending(api, record) {
  assert.notEqual(record.statusVerifikasi, 'Valid', 'Extraction/matching must not approve a record');
  assert.equal(api.isApproved(record), false);
  assert.equal(record.approval, undefined);
}

function assertIndependent(record, entry, originalEntry) {
  assert.deepEqual(plain(record.entry), entry, 'PDF/OCR must not change spreadsheet values');
  assert.deepEqual(plain(record.originalEntry), originalEntry, 'Import snapshot must remain unchanged');
}

// Let the on-demand OCR promise chain (including persistence) settle without running UI timers.
const settleOCR = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function startOCR(h, route, record) {
  if (route === 'on-demand') {
    h.api.triggerFastOnDemandOCR(record, record.pdfDoc, record.pdfDoc.index);
    return;
  }
  if (route === 'inspector') {
    h.api.renderProofreadingDetail();
    return h.element('btn-trigger-single-ocr').handlers.click();
  }
  return h.element(route === 'toolbar' ? 'tool-ocr' : 'btn-batch-ocr').handlers.click();
}

for (const loaded of [false, true]) {
  for (const [name, book, entry] of [
    ['both blank', { ...empty }, { ...empty }],
    ['unread book', { ...empty }, { ...fields }],
    ['blank Excel', { ...fields }, { ...empty }]
  ]) {
    test(`${name} cannot be approved (spreadsheetLoaded=${loaded})`, () => {
      const { api, select, element } = setupMain();
      const record = makeRecord(makeDoc(), { book, entry });
      select(record, loaded);
      assert.equal(api.evaluateVerification(record).isClean, false);
      assert.equal(api.approveRecord(record), false);
      api.renderProofreadingDetail();
      element('btn-mark-resolved').handlers.click();
      const target = { value: 'Valid' };
      element('record-status-select').handlers.change({ target });
      assert.notEqual(target.value, 'Valid', 'Status selector must reject invalid approval');
      assertPending(api, record);
    });
  }
}

for (const key of keys) {
  test(`a single missing Excel ${key} prevents approval even with a complete book`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields }, entry: { ...fields, [key]: '' } });
    h.select(record);
    assert.equal(h.api.evaluateVerification(record).isClean, false);
    assert.equal(h.api.approveRecord(record), false);
    assertPending(h.api, record);
  });
}

for (const gate of ['no spreadsheet', 'no PDF', 'pairing required']) {
  test(`complete matching values cannot bypass ${gate}`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields } });
    if (gate === 'no PDF') delete record.pdfDoc;
    if (gate === 'pairing required') record.pairingRequired = true;
    h.select(record, gate !== 'no spreadsheet');
    assert.equal(h.api.approveRecord(record), false);
    assertPending(h.api, record);
  });
}

test('ambiguous I/1 stays visible in table and detail and cannot be approved', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), {
    book: { ...fields, noAkta: '17/002/1/2020', namaIstri: 'SITI AMINAH A MD' },
    entry: { ...fields, namaIstri: 'SITI AMINAH, A.Md.' }
  });
  h.select(record);
  const original = plain({ book: record.book, entry: record.entry });
  h.api.renderProofreadingTable();
  let html = h.element('proofread-content').innerHTML;
  assert.match(html, /Perlu pemeriksaan/);
  assert.match(html, /17\/002\/1\/2020/);
  assert.match(html, /17\/002\/I\/2020/);
  assert.match(html, /SITI AMINAH A MD/);
  assert.match(html, /SITI AMINAH, A\.Md\./);
  assert.match(html, /normalisasi/);
  h.api.renderProofreadingDetail();
  html = h.element('proofread-content').innerHTML;
  assert.match(html, /Perlu pemeriksaan/);
  assert.match(html, /Sesuai · Format gelar/);
  assert.doesNotMatch(html, /0% Mirip/);
  assert.equal(h.api.approveRecord(record), false);
  assert.deepEqual(plain({ book: record.book, entry: record.entry }), original);
  assertPending(h.api, record);
});

test('matching title typography does not automatically approve a record', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), {
    book: { ...fields, namaIstri: 'SITI AMINAH A MD' },
    entry: { ...fields, namaIstri: 'SITI AMINAH, A.Md.' }
  });
  h.select(record);
  assert.equal(h.api.evaluateVerification(record).isClean, true);
  assertPending(h.api, record);
  assert.equal(h.api.approveRecord(record), true);
  assert.equal(h.api.isApproved(record), true);
  assert.equal(record.book.namaIstri, 'SITI AMINAH A MD');
  assert.equal(record.entry.namaIstri, 'SITI AMINAH, A.Md.');
});

test('timed-out extraction preserves data but cannot validate stale OCR and can be retried', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), {book:{...fields},bookSources:Object.fromEntries(keys.map(k=>[k,'ocr']))});
  h.select(record);
  const original=plain({book:record.book,entry:record.entry,originalEntry:record.originalEntry});
  assert.equal(h.api.evaluateVerification(record).isClean,true);
  h.api.applyExtractionResult(record,{...empty,status:'timeout',source:'local',warnings:['OCR lokal belum selesai']});
  assert.deepEqual(plain({book:record.book,entry:record.entry,originalEntry:record.originalEntry}),original);
  assert.equal(h.api.evaluateVerification(record).isClean,false);
  assert.equal(h.api.approveRecord(record),false);
  h.api.renderProofreadingTable();
  assert.match(h.element('proofread-content').innerHTML,/OCR melewati batas waktu/);
  h.api.renderProofreadingDetail();
  assert.match(h.element('proofread-content').innerHTML,/Ulangi OCR lokal/);
  assert.match(h.element('proofread-content').innerHTML,/Gunakan OCR browser/);
  h.api.applyExtractionResult(record,{...fields,status:'completed',source:'local'});
  assert.equal(h.api.evaluateVerification(record).isClean,true);
  assertPending(h.api,record);
});

test('a failed extraction does not discard reviewed manual transcription', () => {
  const h=setupMain();
  const record=makeRecord(makeDoc(),{book:{...fields},bookSources:Object.fromEntries(keys.map(k=>[k,'manual']))});
  h.select(record);
  h.api.applyExtractionResult(record,{...empty,status:'failed',source:'local'});
  assert.deepEqual(plain(record.book),fields);
  assert.equal(h.api.evaluateVerification(record).isClean,true);
  assertPending(h.api,record);
});

test('batch pauses after a local timeout instead of queuing the next document', async () => {
  const docs=[makeDoc(0),makeDoc(1)];
  const h=setupMain({docs,ocrResult:{...empty,status:'timeout',source:'local',warnings:['Terlambat']}});
  const records=docs.map(doc=>makeRecord(doc));
  h.select(records[0]);
  h.api.state.records=records;
  await h.element('btn-batch-ocr').handlers.click();
  assert.deepEqual(h.calls.ocr,[docs[0].id]);
  assert.match(h.element('batch-ocr-status-text').innerText,/Dijeda/);
  assert.match(h.element('batch-ocr-status-text').innerText,/0 dari 1/);
  assert.equal(records[0].extraction.status,'timeout');
  assert.equal(records[1].extraction,undefined);
  assertPending(h.api,records[0]);
});

for (const [button, engine] of [['btn-retry-local-ocr','local'],['btn-browser-ocr','browser']]) {
  test(`${button} retries using only the engine explicitly selected by the user`, async () => {
    let selected;
    const h=setupMain({recognize:(_doc,mode)=>{selected=mode.engine;return {...fields,status:'completed',source:engine};}});
    const record=makeRecord(makeDoc(),{extraction:{status:'failed',source:'local'}});
    h.select(record);
    h.api.renderProofreadingDetail();
    await h.element(button).handlers.click();
    assert.equal(selected,engine);
    assert.equal(record.extraction.status,'completed');
    assert.equal(h.api.evaluateVerification(record).isClean,true);
    assertPending(h.api,record);
  });
}

test('real validation compares equivalent dates semantically but still requires explicit approval', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), {
    book: { ...fields, tglAkad: '2020-01-02' },
    entry: { ...fields, tglAkad: '02/01/2020' }
  });
  h.select(record);
  assert.equal(h.api.evaluateVerification(record).overallScore, 100);
  assertPending(h.api, record);
  assert.equal(h.api.approveRecord(record), true);
  assert.equal(h.api.isApproved(record), true);
});

test('Excel-only import has an immutable snapshot but no independent book or PDF', () => {
  const { api, calls, uploadExcel } = setupMain();
  uploadExcel();
  assert.deepEqual(calls.reads, ['reference.xlsx']);
  const [record] = api.state.records;
  assert.deepEqual(plain(record.book), {});
  assert.equal(record.pdfDoc, undefined);
  assert.equal(record.entry.noAkta, fields.noAkta);
  assert.deepEqual(record.originalEntry, record.entry);
  assert.notEqual(record.originalEntry, record.entry);
  assert.equal(Object.isFrozen(record.originalEntry), true);
  assert.equal(api.evaluateVerification(record).matchesCount, 0);
  assert.equal(api.approveRecord(record), false);
  assertPending(api, record);
});

for (const order of ['PDF then Excel', 'Excel then PDF']) {
  test(`${order}: sources stay independent even when every value disagrees`, async () => {
    const extracted = { ...fields, ...metadata };
    const excel = { noAkta: '99/009/IX/2022', tglAkad: '09-09-2022', namaSuami: 'BUDI', namaIstri: 'RINA', fileName: '1.pdf' };
    const h = setupMain({ docs: [makeDoc(0, extracted)] });
    if (order === 'PDF then Excel') {
      await h.uploadPDF();
      assert.deepEqual(plain(h.api.state.records[0].entry), empty, 'PDF must never seed Excel');
      h.uploadExcel([excel]);
    } else {
      h.uploadExcel([excel]);
      await h.uploadPDF();
    }
    assert.equal(h.api.state.records.length, 1);
    const [record] = h.api.state.records;
    assert.deepEqual(plain(record.book), fields);
    assertIndependent(record, excel, excel);
    assert.equal(record.pdfDoc.id, 'pdf_folder__1.pdf');
    assert.equal(record.pairingRequired, false);
    assert.equal(h.api.evaluateVerification(record).isClean, false);
    assert.equal(h.api.approveRecord(record), false);
    assertPending(h.api, record);
  });

  test(`${order}: matching extraction remains pending until explicit human approval`, async () => {
    const h = setupMain({ docs: [makeDoc(0, { ...fields, ...metadata })] });
    if (order === 'PDF then Excel') { await h.uploadPDF(); h.uploadExcel(); }
    else { h.uploadExcel(); await h.uploadPDF(); }
    const [record] = h.api.state.records;
    assert.equal(h.api.evaluateVerification(record).isClean, true);
    assertPending(h.api, record);
    assert.equal(h.api.approveRecord(record), true);
    assert.equal(h.api.isApproved(record), true);
  });
}

test('Excel upload retains manual book work and snapshots the actual new import', async () => {
  const h = setupMain({ docs: [makeDoc(0, { ...fields, ...metadata })] });
  await h.uploadPDF();
  const previous = h.api.state.records[0];
  previous.fieldMapping = {schema:1,profileId:'model-a1',documentKey:'bound-to-original-pdf',fields:{}};
  h.api.recordManualChange(previous, 'book', 'namaSuami', 'MANUAL SUAMI');
  const beforeBook = plain(previous.book);
  const imported = { ...fields, namaSuami: 'EXCEL SUAMI', fileName: '1.pdf' };
  h.uploadExcel([imported]);
  const record = h.api.state.records[0];
  assert.deepEqual(plain(record.book), beforeBook);
  assert.equal(record.bookSources.namaSuami, 'manual');
  assert.deepEqual(plain(record.fieldMapping), plain(previous.fieldMapping));
  assertIndependent(record, imported, imported);
  assert.equal(Object.isFrozen(record.originalEntry), true);
  h.api.recordManualChange(record, 'entry', 'namaSuami', 'CORRECTED ENTRY');
  assert.deepEqual(plain(record.originalEntry), imported);
  assert.equal(record.changeHistory.length, 2);
  assertPending(h.api, record);
});

test('successful reread clears rejected OCR labels and stale fields, preserving manual data and Excel', () => {
  const { api, select } = setupMain();
  const record = makeRecord(makeDoc(), {book:{...fields, namaSuami:'TEMPATDANTANGGALLAHIR'},
    bookSources:Object.fromEntries(keys.map(k=>[k,k==='namaIstri'?'manual':'ocr']))});
  record.extraction={...record.book,status:'completed'};
  select(record);
  const entry=plain(record.entry), original=plain(record.originalEntry);
  api.applyExtractionResult(record,{...empty,noAkta:fields.noAkta,namaSuami:'TEMPATDANTANGGALLAHIR',status:'completed'});
  assert.equal(record.book.namaSuami,'');
  assert.equal(record.book.tglAkad,'');
  assert.equal(record.book.namaIstri,fields.namaIstri);
  assert.equal(record.extraction.namaSuami,'');
  assert.equal(record.extraction.tglAkad,'');
  assert.match(record.extraction.warnings.join(' '),/Label formulir ditolak/);
  assertIndependent(record,entry,original);
  assertPending(api,record);
});

for (const result of [{ ...empty, ...metadata }, {
  ...empty, ...metadata, noAkta: 'OCR AKTA', namaSuami: 'OCR SUAMI', namaIstri: 'OCR ISTRI'
}]) {
  test(`${result.namaIstri ? 'partial' : 'empty'} OCR preserves manual book fields, entry and originalEntry`, () => {
    const { api, calls, select } = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...empty } });
    select(record);
    api.recordManualChange(record, 'book', 'namaSuami', 'MANUAL SUAMI');
    api.recordManualChange(record, 'book', 'noAkta', 'MANUAL AKTA');
    const entry = plain(record.entry), snapshot = plain(record.originalEntry);
    api.applyExtractionResult(record, result);
    assert.equal(record.book.namaSuami, 'MANUAL SUAMI');
    assert.equal(record.book.noAkta, 'MANUAL AKTA');
    assert.equal(record.book.tglAkad, '');
    assert.equal(record.book.namaIstri, result.namaIstri);
    assertIndependent(record, entry, snapshot);
    assert.equal(record.bookSources.namaSuami, 'manual');
    assert.deepEqual(plain(record.extraction.warnings), metadata.warnings);
    assert.equal(calls.saved.length, 1, 'Even empty results must persist review metadata');
    assertPending(api, record);
  });
}

for (const missing of keys) {
  for (const route of ['automatic', 'batch']) {
    test(`${route} OCR with Excel loaded runs when only ${missing} is unread; never auto-approves`, async () => {
      const partial = { ...fields, [missing]: '', ...metadata };
      const doc = makeDoc(7, partial);
      const h = setupMain({ docs: [doc], vector: partial, ocrResult: { ...fields, ...metadata } });
      const record = makeRecord(doc, {
        book: { ...fields, [missing]: '' },
        bookSources: Object.fromEntries(keys.filter(key => key !== missing).map(key => [key, 'manual']))
      });
      h.select(record);
      const entry = plain(record.entry), snapshot = plain(record.originalEntry);
      assert.equal(h.api.needsAktaOCR(record.book), true);
      assert.equal(h.api.approveRecord(record), false, 'A single unread field must block approval');
      if (route === 'automatic') {
        h.api.triggerFastOnDemandOCR(record, doc, doc.index);
        await settleOCR();
        h.api.triggerFastOnDemandOCR(record, doc, doc.index);
        await settleOCR();
      } else {
        await h.element('btn-batch-ocr').handlers.click();
        assert.deepEqual(h.calls.rendered, [7], 'Render the PDF index, not its Excel row position');
      }
      assert.deepEqual(h.calls.ocr, [doc.id]);
      assert.deepEqual(h.calls.errors, []);
      assert.deepEqual(h.calls.alerts, []);
      assert.equal(record.book[missing], fields[missing]);
      assert.deepEqual(plain(record.book), fields);
      assertIndependent(record, entry, snapshot);
      assert.equal(h.api.evaluateVerification(record).isClean, true);
      assertPending(h.api, record);
      assert.ok(h.calls.saved.length > 0);
    });
  }
}

for (const route of ['toolbar', 'detail', 'batch', 'automatic']) {
  test(`${route} empty OCR with Excel loaded cannot borrow spreadsheet data`, async () => {
    const h = setupMain({ vector: { ...empty, ...metadata } });
    const record = makeRecord();
    h.select(record);
    const entry = plain(record.entry), snapshot = plain(record.originalEntry);
    if (route === 'toolbar') await h.element('tool-ocr').handlers.click();
    if (route === 'detail') {
      h.api.renderProofreadingDetail();
      await h.element('btn-trigger-single-ocr').handlers.click();
    }
    if (route === 'batch') await h.element('btn-batch-ocr').handlers.click();
    if (route === 'automatic') {
      h.api.triggerFastOnDemandOCR(record, record.pdfDoc, 0);
      await settleOCR();
    }
    assert.equal(h.calls.ocr.length, 1);
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.alerts, []);
    assert.deepEqual(plain(record.book), empty);
    assertIndependent(record, entry, snapshot);
    assert.equal(h.api.evaluateVerification(record).matchesCount, 0);
    assert.equal(h.api.approveRecord(record), false);
    assertPending(h.api, record);
  });
}

test('Smart Auto Fix entry points and both sync directions never mutate either source', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), { book: { ...fields, namaSuami: 'SCAN ONLY' } });
  h.select(record);
  const sync = h.element('sync-to-book');
  sync.attributes['data-sync-key'] = 'namaSuami';
  const copy = h.element('copy-to-entry');
  copy.attributes['data-copy-to-entry'] = 'namaSuami';
  h.element('proofread-content').matches['.btn-sync-field'] = [sync, copy];
  h.api.renderProofreadingDetail();
  const before = plain(record);
  const saves = h.calls.autoSaves;
  for (const id of ['btn-smart-autofix', 'btn-modal-smart-autofix', 'btn-batch-instant-fix']) {
    h.element(id).handlers.click();
    assert.deepEqual(plain(record), before, `${id} must not rewrite data`);
  }
  for (const button of [sync, copy]) {
    assert.equal(typeof button.handlers.click, 'function');
    button.handlers.click();
    assert.deepEqual(plain(record), before, 'Sync/copy must not contaminate independent sources');
  }
  assert.equal(h.calls.autoSaves, saves);
  assert.equal(h.calls.notifications.length, 5);
});

test('unique explicit filename pairing is case-insensitive and independent of row/index order', async () => {
  const docs = [makeDoc(11, { ...fields, ...metadata }, { fileName: 'second.pdf' }),
    makeDoc(4, { ...fields, ...metadata }, { fileName: 'first.pdf' })];
  const h = setupMain({ docs });
  h.uploadExcel([{ ...fields, fileName: 'FIRST.PDF' }, { ...fields, fileName: 'second.pdf' }]);
  await h.uploadPDF();
  assert.deepEqual(h.api.state.records.map(record => record.pdfDoc.index), [4, 11]);
  for (const record of h.api.state.records) {
    assert.equal(record.pairingRequired, false);
    assertPending(h.api, record);
  }
});

for (const order of ['PDF then Excel', 'Excel then PDF']) {
  for (const scenario of ['missing filename', 'unknown filename', 'duplicate Excel names', 'duplicate PDF names']) {
    test(`${order}: ${scenario} cannot pair by row number, count, or folder name`, async () => {
      const duplicatePDF = scenario === 'duplicate PDF names';
      const docs = duplicatePDF
        ? [makeDoc(0, null, { fileName: '1.pdf' }), makeDoc(1, null, { fileName: '1.pdf' })]
        : [makeDoc(0)];
      const filename = scenario === 'missing filename' ? '' : scenario === 'unknown filename' ? 'missing.pdf' : '1.pdf';
      const rows = scenario === 'duplicate Excel names'
        ? [{ ...fields, fileName: filename }, { ...fields, fileName: filename }]
        : [{ ...fields, fileName: filename }];
      const h = setupMain({ docs });
      if (order === 'PDF then Excel') { await h.uploadPDF(); h.uploadExcel(rows, '2020 - 1.xlsx'); }
      else { h.uploadExcel(rows, '2020 - 1.xlsx'); await h.uploadPDF(); }
      const imported = h.api.state.records.filter(record => record.originalEntry);
      assert.equal(imported.length, rows.length);
      for (const record of imported) {
        assert.ok(!record.pdfDoc, 'Ambiguous/missing identity must never use the row index');
        assert.equal(record.pairingRequired, true);
        assert.equal(h.api.evaluateVerification(record).isClean, false);
        assert.equal(h.api.approveRecord(record), false);
        assertPending(h.api, record);
      }
      for (const doc of docs) {
        assert.ok(h.api.state.records.some(record => record.pdfDoc === doc), 'Unmatched scans must remain available');
      }
    });
  }
}

test('Excel replacement preserves unmatched manual scan work rather than discarding it', async () => {
  const h = setupMain();
  await h.uploadPDF();
  const previous = h.api.state.records[0];
  h.api.recordManualChange(previous, 'book', 'namaSuami', 'UNMATCHED MANUAL');
  h.uploadExcel([{ ...fields, fileName: 'other.pdf' }]);
  assert.equal(h.api.state.records.length, 2);
  assert.ok(h.api.state.records.includes(previous));
  assert.equal(previous.book.namaSuami, 'UNMATCHED MANUAL');
  assert.equal(previous.pairingRequired, true);
  assert.equal(h.api.approveRecord(previous), false);
});

test('replacing a PDF with the same filename cannot approve stale OCR from the previous document', async () => {
  const replacement = makeDoc(0, null, { id: 'pdf_NEW_FOLDER__1.pdf' });
  const h = setupMain({ docs: [replacement] });
  const oldDoc = makeDoc(0, { ...fields, ...metadata });
  const record = makeRecord(oldDoc, {
    book: { ...fields }, bookSources: Object.fromEntries(keys.map(key => [key, 'ocr']))
  });
  h.select(record);
  assert.equal(h.api.approveRecord(record), true);
  await h.uploadPDF();
  assert.equal(record.pdfDoc.id, replacement.id);
  assertPending(h.api, record);
  assert.equal(h.api.approveRecord(record), false, 'Old PDF OCR must not approve a newly uploaded PDF');
  assert.equal(h.api.evaluateVerification(record).isClean, false, 'Old PDF OCR must not certify a newly uploaded PDF');
});

test('legacy migration preserves a detached snapshot, invalidates approval and is idempotent', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(0, { ...fields }), {
    sourceVersion: undefined, book: { ...fields }, statusVerifikasi: 'Valid',
    approval: { at: '2020-01-02T00:00:00.000Z', source: 'manual' }
  });
  h.select(record);
  const expected = plain({ book: record.book, entry: record.entry, extraction: record.pdfDoc.extracted, statusVerifikasi: record.statusVerifikasi });
  h.api.migrateLegacyRecord(record);
  assert.deepEqual(plain(record.legacySnapshot), expected);
  assert.notEqual(record.legacySnapshot.book, record.book);
  assert.notEqual(record.legacySnapshot.entry, record.entry);
  assert.equal(record.requiresReverification, true);
  assert.equal(h.api.evaluateVerification(record).matchesCount, 0);
  assert.equal(h.api.approveRecord(record), false);
  assertPending(h.api, record);
  const migrated = plain(record);
  h.api.migrateLegacyRecord(record);
  assert.deepEqual(plain(record), migrated);
  assert.equal(record.approvalHistory.length, 1);
  assert.ok(record.approvalHistory[0].reason);
  assert.ok(!Number.isNaN(Date.parse(record.approvalHistory[0].invalidatedAt)));
});

for (const route of ['manual', 'OCR']) {
  test(`legacy old matches remain blocked until all four fields are re-established by ${route}`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { sourceVersion: undefined, book: { ...fields }, statusVerifikasi: 'Valid' });
    h.select(record);
    h.api.migrateLegacyRecord(record);
    const snapshot = plain(record.legacySnapshot);
    for (const [index, key] of keys.entries()) {
      if (route === 'manual') h.api.recordManualChange(record, 'book', key, fields[key]);
      else h.api.applyExtractionResult(record, { [key]: fields[key], ...metadata });
      if (index < keys.length - 1) {
        assert.equal(record.requiresReverification, true);
        assert.equal(h.api.evaluateVerification(record).isClean, false);
        assert.equal(h.api.approveRecord(record), false);
      }
      assertPending(h.api, record);
    }
    assert.equal(record.requiresReverification, false);
    assert.equal(h.api.evaluateVerification(record).isClean, true);
    assert.deepEqual(plain(record.legacySnapshot), snapshot);
    assert.equal(h.api.approveRecord(record), true);
  });
}

test('legacy empty OCR does not turn old matching data into trusted evidence', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), { sourceVersion: undefined, book: { ...fields } });
  h.select(record);
  h.api.migrateLegacyRecord(record);
  const snapshot = plain(record.legacySnapshot);
  h.api.applyExtractionResult(record, { ...empty, ...metadata });
  assert.equal(record.requiresReverification, true);
  assert.equal(h.api.evaluateVerification(record).matchesCount, 0);
  assert.equal(h.api.approveRecord(record), false);
  assert.deepEqual(plain(record.legacySnapshot), snapshot);
});

for (const side of ['book', 'entry']) {
  test(`manual ${side} input invalidates approval and records a basic audit trail without changing the import`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields } });
    h.select(record);
    const input = h.element(`${side}-input`);
    input.attributes[side === 'book' ? 'data-book-key' : 'data-field-key'] = 'namaSuami';
    h.element('proofread-content').matches[side === 'book' ? '.f-buku-input' : '.f-entry-input'] = [input];
    h.api.renderProofreadingDetail();
    assert.equal(h.api.approveRecord(record), true);
    const approval = plain(record.approval);
    assert.equal(approval.source, 'manual');
    assert.equal(approval.pdfId, record.pdfDoc.id);
    assert.deepEqual(approval.book, fields);
    assert.deepEqual(approval.entry, fields);
    assert.ok(!Number.isNaN(Date.parse(approval.at)));
    assert.notEqual(record.approval.book, record.book);
    assert.notEqual(record.approval.entry, record.entry);
    input.handlers.input({ target: { getAttribute: name => input.getAttribute(name), value: 'MANUAL CHANGE' } });
    assertPending(h.api, record);
    const [change] = record.changeHistory;
    assert.equal(change.side, side);
    assert.equal(change.key, 'namaSuami');
    assert.equal(change.before, fields.namaSuami);
    assert.equal(change.after, 'MANUAL CHANGE');
    assert.equal(change.source, 'manual');
    assert.ok(!Number.isNaN(Date.parse(change.at)));
    const [history] = record.approvalHistory;
    assert.deepEqual(plain(history.book), approval.book);
    assert.deepEqual(plain(history.entry), approval.entry);
    assert.ok(history.reason);
    assert.ok(!Number.isNaN(Date.parse(history.invalidatedAt)));
    assert.deepEqual(plain(record.originalEntry), fields);
  });
}

for (const incoming of [{ ...empty, ...metadata }, { ...fields, ...metadata }]) {
  test(`${incoming.noAkta ? 'matching' : 'empty'} OCR invalidates existing manual approval without approving again`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields } });
    h.select(record);
    assert.equal(h.api.approveRecord(record), true);
    const entry = plain(record.entry), snapshot = plain(record.originalEntry);
    h.api.applyExtractionResult(record, incoming);
    assertPending(h.api, record);
    assertIndependent(record, entry, snapshot);
    assert.equal(record.approvalHistory.length, 1);
    assert.ok(record.approvalHistory[0].reason);
    assert.equal(h.api.evaluateVerification(record).isClean, true);
  });
}

test('detail/table retain structural verification controls without mutating data or asserting a design', () => {
  const h = setupMain();
  const record = makeRecord(makeDoc(), { book: { ...fields } });
  h.select(record);
  const before = plain(record);
  h.api.renderProofreadingDetail();
  const detail = h.element('proofread-content').innerHTML;
  for (const key of keys) {
    assert.match(detail, new RegExp(`data-book-key="${key}"`));
    assert.match(detail, new RegExp(`data-field-key="${key}"`));
  }
  assert.match(detail, /id="record-status-select"/);
  assert.match(detail, /id="btn-mark-resolved"/);
  assert.match(detail, /id="btn-trigger-single-ocr"/);
  h.api.renderProofreadingTable();
  const table = h.element('proofread-content').innerHTML;
  assert.match(table, /<table\b/);
  assert.match(table, /<thead\b/);
  assert.match(table, /<tbody\b/);
  assert.deepEqual(plain(record), before);
  assertPending(h.api, record);
});

for (const route of ['on-demand', 'inspector', 'toolbar', 'batch']) {
  for (const transition of ['different PDF id', 'same PDF id, new object', 'Excel replaces record']) {
    test(`late ${route} OCR is discarded after ${transition}`, { timeout: 3000 }, async () => {
      const started = deferred();
      const result = deferred();
      const oldDoc = makeDoc();
      const h = setupMain({
        docs: [oldDoc],
        recognize: doc => {
          started.resolve(doc);
          return result.promise;
        }
      });
      const record = makeRecord(oldDoc);
      h.select(record);
      const completion = startOCR(h, route, record);
      assert.equal(await started.promise, oldDoc, 'The old PDF must be in flight before state changes');
      assert.deepEqual(h.calls.ocr, [oldDoc.id]);
      assert.deepEqual(h.calls.saved, [], 'OCR has not completed yet');

      let currentRecord = record;
      if (transition === 'Excel replaces record') {
        h.uploadExcel();
        [currentRecord] = h.api.state.records;
        assert.notEqual(currentRecord, record);
        assert.equal(h.api.state.records.includes(record), false);
        assert.equal(record.pdfDoc, oldDoc, 'Removal guard must work even if the old PDF pointer is unchanged');
        assert.equal(currentRecord.pdfDoc, oldDoc);
      } else {
        const replacement = makeDoc(0, {
          ...metadata, namaSuami: 'REPLACEMENT CACHE ONLY'
        }, { id: transition === 'different PDF id' ? 'pdf_REPLACEMENT__1.pdf' : oldDoc.id });
        assert.equal(replacement.fileName, oldDoc.fileName, 'Filename alone cannot identify an in-flight document');
        record.pdfDoc = replacement;
        h.api.state.pdfDocuments = [replacement];
        assert.notEqual(record.pdfDoc, oldDoc);
        assert.equal(h.api.state.records.includes(record), true);
      }

      const oldBefore = plain(record);
      const currentBefore = plain(currentRecord);
      const oldCacheBefore = plain(oldDoc);
      const currentCacheBefore = plain(currentRecord.pdfDoc);
      const savedBefore = plain(h.calls.saved);
      const entry = currentRecord.entry;
      const originalEntry = currentRecord.originalEntry;
      result.resolve({ ...fields, ...metadata });
      await completion;
      await settleOCR();

      assert.deepEqual(h.calls.errors, [], 'A swallowed exception must not masquerade as rejecting stale OCR');
      assert.deepEqual(h.calls.alerts, []);
      assert.deepEqual(plain(record), oldBefore, 'Do not mutate the detached/rebound record');
      assert.deepEqual(plain(currentRecord), currentBefore, 'Do not apply old OCR to the replacement record');
      assert.deepEqual(plain(oldDoc), oldCacheBefore, 'Do not update the old document cache');
      assert.deepEqual(plain(currentRecord.pdfDoc), currentCacheBefore, 'Do not write into the replacement PDF cache');
      assert.deepEqual(h.calls.saved, savedBefore, 'Do not persist stale OCR under either document id');
      assert.equal(currentRecord.entry, entry);
      assert.equal(currentRecord.originalEntry, originalEntry);
      assertIndependent(currentRecord, currentBefore.entry, currentBefore.originalEntry);
      assertPending(h.api, record);
      assertPending(h.api, currentRecord);
      assert.equal(h.api.evaluateVerification(currentRecord).matchesCount, 0);
    });
  }
}

for (const invalidDate of ['31-02-2020', '29-02-2021', '2020-02-31']) {
  test(`identical invalid date ${invalidDate} renders separate Scan/Excel values, not a matched cell`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), {
      book: { ...fields, tglAkad: invalidDate },
      entry: { ...fields, tglAkad: invalidDate }
    });
    h.select(record);
    const before = plain(record);
    const evaluation = h.api.evaluateVerification(record);
    assert.equal(evaluation.evaluations.find(field => field.key === 'tglAkad').status, 'format_error');
    assert.equal(evaluation.isClean, false);
    h.api.renderProofreadingTable();
    const html = h.element('proofread-content').innerHTML;
    const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1];
    assert.ok(body, 'The rendered table must contain a body');
    const row = body.match(/<tr\b[^>]*data-record-index="0"[^>]*>([\s\S]*?)<\/tr>/)?.[1];
    assert.ok(row, 'Inspect the actual data row, not a summary or status banner');
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
    assert.equal(cells.length, 8);
    const dateCell = cells[3];
    assert.match(dateCell, /Scan:\s*<strong\b[^>]*>/);
    assert.match(dateCell, /Excel:\s*<span\b[^>]*class="val-diff-tag"/);
    assert.equal(dateCell.split(invalidDate).length - 1, 2, 'Show the invalid value independently on both sides');
    assert.doesNotMatch(dateCell, /class="val-buku"/, 'Invalid equal strings cannot use the single matched-value cell');
    assert.deepEqual(plain(record), before);
    assertPending(h.api, record);
  });
}

for (const side of ['book', 'entry']) {
  for (const key of keys) {
    test(`approval is false when the ${side}.${key} snapshot disagrees despite a clean evaluator result`, () => {
      const h = setupMain();
      const record = makeRecord(makeDoc(), { book: { ...fields } });
      h.select(record);
      assert.equal(h.api.approveRecord(record), true);
      assert.equal(h.api.isApproved(record), true);
      record.approval[side][key] = 'STALE SNAPSHOT';
      assert.equal(record.statusVerifikasi, 'Valid', 'Do not rely on an edit handler resetting status');
      assert.equal(h.api.evaluateVerification(record).isClean, true);
      assert.equal(h.api.isApproved(record), false);
    });
  }
}

for (const key of keys) {
  test(`matching live ${key} edits cannot reuse an approval for the old values`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields } });
    h.select(record);
    assert.equal(h.api.approveRecord(record), true);
    const approval = plain(record.approval);
    const value = key === 'tglAkad' ? '03-01-2020' : `${fields[key]} UPDATED`;
    record.book[key] = value;
    record.entry[key] = value;
    assert.equal(h.api.evaluateVerification(record).isClean, true);
    assert.equal(record.statusVerifikasi, 'Valid');
    assert.equal(h.api.isApproved(record), false);
    assert.deepEqual(plain(record.approval), approval);
    assert.deepEqual(plain(record.originalEntry), fields);
  });
}

for (const change of ['PDF detached', 'different PDF attached', 'wrong PDF snapshot', 'no approval', 'nonmanual approval']) {
  test(`matching Valid status is not approved after ${change}`, () => {
    const h = setupMain();
    const record = makeRecord(makeDoc(), { book: { ...fields } });
    h.select(record);
    assert.equal(h.api.approveRecord(record), true);
    assert.equal(h.api.isApproved(record), true);
    if (change === 'PDF detached') record.pdfDoc = null;
    if (change === 'different PDF attached') record.pdfDoc = makeDoc(1);
    if (change === 'wrong PDF snapshot') record.approval.pdfId = 'wrong-document';
    if (change === 'no approval') delete record.approval;
    if (change === 'nonmanual approval') record.approval.source = 'ocr';
    assert.equal(record.statusVerifikasi, 'Valid');
    assert.equal(h.api.evaluateVerification(record).isClean, true);
    assert.equal(h.api.isApproved(record), false);
  });
}
