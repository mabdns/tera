// Area proposals only: no inferred text, spreadsheet values, or approval decisions.
export const MAPPING_FIELDS = Object.freeze([
  { key: 'noAkta', label: 'Nomor akta', excel: 'Nomor Dokumen' },
  { key: 'tglAkad', label: 'Tanggal akad', excel: 'Tanggal Dokumen' },
  { key: 'namaSuami', label: 'Nama pengantin pria', excel: 'Pengantin Laki' },
  { key: 'namaIstri', label: 'Nama pengantin perempuan', excel: 'Pengantin Perempuan' }
]);

export const MAPPING_PROFILES = Object.freeze({
  'model-a1': {
    label: 'Model A.1 — bentangan buku lama', minimumPages: 1,
    sources: ['Nomor pada kepala formulir', 'Bagian II: tanggal Masehi pelaksanaan akad; bukan baris Hijriyah atau bagian I: pencatatan',
      'Bagian III: suami, item nama lengkap', 'Bagian V: istri, item nama lengkap'],
    regions: [[1, .53, .025, .29, .055], [1, .30, .12, .20, .035],
      [1, .28, .15, .22, .045], [1, .275, .59, .22, .025]]
  },
  'model-n': {
    label: 'Model N — halaman depan dan mempelai', minimumPages: 2,
    sources: ['Halaman depan: Nomor Akta, bukan Nomor Pemeriksaan',
      'Header akad pada halaman mempelai: tanggal Masehi, bukan Hijriyah atau tanggal lahir',
      'Kolom suami: item nama lengkap, bukan nama orang tua',
      'Kolom istri: item nama lengkap, bukan nama orang tua'],
    regions: [[1, .61, .34, .25, .04], [2, .18, .019, .29, .025],
      [2, .25, .085, .24, .026], [2, .68, .015, .23, .028]]
  }
});

export function validateMapping(mapping, documentKey, pageCount) {
  if (!mapping || mapping.schema !== 1 || mapping.documentKey !== documentKey || typeof documentKey !== 'string' || !documentKey)
    throw new Error('Pemetaan tidak cocok dengan dokumen ini. Pilih profil dan periksa ulang.');
  const profile = Object.hasOwn(MAPPING_PROFILES, mapping.profileId) ? MAPPING_PROFILES[mapping.profileId] : null;
  if (!profile || !Number.isInteger(pageCount) || pageCount < profile.minimumPages)
    throw new Error('Profil tidak sesuai jumlah halaman PDF.');
  for (const { key } of MAPPING_FIELDS) {
    const r = mapping.fields?.[key];
    if (!r || !Number.isInteger(r.page) || r.page < 1 || r.page > pageCount)
      throw new Error('Halaman bidang berada di luar PDF.');
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.x >= 1 || r.y >= 1 || r.w <= 0 || r.h <= 0
      || r.x + r.w > 1.000000001 || r.y + r.h > 1.000000001 || typeof r.confirmed !== 'boolean')
      throw new Error('Kotak harus memiliki ukuran positif dan berada di dalam gambar.');
  }
  return mapping;
}

export function createMapping(profileId, documentKey, pageCount) {
  const profile = Object.hasOwn(MAPPING_PROFILES, profileId) ? MAPPING_PROFILES[profileId] : null;
  if (!profile) throw new Error('Pilih profil formulir terlebih dahulu.');
  return validateMapping({ schema: 1, documentKey, profileId,
    fields: Object.fromEntries(MAPPING_FIELDS.map(({ key }, i) => {
      const [page, x, y, w, h] = profile.regions[i];
      return [key, { page, x, y, w, h, confirmed: false }];
    })) }, documentKey, pageCount);
}

export function updateMappingRegion(mapping, key, region, pageCount) {
  if (!MAPPING_FIELDS.some(f => f.key === key)) throw new Error('Bidang tidak dikenal.');
  const result = structuredClone(mapping);
  result.fields[key] = { ...region, confirmed: false };
  return validateMapping(result, mapping.documentKey, pageCount);
}

export function cropBounds(region, width, height) {
  if (![width, height].every(v => Number.isInteger(v) && v > 0)) throw new Error('Ukuran gambar tidak sah.');
  validateMapping({ schema: 1, documentKey: 'crop', profileId: 'model-a1',
    fields: Object.fromEntries(MAPPING_FIELDS.map(f => [f.key, { ...region, page: 1, confirmed: false }])) }, 'crop', 1);
  const x = Math.min(width - 1, Math.floor(region.x * width + 1e-9));
  const y = Math.min(height - 1, Math.floor(region.y * height + 1e-9));
  return { x, y, w: Math.max(1, Math.min(width, Math.ceil((region.x + region.w) * width - 1e-9)) - x),
    h: Math.max(1, Math.min(height, Math.ceil((region.y + region.h) * height - 1e-9)) - y) };
}

export function mappingReviewed(mapping) {
  return MAPPING_FIELDS.every(({ key }) => mapping?.fields?.[key]?.confirmed === true);
}

// Content + original folder/file names bind a mapping to one actual PDF.
// Sanitized display IDs and row numbers alone are not safe identifiers.
export async function mappingDocumentKey(doc) {
  if (!doc?.file?.arrayBuffer) throw new Error('Berkas PDF asli belum tersedia. Unggah kembali PDF untuk memetakan.');
  if (!globalThis.crypto?.subtle) throw new Error('Buka aplikasi melalui localhost atau HTTPS agar identitas PDF dapat diperiksa.');
  const bytes = await doc.file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify([doc.folderName || '', doc.folderPath || doc.fileName || '', doc.fileName || '', sha]);
}
