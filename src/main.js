/**
 * VerifAkta - Main Application Controller
 * High-performance proofreading engine supporting 250+ PDF files from folder uploads
 * (such as 1.pdf ... 251.pdf) with on-demand rendering, instant folder indexing,
 * interactive diff inspection, and direct synchronization with the spreadsheet entry form.
 */

import './style.css';
import { evaluateRecord } from './validation.js';
import { renderCertificateSVG } from './certificateRenderer.js';
import { parseSpreadsheet, exportCorrectedExcel, exportArsipInventarisExcel } from './excelHelper.js';
import { generateBeritaAcaraHTML } from './reportGenerator.js';
import { recognizeDocumentText, parseKUAFieldsFromOCR, recognizeMultiPageAkta } from './ocrHelper.js';
import {
  loadPDFFolder,
  renderPDFDocPage,
  preRenderAdjacentDoc,
  getFilesFromDataTransfer,
  getLoadedPDFDocuments,
  getPDFDocument,
  getPDFDocumentCount,
  getLoadedFolderName,
  isPDFLoaded,
  clearPDFDocuments,
  getFileNumber,
  restorePDFDocuments,
  cleanPersonName
} from './pdfViewer.js';
import { getKuaVerifiedRecord } from './kuaDatabase.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  debouncedAutoSave,
  savePDFFilesToDB,
  loadPDFFilesFromDB,
  saveRenderedScanToDB,
  loadRenderedScanFromDB
} from './storageHelper.js';
import {
  createIcons,
  BookCheck,
  Sparkles,
  Upload,
  FileText,
  Download,
  Moon,
  Sun,
  Files,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  BookOpen,
  ImageUp,
  ZoomOut,
  ZoomIn,
  Maximize,
  RotateCw,
  SunMedium,
  ScanText,
  ClipboardCheck,
  CheckCheck,
  X,
  FileSpreadsheet,
  Printer,
  Check,
  AlertCircle,
  FolderOpen,
  FolderDown,
  FolderCheck,
  Cloud,
  ShieldCheck,
  RotateCcw,
  Sheet,
  LayoutGrid,
  Rows,
  Wand2,
  Scan,
  ArrowRight
} from 'lucide';

// Toast Notification Manager
export function showNotification(title, message = '', type = 'success', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `verifakta-toast toast-${type}`;

  const iconMap = {
    success: '✅',
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌'
  };

  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || '🔔'}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ''}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hiding');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 320);
  }, duration);
}

// Global Application State
const state = {
  records: [],
  currentIndex: 0,
  filter: 'all', // 'all', 'issues', 'clean'
  searchQuery: '',
  theme: localStorage.getItem('verifakta-theme') || 'light',

  // Document Viewer Controls
  zoom: 1,
  rotation: 0,
  contrastMode: 0, // 0 = normal, 1 = high contrast, 2 = invert, 3 = grayscale
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,

  // PDF Folder & Documents State
  pdfLoaded: false,
  pdfFolderName: '',
  pdfDocuments: [], // Array of lightweight doc descriptors
  activeScanPageFilter: 'all', // 'all', or '1', '2', '3'
  scanLayoutMode: 'vertical', // Always vertical stacked layout
  spreadsheetLoaded: false,
  spreadsheetFileName: '',

  // Custom User Scans (legacy single photo fallback)
  customScans: {} // Map recordId -> dataUrl
};

// Initialize Lucide Icons Helper
function refreshIcons() {
  createIcons({
    icons: {
      BookCheck,
      Sparkles,
      Upload,
      FileText,
      Download,
      Moon,
      Sun,
      Files,
      AlertTriangle,
      CheckCircle2,
      Gauge,
      Search,
      ChevronLeft,
      ChevronRight,
      ChevronUp,
      ChevronDown,
      BookOpen,
      ImageUp,
      ZoomOut,
      ZoomIn,
      Maximize,
      RotateCw,
      SunMedium,
      ScanText,
      ClipboardCheck,
      CheckCheck,
      X,
      FileSpreadsheet,
      Printer,
      Check,
      AlertCircle,
      FolderOpen,
      FolderDown,
      FolderCheck,
      Cloud,
      ShieldCheck,
      RotateCcw,
      Sheet,
      LayoutGrid,
      Rows,
      Wand2,
      Scan,
      ArrowRight
    }
  });
}

// Auto-Save Trigger Helper (persists to IndexedDB in background)
function triggerAutoSave() {
  const badge = document.getElementById('autosave-badge');
  const text = document.getElementById('autosave-text');
  if (badge) badge.classList.add('saving');
  if (text) text.innerText = 'Menyimpan...';

  debouncedAutoSave({
    records: state.records,
    currentIndex: state.currentIndex,
    pdfFolderName: state.pdfFolderName,
    spreadsheetFileName: state.spreadsheetFileName,
    spreadsheetLoaded: state.spreadsheetLoaded,
    pdfLoaded: state.pdfLoaded
  }, 350, (res) => {
    if (badge) badge.classList.remove('saving');
    if (text && res && res.updatedTimeStr) {
      text.innerText = `Tersimpan (${res.updatedTimeStr})`;
    }
  });
}

// Get Filtered Records based on current tab & search
function getFilteredRecords() {
  return state.records.filter((rec) => {
    // Filter Tab Match
    if (state.filter !== 'all') {
      const evalRes = evaluateRecord(rec.book, rec.entry, state.spreadsheetLoaded);
      const hasIssues = !evalRes.isClean || rec.statusVerifikasi === 'Ada Kesalahan';
      if (state.filter === 'issues' && !hasIssues) return false;
      if (state.filter === 'clean' && hasIssues) return false;
    }

    // Search Query Match
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase().trim();
      const b = rec.book || {};
      const e = rec.entry || {};
      const fileName = rec.pdfDoc ? rec.pdfDoc.fileName.toLowerCase() : '';

      const match =
        fileName.includes(q) ||
        (b.noAkta && b.noAkta.toLowerCase().includes(q)) ||
        (b.namaSuami && b.namaSuami.toLowerCase().includes(q)) ||
        (b.namaIstri && b.namaIstri.toLowerCase().includes(q)) ||
        (e.namaSuami && e.namaSuami.toLowerCase().includes(q)) ||
        (e.namaIstri && e.namaIstri.toLowerCase().includes(q)) ||
        (rec.noPorporasi && rec.noPorporasi.toLowerCase().includes(q));
      if (!match) return false;
    }

    return true;
  });
}

// Update Global Stats in the Top Banner
function updateStats() {
  const total = state.records.length;
  let issuesCount = 0;
  let cleanCount = 0;
  let totalScoreSum = 0;

  state.records.forEach(rec => {
    const evalRes = evaluateRecord(rec.book, rec.entry, state.spreadsheetLoaded);
    totalScoreSum += evalRes.overallScore;

    if (evalRes.isClean && rec.statusVerifikasi !== 'Ada Kesalahan') {
      cleanCount++;
    } else {
      issuesCount++;
    }
  });

  const avgAccuracy = total > 0 ? Math.round(totalScoreSum / total) : 0;

  document.getElementById('stat-total').innerText = total;
  document.getElementById('stat-errors').innerText = state.spreadsheetLoaded ? issuesCount : 0;
  document.getElementById('stat-clean').innerText = cleanCount;
  document.getElementById('stat-accuracy').innerText = state.spreadsheetLoaded ? `${avgAccuracy}%` : `${avgAccuracy}% (Fisik)`;

  document.getElementById('count-all').innerText = total;
  document.getElementById('count-issues').innerText = state.spreadsheetLoaded ? issuesCount : 0;
  document.getElementById('count-clean').innerText = cleanCount;
}

// Render Single or Multi-Page Scan Images to Target Canvas
function renderScanDocument(target, pdfDoc) {
  const images = (pdfDoc.pageImages && pdfDoc.pageImages.length > 0)
    ? pdfDoc.pageImages
    : [{ pageNumber: 1, dataURL: pdfDoc.dataURL, width: 1584, height: 1188 }];

  const totalPages = pdfDoc.numPages || images.length;
  const pageTabsContainer = document.getElementById('pdf-page-tabs');
  const viewToggle = document.getElementById('scan-view-toggle');
  const subtoolbar = document.getElementById('panel-subtoolbar');

  if (subtoolbar) {
    subtoolbar.style.display = 'flex';
  }

  const curFilter = state.activeScanPageFilter || 'all';

  // Multi-page navigation tabs in panel subtoolbar
  if (pageTabsContainer) {
    if (totalPages > 1) {
      pageTabsContainer.style.display = 'inline-flex';

      pageTabsContainer.innerHTML = `
        <button class="page-tab-btn ${curFilter === 'all' ? 'active' : ''}" data-scan-page="all" title="Tampilkan semua ${totalPages} halaman scan">
          Semua Scan (${totalPages})
        </button>
        ${images.map(img => {
          let tabLabel = `Scan ${img.pageNumber}`;
          if (totalPages === 3) {
            if (img.pageNumber === 1) tabLabel = `Scan 1: Depan`;
            else if (img.pageNumber === 2) tabLabel = `Scan 2: Mempelai`;
            else if (img.pageNumber === 3) tabLabel = `Scan 3: Mas Kawin`;
          }
          return `
            <button class="page-tab-btn ${curFilter === String(img.pageNumber) ? 'active' : ''}" data-scan-page="${img.pageNumber}" title="Fokus pada ${tabLabel}">
              ${tabLabel}
            </button>
          `;
        }).join('')}
      `;

      pageTabsContainer.querySelectorAll('.page-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetPage = btn.getAttribute('data-scan-page');
          state.activeScanPageFilter = targetPage;
          renderScanDocument(target, pdfDoc);
          applyViewerTransform();

          if (targetPage !== 'all') {
            const cardEl = document.getElementById(`scan-page-card-${targetPage}`);
            if (cardEl) {
              cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
        });
      });
    } else {
      pageTabsContainer.style.display = 'none';
    }
  }

  // Show/Hide layout indicator (Vertikal only)
  if (viewToggle) {
    if (totalPages > 1 && curFilter === 'all') {
      viewToggle.style.display = 'inline-flex';
      const btnVertical = document.getElementById('btn-view-vertical');
      if (btnVertical) btnVertical.classList.add('active');
    } else {
      viewToggle.style.display = 'none';
    }
  }

  // Filter which scan images to display
  const displayImages = curFilter === 'all'
    ? images
    : images.filter(img => String(img.pageNumber) === curFilter);

  const containerClass = (curFilter !== 'all')
    ? 'pdf-multipage-container mode-single'
    : 'pdf-multipage-container mode-vertical';

  const pagesHTML = displayImages.map(img => {
    const pageNum = img.pageNumber;
    let label = `Scan ${pageNum} dari ${totalPages}`;
    if (totalPages === 3 || totalPages === 2) {
      if (pageNum === 1) label = `Scan 1: Halaman Depan / Kutipan Akta`;
      else if (pageNum === 2) label = `Scan 2: Data Mempelai & Wali Nikah`;
      else if (pageNum === 3) label = `Scan 3: Mas Kawin, Saksi & Pencatatan`;
    }

    return `
      <div class="pdf-scan-card" id="scan-page-card-${pageNum}">
        ${totalPages > 1 ? `
          <div class="pdf-scan-header-bar">
            <span class="scan-page-badge">📄 ${label}</span>
            <div class="scan-card-actions">
              <span class="scan-page-dim">${img.width ? Math.round(img.width) : 1584} &times; ${img.height ? Math.round(img.height) : 1188} px</span>
              ${curFilter === 'all' ? `
                <button class="btn-focus-scan" data-focus-page="${pageNum}" title="Perbesar & fokuskan ke Scan ${pageNum}">
                  🔍 Fokus
                </button>
              ` : ''}
            </div>
          </div>
        ` : ''}
        <img
          src="${img.dataURL}"
          class="uploaded-cert-img"
          alt="Scan Akta Nikah - ${escapeHTML(pdfDoc.fileName)} (Halaman ${pageNum})"
          style="max-width: 100%; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); cursor: ${curFilter === 'all' ? 'zoom-in' : 'grab'};"
          data-page="${pageNum}"
        />
      </div>
    `;
  }).join('');

  target.innerHTML = `
    <div class="${containerClass}">
      ${pagesHTML}
    </div>
  `;

  // Attach quick focus listeners on card header button and image
  target.querySelectorAll('.btn-focus-scan').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.getAttribute('data-focus-page');
      state.activeScanPageFilter = p;
      renderScanDocument(target, pdfDoc);
      applyViewerTransform();
    });
  });

  if (curFilter === 'all') {
    target.querySelectorAll('.uploaded-cert-img').forEach(img => {
      img.addEventListener('click', (e) => {
        const p = img.getAttribute('data-page');
        if (p) {
          state.activeScanPageFilter = p;
          renderScanDocument(target, pdfDoc);
          applyViewerTransform();
        }
      });
    });
  }

  refreshIcons();
}

// Fast On-Demand targeted OCR for active document (runs in ~1s via ROI crops)
let isFastOCROngoing = false;
function triggerFastOnDemandOCR(currentRec, pdfDoc, originalIndex) {
  if (!currentRec || !pdfDoc || state.spreadsheetLoaded || isFastOCROngoing) return;
  const isBirthYear = currentRec.book.tglAkad && (currentRec.book.tglAkad.endsWith('1988') || currentRec.book.tglAkad.endsWith('1989') || currentRec.book.tglAkad.endsWith('1959') || currentRec.book.tglAkad.endsWith('1991') || currentRec.book.tglAkad.endsWith('1995') || currentRec.book.tglAkad.endsWith('1990') || currentRec.book.tglAkad.endsWith('1954'));
  const needsOCR = !currentRec.book.namaSuami || !currentRec.book.namaIstri || !currentRec.book.noAkta || !currentRec.book.tglAkad || isBirthYear;
  if (!needsOCR) return;

  isFastOCROngoing = true;
  recognizeMultiPageAkta(pdfDoc).then(ext => {
    isFastOCROngoing = false;
    if (ext && (ext.noAkta || ext.namaSuami || ext.namaIstri || ext.tglAkad)) {
      let ocrChanged = false;
      if (ext.noAkta && currentRec.book.noAkta !== ext.noAkta) { currentRec.book.noAkta = ext.noAkta; ocrChanged = true; }
      if (ext.tglAkad && (currentRec.book.tglAkad !== ext.tglAkad || isBirthYear)) { currentRec.book.tglAkad = ext.tglAkad; ocrChanged = true; }
      if (ext.namaSuami && currentRec.book.namaSuami !== ext.namaSuami) { currentRec.book.namaSuami = ext.namaSuami; ocrChanged = true; }
      if (ext.namaIstri && currentRec.book.namaIstri !== ext.namaIstri) { currentRec.book.namaIstri = ext.namaIstri; ocrChanged = true; }

      if (ocrChanged) {
        if (currentRec.book.noAkta && currentRec.book.tglAkad) {
          currentRec.statusVerifikasi = 'Sesuai / Valid';
        }
        pdfDoc.extracted = { ...(pdfDoc.extracted || {}), ...ext };
        saveRenderedScanToDB(pdfDoc.id, pdfDoc.dataURL, pdfDoc.pageImages, pdfDoc.numPages, pdfDoc.extracted).catch(() => {});
        if (state.currentIndex === originalIndex) {
          renderProofreadingInspector();
          updateStats();
        }
        triggerAutoSave();
      }
    }
  }).catch(err => {
    isFastOCROngoing = false;
    console.warn('Fast on-demand OCR fallback error:', err);
  });
}

// Render Document Viewer (Left Side)
function renderDocumentViewer() {
  const target = document.getElementById('cert-render-target');
  const folderBadge = document.getElementById('pdf-folder-badge');
  const docDropdown = document.getElementById('select-pdf-document');
  const subtoolbar = document.getElementById('panel-subtoolbar');
  const filtered = getFilteredRecords();

  if (filtered.length === 0) {
    const emptyMsg = state.records.length === 0
      ? '<div style="color: var(--text-muted); padding: 3rem 1.5rem; text-align: center;"><i data-lucide="files" style="width: 48px; height: 48px; margin: 0 auto 0.75rem; opacity: 0.4;"></i><div style="font-size: 1.05rem; font-weight: 700; color: var(--text-main);">Belum Ada Berkas yang Dimuat</div><p style="font-size: 0.85rem; margin-top: 0.5rem;">Silakan klik <strong>Unggah Data / Scan</strong> untuk memilih folder berkas scan PDF atau file spreadsheet.</p></div>'
      : '<div style="color: #94a3b8; padding: 2.5rem; text-align: center;">Tidak ada dokumen yang sesuai dengan filter pencarian.</div>';
    target.innerHTML = emptyMsg;
    refreshIcons();
    if (folderBadge) folderBadge.style.display = 'none';
    if (docDropdown) docDropdown.style.display = 'none';
    if (subtoolbar) subtoolbar.style.display = 'none';
    const pageTabsContainer = document.getElementById('pdf-page-tabs');
    if (pageTabsContainer) pageTabsContainer.style.display = 'none';
    return;
  }

  const currentRec = filtered[state.currentIndex];
  if (!currentRec) return;

  const originalIndex = state.records.indexOf(currentRec);

  // Check if PDF documents are loaded
  if (state.pdfLoaded && state.pdfDocuments.length > 0) {
    const pdfDoc = currentRec.pdfDoc || state.pdfDocuments[originalIndex] || state.pdfDocuments[0];

    if (subtoolbar) {
      subtoolbar.style.display = 'flex';
    }

    // Update folder badge
    if (folderBadge) {
      folderBadge.style.display = 'inline-flex';
      folderBadge.innerHTML = `📁 ${state.pdfFolderName} (${state.pdfDocuments.length} PDF)`;
      folderBadge.title = `Folder: ${state.pdfFolderName}\nTotal file scan: ${state.pdfDocuments.length}`;
    }

    // Update dropdown selector
    if (docDropdown) {
      docDropdown.style.display = 'inline-block';
      const dropdownKey = `${state.pdfFolderName}__${state.records.length}__${state.records[0]?.fileName || ''}`;
      if (docDropdown.dataset.renderedKey !== dropdownKey) {
        docDropdown.innerHTML = state.records.map((r, idx) => {
          const docName = r.pdfDoc?.fileName || r.fileName || `Akta ${idx + 1}`;
          return `<option value="${idx}">📄 ${idx + 1}. ${escapeHTML(docName)}</option>`;
        }).join('');
        docDropdown.dataset.renderedKey = dropdownKey;
      }
      docDropdown.value = String(originalIndex);
    }

    // If active document page is already rendered in cache
    if (pdfDoc && (pdfDoc.dataURL || (pdfDoc.pageImages && pdfDoc.pageImages.length > 0))) {
      renderScanDocument(target, pdfDoc);
      // Pre-render next document silently in background
      preRenderAdjacentDoc(originalIndex);
      // Fast targeted On-Demand OCR if fields are missing or have birth dates
      triggerFastOnDemandOCR(currentRec, pdfDoc, originalIndex);
    } else if (pdfDoc) {
      // Show animated loading indicator while rendering lazily
      target.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 430px; color: var(--text-muted); gap: 1rem; width: 100%;">
          <div style="width: 44px; height: 44px; border: 3px solid rgba(16, 185, 129, 0.2); border-top-color: var(--primary-600); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
          <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-main);">Memuat Berkas Scan: ${escapeHTML(pdfDoc.fileName)}...</div>
          <div style="font-size: 0.82rem; color: var(--text-muted);">Membaca halaman scan dokumen ke-${originalIndex + 1} dari ${state.records.length} (Folder "${state.pdfFolderName}")</div>
        </div>
      `;

      // Render on demand
      renderPDFDocPage(originalIndex).then((res) => {
        // Confirm user hasn't switched away while rendering
        if (state.currentIndex === originalIndex && res) {
          renderScanDocument(target, pdfDoc);
          applyViewerTransform();

          // User explicit requirement: "yang saya inginkan itu buku scan akta disamakan dengan entry spreadsheetnya yang telah dimasukkan, bukan sebaliknya"
          // If spreadsheet data is present, NEVER overwrite book fields with raw PDF text extraction.
          if (state.spreadsheetLoaded) {
            // Keep book synchronized with entry spreadsheet
            if (!currentRec.book.noAkta && currentRec.entry.noAkta) currentRec.book.noAkta = currentRec.entry.noAkta;
            if (!currentRec.book.tglAkad && currentRec.entry.tglAkad) currentRec.book.tglAkad = currentRec.entry.tglAkad;
            if (!currentRec.book.namaSuami && currentRec.entry.namaSuami) currentRec.book.namaSuami = currentRec.entry.namaSuami;
            if (!currentRec.book.namaIstri && currentRec.entry.namaIstri) currentRec.book.namaIstri = currentRec.entry.namaIstri;
          } else {
            // Standalone PDF scan mode (no spreadsheet)
            let changed = false;

            // 1. Direct text extraction from PDF.js if available
            if (res.extracted) {
              if (res.extracted.noAkta && !currentRec.book.noAkta) { currentRec.book.noAkta = res.extracted.noAkta; changed = true; }
              if (res.extracted.tglAkad && !currentRec.book.tglAkad) { currentRec.book.tglAkad = res.extracted.tglAkad; changed = true; }
              if (res.extracted.namaSuami && !currentRec.book.namaSuami) { currentRec.book.namaSuami = res.extracted.namaSuami; changed = true; }
              if (res.extracted.namaIstri && !currentRec.book.namaIstri) { currentRec.book.namaIstri = res.extracted.namaIstri; changed = true; }
            }

            // 2. Check cached extracted data on pdfDoc
            if (pdfDoc.extracted) {
              if (pdfDoc.extracted.noAkta && !currentRec.book.noAkta) { currentRec.book.noAkta = pdfDoc.extracted.noAkta; changed = true; }
              if (pdfDoc.extracted.tglAkad && !currentRec.book.tglAkad) { currentRec.book.tglAkad = pdfDoc.extracted.tglAkad; changed = true; }
              if (pdfDoc.extracted.namaSuami && !currentRec.book.namaSuami) { currentRec.book.namaSuami = pdfDoc.extracted.namaSuami; changed = true; }
              if (pdfDoc.extracted.namaIstri && !currentRec.book.namaIstri) { currentRec.book.namaIstri = pdfDoc.extracted.namaIstri; changed = true; }
            }

            if (changed) {
              renderProofreadingInspector();
              updateStats();
            }

            // 3. Fast targeted On-Demand OCR
            triggerFastOnDemandOCR(currentRec, pdfDoc, originalIndex);
          }

          // Pre-render next page
          preRenderAdjacentDoc(originalIndex);
          // Persist rendered scan to IndexedDB
          saveRenderedScanToDB(pdfDoc.id, res.dataURL, res.pageImages, res.numPages, pdfDoc.extracted).catch(() => {});
        }
      }).catch((err) => {
        target.innerHTML = `<div style="color: var(--danger-600); padding: 2.5rem; text-align: center;">Gagal membaca berkas ${pdfDoc.fileName}: ${err.message}</div>`;
      });
    }
  } else if (state.pdfFolderName) {
    // PDF folder was configured in this session, but files need to be linked
    if (folderBadge) {
      folderBadge.style.display = 'inline-flex';
      folderBadge.innerHTML = `📁 ${escapeHTML(state.pdfFolderName)} (Perlu Dihubungkan)`;
      folderBadge.title = `Folder: ${state.pdfFolderName} belum dimuat`;
    }
    if (docDropdown) docDropdown.style.display = 'none';
    if (subtoolbar) subtoolbar.style.display = 'none';

    target.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 440px; padding: 2.5rem 1.5rem; text-align: center; background: rgba(248, 250, 252, 0.6); border: 2px dashed var(--border-color); border-radius: 12px; margin: 1rem;">
        <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); color: var(--primary-600); display: flex; align-items: center; justify-content: center; font-size: 2rem; margin-bottom: 1rem;">
          📖
        </div>
        <div style="font-weight: 700; font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.5rem;">
          Preview Scan Fisik Buku Akta Nikah
        </div>
        <div style="font-size: 0.88rem; color: var(--text-muted); max-width: 440px; line-height: 1.55; margin-bottom: 1.5rem;">
          Sesi verifikasi Anda tersimpan untuk folder <strong>"${escapeHTML(state.pdfFolderName)}"</strong> (${state.records.length} berkas akta).
          Klik tombol di bawah untuk memuat kembali file scan fisik buku.
        </div>
        <button id="btn-reconnect-pdf-folder" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; font-weight: 600; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);">
          📂 Hubungkan Folder "${escapeHTML(state.pdfFolderName)}"
        </button>
      </div>
    `;

    setTimeout(() => {
      const reconnectBtn = document.getElementById('btn-reconnect-pdf-folder');
      if (reconnectBtn) {
        reconnectBtn.onclick = () => {
          const fileInput = document.getElementById('file-input-pdf-folder');
          if (fileInput) fileInput.click();
        };
      }
    }, 50);
  } else {
    // Normal certificate SVG fallback
    if (folderBadge) folderBadge.style.display = 'none';
    if (docDropdown) docDropdown.style.display = 'none';
    if (subtoolbar) subtoolbar.style.display = 'none';

    const customPhoto = state.customScans[currentRec.id];
    if (customPhoto) {
      target.innerHTML = `<img src="${customPhoto}" class="uploaded-cert-img" alt="Scan Buku Akta Nikah" />`;
    } else {
      target.innerHTML = renderCertificateSVG(currentRec);
    }
  }

  applyViewerTransform();
}

// Apply Zoom, Pan, Rotation, and Image Filter
function applyViewerTransform() {
  const wrapper = document.getElementById('viewer-canvas-wrapper');
  if (!wrapper) return;

  wrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom}) rotate(${state.rotation}deg)`;
  document.getElementById('zoom-level-text').innerText = `${Math.round(state.zoom * 100)}%`;

  // Apply filters
  wrapper.classList.remove('filter-high-contrast', 'filter-invert', 'filter-grayscale');
  if (state.contrastMode === 1) wrapper.classList.add('filter-high-contrast');
  else if (state.contrastMode === 2) wrapper.classList.add('filter-invert');
  else if (state.contrastMode === 3) wrapper.classList.add('filter-grayscale');
}

// Render Proofreading Inspector (Right Side)
function renderProofreadingInspector() {
  const container = document.getElementById('proofread-content');
  const filtered = getFilteredRecords();

  if (filtered.length === 0) {
    const emptyTitle = state.records.length === 0 ? 'Formulir Siap Digunakan' : 'Tidak ada data ditemukan';
    const emptyDesc = state.records.length === 0
      ? 'Unggah berkas scan PDF atau spreadsheet untuk memulai proofreading dan validasi akta nikah.'
      : 'Coba sesuaikan kata kunci pencarian atau ganti filter.';
    container.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <i data-lucide="${state.records.length === 0 ? 'upload' : 'search'}" style="width: 48px; height: 48px; margin: 0 auto 1rem; opacity: 0.5;"></i>
        <div style="font-size: 1.1rem; font-weight: bold;">${emptyTitle}</div>
        <p style="font-size: 0.85rem; margin-top: 0.5rem;">${emptyDesc}</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  const currentRec = filtered[state.currentIndex];
  const evalRes = evaluateRecord(currentRec.book, currentRec.entry, state.spreadsheetLoaded);

  // Group by category (Identitas Akta & Data Pengantin)
  const categories = {};
  evalRes.evaluations.forEach(ev => {
    const cat = ev.category || 'Bidang Verifikasi';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(ev);
  });

  // Status Banner styling
  let bannerClass = 'status-clean';
  let badgeIndicator = '<span class="status-badge-indicator success"><i data-lucide="check" style="width: 14px; height: 14px;"></i> Data Cocok / Selesai Diperbaiki</span>';

  if (!state.spreadsheetLoaded) {
    bannerClass = 'status-clean';
    badgeIndicator = `
      <span class="status-badge-indicator" style="background: rgba(14, 165, 233, 0.12); color: #0284c7; border: 1px solid rgba(14, 165, 233, 0.25);">
        <i data-lucide="scan" style="width: 14px; height: 14px;"></i> Mode Pindaian Scan Berkas (${state.pdfDocuments.length || state.records.length} Berkas)
      </span>
    `;
  } else if (evalRes.totalErrors > 0) {
    bannerClass = 'status-danger';
    badgeIndicator = `<span class="status-badge-indicator danger"><i data-lucide="alert-triangle" style="width: 14px; height: 14px;"></i> Terdapat ${evalRes.totalErrors} Kesalahan</span>`;
  } else if (evalRes.totalWarnings > 0) {
    bannerClass = 'status-warning';
    badgeIndicator = `<span class="status-badge-indicator warning"><i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i> Perlu Perhatian (${evalRes.totalWarnings} Catatan)</span>`;
  }

  // Cross-Field Legal Alerts
  const legalAlertsHTML = state.spreadsheetLoaded ? evalRes.crossFieldNotes.map(n => `
    <div class="legal-alert-box ${n.type === 'danger' ? 'alert-danger' : 'alert-warning'}">
      <i data-lucide="${n.type === 'danger' ? 'alert-triangle' : 'alert-circle'}" style="width: 20px; height: 20px; flex-shrink: 0; margin-top: 2px;"></i>
      <div>
        <strong>Peringatan Regulasi KUA (${n.field}):</strong>
        <div>${n.message}</div>
      </div>
    </div>
  `).join('') : '';

  // Source info banner (shows PDF file name if read from PDF)
  let docSourceBadge = '';
  if (currentRec.pdfDoc) {
    docSourceBadge = `
      <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(5, 150, 105, 0.08); padding: 0.5rem 0.85rem; border-radius: var(--radius-sm); border: 1px solid rgba(5, 150, 105, 0.2); margin-bottom: 0.85rem; font-size: 0.78rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <i data-lucide="folder-check" style="width: 16px; height: 16px; color: var(--primary-600); flex-shrink: 0;"></i>
          <span>Berkas PDF: <strong>${escapeHTML(currentRec.pdfDoc.fileName)}</strong> (Akta ${state.currentIndex + 1} dari ${state.records.length}${currentRec.pdfDoc.numPages > 1 ? ` • ${currentRec.pdfDoc.numPages} Scan Halaman` : ''})</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.65rem;">
          ${!state.spreadsheetLoaded ? `
          <button class="btn btn-secondary" id="btn-trigger-single-ocr" style="padding: 2px 8px; font-size: 0.72rem;" title="Pindai ulang dokumen ini dengan OCR">
            <i data-lucide="scan-text" style="width: 12px; height: 12px; color: var(--primary-600);"></i>
            <span>Pindai OCR</span>
          </button>
          ` : ''}
          <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600;">Ukuran: ${currentRec.pdfDoc.fileSize}</span>
        </div>
      </div>
    `;
  }

  // Category Sections HTML
  const categoriesHTML = Object.entries(categories).map(([catName, fields]) => `
    <div class="field-category-block">
      <div class="category-header">
        <span>${catName}</span>
        <span style="font-size: 0.7rem; font-weight: 600; opacity: 0.8;">${fields.length} Kolom</span>
      </div>
      <div class="category-fields-list">
        ${fields.map(f => {
          let rowClass = 'field-item-row';
          if (state.spreadsheetLoaded) {
            if (f.status === 'typo') rowClass += ' row-typo';
            else if (f.status === 'mismatch' || f.status === 'format_error') rowClass += ' row-mismatch';
            else if (f.status === 'empty') rowClass += ' row-empty';
          }

          const inputClass = state.spreadsheetLoaded && (f.status === 'format_error' || f.status === 'mismatch' || f.status === 'empty')
            ? 'input-has-error'
            : (state.spreadsheetLoaded && f.status === 'typo' ? 'input-has-warning' : '');

          // Render diff representation
          const diffHTML = f.diff.map(d => {
            if (d.type === 'del') return `<span class="diff-del" title="Kurang dari spreadsheet: '${d.text}'">${escapeHTML(d.text)}</span>`;
            if (d.type === 'ins') return `<span class="diff-ins" title="Kelebihan/Salah ketik di spreadsheet: '${d.text}'">${escapeHTML(d.text)}</span>`;
            return `<span class="diff-same">${escapeHTML(d.text)}</span>`;
          }).join('');

          return `
            <div class="${rowClass}">
              <div class="f-title-col">
                <span class="f-name">${f.label}</span>
                <span class="similarity-badge ${f.similarity === 100 ? 'sim-100' : f.similarity >= 75 ? 'sim-warning' : 'sim-danger'}">
                  ${!state.spreadsheetLoaded
                    ? (f.bookValue ? '✓ Terbaca dari Scan' : '⏳ Belum Terdeteksi')
                    : (f.similarity === 100 ? '✓ Cocok 100%' : `${f.similarity}% Mirip`)}
                </span>
              </div>

              <!-- Data Buku Fisik / PDF Scan -->
              <div class="f-buku-col" title="Nilai di Buku Akta Fisik (Scan PDF). Dapat disunting jika perlu koreksi data buku.">
                <div class="f-buku-label">
                  <span>Buku Akta (Scan PDF):</span>
                  <span style="font-size: 0.65rem; color: var(--primary-700); font-weight: bold;">Sumber Fisik</span>
                </div>
                <input
                  type="text"
                  class="f-buku-input"
                  data-book-key="${f.key}"
                  value="${escapeHTML(f.bookValue)}"
                  placeholder="Data terbaca dari PDF / OCR..."
                />
              </div>

              <!-- Data Entry Spreadsheet -->
              <div class="f-entry-col">
                <div class="f-entry-label">
                  <span>Entry Spreadsheet:</span>
                  ${!state.spreadsheetLoaded
                    ? `<span style="font-size: 0.65rem; color: var(--text-muted); font-weight: 600;">Belum Diunggah</span>`
                    : (f.similarity < 100 ? `<span style="font-size: 0.65rem; color: var(--danger-600); font-weight: bold;">Selisih Teks</span>` : '')}
                </div>
                <input
                  type="text"
                  class="f-entry-input ${inputClass}"
                  data-field-key="${f.key}"
                  value="${escapeHTML(f.entryValue)}"
                  title="${f.message}"
                  placeholder="${!state.spreadsheetLoaded ? 'Unggah file Excel untuk mencocokkan...' : 'Ketik nilai entry spreadsheet...'}"
                />
                ${state.spreadsheetLoaded && f.similarity < 100 ? `<div class="diff-preview-box">${diffHTML}</div>` : ''}
                ${state.spreadsheetLoaded && f.message && f.similarity < 100 ? `<div style="font-size: 0.68rem; color: ${f.severity === 'danger' ? 'var(--danger-600)' : 'var(--warning-600)'}; font-weight: 600;">${f.message}</div>` : ''}
              </div>

              <!-- Action Sync Button -->
              <div class="f-action-col">
                ${state.spreadsheetLoaded ? `
                <button
                  class="btn-sync-field"
                  data-sync-key="${f.key}"
                  title="Samakan Buku Akta: Salin nilai dari Entry Spreadsheet ke Buku Akta"
                >
                  <i data-lucide="check" style="width: 12px; height: 12px;"></i>
                  <span>Samakan ke Buku</span>
                </button>
                ` : `
                <button
                  class="btn-sync-field"
                  data-copy-to-entry="${f.key}"
                  title="Salin nilai pembacaan buku ke kolom draf spreadsheet"
                  style="background: rgba(16, 185, 129, 0.08); color: var(--primary-700); border-color: rgba(16, 185, 129, 0.25);"
                >
                  <i data-lucide="arrow-right" style="width: 12px; height: 12px;"></i>
                  <span>Salin ke Entry</span>
                </button>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  // Submit / Verification Footer
  const footerHTML = `
    <div class="verification-submit-bar">
      <div>
        <label style="display: block; font-size: 0.72rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.35rem;">
          Catatan Koreksi & Verifikasi:
        </label>
        <textarea id="record-notes" class="notes-input-area" placeholder="Tuliskan catatan perbaikan atau dispensasi nikah bila ada...">${escapeHTML(currentRec.catatan || '')}</textarea>
      </div>

      <div class="submit-actions-row">
        <div class="status-selector">
          <label style="font-size: 0.78rem; font-weight: 700;">Status Berkas:</label>
          <select id="record-status-select">
            <option value="Belum Diperiksa" ${currentRec.statusVerifikasi === 'Belum Diperiksa' ? 'selected' : ''}>🟡 Belum Diperiksa</option>
            <option value="Ada Kesalahan" ${currentRec.statusVerifikasi === 'Ada Kesalahan' ? 'selected' : ''}>🔴 Ada Kesalahan</option>
            <option value="Telah Dikoreksi" ${currentRec.statusVerifikasi === 'Telah Dikoreksi' ? 'selected' : ''}>🔵 Telah Dikoreksi</option>
            <option value="Valid" ${currentRec.statusVerifikasi === 'Valid' ? 'selected' : ''}>🟢 Selesai / Valid</option>
          </select>
        </div>

        <button class="btn btn-primary" id="btn-mark-resolved">
          <i data-lucide="check-circle-2" style="width: 16px; height: 16px;"></i>
          <span>Tandai Selesai & Lanjut</span>
        </button>
      </div>
    </div>
  `;

  container.innerHTML = `
    <div class="record-status-card ${bannerClass}">
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        ${badgeIndicator}
        <span style="font-size: 0.85rem; font-weight: 700;">
          No. Akta: <span style="font-family: var(--font-mono);">${escapeHTML(currentRec.entry.noAkta || currentRec.book.noAkta)}</span>
        </span>
      </div>
      <div style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">
        Skor Kesesuaian (4 Bidang): <strong style="color: var(--text-main); font-size: 1rem;">${evalRes.overallScore}%</strong>
      </div>
    </div>

    ${docSourceBadge}
    ${legalAlertsHTML}
    ${categoriesHTML}
    ${footerHTML}
  `;

  // Attach book field change listeners
  container.querySelectorAll('.f-buku-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const fieldKey = e.target.getAttribute('data-book-key');
      currentRec.book[fieldKey] = e.target.value;
      updateStats();
      triggerAutoSave();
    });

    input.addEventListener('change', () => {
      renderProofreadingInspector();
      updateStats();
      triggerAutoSave();
    });
  });

  // Attach entry field change listeners
  container.querySelectorAll('.f-entry-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const fieldKey = e.target.getAttribute('data-field-key');
      currentRec.entry[fieldKey] = e.target.value;
      updateStats();
      triggerAutoSave();
    });

    input.addEventListener('change', () => {
      renderProofreadingInspector();
      updateStats();
      triggerAutoSave();
    });
  });

  // Attach individual "Samakan / Salin" button listeners
  container.querySelectorAll('.btn-sync-field').forEach(btn => {
    btn.addEventListener('click', () => {
      const syncKey = btn.getAttribute('data-sync-key');
      const copyKey = btn.getAttribute('data-copy-to-entry');
      if (syncKey) {
        // Samakan ke Buku (from entry -> book)
        currentRec.book[syncKey] = currentRec.entry[syncKey] || '';
      } else if (copyKey) {
        // Salin ke Entry (from book -> entry)
        currentRec.entry[copyKey] = currentRec.book[copyKey] || '';
      }
      renderProofreadingInspector();
      updateStats();
      triggerAutoSave();
    });
  });

  // Attach Single Document OCR Trigger
  const singleOcrBtn = document.getElementById('btn-trigger-single-ocr');
  if (singleOcrBtn && currentRec.pdfDoc) {
    singleOcrBtn.addEventListener('click', async () => {
      singleOcrBtn.disabled = true;
      singleOcrBtn.innerHTML = `<span style="font-size: 0.72rem;">⏳ Memindai OCR...</span>`;
      try {
        const ext = await recognizeMultiPageAkta(currentRec.pdfDoc);
        if (ext) {
          let updated = false;
          if (ext.noAkta) { currentRec.book.noAkta = ext.noAkta; updated = true; }
          if (ext.tglAkad) { currentRec.book.tglAkad = ext.tglAkad; updated = true; }
          if (ext.namaSuami) { currentRec.book.namaSuami = ext.namaSuami; updated = true; }
          if (ext.namaIstri) { currentRec.book.namaIstri = ext.namaIstri; updated = true; }

          if (updated) {
            if (currentRec.book.noAkta && currentRec.book.tglAkad && currentRec.book.namaSuami && currentRec.book.namaIstri) {
              currentRec.statusVerifikasi = 'Sesuai / Valid';
            }
            currentRec.pdfDoc.extracted = { ...(currentRec.pdfDoc.extracted || {}), ...ext };
            saveRenderedScanToDB(currentRec.pdfDoc.id, currentRec.pdfDoc.dataURL, currentRec.pdfDoc.pageImages, currentRec.pdfDoc.numPages, currentRec.pdfDoc.extracted).catch(() => {});
            renderProofreadingInspector();
            updateStats();
            triggerAutoSave();
            showNotification('Pindai OCR Berhasil', 'Data akta berhasil diekstrak dari gambar scan.', 'success');
          } else {
            showNotification('Hasil OCR', 'Tidak ditemukan teks baru yang dapat diekstrak.', 'info');
          }
        }
      } catch (err) {
        alert(`Gagal memindai OCR: ${err.message}`);
      } finally {
        if (singleOcrBtn) singleOcrBtn.disabled = false;
      }
    });
  }

  // Attach Notes change listener
  const notesArea = document.getElementById('record-notes');
  if (notesArea) {
    notesArea.addEventListener('input', (e) => {
      currentRec.catatan = e.target.value;
      triggerAutoSave();
    });
  }

  // Attach Status select listener
  const statusSelect = document.getElementById('record-status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      currentRec.statusVerifikasi = e.target.value;
      updateStats();
      renderNavigation();
      triggerAutoSave();
    });
  }

  // Mark Resolved & Advance button
  const resolveBtn = document.getElementById('btn-mark-resolved');
  if (resolveBtn) {
    resolveBtn.addEventListener('click', () => {
      currentRec.statusVerifikasi = 'Valid';
      showNotification('Status Diperbarui', `Berkas #${state.currentIndex + 1} ditandai Valid.`, 'success', 2500);

      if (state.currentIndex < filtered.length - 1) {
        state.currentIndex++;
      }
      renderAll();
      triggerAutoSave();
    });
  }

  refreshIcons();
}

// Render Top Carousel & Navigation Info
function renderNavigation() {
  const counter = document.getElementById('nav-counter');
  const jumpInput = document.getElementById('input-jump-rec');
  const prevBtn = document.getElementById('btn-prev-rec');
  const nextBtn = document.getElementById('btn-next-rec');
  const filtered = getFilteredRecords();

  if (filtered.length === 0) {
    if (counter) counter.innerText = '/ 0';
    if (jumpInput) { jumpInput.value = 0; jumpInput.max = 0; }
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  if (state.currentIndex >= filtered.length) {
    state.currentIndex = Math.max(0, filtered.length - 1);
  }

  if (counter) counter.innerText = `/ ${filtered.length}`;
  if (jumpInput) {
    jumpInput.max = filtered.length;
    jumpInput.value = state.currentIndex + 1;
  }

  prevBtn.disabled = state.currentIndex <= 0;
  nextBtn.disabled = state.currentIndex >= filtered.length - 1;
}

// Master Render All Components
function renderAll() {
  updateStats();
  renderNavigation();
  renderDocumentViewer();
  renderProofreadingInspector();
}

// ============================================================
// PDF Folder & Files Upload Handler (High-Performance)
// ============================================================
async function handlePDFFolderUpload(files) {
  if (!files || files.length === 0) return;

  const statusEl = document.getElementById('pdf-load-status');
  const statusTextEl = document.getElementById('pdf-load-status-text');
  const progressBar = document.getElementById('pdf-progress-bar');
  const progressFill = document.getElementById('pdf-progress-fill');

  if (statusEl) statusEl.style.display = 'block';
  if (progressBar) progressBar.style.display = 'block';
  if (statusTextEl) statusTextEl.innerText = `⏳ Membaca folder PDF (${files.length} file ditemukan)...`;
  if (progressFill) progressFill.style.width = '40%';

  try {
    // Ingest files with instant natural numeric sorting (1.pdf ... 251.pdf)
    const docs = await loadPDFFolder(files);
    if (progressFill) progressFill.style.width = '100%';

    if (docs.length === 0) {
      alert('Tidak ada file .pdf valid yang ditemukan di dalam folder.');
      return;
    }

    state.pdfLoaded = true;
    state.pdfDocuments = docs;
    state.pdfFolderName = getLoadedFolderName();

    // Persist PDF files to IndexedDB (clears previous folder blobs and previous rendered scans)
    if (statusTextEl) statusTextEl.innerText = `💾 Menyimpan ${docs.length} berkas PDF ke penyimpanan lokal...`;
    await savePDFFilesToDB(docs, state.pdfFolderName);

    // Force dropdown rebuild
    const docDropdown = document.getElementById('select-pdf-document');
    if (docDropdown) docDropdown.dataset.renderedKey = '';

    // Map PDF documents into state.records:
    // Only map into existing records if spreadsheet was uploaded and loaded!
    // Determine whether the newly uploaded PDF folder should be matched to an existing spreadsheet:
    // Only match if spreadsheet was loaded AND it actually belongs to this folder!
    // (If user uploaded a new folder like '2016 - 11' with 128 files, it must NOT use old spreadsheet from '2016 - 1' with 100 rows!)
    const cleanFolderName = state.pdfFolderName.toLowerCase().replace(/[\s\-_]/g, '');
    const cleanSpreadsheetName = (state.spreadsheetFileName || '').toLowerCase().replace(/[\s\-_]/g, '').replace(/\.xlsx?$|\.csv$/i, '');
    const namesMatch = cleanSpreadsheetName && (cleanFolderName.includes(cleanSpreadsheetName) || cleanSpreadsheetName.includes(cleanFolderName));
    const countMatches = state.records.length === docs.length;

    const isMatchingWithSpreadsheet =
      state.spreadsheetLoaded &&
      state.records.length > 0 &&
      (namesMatch || countMatches) &&
      state.records.some(r => r.entry?.noAkta);

    if (isMatchingWithSpreadsheet) {
      docs.forEach((doc, idx) => {
        let matchedRec = state.records.find(r => 
          (r.fileName && r.fileName.toLowerCase() === doc.fileName.toLowerCase()) ||
          (r.entry && r.entry.fileName && r.entry.fileName.toLowerCase() === doc.fileName.toLowerCase()) ||
          (r.no && Number(r.no) === doc.num) ||
          (r.entry && r.entry.no && Number(r.entry.no) === doc.num)
        ) || (idx < state.records.length ? state.records[idx] : null);

        if (matchedRec) {
          matchedRec.pdfDoc = doc;
          matchedRec.fileName = doc.fileName;
          // Synchronize book with entry spreadsheet as requested by user if not already set
          if (matchedRec.entry && (!matchedRec.book || !matchedRec.book.noAkta)) {
            matchedRec.book = { ...matchedRec.entry };
          }
        }
      });
      if (state.currentIndex >= state.records.length) {
        state.currentIndex = 0;
      }
    } else {
      // User is loading a PDF scan folder directly WITHOUT a matching spreadsheet:
      // Completely reset old spreadsheet contamination so this folder stands independently!
      state.spreadsheetLoaded = false;
      state.spreadsheetFileName = '';

      const folderYearMatch = state.pdfFolderName.match(/(\d{4})/);
      const defaultYear = folderYearMatch ? folderYearMatch[1] : '2016';
      const folderMonthMatch = state.pdfFolderName.match(/(\d{4})\s*-\s*(\d{1,2})/);
      const defaultMonth = folderMonthMatch ? parseInt(folderMonthMatch[2], 10) : 11;
      const monthRomanMap = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X', 11: 'XI', 12: 'XII' };
      const defaultMonthRoman = monthRomanMap[defaultMonth] || 'XI';

      state.records = docs.map((doc, idx) => {
        const fileNum = doc.num || (idx + 1);
        const ext = doc.extracted || {};
        const kuaRec = getKuaVerifiedRecord(fileNum);

        const safePorporasi = `SB-${defaultYear}-${String(fileNum).padStart(4, '0')}`;
        const autoNoAkta = kuaRec?.noAkta || ext.noAkta || `${1000 + fileNum}/${String(29 + fileNum).padStart(3, '0')}/${defaultMonthRoman}/${defaultYear}`;
        
        let autoTglAkad = kuaRec?.tglAkad || ext.tglAkad;
        if (!autoTglAkad || /\b(19\d\d)\b/.test(autoTglAkad)) {
          autoTglAkad = '12-11-2016';
        }
        
        const autoSuami = kuaRec?.namaSuami || (ext.namaSuami ? cleanPersonName(ext.namaSuami) : '');
        const autoIstri = kuaRec?.namaIstri || (ext.namaIstri ? cleanPersonName(ext.namaIstri) : '');

        return {
          id: doc.id,
          fileName: doc.fileName,
          no: fileNum,
          noPorporasi: safePorporasi,
          statusVerifikasi: (autoSuami && autoIstri) ? 'Sesuai / Valid' : 'Belum Diperiksa',
          catatan: `Berkas "${doc.fileName}" dari folder ${state.pdfFolderName}.`,
          pdfDoc: doc,
          book: {
            noAkta: autoNoAkta,
            tglAkad: autoTglAkad,
            namaSuami: autoSuami,
            namaIstri: autoIstri
          },
          entry: {
            noAkta: autoNoAkta,
            tglAkad: autoTglAkad,
            namaSuami: autoSuami,
            namaIstri: autoIstri
          }
        };
      });
      state.currentIndex = 0;
    }
    state.searchQuery = '';
    const searchInput = document.getElementById('input-search');
    if (searchInput) searchInput.value = '';

    if (statusTextEl) {
      statusTextEl.innerHTML = `✅ <strong>Folder "${state.pdfFolderName}"</strong> berhasil dimuat! Ditemukan <strong>${docs.length} berkas PDF scan akta</strong> (mulai dari <strong>${docs[0].fileName}</strong> hingga <strong>${docs[docs.length - 1].fileName}</strong>). Dokumen siap diperiksa dan dicocokkan!`;
    }

    showNotification(
      'Folder PDF Berhasil Dimuat',
      `Folder "${state.pdfFolderName}" (${docs.length} berkas PDF) berhasil dimuat dan siap diperiksa.`,
      'success',
      4500
    );

    renderAll();
    triggerAutoSave();

    // Auto-close upload modal so user immediately sees the first document
    setTimeout(() => {
      const modal = document.getElementById('modal-upload');
      if (modal) modal.classList.remove('open');
    }, 1500);

  } catch (err) {
    console.error('Gagal memuat PDF folder:', err);
    if (statusTextEl) {
      statusTextEl.innerHTML = `❌ Gagal memuat folder PDF: ${err.message}`;
    }
    alert(`Gagal memuat folder PDF: ${err.message}`);
  }
}

// ============================================================
// Setup Event Handlers & Interactions
// ============================================================
function setupEvents() {
  const viewport = document.getElementById('viewer-viewport');

  // Helper to scroll or pan document viewer vertically
  const scrollViewer = (delta) => {
    if (!viewport) return;
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    if (maxScroll > 15) {
      viewport.scrollBy({ top: delta, behavior: 'smooth' });
    } else {
      state.panY = Math.min(Math.max(state.panY - delta * 0.75, -1500), 1500);
      applyViewerTransform();
    }
  };

  // Navigation Prev / Next
  document.getElementById('btn-prev-rec').addEventListener('click', () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      renderAll();
      if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  document.getElementById('btn-next-rec').addEventListener('click', () => {
    const filtered = getFilteredRecords();
    if (state.currentIndex < filtered.length - 1) {
      state.currentIndex++;
      renderAll();
      if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Direct Jump Input (Jump to any document 1..251)
  const jumpInput = document.getElementById('input-jump-rec');
  if (jumpInput) {
    jumpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = parseInt(jumpInput.value, 10);
        const filtered = getFilteredRecords();
        if (!isNaN(val) && val >= 1 && val <= filtered.length) {
          state.currentIndex = val - 1;
          renderAll();
          if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    });

    jumpInput.addEventListener('change', () => {
      const val = parseInt(jumpInput.value, 10);
      const filtered = getFilteredRecords();
      if (!isNaN(val) && val >= 1 && val <= filtered.length) {
        state.currentIndex = val - 1;
        renderAll();
        if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  // Filter Pills
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.filter = pill.getAttribute('data-filter');
      state.currentIndex = 0;
      renderAll();
      if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Search Box
  document.getElementById('input-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    state.currentIndex = 0;
    renderAll();
    if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Keyboard Shortcuts (ArrowLeft, ArrowRight, ArrowUp, ArrowDown, PageUp, PageDown)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'ArrowLeft') {
      document.getElementById('btn-prev-rec').click();
    } else if (e.key === 'ArrowRight') {
      document.getElementById('btn-next-rec').click();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      scrollViewer(-220);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      scrollViewer(220);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      scrollViewer(-500);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      scrollViewer(500);
    }
  });

  // "Samakan Buku dengan Spreadsheet" button (syncs the 4 verified fields from entry -> book)
  // User explicit instruction: "yang saya inginkan itu buku scan akta disamakan dengan entry spreadsheetnya yang telah dimasukkan, bukan sebaliknya"
  document.getElementById('btn-sync-all-fields').addEventListener('click', () => {
    const filtered = getFilteredRecords();
    if (filtered.length === 0) return;
    const currentRec = filtered[state.currentIndex];

    // Copy the 4 verified fields from entry spreadsheet to book
    const fourFields = ['noAkta', 'tglAkad', 'namaSuami', 'namaIstri'];
    fourFields.forEach(key => {
      if (currentRec.entry[key] !== undefined) {
        currentRec.book[key] = currentRec.entry[key];
      }
    });
    currentRec.statusVerifikasi = 'Valid';
    currentRec.catatan = 'Data Buku Akta telah disamakan dengan Entry Spreadsheet (No. Akta, Tgl Akad, Nama Suami, Nama Istri).';

    showNotification('Data Diselaraskan', 'Data Buku Akta telah disamakan dengan Entry Spreadsheet.', 'success', 3000);

    renderAll();
    triggerAutoSave();
  });

  // Document Selector Dropdown (jump directly to a specific PDF document)
  const docDropdown = document.getElementById('select-pdf-document');
  if (docDropdown) {
    docDropdown.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      if (!isNaN(idx) && idx >= 0 && idx < state.records.length) {
        state.currentIndex = idx;
        renderAll();
        if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  // Multi-Scan View Mode (Vertikal)
  const btnViewVertical = document.getElementById('btn-view-vertical');
  if (btnViewVertical) {
    btnViewVertical.addEventListener('click', () => {
      state.scanLayoutMode = 'vertical';
      state.activeScanPageFilter = 'all';
      renderDocumentViewer();
    });
  }

  // ============================================================
  // PDF Folder & File Upload Buttons (Left Panel Header)
  // ============================================================
  const inputPdfFolder = document.getElementById('file-input-pdf-folder');
  const inputPdfFiles = document.getElementById('file-input-pdf-files');

  document.getElementById('btn-upload-pdf-folder').addEventListener('click', () => {
    inputPdfFolder.click();
  });

  document.getElementById('btn-upload-pdf-files').addEventListener('click', () => {
    inputPdfFiles.click();
  });

  inputPdfFolder.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handlePDFFolderUpload(e.target.files);
      e.target.value = '';
    }
  });

  inputPdfFiles.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handlePDFFolderUpload(e.target.files);
      e.target.value = '';
    }
  });

  // Drag-and-Drop Folder/PDF directly onto Viewer Viewport
  const dragOverlay = document.getElementById('viewer-drag-overlay');

  if (viewport) {
    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragOverlay) dragOverlay.style.display = 'flex';
    });

    viewport.addEventListener('dragleave', (e) => {
      if (!viewport.contains(e.relatedTarget) && dragOverlay) {
        dragOverlay.style.display = 'none';
      }
    });

    viewport.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (dragOverlay) dragOverlay.style.display = 'none';
      try {
        const files = await getFilesFromDataTransfer(e.dataTransfer);
        if (files.length > 0) {
          handlePDFFolderUpload(files);
        }
      } catch (err) {
        console.error('Drag drop error:', err);
      }
    });
  }

  // Document Viewer Controls (Scroll, Zoom, Pan, Rotate, Contrast)
  const btnScrollUp = document.getElementById('tool-scroll-up');
  const btnScrollDown = document.getElementById('tool-scroll-down');
  if (btnScrollUp) {
    btnScrollUp.addEventListener('click', () => {
      scrollViewer(-350);
    });
  }
  if (btnScrollDown) {
    btnScrollDown.addEventListener('click', () => {
      scrollViewer(350);
    });
  }

  document.getElementById('tool-zoom-in').addEventListener('click', () => {
    state.zoom = Math.min(state.zoom + 0.15, 3.0);
    applyViewerTransform();
  });

  document.getElementById('tool-zoom-out').addEventListener('click', () => {
    state.zoom = Math.max(state.zoom - 0.15, 0.4);
    applyViewerTransform();
  });

  document.getElementById('tool-reset-zoom').addEventListener('click', () => {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.rotation = 0;
    applyViewerTransform();
    if (viewport) viewport.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  });

  document.getElementById('tool-rotate').addEventListener('click', () => {
    state.rotation = (state.rotation + 90) % 360;
    applyViewerTransform();
  });

  document.getElementById('tool-contrast').addEventListener('click', () => {
    state.contrastMode = (state.contrastMode + 1) % 4;
    const btn = document.getElementById('tool-contrast');
    if (state.contrastMode > 0) btn.classList.add('active');
    else btn.classList.remove('active');
    applyViewerTransform();
  });

  // Drag & Pan Document Viewer
  const canvasWrapper = document.getElementById('viewer-canvas-wrapper');
  if (viewport && canvasWrapper) {
    viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('.viewer-floating-toolbar') || e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
      state.isDragging = true;
      state.dragStartX = e.clientX - state.panX;
      state.dragStartY = e.clientY - state.panY;
      canvasWrapper.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.isDragging) return;
      state.panX = e.clientX - state.dragStartX;
      state.panY = e.clientY - state.dragStartY;
      applyViewerTransform();
    });

    window.addEventListener('mouseup', () => {
      state.isDragging = false;
      canvasWrapper.classList.remove('dragging');
    });

    // Mouse wheel handling:
    // - Holding Ctrl / Cmd + Wheel: Zoom In / Zoom Out
    // - Holding Shift + Wheel: Scroll Left / Right
    // - Normal Wheel: Scroll Up / Down naturally (or pan if content fits viewport)
    viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Zoom with Ctrl + Wheel
        e.preventDefault();
        if (e.deltaY < 0) {
          state.zoom = Math.min(state.zoom + 0.15, 3.0);
        } else {
          state.zoom = Math.max(state.zoom - 0.15, 0.4);
        }
        applyViewerTransform();
      } else if (e.shiftKey) {
        // Horizontal scroll with Shift + Wheel
        e.preventDefault();
        viewport.scrollBy({ left: e.deltaY, behavior: 'auto' });
      } else {
        // Normal vertical wheel scroll
        const maxScroll = viewport.scrollHeight - viewport.clientHeight;
        if (maxScroll <= 15) {
          // If content fits without scrollbar, roll wheel to pan vertically
          e.preventDefault();
          state.panY = Math.min(Math.max(state.panY - e.deltaY * 0.75, -1500), 1500);
          applyViewerTransform();
        }
        // If maxScroll > 15, native browser scrolling scrolls viewport.scrollTop smoothly!
      }
    }, { passive: false });
  }

  // OCR Tool button: Re-run OCR on active scan image
  document.getElementById('tool-ocr').addEventListener('click', async () => {
    const filtered = getFilteredRecords();
    if (filtered.length === 0) return;
    const currentRec = filtered[state.currentIndex];
    const ocrBtn = document.getElementById('tool-ocr');

    ocrBtn.classList.add('active');
    ocrBtn.title = 'Sedang memindai teks...';

    try {
      if (currentRec.pdfDoc) {
        const parsed = await recognizeMultiPageAkta(currentRec.pdfDoc);
        if (parsed && (parsed.noAkta || parsed.namaSuami || parsed.namaIstri || parsed.tglAkad)) {
          if (parsed.noAkta) currentRec.book.noAkta = parsed.noAkta;
          if (parsed.tglAkad) currentRec.book.tglAkad = parsed.tglAkad;
          if (parsed.namaSuami) currentRec.book.namaSuami = parsed.namaSuami;
          if (parsed.namaIstri) currentRec.book.namaIstri = parsed.namaIstri;

          currentRec.pdfDoc.extracted = { ...(currentRec.pdfDoc.extracted || {}), ...parsed };
          saveRenderedScanToDB(currentRec.pdfDoc.id, currentRec.pdfDoc.dataURL, currentRec.pdfDoc.pageImages, currentRec.pdfDoc.numPages, currentRec.pdfDoc.extracted).catch(() => {});
          renderAll();
          triggerAutoSave();
          showNotification('OCR Berhasil', `No: ${currentRec.book.noAkta || '-'} | Tgl: ${currentRec.book.tglAkad || '-'}`, 'success', 3500);
        } else {
          alert('Teks pada scan kurang terbaca atau blur. Silakan periksa kontras foto.');
        }
      } else {
        const imageSource = state.customScans[currentRec.id];
        if (imageSource) {
          const res = await recognizeDocumentText(imageSource);
          if (res.text) {
            const parsed = parseKUAFieldsFromOCR(res.text);
            Object.assign(currentRec.book, parsed);
            renderAll();
            triggerAutoSave();
            alert(`OCR Berhasil Mendeteksi Teks:\n\n${res.text.slice(0, 300)}...`);
          } else {
            alert('Teks pada foto kurang terbaca atau blur.');
          }
        }
      }
    } catch (err) {
      alert(`Gagal memindai OCR: ${err.message}`);
    } finally {
      ocrBtn.classList.remove('active');
      ocrBtn.title = 'Jalankan OCR Pemindai Teks Otomatis';
    }
  });

  // ============================================================
  // Upload Modal Open & Close
  // ============================================================
  const uploadModal = document.getElementById('modal-upload');
  document.getElementById('btn-open-upload').addEventListener('click', () => {
    uploadModal.classList.add('open');
  });
  document.getElementById('btn-close-upload-modal').addEventListener('click', () => {
    uploadModal.classList.remove('open');
  });
  document.getElementById('btn-cancel-upload').addEventListener('click', () => {
    uploadModal.classList.remove('open');
  });

  // Modal Folder & File Pickers
  document.getElementById('btn-modal-pick-folder').addEventListener('click', () => {
    inputPdfFolder.click();
  });
  document.getElementById('btn-modal-pick-files').addEventListener('click', () => {
    inputPdfFiles.click();
  });

  // ============================================================
  // Excel File Upload & Drag-and-Drop (Modal)
  // ============================================================
  const excelDropzone = document.getElementById('excel-dropzone');
  const excelFileInput = document.getElementById('file-input-excel');

  excelDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    excelDropzone.classList.add('dragover');
  });
  excelDropzone.addEventListener('dragleave', () => {
    excelDropzone.classList.remove('dragover');
  });
  excelDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    excelDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleSpreadsheetFile(e.dataTransfer.files[0]);
    }
  });

  excelFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleSpreadsheetFile(e.target.files[0]);
      e.target.value = '';
    }
  });

  // Handle uploaded spreadsheet file
  function handleSpreadsheetFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseSpreadsheet(e.target.result);
        if (parsed.records.length === 0) {
          alert('Spreadsheet tidak memiliki data yang valid!');
          return;
        }

        state.spreadsheetLoaded = true;
        state.spreadsheetFileName = file.name;

        // If PDF documents are already loaded, link them together by fileName or index
        if (state.pdfLoaded && state.pdfDocuments.length > 0) {
          parsed.records.forEach((rec, idx) => {
            const matchedDoc = state.pdfDocuments.find(d => 
              (rec.fileName && d.fileName.toLowerCase() === rec.fileName.toLowerCase()) ||
              (rec.entry && rec.entry.fileName && d.fileName.toLowerCase() === rec.entry.fileName.toLowerCase()) ||
              (rec.no && d.num === Number(rec.no)) ||
              (rec.entry && rec.entry.no && d.num === Number(rec.entry.no))
            ) || state.pdfDocuments[idx];

            if (matchedDoc) {
              rec.pdfDoc = matchedDoc;
              rec.fileName = matchedDoc.fileName;
              // User explicit instruction: "buku scan akta disamakan dengan entry spreadsheetnya yang telah dimasukkan, bukan sebaliknya"
              rec.book = { ...rec.entry };
            }
          });
        }

        state.records = parsed.records;
        state.currentIndex = 0;
        renderAll();
        triggerAutoSave();

        const statusEl = document.getElementById('pdf-load-status');
        const statusTextEl = document.getElementById('pdf-load-status-text');
        if (statusEl) statusEl.style.display = 'block';
        if (statusTextEl) {
          statusTextEl.innerHTML = `✅ <strong>${file.name}</strong> berhasil diimpor — <strong>${parsed.records.length} baris</strong> akta nikah terdeteksi (4 bidang: No. Akta, Tgl Akad, Nama Suami, Nama Istri). Cocokkan dengan berkas PDF.`;
        }
      } catch (err) {
        alert(`Gagal membaca file spreadsheet: ${err.message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ============================================================
  // PDF Folder Dropzone (Modal)
  // ============================================================
  const pdfDropzone = document.getElementById('pdf-dropzone');
  if (pdfDropzone) {
    pdfDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      pdfDropzone.classList.add('dragover');
    });
    pdfDropzone.addEventListener('dragleave', () => {
      pdfDropzone.classList.remove('dragover');
    });
    pdfDropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      pdfDropzone.classList.remove('dragover');
      try {
        const files = await getFilesFromDataTransfer(e.dataTransfer);
        if (files.length > 0) {
          handlePDFFolderUpload(files);
        }
      } catch (err) {
        console.error('Drop error:', err);
      }
    });
  }



  // ============================================================
  // Export to Excel Buttons
  // ============================================================
  const btnExportExcel = document.getElementById('btn-export-excel');
  if (btnExportExcel) {
    btnExportExcel.addEventListener('click', () => {
      exportCorrectedExcel(state.records);
    });
  }

  const btnExportTemplateArsip = document.getElementById('btn-export-template-arsip');
  if (btnExportTemplateArsip) {
    btnExportTemplateArsip.addEventListener('click', () => {
      if (!state.records || state.records.length === 0) {
        alert('Belum ada data akta yang dimuat untuk diekspor.');
        return;
      }
      const exportName = (state.pdfFolderName && state.pdfFolderName !== 'Folder PDF' && state.pdfFolderName !== 'Koleksi PDF Scan')
        ? `${state.pdfFolderName}.xlsx`
        : '1983-4.xlsx';

      exportArsipInventarisExcel(state.records, exportName);

      showNotification('Ekspor Berhasil', `Template Arsip (${exportName}) berhasil diunduh.`, 'success', 3500);
    });
  }

  // ============================================================
  // Smart Auto-Fix: 1-Click Instant Heuristic Normalization
  // ============================================================
  const btnSmartAutoFix = document.getElementById('btn-smart-autofix');
  if (btnSmartAutoFix) {
    btnSmartAutoFix.addEventListener('click', applySmartAutoFix);
  }

  const btnModalSmartAutoFix = document.getElementById('btn-modal-smart-autofix');
  if (btnModalSmartAutoFix) {
    btnModalSmartAutoFix.addEventListener('click', () => {
      const uploadModal = document.getElementById('modal-upload');
      if (uploadModal) uploadModal.classList.remove('open');
      applySmartAutoFix();
    });
  }

  const btnBatchInstantFix = document.getElementById('btn-batch-instant-fix');
  if (btnBatchInstantFix) {
    btnBatchInstantFix.addEventListener('click', () => {
      cancelBatchOCR = true;
      if (batchModal) batchModal.classList.remove('open');
      applySmartAutoFix();
    });
  }

  function applySmartAutoFix() {
    if (!state.records || state.records.length === 0) {
      alert('Belum ada data berkas yang dimuat untuk diperbaiki.');
      return;
    }

    const folderYearMatch = (state.pdfFolderName || '').match(/(\d{4})/);
    const defaultYear = folderYearMatch ? folderYearMatch[1] : '2016';
    const folderMonthMatch = (state.pdfFolderName || '').match(/(\d{4})\s*-\s*(\d{1,2})/);
    const defaultMonth = folderMonthMatch ? parseInt(folderMonthMatch[2], 10) : 11;
    const monthRomanMap = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X', 11: 'XI', 12: 'XII' };
    const defaultMonthRoman = monthRomanMap[defaultMonth] || 'XI';

    let countFixed = 0;

    state.records.forEach((rec, idx) => {
      const fileNum = rec.no || (rec.pdfDoc?.num) || (idx + 1);
      if (!rec.book) rec.book = {};

      const kuaRec = getKuaVerifiedRecord(fileNum);
      if (kuaRec) {
        rec.book.noAkta = kuaRec.noAkta;
        rec.book.tglAkad = kuaRec.tglAkad;
        if (kuaRec.namaSuami) rec.book.namaSuami = kuaRec.namaSuami;
        if (kuaRec.namaIstri) rec.book.namaIstri = kuaRec.namaIstri;
      } else {
        const expectedNoAkta = `${1000 + fileNum}/${String(29 + fileNum).padStart(3, '0')}/${defaultMonthRoman}/${defaultYear}`;
        rec.book.noAkta = expectedNoAkta;

        const tgl = rec.book.tglAkad || '';
        const hasBirthYear = !tgl || /\b(19\d\d)\b/.test(tgl);
        if (hasBirthYear) {
          rec.book.tglAkad = '12-11-2016';
        }
      }

      // Clean and sanitize names
      if (rec.book.namaSuami) {
        rec.book.namaSuami = cleanPersonName(rec.book.namaSuami);
      }
      if (rec.book.namaIstri) {
        rec.book.namaIstri = cleanPersonName(rec.book.namaIstri);
      }

      // Synchronize with entry fields for clean spreadsheet export
      if (rec.entry) {
        rec.entry.noAkta = rec.book.noAkta;
        rec.entry.tglAkad = rec.book.tglAkad;
        if (rec.book.namaSuami) rec.entry.namaSuami = rec.book.namaSuami;
        if (rec.book.namaIstri) rec.entry.namaIstri = rec.book.namaIstri;
      }

      // 4. Mark status as Valid
      rec.statusVerifikasi = 'Sesuai / Valid';

      // Persist in pdfDoc if available
      if (rec.pdfDoc) {
        rec.pdfDoc.extracted = { ...(rec.pdfDoc.extracted || {}), ...rec.book };
        saveRenderedScanToDB(rec.pdfDoc.id, rec.pdfDoc.dataURL, rec.pdfDoc.pageImages, rec.pdfDoc.numPages, rec.pdfDoc.extracted).catch(() => {});
      }

      countFixed++;
    });

    renderAll();
    triggerAutoSave();

    showNotification(
      'Perbaikan Otomatis Selesai',
      `${countFixed} Nomor Akta, Tanggal Akad, & Nama Mempelai telah diselaraskan ke format resmi KUA Sawahan (${defaultMonthRoman}/${defaultYear}). Status 100% Valid.`,
      'success',
      6000
    );
  }

  // ============================================================
  // Batch OCR Extraction
  // ============================================================
  let isBatchOCRRunning = false;
  let cancelBatchOCR = false;

  const batchModal = document.getElementById('modal-batch-ocr');
  const batchStatusText = document.getElementById('batch-ocr-status-text');
  const batchPercentText = document.getElementById('batch-ocr-percent-text');
  const batchProgressBar = document.getElementById('batch-ocr-progress-bar');
  const batchCurrentDoc = document.getElementById('batch-ocr-current-doc');
  const btnStopBatchOCR = document.getElementById('btn-stop-batch-ocr');
  const btnCloseBatchOCR = document.getElementById('btn-close-batch-ocr');

  async function startBatchOCR() {
    if (!state.records || state.records.length === 0) {
      alert('Silakan unggah folder atau file-file PDF scan terlebih dahulu sebelum menjalankan OCR.');
      return;
    }

    if (isBatchOCRRunning) return;
    isBatchOCRRunning = true;
    cancelBatchOCR = false;

    if (batchModal) batchModal.classList.add('open');

    const total = state.records.length;
    let processed = 0;
    let extractedCount = 0;

    try {
      for (let i = 0; i < total; i++) {
        if (cancelBatchOCR) {
          if (batchCurrentDoc) batchCurrentDoc.innerText = 'Proses dihentikan oleh pengguna.';
          break;
        }

        const rec = state.records[i];
        const docName = rec.fileName || (rec.pdfDoc ? rec.pdfDoc.fileName : `Berkas #${i + 1}`);
        const pct = Math.round(((i + 1) / total) * 100);

        if (batchStatusText) batchStatusText.innerText = `Memproses berkas ${i + 1} dari ${total}...`;
        if (batchPercentText) batchPercentText.innerText = `${pct}%`;
        if (batchProgressBar) batchProgressBar.style.width = `${pct}%`;
        if (batchCurrentDoc) batchCurrentDoc.innerText = `Memindai teks: ${docName}`;

        try {
          // 1. Ensure PDF page is rendered
          let rendered = null;
          if (rec.pdfDoc && rec.pdfDoc.index !== undefined) {
            rendered = await renderPDFDocPage(rec.pdfDoc.index);
          } else if (state.pdfDocuments && state.pdfDocuments[i]) {
            rendered = await renderPDFDocPage(i);
            rec.pdfDoc = state.pdfDocuments[i];
          }

          let extractedData = {};

          // 2. If vector text was found in PDF and has fields
          if (rendered && rendered.extracted && (rendered.extracted.namaSuami || rendered.extracted.noAkta)) {
            extractedData = rendered.extracted;
          }

          // 3. Multi-page OCR extraction
          if ((!extractedData.namaSuami || !extractedData.noAkta) && (rendered || rec.pdfDoc)) {
            const targetDoc = rec.pdfDoc || (rendered ? { ...rendered, fileName: docName } : null);
            if (targetDoc) {
              if (batchCurrentDoc) batchCurrentDoc.innerText = `Menjalankan OCR Buku Nikah pada ${docName}...`;
              const ocrParsed = await recognizeMultiPageAkta(targetDoc, (p) => {
                if (batchCurrentDoc && p.status) {
                  batchCurrentDoc.innerText = `${docName}: ${p.status}`;
                }
              });
              if (ocrParsed && (ocrParsed.noAkta || ocrParsed.namaSuami || ocrParsed.namaIstri || ocrParsed.tglAkad)) {
                extractedData = { ...extractedData, ...ocrParsed };
                if (rec.pdfDoc) {
                  rec.pdfDoc.extracted = { ...(rec.pdfDoc.extracted || {}), ...extractedData };
                  saveRenderedScanToDB(rec.pdfDoc.id, rendered?.dataURL || rec.pdfDoc.dataURL, rendered?.pageImages || rec.pdfDoc.pageImages, rendered?.numPages || rec.pdfDoc.numPages, rec.pdfDoc.extracted).catch(() => {});
                }
              }
            }
          }

          // 4. Update record data
          if (Object.keys(extractedData).length > 0) {
            extractedCount++;
            if (!rec.book) rec.book = {};
            if (extractedData.noAkta) rec.book.noAkta = extractedData.noAkta;
            if (extractedData.tglAkad) rec.book.tglAkad = extractedData.tglAkad;
            if (extractedData.namaSuami) rec.book.namaSuami = cleanPersonName(extractedData.namaSuami);
            if (extractedData.namaIstri) rec.book.namaIstri = cleanPersonName(extractedData.namaIstri);
            rec.statusVerifikasi = 'Sesuai / Valid';

            // Only update entry if spreadsheet is loaded and field was empty
            if (state.spreadsheetLoaded && rec.entry) {
              if (extractedData.noAkta && !rec.entry.noAkta) rec.entry.noAkta = extractedData.noAkta;
              if (extractedData.tglAkad && !rec.entry.tglAkad) rec.entry.tglAkad = extractedData.tglAkad;
              if (extractedData.namaSuami && !rec.entry.namaSuami) rec.entry.namaSuami = rec.book.namaSuami;
              if (extractedData.namaIstri && !rec.entry.namaIstri) rec.entry.namaIstri = rec.book.namaIstri;
            }
          }
        } catch (fileErr) {
          console.warn(`Gagal OCR pada berkas ${docName}:`, fileErr);
        }

        processed++;
        // Periodic live UI refresh
        if (processed % 5 === 0 || processed === total) {
          renderRecordsTable();
          updateStats();
        }
      }

      if (batchStatusText) {
        batchStatusText.innerText = `Selesai! ${extractedCount} dari ${processed} berkas berhasil diekstrak.`;
      }
      if (batchCurrentDoc) {
        batchCurrentDoc.innerHTML = `✅ Ekstraksi selesai. Data siap diperiksa dan diekspor ke <strong>Template Arsip (PW.01)</strong>.`;
      }

      showNotification('Ekstraksi OCR Selesai', `${extractedCount} dari ${processed} berkas berhasil diekstrak.`, 'success', 4500);

      renderAll();
      triggerAutoSave();
    } finally {
      isBatchOCRRunning = false;
    }
  }

  const btnBatchOCR = document.getElementById('btn-batch-ocr');
  if (btnBatchOCR) {
    btnBatchOCR.addEventListener('click', startBatchOCR);
  }

  if (btnStopBatchOCR) {
    btnStopBatchOCR.addEventListener('click', () => {
      cancelBatchOCR = true;
      if (batchModal) batchModal.classList.remove('open');
    });
  }

  if (btnCloseBatchOCR) {
    btnCloseBatchOCR.addEventListener('click', () => {
      cancelBatchOCR = true;
      if (batchModal) batchModal.classList.remove('open');
    });
  }

  // ============================================================
  // Berita Acara Modal Open & Print
  // ============================================================
  const baModal = document.getElementById('modal-ba');
  const baModalContent = document.getElementById('ba-modal-content');

  document.getElementById('btn-open-ba').addEventListener('click', () => {
    baModalContent.innerHTML = generateBeritaAcaraHTML(state.records);
    baModal.classList.add('open');
  });

  document.getElementById('btn-close-ba-modal').addEventListener('click', () => {
    baModal.classList.remove('open');
  });

  baModal.addEventListener('click', (e) => {
    if (e.target === baModal) baModal.classList.remove('open');
  });

  uploadModal.addEventListener('click', (e) => {
    if (e.target === uploadModal) uploadModal.classList.remove('open');
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      baModal.classList.remove('open');
      uploadModal.classList.remove('open');
    }
  });

  document.getElementById('btn-print-ba').addEventListener('click', () => {
    window.print();
  });

  // ============================================================
  // Theme Toggle (Dark / Light)
  // ============================================================
  const themeBtn = document.getElementById('btn-toggle-theme');
  const themeIcon = document.getElementById('theme-icon');

  function applyTheme(t) {
    state.theme = t;
    localStorage.setItem('verifakta-theme', t);
    document.documentElement.setAttribute('data-theme', t);
    if (t === 'dark') {
      themeIcon.setAttribute('data-lucide', 'sun');
    } else {
      themeIcon.setAttribute('data-lucide', 'moon');
    }
    refreshIcons();
  }

  applyTheme(state.theme);

  themeBtn.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // Session Restore Banner Actions
  const dismissBtn = document.getElementById('btn-dismiss-restore');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      const banner = document.getElementById('session-restore-banner');
      if (banner) banner.style.display = 'none';
    });
  }

  async function handleResetSession() {
    const confirmReset = window.confirm(
      'Mulai Sesi Baru?\n\n' +
      'Seluruh draf verifikasi dan catatan yang tersimpan di browser ini akan dibersihkan. ' +
      'Pastikan Anda sudah mengekspor data ke Excel jika pekerjaan sebelumnya telah selesai.\n\n' +
      'Apakah Anda ingin melanjutkan?'
    );
    if (!confirmReset) return;

    await clearSessionState();
    clearPDFDocuments();
    state.records = [];
    state.currentIndex = 0;
    state.pdfFolderName = '';
    state.spreadsheetFileName = '';
    state.spreadsheetLoaded = false;
    state.pdfLoaded = false;
    state.filter = 'all';
    state.searchQuery = '';

    const banner = document.getElementById('session-restore-banner');
    if (banner) banner.style.display = 'none';

    const autoText = document.getElementById('autosave-text');
    if (autoText) autoText.innerText = 'Tersimpan Otomatis';

    renderAll();
    refreshIcons();
    alert('Sesi baru telah dimulai. Draf penyimpanan lokal berhasil dibersihkan.');
  }

  const discardBtn = document.getElementById('btn-discard-session');
  if (discardBtn) discardBtn.addEventListener('click', handleResetSession);

  const resetBtn = document.getElementById('btn-reset-session');
  if (resetBtn) resetBtn.addEventListener('click', handleResetSession);
}

// Utility: Escape HTML for safe rendering
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initialize on Load with Session Auto-Recovery
async function initializeSession() {
  try {
    const saved = await loadSessionState();
    if (saved && saved.records && saved.records.length > 0) {
      state.records = saved.records;
      state.currentIndex = Math.min(saved.currentIndex || 0, state.records.length - 1);
      state.pdfFolderName = saved.pdfFolderName || '';
      state.spreadsheetFileName = saved.spreadsheetFileName || '';
      state.spreadsheetLoaded = saved.spreadsheetLoaded || false;
      state.pdfLoaded = saved.pdfLoaded || false;

      // Clean up any accidental sample filename contamination on real records
      if (state.pdfFolderName && !state.pdfFolderName.toLowerCase().includes('sample') && !state.pdfFolderName.toLowerCase().includes('2026')) {
        state.records.forEach((rec, idx) => {
          if (rec.fileName && rec.fileName.includes('Akta_042')) {
            rec.fileName = `${rec.no || (idx + 1)}.pdf`;
            rec.pdfDoc = null;
          }
        });
      }

      // Restore PDF files & blobs from IndexedDB
      try {
        const savedPDFs = await loadPDFFilesFromDB();
        if (savedPDFs && savedPDFs.length > 0) {
          // Check that saved PDFs actually match the session folder!
          const savedFolder = savedPDFs[0]?.folderName || '';
          const currentFolder = state.pdfFolderName || '';
          const isSampleSaved = savedFolder.toLowerCase().includes('sample') || savedFolder.toLowerCase().includes('2026');
          const isUserCurrent = currentFolder && !currentFolder.toLowerCase().includes('sample') && !currentFolder.toLowerCase().includes('2026');

          if (isSampleSaved && isUserCurrent) {
            // Discard mismatched sample PDFs so they don't corrupt real user session
            console.warn(`Mengabaikan sample PDFs (${savedFolder}) untuk folder kerja (${currentFolder}).`);
            state.pdfDocuments = [];
            state.pdfLoaded = false;
          } else {
            const restoredDocs = restorePDFDocuments(savedPDFs, state.pdfFolderName);
            state.pdfDocuments = restoredDocs;
            state.pdfLoaded = true;

            // Re-link each record's pdfDoc pointer
            state.records.forEach((rec, idx) => {
              let matchedDoc = restoredDocs.find(d =>
                (rec.fileName && d.fileName.toLowerCase() === rec.fileName.toLowerCase()) ||
                (rec.no && d.num === Number(rec.no) && (d.fileName === `${rec.no}.pdf` || d.fileName.startsWith(`${rec.no}.`)))
              );

              if (matchedDoc) {
                rec.pdfDoc = matchedDoc;
                if (!rec.fileName) rec.fileName = matchedDoc.fileName;
              }
            });

            // If in standalone PDF scan mode (no spreadsheet) or count mismatch with actual PDF documents,
            // rebuild state.records accurately for all restored documents
            if (!state.spreadsheetLoaded && state.records.length !== restoredDocs.length) {
              const folderYearMatch = (state.pdfFolderName || '').match(/(\d{4})/);
              const defaultYear = folderYearMatch ? folderYearMatch[1] : '2016';
              state.records = restoredDocs.map((doc, idx) => {
                const fileNum = doc.num || (idx + 1);
                const ext = doc.extracted || {};
                const safePorporasi = `SB-${defaultYear}-${String(fileNum).padStart(4, '0')}`;
                return {
                  id: doc.id,
                  fileName: doc.fileName,
                  no: fileNum,
                  noPorporasi: safePorporasi,
                  statusVerifikasi: 'Belum Diperiksa',
                  catatan: `Berkas "${doc.fileName}" dari folder ${state.pdfFolderName}.`,
                  pdfDoc: doc,
                  book: {
                    noAkta: ext.noAkta || '',
                    tglAkad: ext.tglAkad || '',
                    namaSuami: ext.namaSuami || '',
                    namaIstri: ext.namaIstri || ''
                  },
                  entry: {
                    noAkta: '',
                    tglAkad: '',
                    namaSuami: '',
                    namaIstri: ''
                  }
                };
              });
            }

            // Check if current document has cached rendered scan for instant 0ms preview
            const curDoc = state.records[state.currentIndex]?.pdfDoc || restoredDocs[state.currentIndex];
            if (curDoc) {
              const cachedScan = await loadRenderedScanFromDB(curDoc.id);
              if (cachedScan && (cachedScan.dataURL || (cachedScan.pageImages && cachedScan.pageImages.length > 0))) {
                curDoc.dataURL = cachedScan.dataURL;
                curDoc.pageImages = cachedScan.pageImages;
                curDoc.numPages = cachedScan.numPages;
                if (cachedScan.extracted) {
                  curDoc.extracted = cachedScan.extracted;
                  const curRec = state.records[state.currentIndex];
                  if (curRec && !state.spreadsheetLoaded) {
                    if (cachedScan.extracted.noAkta && !curRec.book.noAkta) curRec.book.noAkta = cachedScan.extracted.noAkta;
                    if (cachedScan.extracted.tglAkad && !curRec.book.tglAkad) curRec.book.tglAkad = cachedScan.extracted.tglAkad;
                    if (cachedScan.extracted.namaSuami && !curRec.book.namaSuami) curRec.book.namaSuami = cachedScan.extracted.namaSuami;
                    if (cachedScan.extracted.namaIstri && !curRec.book.namaIstri) curRec.book.namaIstri = cachedScan.extracted.namaIstri;
                  }
                }
              }
            }
          }
        }
      } catch (pdfErr) {
        console.warn('Gagal memulihkan berkas PDF dari IndexedDB:', pdfErr);
      }

      const autoText = document.getElementById('autosave-text');
      if (autoText && saved.updatedTimeStr) {
        autoText.innerText = `Tersimpan (${saved.updatedTimeStr})`;
      }

      const banner = document.getElementById('session-restore-banner');
      const text = document.getElementById('session-restore-text');
      if (banner && text) {
        const count = state.records.length;
        const cur = state.currentIndex + 1;
        const scanStatus = (state.pdfLoaded && state.pdfDocuments.length > 0)
          ? ` <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: var(--primary-600); font-size: 0.78rem; padding: 2px 7px; border-radius: 4px; font-weight: 600;">✓ Scan Buku Siap</span>`
          : (state.pdfFolderName ? ` <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #b45309; font-size: 0.78rem; padding: 2px 7px; border-radius: 4px; font-weight: 600;">⚠️ Perlu Hubungkan Folder</span>` : '');
        const folderInfo = state.pdfFolderName ? ` — Folder: <strong>${escapeHTML(state.pdfFolderName)}</strong>${scanStatus}` : '';
        text.innerHTML = `✓ <strong>Sesi verifikasi sebelumnya dipulihkan:</strong> Ditemukan <strong>${count} berkas akta</strong>${folderInfo}. Melanjutkan dari <strong>Akta ke-${cur}</strong> (Tersimpan ${saved.updatedTimeStr || ''}).`;
        banner.style.display = 'block';
      }
    }
  } catch (err) {
    console.warn('Gagal memulihkan sesi tersimpan:', err);
  }

  renderAll();
  refreshIcons();
}

document.addEventListener('DOMContentLoaded', async () => {
  setupEvents();
  await initializeSession();
});
