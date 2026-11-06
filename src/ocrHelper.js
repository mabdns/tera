/**
 * VerifAkta - OCR (Optical Character Recognition) Engine
 * Reads text from scanned Buku Akta Nikah images via Tesseract.js
 * and intelligently extracts structured KUA fields.
 * Supports multi-page Model N marriage books (Page 1: Akta & Tanggal, Page 2: Mempelai).
 */
import { createWorker } from 'tesseract.js';
import { parseKUAFieldsFromText, extractNameFromColumnText } from './pdfViewer.js';

export const LOCAL_AI_URL = 'http://127.0.0.1:8000';
export const LOCAL_OCR_TIMEOUT_MS = 180_000;
let healthProbe = null;
const FIELD_KEYS = ['noAkta', 'tglAkad', 'namaSuami', 'namaIstri'];
let extractionQueue = Promise.resolve();
let queuedExtractions = 0;
const pendingDocuments = new WeakMap();

function enqueueExtraction(task, progressCallback) {
  if (queuedExtractions > 0 && progressCallback) {
    progressCallback({ status: 'Menunggu giliran OCR...', progress: 0 });
  }
  queuedExtractions++;
  const result = extractionQueue.then(task);
  extractionQueue = result.then(() => { queuedExtractions--; }, () => { queuedExtractions--; });
  return result;
}

// Bound both the connection and JSON body, including fetch implementations
// that do not settle immediately when aborted.
async function requestLocalJSON(path, init, timeoutMs) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${LOCAL_AI_URL}${path}`, { ...init, signal: controller.signal });
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw Object.assign(new Error('Respons OCR lokal bukan JSON'), { reason: 'invalid-response' });
        }
        return { response, payload };
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(Object.assign(new Error('OCR lokal melewati batas waktu'), { reason: 'timeout' }));
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    // Abort can reject fetch/JSON before its timer promise settles. Preserve
    // the timeout diagnosis instead of treating it as an offline fallback.
    if (timedOut) throw Object.assign(new Error('OCR lokal melewati batas waktu'), { reason: 'timeout' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Share concurrent probes, but never cache a completed model-availability result. */
export function checkLocalAIService() {
  if (!healthProbe) {
    healthProbe = (async () => {
      try {
        const { response, payload } = await requestLocalJSON('/health', { method: 'GET', cache: 'no-store' }, 2_000);
        return {
          available: response.ok && payload?.status === 'ok' && payload?.ocrAvailable === true,
          data: payload
        };
      } catch (error) {
        return { available: false, reason: error.reason || 'network-error' };
      } finally {
        healthProbe = null;
      }
    })();
  }
  return healthProbe;
}

function imageDataURL(image) {
  const value = typeof image === 'string' ? image : (image?.dataURL || image?.src || image?.toDataURL?.() || '');
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(value) ? value : '';
}

function localResult(payload) {
  const fields = Object.fromEntries(FIELD_KEYS.map(key => [key, typeof payload.data[key] === 'string' ? payload.data[key] : '']));
  return {
    ...payload,
    ...fields,
    status: 'completed',
    sourceVersion: 2,
    rawText: payload.rawText ?? '',
    source: payload.source ?? 'local',
    requiresReview: payload.requiresReview ?? true,
    missingFields: FIELD_KEYS.filter(key => !fields[key]),
    fieldDetails: payload.fieldDetails ?? {},
    warnings: payload.warnings ?? []
  };
}

async function extractLocal(images, fileName) {
  try {
    const { response, payload } = await requestLocalJSON('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, images })
    }, LOCAL_OCR_TIMEOUT_MS);
    if (response.ok && payload?.success === true && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return { result: localResult(payload) };
    }
    return { reason: payload?.success === false ? 'local-error' : 'invalid-response', payload };
  } catch (error) {
    return { reason: error.reason || 'network-error', error: error.message };
  }
}

function reviewResult(local, source = 'tesseract') {
  return {
    ...Object.fromEntries(FIELD_KEYS.map(key => [key, ''])),
    sourceVersion: 2,
    status: 'completed',
    rawText: '',
    source,
    requiresReview: true,
    fieldDetails: {},
    warnings: [
      ...(Array.isArray(local.payload?.warnings) ? local.payload.warnings : []),
      source === 'none' ? 'Tidak ada gambar scan yang dapat diproses; wajib ditinjau.' : 'Hasil OCR Tesseract wajib ditinjau.',
      ...(local.payload?.error ? [String(local.payload.error)] : [])
    ],
    provenance: { reason: local.reason, ...(local.error ? { error: local.error } : {}) },
    ...(local.payload !== undefined ? { localResponse: local.payload } : {})
  };
}

function failedLocalResult(local, includeNetwork = false) {
  if (!['timeout', 'local-error', 'invalid-response', ...(includeNetwork ? ['network-error', 'missing-first-page'] : [])].includes(local.reason)) return null;
  const message = local.reason === 'timeout'
    ? 'OCR lokal belum selesai dalam 180 detik. Hasil belum diterima; tidak beralih otomatis ke OCR browser. Tunggu proses lokal selesai lalu ulangi Pindai OCR.'
    : 'Hasil OCR lokal gagal diterima. Tidak beralih otomatis ke OCR browser; periksa terminal AI lokal lalu ulangi Pindai OCR.';
  return {
    ...reviewResult(local, 'local'),
    status: local.reason === 'timeout' ? 'timeout' : 'failed',
    error: message,
    warnings: [message, ...(Array.isArray(local.payload?.warnings) ? local.payload.warnings : []),
      ...(local.payload?.error ? [String(local.payload.error)] : [])]
  };
}

function recordFields(result, fields) {
  for (const key of FIELD_KEYS) {
    if (!fields[key]) continue;
    result[key] = fields[key];
    result.fieldDetails[key] = { source: 'tesseract' };
  }
}

let workerInstance = null;

// Initialize or get OCR worker
export async function getOCRWorker(progressCallback) {
  if (!workerInstance) {
    if (progressCallback) progressCallback({ status: 'Memuat modul OCR Tesseract...', progress: 0.1 });
    workerInstance = await createWorker('ind+eng', 1, {
      logger: m => {
        if (progressCallback && m.status === 'recognizing text') {
          progressCallback({ status: 'Mengenali teks dokumen akta...', progress: m.progress });
        }
      }
    });
  }
  return workerInstance;
}

/**
 * Preprocess image for OCR by suppressing the green/yellow guilloche security
 * pattern and boosting dark black ink contrast.
 * @param {string|HTMLImageElement|HTMLCanvasElement} imageSource 
 * @returns {Promise<string>} Preprocessed image as data URL
 */
export async function preprocessImageForOCR(imageSource) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;

          // Limit max dimension to 1200px for speed and memory efficiency
          const MAX_DIM = 1200;
          if (w > MAX_DIM || h > MAX_DIM) {
            if (w > h) {
              h = Math.round((h * MAX_DIM) / w);
              w = MAX_DIM;
            } else {
              w = Math.round((w * MAX_DIM) / h);
              h = MAX_DIM;
            }
          }

          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);

          const imgData = ctx.getImageData(0, 0, w, h);
          const d = imgData.data;

          for (let i = 0; i < d.length; i += 4) {
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];

            // Luminance calculation
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            // In Buku Nikah, text is black/dark toner (low lum in all channels),
            // while security pattern is light green / yellow.
            if (lum < 130 && r < 145 && g < 155 && b < 145) {
              // Black ink
              d[i] = 0;
              d[i + 1] = 0;
              d[i + 2] = 0;
            } else {
              // White background
              d[i] = 255;
              d[i + 1] = 255;
              d[i + 2] = 255;
            }
          }

          ctx.putImageData(imgData, 0, 0);
          resolve(canvas.toDataURL('image/jpeg', 0.90));
        } catch {
          resolve(typeof imageSource === 'string' ? imageSource : '');
        }
      };
      img.onerror = () => {
        resolve(typeof imageSource === 'string' ? imageSource : '');
      };
      img.src = typeof imageSource === 'string' ? imageSource : (imageSource.src || imageSource.toDataURL?.() || '');
    } catch {
      resolve(typeof imageSource === 'string' ? imageSource : '');
    }
  });
}

// Perform OCR on an image element, canvas, or data URL
export function recognizeDocumentText(imageSource, progressCallback) {
  return enqueueExtraction(() => recognizeDocumentTextNow(imageSource, progressCallback), progressCallback);
}

async function recognizeDocumentTextNow(imageSource, progressCallback) {
  const image = imageDataURL(imageSource);
  const local = image ? await extractLocal([image], 'single_doc') : { reason: 'no-image' };
  if (local.result) {
    return { ...local.result, text: local.result.rawText, words: local.result.words ?? [] };
  }
  const failed = failedLocalResult(local);
  if (failed) return { ...failed, text: '' };
  const review = reviewResult(local);

  try {
    const worker = await getOCRWorker(progressCallback);
    // Preprocess to suppress security pattern and limit size
    let cleanImage = imageSource;
    try {
      cleanImage = await preprocessImageForOCR(imageSource);
    } catch {}

    const result = await worker.recognize(cleanImage || imageSource);
    return {
      ...review,
      text: result.data.text,
      rawText: result.data.text,
      confidence: result.data.confidence,
      words: result.data.words
    };
  } catch (error) {
    console.warn('OCR processing fallback:', error);
    return {
      ...review,
      text: '',
      error: error.message,
      warnings: [...review.warnings, error.message]
    };
  }
}

/**
 * Crop a specific sub-region of an image, downscale to optimal OCR resolution,
 * and binarize it to black and white, completely isolating dark ink from guilloche patterns.
 * @param {string|HTMLImageElement} imageSource 
 * @param {Object} rect - { xRatio, yRatio, wRatio, hRatio }
 * @param {number} threshold - Luminance cutoff
 * @param {number} maxDim - Maximum width/height for fast WASM processing
 * @returns {Promise<string>} Binarized cropped image dataURL
 */
export async function cropAndBinarizeRegion(imageSource, rect, threshold = 125, maxDim = 1100) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const natW = img.naturalWidth || img.width;
          const natH = img.naturalHeight || img.height;

          const sx = Math.floor(natW * (rect.xRatio ?? 0));
          const sy = Math.floor(natH * (rect.yRatio ?? 0));
          const sw = Math.floor(natW * (rect.wRatio ?? 1));
          const sh = Math.floor(natH * (rect.hRatio ?? 1));
          if (![sx, sy, sw, sh].every(Number.isFinite) || sx < 0 || sy < 0 || sw <= 0 || sh <= 0 || sx + sw > natW || sy + sh > natH) {
            resolve('');
            return;
          }

          let targetW = sw;
          let targetH = sh;
          if (targetW > maxDim) {
            targetH = Math.round((targetH * maxDim) / targetW);
            targetW = maxDim;
          }

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          const d = imgData.data;

          for (let i = 0; i < d.length; i += 4) {
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            if (lum < threshold && r < threshold + 20 && g < threshold + 20 && b < threshold + 20) {
              d[i] = 0;
              d[i + 1] = 0;
              d[i + 2] = 0;
            } else {
              d[i] = 255;
              d[i + 1] = 255;
              d[i + 2] = 255;
            }
          }

          ctx.putImageData(imgData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = typeof imageSource === 'string' ? imageSource : (imageSource.src || imageSource.toDataURL?.() || '');
    } catch {
      resolve('');
    }
  });
}

/**
 * Local OCR for Indonesian Akta Nikah, with explicitly selected browser OCR.
 * Browser crops assume a Model N layout: akta box on page 1, registration
 * header and separate spouse columns on page 2. Results require review.
 *
 * @param {Object} pdfDoc - The PDF document object
 * @param {Function} progressCallback - Progress reporting callback
 * @returns {Promise<Object>} Extracted structured KUA fields
 */
export function recognizeMultiPageAkta(pdfDoc, progressCallback, { engine = 'local' } = {}) {
  if (!pdfDoc || typeof pdfDoc !== 'object') return Promise.resolve(reviewResult({ reason: 'no-image' }, 'none'));
  if (pendingDocuments.has(pdfDoc)) return pendingDocuments.get(pdfDoc);
  const result = enqueueExtraction(() => recognizeMultiPageAktaNow(pdfDoc, progressCallback, engine), progressCallback);
  pendingDocuments.set(pdfDoc, result);
  const clear = () => pendingDocuments.delete(pdfDoc);
  result.then(clear, clear);
  return result;
}

async function recognizeMultiPageAktaNow(pdfDoc, progressCallback, engine) {
  if (!pdfDoc) return reviewResult({ reason: 'no-image' }, 'none');

  // Keep original page positions: a missing page must not turn a different
  // scan into the spouse page. The service accepts only image data URLs.
  const pages = (pdfDoc.pageImages || []).slice(0, 2).map(imageDataURL);
  if (!pages.some(Boolean)) {
    const image = imageDataURL(pdfDoc.dataURL);
    if (image) pages.splice(0, pages.length, image);
  }
  const images = pages.filter(Boolean);
  if (!images.length) return reviewResult({ reason: 'no-image' }, 'none');

  if (progressCallback) progressCallback({ status: engine === 'browser'
    ? `Memproses OCR browser (${pdfDoc.fileName})...`
    : `Memproses AI Lokal (${pdfDoc.fileName}, batas tunggu 3 menit)...`, progress: 0.35 });
  const local = engine === 'browser' ? { reason: 'user-selected-browser' } : pages[0]
    ? await extractLocal(images, pdfDoc.fileName)
    : { reason: 'missing-first-page' };
  if (local.result) {
    if (progressCallback) progressCallback({ status: `Selesai AI Lokal (${pdfDoc.fileName})`, progress: 1.0 });
    return local.result;
  }
  const failed = failedLocalResult(local, true);
  if (failed) return failed;

  let combinedText = '';
  const result = reviewResult(local);
  if (progressCallback) progressCallback({ status: `Memproses Tesseract (${pdfDoc.fileName})...`, progress: 0.1 });

  // PDF browser OCR requires an explicit user selection.
  try {
    const worker = await getOCRWorker(progressCallback);

    if (pages.length >= 2) {
      // 1. Page 1: Target the Nomor Akta box directly (center-right table under AKTA NIKAH)
      if (progressCallback) progressCallback({ status: `Memindai Nomor Akta (${pdfDoc.fileName})...`, progress: 0.2 });
      try {
        const p1BoxCrop = await cropAndBinarizeRegion(pages[0], {
          xRatio: 0.48,
          yRatio: 0.30,
          wRatio: 0.48,
          hRatio: 0.22
        }, 125, 1100);

        if (!p1BoxCrop) throw new Error('Crop nomor akta gagal');
        const p1BoxRes = await worker.recognize(p1BoxCrop);
        const p1BoxText = p1BoxRes.data?.text || '';
        combinedText += p1BoxText + '\n';

        const p1Fields = parseKUAFieldsFromText(p1BoxText);
        recordFields(result, { noAkta: p1Fields.noAkta });
      } catch (boxErr) {
        console.warn('Page 1 box OCR error:', boxErr);
        result.warnings.push(boxErr.message);
      }

      // 2. Page 2: Target the Registration Header for Tanggal Akad Nikah
      if (progressCallback) progressCallback({ status: `Memindai Tanggal Akad (${pdfDoc.fileName})...`, progress: 0.45 });
      try {
        const p2HeaderCrop = await cropAndBinarizeRegion(pages[1], {
          xRatio: 0.0,
          yRatio: 0.0,
          wRatio: 0.95,
          hRatio: 0.26
        }, 125, 1100);

        if (!p2HeaderCrop) throw new Error('Crop tanggal akad gagal');
        const p2HeaderRes = await worker.recognize(p2HeaderCrop);
        const p2HeaderText = p2HeaderRes.data?.text || '';
        combinedText += p2HeaderText + '\n';

        const p2HeaderFields = parseKUAFieldsFromText(p2HeaderText);
        recordFields(result, { tglAkad: p2HeaderFields.tglAkad });
      } catch (hdrErr) {
        console.warn('Page 2 header OCR error:', hdrErr);
        result.warnings.push(hdrErr.message);
      }

      // Spouse columns have a gap at the center to avoid cross-column text.
      if (progressCallback) progressCallback({ status: `Memindai Nama Suami (${pdfDoc.fileName})...`, progress: 0.65 });
      try {
        const p2SuamiCrop = await cropAndBinarizeRegion(pages[1], {
          xRatio: 0.0,
          yRatio: 0.05,
          wRatio: 0.48,
          hRatio: 0.38
        }, 125, 1100);
        if (!p2SuamiCrop) throw new Error('Crop nama suami gagal');
        const p2SuamiRes = await worker.recognize(p2SuamiCrop);
        const p2SuamiText = p2SuamiRes.data?.text || '';
        combinedText += p2SuamiText + '\n';

        recordFields(result, { namaSuami: extractNameFromColumnText(p2SuamiText) });
      } catch (cropErr) {
        console.warn('Page 2 targeted Suami crop error:', cropErr);
        result.warnings.push(cropErr.message);
      }

      // The wife name is read only from the right column.
      if (progressCallback) progressCallback({ status: `Memindai Nama Istri (${pdfDoc.fileName})...`, progress: 0.85 });
      try {
        const p2IstriCrop = await cropAndBinarizeRegion(pages[1], {
          xRatio: 0.52,
          yRatio: 0.05,
          wRatio: 0.48,
          hRatio: 0.38
        }, 125, 1100);
        if (!p2IstriCrop) throw new Error('Crop nama istri gagal');
        const p2IstriRes = await worker.recognize(p2IstriCrop);
        const p2IstriText = p2IstriRes.data?.text || '';
        combinedText += p2IstriText + '\n';

        recordFields(result, { namaIstri: extractNameFromColumnText(p2IstriText) });
      } catch (cropErr) {
        console.warn('Page 2 targeted Istri crop error:', cropErr);
        result.warnings.push(cropErr.message);
      }
    } else {
      // Single page scan (like 1983 format)
      const imageSrc = pages[0];
      if (imageSrc) {
        if (progressCallback) progressCallback({ status: `Memindai scan dokumen ${pdfDoc.fileName}...`, progress: 0.4 });
        const image = await preprocessImageForOCR(imageSrc);
        const res = await worker.recognize(image || imageSrc);
        combinedText = res.data?.text || '';
        recordFields(result, parseKUAFieldsFromText(combinedText));
      }
    }
  } catch (err) {
    console.warn(`OCR multi-page error for ${pdfDoc.fileName}:`, err);
    result.warnings.push(err.message);
    result.status = 'failed';
    result.error = 'OCR browser gagal membaca dokumen. Periksa scan atau ulangi OCR lokal.';
  }

  result.missingFields = FIELD_KEYS.filter(key => !result[key]);
  result.rawText = combinedText;
  return result;
}

// Extract structured KUA entities from raw OCR text
export function parseKUAFieldsFromOCR(ocrText) {
  return { ...parseKUAFieldsFromText(ocrText), sourceVersion: 2 };
}
