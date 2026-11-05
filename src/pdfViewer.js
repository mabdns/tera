/**
 * VerifAkta - High-Performance PDF Folder & Document Engine
 * Supports large folders (250+ PDF files such as 1.pdf ... 251.pdf)
 * Uses natural numeric sorting, instant folder ingestion, on-demand (lazy) rendering,
 * and memory-bounded LRU caching to eliminate memory exhaustion and UI freezes.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { loadRenderedScanFromDB, saveRenderedScanToDB } from './storageHelper.js';

// Configure the PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// State for loaded PDF collection
let loadedDocs = []; // Array of lightweight PDF doc descriptor objects
let loadedFolderName = '';

// LRU Cache for rendered page images and extracted data (max 20 items to prevent RAM bloat)
const RENDER_CACHE_LIMIT = 20;
const renderCache = new Map();

/**
 * Extract natural numeric index from filename (e.g. "1.pdf" -> 1, "251.pdf" -> 251)
 * @param {string} fileName
 * @returns {number}
 */
export function getFileNumber(fileName) {
  if (!fileName) return Infinity;
  // Get filename from path
  const nameOnly = fileName.split(/[\/\\]/).pop();
  const match = nameOnly.match(/^(\d+)\.pdf$/i) || nameOnly.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : Infinity;
}

/**
 * Natural sort comparator specifically tuned for numbered files like 1.pdf, 2.pdf, ..., 251.pdf
 */
export function comparePDFFileNames(fileA, fileB) {
  const nameA = fileA.name || fileA.webkitRelativePath || '';
  const nameB = fileB.name || fileB.webkitRelativePath || '';

  const numA = getFileNumber(nameA);
  const numB = getFileNumber(nameB);

  if (numA !== Infinity && numB !== Infinity) {
    if (numA !== numB) return numA - numB;
  }

  // Fallback to natural string compare
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Parse structured KUA Akta Nikah fields from extracted text
 * Strictly focuses on the 4 verified fields:
 * 1. Nomor Akta Nikah (noAkta)
 * 2. Tanggal Akad Nikah (tglAkad)
 * 3. Nama Pengantin Laki-laki (namaSuami)
 * 4. Nama Pengantin Perempuan (namaIstri)
 * 
 * @param {string} text - Raw text extracted from PDF
 * @param {string} fileName - Retained for compatibility; never used as field evidence
 * @returns {Object} Extracted KUA fields
 */
export function parseKUAFieldsFromText(text, fileName = '') {
  const fields = {};
  if (!text) return fields;

  try {
    const cleanText = text.replace(/\r/g, '');

    // 1. Nomor Dokumen / Nomor Akta Nikah
    // Normalize OCR text noise for Roman numerals and slashes (e.g., XLI2016 -> XI/2016, X1 -> XI)
    let normalizedForAkta = cleanText
      .replace(/XLI(\d{4})/gi, 'XI/$1')
      .replace(/XIN(\d{4})/gi, 'XI/$1')
      .replace(/X1(\d{4})/gi, 'XI/$1')
      .replace(/\/X1\//gi, '/XI/')
      .replace(/\/XLI\//gi, '/XI/')
      .replace(/\/XIN\//gi, '/XI/');

    // 1a. Search explicitly after 'Nomor Akta' or 'Komor Akta' or 'No Akta'
    const explicitAktaMatch = normalizedForAkta.match(/(?:(?:N|K)omor\s*Akta|No\.?\s*Akta)[\s\S]{0,35}?(\d{1,4}\s*[\/\s]\s*\d{1,4}\s*[\/\s]\s*(?:XI|XII|X|IX|VIII|VII|VI|V|IV|III|II|I|X1|XLI|XIN)\s*[\/\s]\s*(?:19|20)\d{2})/i);
    if (explicitAktaMatch && explicitAktaMatch[1]) {
      fields.noAkta = explicitAktaMatch[1]
        .replace(/\s+/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/X1\//gi, '/XI/')
        .replace(/\/XLI\//gi, '/XI/')
        .replace(/\/XIN\//gi, '/XI/')
        .trim();
    }

    // 1b. Strict labels fallback: Nomor Dokumen, Nomor Akta, No Akta, No Register
    if (!fields.noAkta) {
      const aktaRegex = /(?:Nomor\s*(?:Akta(?:\s*Nikah)?|Dokumen|Register|Reg)|No\.?\s*(?:Akta(?:\s*Nikah)?|Dokumen|Register|Reg|Seri))\s*[:=]?\s*([0-9A-Za-z\/\-\.\s]+)/i;
      const aktaMatch = cleanText.match(aktaRegex);
      if (aktaMatch && aktaMatch[1]) {
        const candidate = aktaMatch[1].replace(/\s+/g, '').trim();
        if (/\d/.test(candidate) && candidate.length >= 3 && !/^\.t\.$/i.test(candidate)) {
          fields.noAkta = candidate;
        }
      }
    }
    
    // 1c. Pattern match for KUA register numbers like 1001/030/XI/2016 or 0001/001/I/2016 or 309/46/VII/1983
    if (!fields.noAkta) {
      const romanPattern = normalizedForAkta.match(/\b(\d{1,4}\s*[\/\s]\s*\d{1,4}\s*[\/\s]\s*(?:XI|XII|X|IX|VIII|VII|VI|V|IV|III|II|I)\s*[\/\s]\s*(?:19|20)\d{2})\b/i);
      if (romanPattern) {
        fields.noAkta = romanPattern[1].replace(/\s+/g, '/').replace(/\/+/g, '/');
      } else {
        const standardPattern = cleanText.match(/\b\d{1,4}\s*\/\s*\d{1,4}\s*\/[A-Za-z0-9\/\-]+\b/) || cleanText.match(/\b\d{1,4}\s*\/\s*(?:19|20)\d{2}\b/);
        if (standardPattern && standardPattern[0].length >= 4) {
          fields.noAkta = standardPattern[0].replace(/\s+/g, '');
        }
      }
    }


    // 2. Dates need marriage-specific evidence, never month proximity or a
    // generic document/birth/examination date elsewhere in the scan.
    const marriageDate = extractMarriageDate(cleanText);
    if (marriageDate) fields.tglAkad = marriageDate;

    // 3. Pasangan Pengantin dari Format Register: "Register Nikah a/n SUAMI dan ISTRI" atau "a/n SUAMI dan ISTRI"
    const coupleMatch = cleanText.match(/(?:Register\s*Nikah\s*)?a\/n\s+([A-Za-z\s\.\,\'\`]+?)\s+dan\s+([A-Za-z\s\.\,\'\`]+?)(?:\s*(?:\r|\n|;|\.|$))/i);
    if (coupleMatch && coupleMatch[1] && coupleMatch[2]) {
      const cleanSuami = cleanPersonName(coupleMatch[1]);
      const cleanIstri = cleanPersonName(coupleMatch[2]);
      if (cleanSuami) fields.namaSuami = cleanSuami;
      if (cleanIstri) fields.namaIstri = cleanIstri;
    }

    // Assign names only from an explicit spouse label or a bounded spouse
    // section. A missing name must not consume the next section's text.
    const roles = [
      {
        key: 'namaSuami',
        direct: /\b(?:Nama[ \t]*(?:Lengkap[ \t]*)?(?:Suami|Pengantin[ \t]*Laki[ -]?laki)|Pengantin[ \t]*Laki[ -]?laki|Mempelai[ \t]*Pria)(?:[ \t]*[:=][ \t]*|[ \t]+)([^\n\r;]+)/i,
        header: /(?:^|\n)[ \t]*(?:III\.[ \t]*)?SUAMI\b[ \t]*[:;]?|\bIII\.[ \t]*Suami[ \t]*[:;]/i
      },
      {
        key: 'namaIstri',
        direct: /\b(?:Nama[ \t]*(?:Lengkap[ \t]*)?(?:Istri|Isteri|Pengantin[ \t]*(?:Perempuan|Wanita))|Pengantin[ \t]*(?:Perempuan|Wanita)|Mempelai[ \t]*Wanita)(?:[ \t]*[:=][ \t]*|[ \t]+)([^\n\r;]+)/i,
        header: /(?:^|\n)[ \t]*(?:V\.[ \t]*)?(?:ISTERI|ISTRI)\b[ \t]*[:;]?|\bV\.[ \t]*Isteri[ \t]*[:;]/i
      }
    ];
    for (const { key, direct, header } of roles) {
      if (fields[key]) continue;
      const directMatch = cleanText.match(direct);
      if (directMatch) {
        const name = cleanPersonName(directMatch[1]);
        if (name) fields[key] = name;
        continue;
      }
      const sectionMatch = cleanText.match(header);
      if (!sectionMatch) continue;
      const section = cleanText.slice(sectionMatch.index + sectionMatch[0].length)
        .split(/(?:^|\n)[ \t]*(?:[IVX]+\.[ \t]*)?(?:SUAMI|ISTERI|ISTRI|WALI|AYAH|IBU)\b|\b[IVX]+\.[ \t]*(?:SUAMI|ISTERI|ISTRI|WALI)\b/i)[0];
      const name = extractNameFromColumnText(section);
      if (name) fields[key] = name;
    }
  } catch (err) {
    console.warn('Gagal mem-parsing teks KUA:', err);
  }

  return fields;
}

export function cleanPersonName(raw) {
  if (typeof raw !== 'string') return '';
  // Remove only explicit form prefixes and edge noise, never repair spelling,
  // split joined names, normalize titles, or discard bin/binti patronymics.
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:\d+[.)]\s*)?Nama(?:\s+lengkap)?(?:\s+dan\s+alias(?:nya)?)?\s*[:=]\s*/i, '')
    .replace(/^[\s: =|_~*•©]+|[\s|_~*•©]+$/g, '')
    .replace(/^\.{2,}\s*|\s*\.{2,}$/g, '')
    .trim();
}

/**
 * Direct extraction of person name from a cropped column (Left: Suami, Right: Istri).
 * Requires a name label; an arbitrary OCR line is not evidence of a name.
 */
export function extractNameFromColumnText(text) {
  if (typeof text !== 'string') return '';
  const labelMatch = text.match(/(?:^|\n)[ \t]*(?:[1iI][.)]?[ \t]*)?(?:(?:Nama|Narna|[1i]ma)[ \t]+lengkap\b|Nama(?=[ \t]*[:=]))(?:[ \t]+dan[ \t]+alias(?:nya)?)?[ \t: =.©|—-]*([^\n\r;]*)(?:\r?\n([^\n\r;]*))?/i);
  if (!labelMatch) return '';
  const raw = (labelMatch[1].trim() || labelMatch[2] || '')
    .split(/[ \t]+\d+[.)][ \t]*(?:Tempat|NIK|Nomor[ \t]+Induk|Kewarganegaraan|Agama|Pekerjaan|Alamat)\b/i)[0];
  // Do not treat the next numbered form field as a missing name's value.
  if (/^\s*(?:\d+[.)]\s*|(?:Tempat|NIK|Nomor Induk|Kewarganegaraan|Agama|Pekerjaan|Alamat|SUAMI|ISTERI|ISTRI)\b)/i.test(raw)) return '';
  const cleaned = cleanPersonName(raw);
  return /\p{L}/u.test(cleaned) ? cleaned : '';
}

function cleanFieldValue(val) {
  if (!val) return '';
  return val
    .replace(/^[:=\s\.]+/, '')
    .replace(/\.{2,}/g, '')
    .replace(/[\r\n\t]+.*/g, '')
    .trim();
}

const DATE_MONTHS = {
  januari: 1, jan: 1, februari: 2, pebruari: 2, feb: 2, maret: 3, mar: 3,
  april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  agustus: 8, agu: 8, agt: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nopember: 11, nov: 11, nop: 11,
  desember: 12, des: 12
};
const DATE_WEEKDAY = "(?:Senin|Selasa|Rabu|Kamis|Jum['’]?at|Sabtu|Ahad|Minggu)";

function normalizeDateString(dateStr) {
  const str = dateStr.trim();
  let day, month, year;
  const iso = str.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
  const numeric = str.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/);
  const named = str.match(/^(\d{1,2})\s+(?:bulan\s+)?([A-Za-z]+)\s+(?:tahun\s+)?(\d{4})$/i);
  if (iso) [, year, , month, day] = iso;
  else if (numeric) [, day, , month, year] = numeric;
  else if (named) {
    [, day, month, year] = named;
    month = DATE_MONTHS[month.toLowerCase()];
  } else return '';

  day = Number(day);
  month = Number(month);
  year = Number(year);
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
}

function uniqueMarriageDate(candidates) {
  // An invalid or conflicting date is not permission to pick another one.
  if (!candidates.length || candidates.some(date => !date)) return '';
  const dates = new Set(candidates);
  return dates.size === 1 ? candidates[0] : '';
}

function parseMarriageDateValue(value, requireCalendar = false) {
  const dates = [];
  const parts = value.trim().replace(/\s+/g, ' ').replace(new RegExp(`^${DATE_WEEKDAY}\\s*,?\\s*`, 'i'), '')
    .split(/\s*[,;]?\s*(?:bertepatan|bersamaan)\s+dengan\s*/i);
  for (const part of parts) {
    const match = part.trim().match(/^(?:tanggal\s+)?(.+?)(?:\s+(Masehi|M|Hijriyah|Hijriah|Hijri|H))?[.,]?$/i);
    if (!match) return '';
    const calendar = match[2]?.toLowerCase();
    if (calendar && /^(?:hijri|h$)/.test(calendar)) {
      // Retain only an explicitly written Gregorian date; do not convert or
      // borrow a Hijri day/month/year to complete a damaged Gregorian date.
      if (!/^(?:\d{1,2}[-/.]){2}\d{4}$|^\d{1,2}\s+(?:bulan\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:tahun\s+)?\d{4}$/i.test(match[1])) return '';
      continue;
    }
    if (requireCalendar && !calendar) return '';
    dates.push(normalizeDateString(match[1]));
  }
  return uniqueMarriageDate(dates);
}

function extractMarriageDate(text) {
  const candidates = [];
  const labels = /\b(?:(?:Tanggal|Tgl\.?)[ \t]+(?:Akad(?:[ \t]+Nikah)?|Nikah|Perkawinan)|waktu[ \t]+akad[ \t]+nikah[ \t]+dilangsungkan)\b/gi;
  for (const label of text.matchAll(labels)) {
    // A field value may start on the next line, but cannot jump another label
    // or search later lines for a plausible date.
    const value = text.slice(label.index + label[0].length)
      .replace(/^[ \t]*[:=]?[ \t]*(?:\n[ \t]*)?/, '')
      .split(/\n|\b(?:Tanggal|Tgl\.?|Nama|NIK|Tempat|Nomor)\s*(?=[A-Za-z:]|\.)/i)[0]
      .replace(/[ \t;]+$/, '');
    candidates.push(parseMarriageDateValue(value));
  }
  if (candidates.length && !uniqueMarriageDate(candidates)) return '';

  // Model N registration formula is the only unlabelled header accepted.
  // Calendar markers and complete date components must be attached, not nearby.
  const headerDate = 'tanggal\\s+\\d{1,2}\\s+bulan\\s+[A-Za-z]+(?:\\s+[A-Za-z]+)?\\s+tahun\\s+\\d{4}\\s+(?:Masehi|Hijriyah|Hijriah|Hijri)\\b';
  const headers = new RegExp(`\\bPada\\s+hari(?:\\s+ini)?\\s+${DATE_WEEKDAY}\\s*[,.:]?\\s*(${headerDate}(?:\\s*[,;]?\\s*(?:bertepatan|bersamaan)\\s+dengan\\s+${headerDate})?)`, 'gi');
  for (const header of text.matchAll(headers)) {
    const lineStart = text.lastIndexOf('\n', header.index) + 1;
    const previousLine = text.slice(0, lineStart).trimEnd().split('\n').at(-1) || '';
    const following = text.slice(header.index + header[0].length)
      .split(/\n(?=[ \t]*(?:\d+[.)][ \t]*)?(?:Tanggal|Nama|Tempat|SUAMI|ISTERI|ISTRI|WALI|NIK)\b)/i)[0]
      .split('\n').slice(0, 2).join(' ');
    const context = text.slice(lineStart, header.index) + ' ' + following;
    if (/\b(?:pemeriksaan|diperiksa|memeriksa|ujian)\b/i.test(previousLine) ||
        /\b(?:pemeriksaan|diperiksa|memeriksa|ujian|lahir|kelahiran|dilahirkan)\b/i.test(context)) continue;
    if (/^[\s,;]*(?:(?:(?:atau|dan)\s+)?(?:tanggal\s+)?\d|(?:bertepatan|bersamaan)\b)/i.test(following)) {
      candidates.push('');
    } else {
      candidates.push(parseMarriageDateValue(header[1], true));
    }
  }
  return uniqueMarriageDate(candidates);
}

/**
 * Ingest a folder or collection of PDF files instantly.
 * This runs in < 20 milliseconds even for 250+ files because it does NOT pre-render canvases.
 * Rendering is performed lazily on-demand as each document is viewed.
 * 
 * @param {Array<File>|FileList} files - List of File objects
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array<Object>>} Array of lightweight document descriptors
 */
export async function loadPDFFolder(files, onProgress = null) {
  const fileArray = Array.from(files).filter(f => f.name && f.name.toLowerCase().endsWith('.pdf'));

  if (fileArray.length === 0) {
    throw new Error('Tidak ada file berekstensi .pdf yang ditemukan di dalam folder yang dipilih.');
  }

  // Sort files naturally by numeric filename (1.pdf, 2.pdf, ..., 251.pdf)
  fileArray.sort(comparePDFFileNames);

  // Extract folder name
  if (fileArray[0].webkitRelativePath) {
    const parts = fileArray[0].webkitRelativePath.split(/[\/\\]/);
    loadedFolderName = parts.length > 1 ? parts[0] : 'Folder PDF';
  } else {
    loadedFolderName = 'Koleksi PDF Scan';
  }

  // Clear previous render cache
  renderCache.clear();

  // Create lightweight descriptors
  loadedDocs = fileArray.map((file, index) => {
    const fileNum = getFileNumber(file.name);
    const numDisplay = fileNum !== Infinity ? fileNum : (index + 1);
    const safeFolder = (loadedFolderName || 'folder').trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const safeFile = file.name.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const docId = `pdf_${safeFolder}__${safeFile}`;

    return {
      id: docId,
      index: index,
      num: numDisplay,
      fileName: file.name,
      folderPath: file.webkitRelativePath || file.name,
      folderName: loadedFolderName,
      fileSize: (file.size / 1024).toFixed(1) + ' KB',
      file: file,
      // Will be populated lazily on demand:
      dataURL: null,
      rawText: '',
      extracted: null
    };
  });

  if (onProgress) {
    onProgress({
      current: loadedDocs.length,
      total: loadedDocs.length,
      fileName: loadedDocs[0].fileName,
      status: `Terdeteksi ${loadedDocs.length} berkas PDF dari folder "${loadedFolderName}". Siap dibuka.`
    });
  }

  return loadedDocs;
}

// Legacy fields may contain fabricated values; retain a backup without making
// them eligible for hydration or changing their original version.
function currentExtraction(doc, extracted) {
  if (extracted?.sourceVersion === 2) return extracted;
  if (extracted) doc.legacyExtracted ??= extracted;
  return null;
}

/**
 * Render a specific PDF document page on demand with caching
 * @param {number} docIndex - 0-based document index
 * @returns {Promise<{ dataURL: string, rawText: string, extracted: Object }>}
 */
export async function renderPDFDocPage(docIndex) {
  if (docIndex < 0 || docIndex >= loadedDocs.length) return null;
  const doc = loadedDocs[docIndex];
  doc.extracted = currentExtraction(doc, doc.extracted);

  // 1. Return cached result if available in memory cache
  if (renderCache.has(doc.id)) {
    const cached = renderCache.get(doc.id);
    doc.dataURL = cached.dataURL;
    doc.pageImages = cached.pageImages;
    doc.numPages = cached.numPages;
    doc.rawText = cached.rawText;
    cached.extracted = doc.extracted ?? currentExtraction(doc, cached.extracted);
    doc.extracted = cached.extracted;
    return cached;
  }

  // 2. Return if doc object already has rendered images
  if (doc.dataURL || (doc.pageImages && doc.pageImages.length > 0)) {
    const res = {
      dataURL: doc.dataURL,
      pageImages: doc.pageImages || [],
      numPages: doc.numPages || 1,
      rawText: doc.rawText || '',
      extracted: doc.extracted || null
    };
    renderCache.set(doc.id, res);
    return res;
  }

  // 3. Return from IndexedDB rendered_scans cache if previously rendered
  try {
    const dbCached = await loadRenderedScanFromDB(doc.id);
    if (dbCached && (dbCached.dataURL || (dbCached.pageImages && dbCached.pageImages.length > 0))) {
      doc.dataURL = dbCached.dataURL;
      doc.pageImages = dbCached.pageImages || [];
      doc.numPages = dbCached.numPages || 1;
      doc.rawText = dbCached.rawText || doc.rawText || '';
      doc.extracted = doc.extracted ?? currentExtraction(doc, dbCached.extracted);
      const res = {
        dataURL: doc.dataURL,
        pageImages: doc.pageImages,
        numPages: doc.numPages,
        rawText: doc.rawText,
        extracted: doc.extracted
      };
      renderCache.set(doc.id, res);
      return res;
    }
  } catch (err) {
    // Non-fatal, continue with standard rendering
  }

  try {
    let arrayBuffer;
    if (doc.file && typeof doc.file.arrayBuffer === 'function') {
      arrayBuffer = await doc.file.arrayBuffer();
    } else if (doc.file && typeof FileReader !== 'undefined') {
      arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(doc.file);
      });
    } else if (doc.arrayBuffer) {
      arrayBuffer = doc.arrayBuffer;
    } else {
      throw new Error(`Data berkas ${doc.fileName} tidak ditemukan.`);
    }

    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: `${baseUrl}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${baseUrl}/standard_fonts/`,
      wasmUrl: `${baseUrl}/wasm/`,
      enableXfa: true,
      useSystemFonts: true
    });

    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages || 1;
    const pageImages = [];
    let combinedRawText = '';

    // Render each scan page in the PDF document (e.g. 1..3 scans)
    for (let p = 1; p <= numPages; p++) {
      const page = await pdf.getPage(p);

      // Adaptive scaling: If scan is already large (> 1200px width), use 1.15x scale to save RAM
      const unscaledViewport = page.getViewport({ scale: 1.0 });
      const scale = unscaledViewport.width > 1200 ? 1.15 : 1.6;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Use JPEG with 0.90 quality for 4x smaller memory footprint than PNG
      const pageDataURL = canvas.toDataURL('image/jpeg', 0.90);
      pageImages.push({
        pageNumber: p,
        dataURL: pageDataURL,
        width: viewport.width,
        height: viewport.height
      });

      // Extract text content from this page
      try {
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(it => it.str).join(' ');
        combinedRawText += ' ' + pageText;
      } catch (err) {
        console.warn(`Gagal membaca teks halaman ${p}:`, err);
      }
    }

    const dataURL = pageImages[0] ? pageImages[0].dataURL : '';
    const extracted = {
      ...parseKUAFieldsFromText(combinedRawText),
      sourceVersion: 2,
      source: 'pdf-text',
      requiresReview: true
    };

    const result = {
      dataURL,
      pageImages,
      numPages,
      rawText: combinedRawText,
      extracted
    };

    // Attach to doc object
    doc.dataURL = dataURL;
    doc.pageImages = pageImages;
    doc.numPages = numPages;
    doc.rawText = combinedRawText;
    doc.extracted = extracted;

    // Maintain cache size
    if (renderCache.size >= RENDER_CACHE_LIMIT) {
      const oldestKey = renderCache.keys().next().value;
      renderCache.delete(oldestKey);
    }
    renderCache.set(doc.id, result);

    // Save rendered image to IndexedDB for instant display on next reload
    saveRenderedScanToDB(doc.id, dataURL, pageImages, numPages, extracted).catch(() => {});

    return result;
  } catch (err) {
    console.error(`Error rendering PDF ${doc.fileName}:`, err);
    throw err;
  }
}

/**
 * Pre-render adjacent documents (e.g. next page) in idle time
 */
export function preRenderAdjacentDoc(docIndex) {
  const nextIdx = docIndex + 1;
  if (nextIdx < loadedDocs.length && !renderCache.has(loadedDocs[nextIdx].id)) {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => renderPDFDocPage(nextIdx).catch(() => {}));
    } else {
      setTimeout(() => renderPDFDocPage(nextIdx).catch(() => {}), 100);
    }
  }
}

/**
 * Read all files from a directory entry recursively (for folder drag-and-drop)
 */
export async function getFilesFromDataTransfer(dataTransfer) {
  const files = [];

  // Check if DataTransferItems are supported with webkitGetAsEntry
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (item.webkitGetAsEntry) {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }

    if (entries.length > 0) {
      for (const entry of entries) {
        await readFileSystemEntry(entry, files);
      }
    }
  }

  // Fallback to standard files list if no entries were collected
  if (files.length === 0 && dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      files.push(dataTransfer.files[i]);
    }
  }

  return files.filter(f => f.name && f.name.toLowerCase().endsWith('.pdf'));
}

async function readFileSystemEntry(entry, fileList) {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((f) => {
        // Attach relative path if available
        if (!f.webkitRelativePath && entry.fullPath) {
          Object.defineProperty(f, 'webkitRelativePath', {
            value: entry.fullPath.replace(/^\//, ''),
            writable: false
          });
        }
        fileList.push(f);
        resolve();
      }, () => resolve());
    });
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const readAllEntries = () => new Promise((resolve) => {
      dirReader.readEntries(async (entries) => {
        if (!entries || entries.length === 0) {
          resolve();
        } else {
          for (const child of entries) {
            await readFileSystemEntry(child, fileList);
          }
          // readEntries may return in chunks, keep reading until empty
          await readAllEntries();
          resolve();
        }
      }, () => resolve());
    });

    await readAllEntries();
  }
}

/**
 * Get all loaded PDF documents
 */
export function getLoadedPDFDocuments() {
  return loadedDocs;
}

/**
 * Get a specific loaded PDF document by index
 */
export function getPDFDocument(index) {
  if (index < 0 || index >= loadedDocs.length) return null;
  return loadedDocs[index];
}

/**
 * Get total count of loaded PDF documents/pages
 */
export function getPDFDocumentCount() {
  return loadedDocs.length;
}

/**
 * Get the loaded folder name
 */
export function getLoadedFolderName() {
  return loadedFolderName || 'Folder PDF';
}

/**
 * Check if PDF folder/documents are currently loaded
 */
export function isPDFLoaded() {
  return loadedDocs.length > 0;
}

/**
 * Restore PDF documents from persistence (IndexedDB)
 */
export function restorePDFDocuments(docs, folderName = '') {
  loadedDocs = docs || [];
  for (const doc of loadedDocs) {
    doc.extracted = currentExtraction(doc, doc.extracted);
  }
  loadedFolderName = folderName || 'Folder PDF';
  renderCache.clear();
  return loadedDocs;
}

/**
 * Clear all loaded PDF documents
 */
export function clearPDFDocuments() {
  loadedDocs = [];
  loadedFolderName = '';
  renderCache.clear();
}

// Backward compatibility aliases
export const clearPDF = clearPDFDocuments;

export function getPDFPageImage(index) {
  const doc = getPDFDocument(index);
  return doc ? doc.dataURL : null;
}

export function getPDFPageCount() {
  return loadedDocs.length;
}

export function getPDFFileName() {
  return loadedDocs.length > 0 ? loadedDocs[0].fileName : '';
}

export async function loadPDF(arrayBuffer, fileName = 'document.pdf', onProgress = null) {
  const file = new File([arrayBuffer], fileName, { type: 'application/pdf' });
  const docs = await loadPDFFolder([file], onProgress);
  return { totalPages: docs.length, fileName };
}
