import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorker } from 'tesseract.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_REGIONS = 8;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const MAX_INPUT_BYTES = MAX_REGIONS * (MAX_BASE64_LENGTH + 1024) + 1024;
const kinds = new Set(['name', 'day', 'month', 'year', 'number']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validateRegions(regions) {
  if (!Array.isArray(regions) || regions.length > MAX_REGIONS) {
    throw new Error(`regions must be an array of at most ${MAX_REGIONS} items`);
  }
  const ids = new Set();
  return regions.map((region, index) => {
    if (!region || typeof region !== 'object' || Array.isArray(region)
      || typeof region.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(region.id)
      || ids.has(region.id)) {
      throw new Error(`Invalid or duplicate region id at index ${index}`);
    }
    ids.add(region.id);
    if (!kinds.has(region.kind)) throw new Error(`Invalid region kind at index ${index}`);
    const prefix = 'data:image/png;base64,';
    if (typeof region.image !== 'string' || !region.image.startsWith(prefix)) {
      throw new Error(`Region ${index} image must be a base64 PNG data URL`);
    }
    const encoded = region.image.slice(prefix.length);
    if (!encoded.length || encoded.length > MAX_BASE64_LENGTH || encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Invalid or oversized base64 image at index ${index}`);
    }
    const image = Buffer.from(encoded, 'base64');
    if (image.length > MAX_IMAGE_BYTES || image.toString('base64') !== encoded
      || image.length <= pngSignature.length || !image.subarray(0, 8).equals(pngSignature)) {
      throw new Error(`Invalid or oversized PNG image at index ${index}`);
    }
    return { id: region.id, kind: region.kind, image };
  });
}

async function requireLocalModels() {
  for (const language of ['ind', 'eng']) {
    const model = path.join(root, `${language}.traineddata`);
    try {
      await access(model, constants.R_OK);
      const info = await stat(model);
      if (!info.isFile() || info.size === 0) throw new Error('Empty or non-file model');
    } catch {
      throw new Error(`Required local model is missing or unreadable: ${model}`);
    }
  }
}

export async function recognizeRegions(regions, {
  createWorker: factory = createWorker,
  checkModels = requireLocalModels,
} = {}) {
  const validated = validateRegions(regions);
  if (!validated.length) return { results: [] };
  await checkModels();
  let worker;
  try {
    worker = await factory('ind+eng', 1, {
      langPath: root,
      gzip: false,
      cacheMethod: 'none',
      logging: false,
      logger: () => {},
      errorHandler: () => {},
    });
    const results = [];
    for (const region of validated) {
      await worker.setParameters({
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '1',
        user_defined_dpi: '216',
        // Always reset: a previous numeric region must not constrain a name.
        tessedit_char_whitelist: ['day', 'year'].includes(region.kind) ? '0123456789' : '',
      });
      const { data } = await worker.recognize(region.image);
      results.push({
        id: region.id,
        text: typeof data?.text === 'string' ? data.text.trim() : '',
        confidence: typeof data?.confidence === 'number' && Number.isFinite(data.confidence)
          ? Math.max(0, Math.min(100, data.confidence)) : 0,
      });
    }
    return { results };
  } finally {
    if (worker) await worker.terminate();
  }
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Input exceeds maximum JSON size');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Input must be a JSON object with regions');
  }
  const output = await recognizeRegions(input.regions);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`OCR refinement failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
