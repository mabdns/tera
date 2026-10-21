/**
 * VerifAkta - Local Session & Auto-Save Manager (IndexedDB)
 * 
 * Provides robust offline-first persistence so users never lose progress on 200+ KUA records
 * when refreshing the page, closing tabs, or restarting the browser.
 * 
 * Stores:
 * 1. sessions: Current state, records, verification status, notes, positions
 * 2. pdf_files: Raw PDF File/Blob objects so PDF documents persist across reloads
 * 3. rendered_scans: Rendered canvas images (JPEG DataURLs) for instant visual preview
 */

const DB_NAME = 'VerifAktaDB';
const DB_VERSION = 3;
const STORE_SESSIONS = 'sessions';
const STORE_PDFS = 'pdf_files';
const STORE_RENDERED = 'rendered_scans';
const SESSION_KEY = 'active_kua_session';

let dbInstance = null;

/**
 * Open or initialize the IndexedDB instance
 */
function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      console.warn('IndexedDB tidak didukung pada browser ini.');
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        db.createObjectStore(STORE_PDFS, { keyPath: 'id' });
      }
      // Recreate rendered_scans to clean up poisoned generic keys like 'pdf-doc-1'
      if (db.objectStoreNames.contains(STORE_RENDERED)) {
        db.deleteObjectStore(STORE_RENDERED);
      }
      db.createObjectStore(STORE_RENDERED, { keyPath: 'id' });
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      console.error('Gagal membuka IndexedDB VerifAkta:', e.target.error);
      reject(e.target.error);
    };
  });
}

/**
 * Save current session state into IndexedDB
 */
export async function saveSessionState(sessionData) {
  try {
    const db = await openDB();
    if (!db) {
      saveToLocalStorageFallback(sessionData);
      return;
    }

    // Sanitize records to ensure clean structured cloning (remove DOM or raw File refs)
    const sanitizedRecords = (sessionData.records || []).map(r => ({
      id: r.id,
      no: r.no,
      fileName: r.fileName,
      noPorporasi: r.noPorporasi,
      statusVerifikasi: r.statusVerifikasi,
      catatan: r.catatan,
      book: { ...r.book },
      entry: { ...r.entry }
    }));

    const payload = {
      id: SESSION_KEY,
      records: sanitizedRecords,
      currentIndex: sessionData.currentIndex || 0,
      pdfFolderName: sessionData.pdfFolderName || '',
      spreadsheetFileName: sessionData.spreadsheetFileName || '',
      spreadsheetLoaded: !!sessionData.spreadsheetLoaded,
      pdfLoaded: !!sessionData.pdfLoaded,
      updatedAt: new Date().toISOString(),
      updatedTimeStr: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.put(payload);

      req.onsuccess = () => resolve(payload);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    console.warn('Gagal menyimpan sesi ke IndexedDB:', err);
  }
}

/**
 * Load saved session state from IndexedDB
 */
export async function loadSessionState() {
  try {
    const db = await openDB();
    if (!db) return loadFromLocalStorageFallback();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.get(SESSION_KEY);

      req.onsuccess = () => {
        const res = req.result;
        if (res && res.records && res.records.length > 0) {
          resolve(res);
        } else {
          resolve(null);
        }
      };

      req.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    console.warn('Gagal memuat sesi tersimpan:', err);
    return null;
  }
}

/**
 * Save all loaded PDF documents and blobs into IndexedDB so they survive page refreshes
 * @param {Array<Object>} docs - Array of loaded PDF document descriptors from pdfViewer.js
 * @param {string} folderName - Name of the PDF folder
 */
export async function savePDFFilesToDB(docs, folderName = '') {
  if (!docs || docs.length === 0) return;

  try {
    const db = await openDB();
    if (!db) return;

    // Clear old PDF files AND old rendered scan cache so previous folder images never leak
    const tx = db.transaction([STORE_PDFS, STORE_RENDERED], 'readwrite');
    tx.objectStore(STORE_PDFS).clear();
    tx.objectStore(STORE_RENDERED).clear();

    const pdfStore = tx.objectStore(STORE_PDFS);

    // Save each doc's file blob with folder-scoped unique ID
    for (const doc of docs) {
      const blobToSave = doc.file || (doc.arrayBuffer ? new Blob([doc.arrayBuffer], { type: 'application/pdf' }) : null);
      if (blobToSave) {
        const safeFolder = (folderName || doc.folderName || 'folder').trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        const safeFile = (doc.fileName || 'file.pdf').trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        const docId = (doc.id && doc.id.includes('__')) ? doc.id : `pdf_${safeFolder}__${safeFile}`;

        pdfStore.put({
          id: docId,
          index: (typeof doc.index === 'number') ? doc.index : 0,
          num: (typeof doc.num === 'number' && !isNaN(doc.num)) ? doc.num : (doc.index + 1),
          fileName: doc.fileName,
          folderName: folderName || doc.folderName || 'Folder PDF',
          fileSize: doc.fileSize || '',
          blob: blobToSave
        });
      }
    }

    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => {
        console.warn('Gagal menyimpan berkas PDF ke IndexedDB:', e.target.error);
        resolve();
      };
    });
  } catch (err) {
    console.warn('savePDFFilesToDB error:', err);
  }
}

/**
 * Load saved PDF files from IndexedDB
 * @returns {Promise<Array<Object>>} Array of restored PDF document descriptors
 */
export async function loadPDFFilesFromDB() {
  try {
    const db = await openDB();
    if (!db) return [];

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_PDFS, 'readonly');
      const store = tx.objectStore(STORE_PDFS);
      const req = store.getAll();

      req.onsuccess = () => {
        const results = req.result || [];
        if (results.length === 0) {
          resolve([]);
          return;
        }

        // Sort naturally by num or index
        results.sort((a, b) => {
          const numA = (typeof a.num === 'number') ? a.num : (a.index || 0);
          const numB = (typeof b.num === 'number') ? b.num : (b.index || 0);
          return numA - numB;
        });

        // Convert to pdfViewer doc descriptors with guaranteed folder-scoped unique IDs
        const restoredDocs = results.map(item => {
          const safeFolder = (item.folderName || 'folder').trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
          const safeFile = (item.fileName || 'file.pdf').trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
          const docId = (item.id && item.id.includes('__')) ? item.id : `pdf_${safeFolder}__${safeFile}`;

          return {
            id: docId,
            index: item.index,
            num: item.num,
            fileName: item.fileName,
            folderName: item.folderName,
            fileSize: item.fileSize,
            file: item.blob, // Blob works as File in pdfjsLib.getDocument({ data: await blob.arrayBuffer() })
            dataURL: null,
            pageImages: [],
            numPages: 1,
            rawText: '',
            extracted: null
          };
        });

        resolve(restoredDocs);
      };

      req.onerror = () => resolve([]);
    });
  } catch (err) {
    console.warn('loadPDFFilesFromDB error:', err);
    return [];
  }
}

/**
 * Save rendered scan image (JPEG DataURL) and extracted OCR data into IndexedDB for instant visual preview
 */
export async function saveRenderedScanToDB(docId, dataURL, pageImages = [], numPages = 1, extracted = null) {
  // Only cache if docId is properly scoped to a folder (prevent generic collisions)
  if (!docId || !docId.includes('__') || !dataURL) return;

  try {
    const db = await openDB();
    if (!db) return;

    const tx = db.transaction(STORE_RENDERED, 'readwrite');
    const store = tx.objectStore(STORE_RENDERED);
    store.put({
      id: docId,
      dataURL,
      pageImages,
      numPages,
      extracted: extracted || null,
      cachedAt: Date.now()
    });
  } catch (err) {
    console.warn('saveRenderedScanToDB error:', err);
  }
}

/**
 * Load cached rendered scan image from IndexedDB
 */
export async function loadRenderedScanFromDB(docId) {
  // Reject un-scoped legacy keys like 'pdf-doc-1' to avoid cross-session contamination
  if (!docId || !docId.includes('__')) return null;

  try {
    const db = await openDB();
    if (!db) return null;

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_RENDERED, 'readonly');
      const store = tx.objectStore(STORE_RENDERED);
      const req = store.get(docId);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

/**
 * Clear all saved sessions, PDF blobs, and rendered images
 */
export async function clearSessionState() {
  try {
    const db = await openDB();
    if (db) {
      const tx = db.transaction([STORE_SESSIONS, STORE_PDFS, STORE_RENDERED], 'readwrite');
      tx.objectStore(STORE_SESSIONS).clear();
      tx.objectStore(STORE_PDFS).clear();
      tx.objectStore(STORE_RENDERED).clear();
      await new Promise(resolve => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
    localStorage.removeItem('verifakta_backup_session');
  } catch (err) {
    console.warn('Gagal membersihkan sesi tersimpan:', err);
  }
}

/**
 * Debounce helper for high-frequency auto-saving (e.g. typing)
 */
let autoSaveTimer = null;
export function debouncedAutoSave(sessionData, delayMs = 350, onSavedCallback = null) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);

  autoSaveTimer = setTimeout(async () => {
    try {
      const res = await saveSessionState(sessionData);
      if (onSavedCallback && res) {
        onSavedCallback(res);
      }
    } catch (err) {
      console.warn('Auto-save error:', err);
    }
  }, delayMs);
}

// LocalStorage Fallback for restricted environments
function saveToLocalStorageFallback(sessionData) {
  try {
    const sanitized = {
      records: (sessionData.records || []).slice(0, 300).map(r => ({
        id: r.id,
        no: r.no,
        fileName: r.fileName,
        statusVerifikasi: r.statusVerifikasi,
        catatan: r.catatan,
        book: { ...r.book },
        entry: { ...r.entry }
      })),
      currentIndex: sessionData.currentIndex || 0,
      pdfFolderName: sessionData.pdfFolderName || '',
      spreadsheetLoaded: !!sessionData.spreadsheetLoaded,
      updatedTimeStr: new Date().toLocaleTimeString('id-ID')
    };
    localStorage.setItem('verifakta_backup_session', JSON.stringify(sanitized));
  } catch (e) {
    // ignore
  }
}

function loadFromLocalStorageFallback() {
  try {
    const raw = localStorage.getItem('verifakta_backup_session');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
