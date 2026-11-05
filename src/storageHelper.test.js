import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import test from 'node:test';

let moduleId = 0;
const freshStorage = () => import(`./storageHelper.js?storage-test=${++moduleId}`);
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));

function setupStorage(t, backend) {
  const globals = ['window', 'indexedDB', 'localStorage'];
  const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => globals.forEach((key, index) => {
    if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index]);
    else delete globalThis[key];
  }));

  const stores = new Map();
  const writes = [];
  const local = new Map();
  function request(operation) {
    const req = {};
    queueMicrotask(() => {
      req.result = operation();
      req.onsuccess?.({ target: req });
    });
    return req;
  }
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, options) {
      assert.equal(options.keyPath, 'id');
      stores.set(name, new Map());
    },
    deleteObjectStore: name => stores.delete(name),
    transaction(name, mode) {
      return {
        objectStore(storeName) {
          assert.equal(storeName, name);
          const store = stores.get(name);
          assert.ok(store, `Missing object store: ${name}`);
          return {
            put(payload) {
              assert.equal(mode, 'readwrite');
              // Real IndexedDB clones synchronously, rejecting functions and DOM references.
              const saved = clone(payload);
              writes.push(saved);
              return request(() => { store.set(saved.id, saved); return saved.id; });
            },
            get: id => request(() => clone(store.get(id)))
          };
        }
      };
    }
  };
  let initialized = false;
  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'VerifAktaDB');
      assert.equal(version, 3);
      const req = {};
      queueMicrotask(() => {
        req.result = db;
        if (!initialized) {
          req.onupgradeneeded?.({ target: req });
          initialized = true;
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };
  globalThis.window = backend === 'indexedDB' ? { indexedDB } : {};
  globalThis.indexedDB = indexedDB;
  globalThis.localStorage = {
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: key => local.delete(key)
  };
  return { writes, local };
}

function makeSession() {
  const originalEntry = Object.freeze({
    fileName: '17.pdf', noAkta: '17/002/I/2020', tglAkad: '02-01-2020',
    namaSuami: 'ALI', namaIstri: 'SITI', blankImportedCell: ''
  });
  const corrected = { ...originalEntry, namaSuami: 'ALI bin UMAR' };
  const extraction = {
    sourceVersion: 2, source: 'local', requiresReview: true,
    warnings: ['Periksa scan'], latestFields: { namaSuami: 'ALI' },
    fieldDetails: { namaSuami: { suggestions: ['ALI bin UMAR'], confidence: 0.8 } },
    timings: { total: 17 }, attempts: [null, { source: 'pdf-text' }]
  };
  const approval = {
    at: '2026-11-05T10:00:00.000Z', source: 'manual',
    book: { ...corrected }, entry: { ...corrected }, pdfId: 'pdf_folder__17.pdf'
  };
  return {
    records: [{
      id: 'imported-42', no: 42, fileName: '17.pdf', noPorporasi: '0099',
      statusVerifikasi: 'Valid', catatan: 'Diperiksa petugas',
      sourceVersion: 2, book: { ...corrected }, entry: { ...corrected }, originalEntry,
      bookSources: { noAkta: 'ocr', tglAkad: 'ocr', namaSuami: 'manual', namaIstri: 'manual' },
      approval,
      changeHistory: [{ side: 'book', key: 'namaSuami', before: 'ALI', after: 'ALI bin UMAR', source: 'manual', at: approval.at }],
      approvalHistory: [{ ...approval, invalidatedAt: approval.at, reason: 'Data disunting petugas' }],
      previousDocuments: [{ pdfId: 'pdf_old__17.pdf', book: { namaSuami: 'OLD' }, bookSources: { namaSuami: 'manual' }, extraction, approval }],
      legacySnapshot: {
        book: { namaSuami: 'LEGACY BOOK' }, entry: { namaSuami: 'LEGACY ENTRY' },
        extraction: { source: 'legacy-cache', warnings: ['Old audit evidence'] },
        statusVerifikasi: 'Valid', approval, changeHistory: [{ before: '', after: 'LEGACY BOOK' }]
      },
      requiresReverification: false, pairingRequired: false, extraction
    }],
    currentIndex: 0, pdfFolderName: '2020 - 1', spreadsheetFileName: 'reference.xlsx',
    spreadsheetLoaded: true, pdfLoaded: true
  };
}

for (const backend of ['indexedDB', 'localStorage']) {
  test(`${backend}: actual serializer preserves manual approval, immutable import and audit metadata across reloads`, async t => {
    const { writes, local } = setupStorage(t, backend);
    const session = makeSession();
    const expected = plain(session);
    const storage = await freshStorage();
    const saved = await storage.saveSessionState(session);
    assert.ok(saved, 'Both save backends return the saved payload');
    const stored = backend === 'indexedDB' ? writes[0] : JSON.parse(local.get('verifakta_backup_session'));
    assert.deepEqual(stored, saved);
    assert.equal(saved.id, 'active_kua_session');
    assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
    assert.equal(typeof saved.updatedTimeStr, 'string');

    // Saving must detach nested metadata, even before a browser reload.
    session.records[0].book.namaSuami = 'UNSAVED';
    session.records[0].approval.book.namaSuami = 'UNSAVED APPROVAL';
    session.records[0].extraction.warnings.push('UNSAVED WARNING');
    assert.deepEqual(saved.records, expected.records);
    const reloadedStorage = await freshStorage();
    const loaded = await reloadedStorage.loadSessionState();
    for (const key of Object.keys(expected)) assert.deepEqual(loaded[key], expected[key], key);
    const record = loaded.records[0];
    assert.equal(record.id, 'imported-42');
    assert.equal(record.fileName, '17.pdf');
    assert.equal(record.entry.fileName, '17.pdf');
    assert.equal(record.approval.pdfId, 'pdf_folder__17.pdf');
    assert.notEqual(record.id, record.approval.pdfId, 'Excel row IDs are not PDF IDs');
    assert.equal(record.originalEntry.namaSuami, 'ALI');
    assert.equal(Object.isFrozen(record.originalEntry), true);
    assert.throws(() => { record.originalEntry.namaSuami = 'OVERWRITTEN'; }, TypeError);
    assert.notStrictEqual(record.originalEntry, record.entry);
    record.entry.namaSuami = 'ANOTHER CORRECTION';
    record.book.namaSuami = 'ANOTHER CORRECTION';
    assert.equal(record.originalEntry.namaSuami, 'ALI');
    assert.equal(record.approval.entry.namaSuami, 'ALI bin UMAR');
    await reloadedStorage.saveSessionState(loaded);
    const secondReload = await (await freshStorage()).loadSessionState();
    assert.deepEqual(secondReload.records[0].originalEntry, expected.records[0].originalEntry);
    assert.deepEqual(secondReload.records[0].legacySnapshot, expected.records[0].legacySnapshot);
    assert.deepEqual(secondReload.records[0].approval, expected.records[0].approval);
  });

  test(`${backend}: excludes runtime references recursively without discarding metadata`, async t => {
    setupStorage(t, backend);
    class DOMNode { constructor() { this.nodeType = 1; this.onclick = () => {}; } }
    class PDFDocument { getPage() {} }
    const session = makeSession();
    const record = session.records[0];
    const pdfDoc = { id: record.approval.pdfId, fileName: record.fileName, pdf: new PDFDocument() };
    pdfDoc.self = pdfDoc;
    const runtime = {
      pdfDoc, file: new File(['%PDF'], '17.pdf', { type: 'application/pdf' }),
      canvas: new DOMNode(), pdf: new PDFDocument(), callback: () => {},
      missing: undefined, kept: { source: 'manual', reviewed: false, confidence: 0 }
    };
    record.pdfDoc = pdfDoc;
    record.rawFile = runtime.file;
    record.element = runtime.canvas;
    record.unlisted = 'must not persist';
    record.extraction.runtime = runtime;
    record.legacySnapshot.runtime = runtime;
    runtime.circular = runtime;
    const storage = await freshStorage();
    const saved = await storage.saveSessionState(session);
    assert.ok(saved, 'Runtime references must not break serialization');
    const loaded = await (await freshStorage()).loadSessionState();
    assert.deepEqual(loaded, saved);
    for (const key of ['pdfDoc', 'rawFile', 'element', 'unlisted']) assert.equal(key in loaded.records[0], false);
    const expected = { kept: { source: 'manual', reviewed: false, confidence: 0 } };
    assert.deepEqual(loaded.records[0].extraction.runtime, expected);
    assert.deepEqual(loaded.records[0].legacySnapshot.runtime, expected);
    assert.ok(record.pdfDoc === pdfDoc, 'Sanitization must not mutate live records');
  });

  test(`${backend}: preserves pending flags and all records beyond the old fallback limit`, async t => {
    setupStorage(t, backend);
    const session = makeSession();
    session.records = Array.from({ length: 301 }, (_, index) => ({
      ...session.records[0], id: `imported-${index}`, fileName: `${index}.pdf`,
      requiresReverification: true, pairingRequired: true, approval: null,
      statusVerifikasi: 'Belum Diperiksa'
    }));
    session.currentIndex = 300;
    await (await freshStorage()).saveSessionState(session);
    const loaded = await (await freshStorage()).loadSessionState();
    assert.deepEqual(loaded.records, plain(session.records));
    assert.equal(loaded.currentIndex, 300);
  });

  test(`${backend}: handles empty and legacy sessions without fabricating provenance`, async t => {
    setupStorage(t, backend);
    const storage = await freshStorage();
    assert.equal(await storage.loadSessionState(), null);
    await storage.saveSessionState({ records: [] });
    assert.equal(await storage.loadSessionState(), null);
    await storage.saveSessionState({ records: [{ id: 'legacy', fileName: 'old.pdf', book: { namaSuami: 'OLD' }, entry: {} }] });
    const loaded = await (await freshStorage()).loadSessionState();
    assert.deepEqual(loaded.records, [{ id: 'legacy', fileName: 'old.pdf', book: { namaSuami: 'OLD' }, entry: {} }]);
    assert.equal('sourceVersion' in loaded.records[0], false);
    assert.equal('originalEntry' in loaded.records[0], false);
    assert.equal('approval' in loaded.records[0], false);
  });
}

test('IndexedDB and localStorage serialize identical session payloads', async t => {
  const { writes, local } = setupStorage(t, 'indexedDB');
  const session = makeSession();
  await (await freshStorage()).saveSessionState(session);
  globalThis.window = {};
  await (await freshStorage()).saveSessionState(session);
  const fallback = JSON.parse(local.get('verifakta_backup_session'));
  const indexed = writes[0];
  for (const key of ['updatedAt', 'updatedTimeStr']) {
    assert.equal(typeof fallback[key], 'string');
    delete fallback[key];
    delete indexed[key];
  }
  assert.deepEqual(fallback, indexed);
});
