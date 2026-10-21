/**
 * VerifAkta - Sample PDF Generator (using pdf-lib)
 * Generates realistic Indonesian Buku Akta Nikah (Model N) PDF files
 * for testing the folder PDF upload & auto-reading functionality.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { SAMPLE_RECORDS } from './sampleData.js';

/**
 * Generate a realistic Buku Akta Nikah PDF document from record data
 * @param {Object} record - A sample record object
 * @returns {Promise<Uint8Array>} PDF bytes
 */
export async function generateSampleAktaPDF(record) {
  const b = record.book;
  const pdfDoc = await PDFDocument.create();
  
  // A4 size: 595.28 x 841.89 points
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Colors
  const darkGreen = rgb(0.02, 0.35, 0.22);
  const emerald = rgb(0.04, 0.47, 0.34);
  const gold = rgb(0.85, 0.55, 0.05);
  const darkText = rgb(0.08, 0.12, 0.18);
  const mutedText = rgb(0.35, 0.42, 0.5);

  // Outer decorative border
  page.drawRectangle({
    x: 20,
    y: 20,
    width: width - 40,
    height: height - 40,
    borderColor: darkGreen,
    borderWidth: 2.5,
  });

  // Inner gold border
  page.drawRectangle({
    x: 26,
    y: 26,
    width: width - 52,
    height: height - 52,
    borderColor: gold,
    borderWidth: 1,
  });

  // Top header banner
  page.drawRectangle({
    x: 28,
    y: height - 100,
    width: width - 56,
    height: 70,
    color: rgb(0.96, 0.98, 0.96),
  });

  let y = height - 50;

  // Header Title
  page.drawText('REPUBLIK INDONESIA', {
    x: 215,
    y: y,
    size: 13,
    font: fontBold,
    color: darkGreen,
  });
  y -= 16;

  page.drawText('KEMENTERIAN AGAMA REPUBLIK INDONESIA', {
    x: 165,
    y: y,
    size: 11,
    font: fontBold,
    color: darkGreen,
  });
  y -= 15;

  const kuaTitle = `KANTOR URUSAN AGAMA ${b.kuaKecamatan ? b.kuaKecamatan.toUpperCase() : 'KECAMATAN'}`;
  page.drawText(kuaTitle, {
    x: (width - (kuaTitle.length * 5.8)) / 2,
    y: y,
    size: 9.5,
    font: fontBold,
    color: emerald,
  });
  y -= 25;

  // Document Title Box
  page.drawRectangle({
    x: 110,
    y: y - 10,
    width: width - 220,
    height: 30,
    color: darkGreen,
  });

  page.drawText('BUKU KUTIPAN AKTA NIKAH', {
    x: 175,
    y: y,
    size: 14,
    font: fontBold,
    color: rgb(1, 1, 1),
  });
  y -= 22;

  page.drawText('MODEL N (SALINAN RESMI UNTUK SUAMI / ISTRI)', {
    x: 172,
    y: y,
    size: 8.5,
    font: fontBold,
    color: gold,
  });
  y -= 28;

  // Metadata Row: No Akta & Porporasi
  page.drawText(`Nomor Akta Nikah : ${b.noAkta || '-'}`, {
    x: 45,
    y: y,
    size: 10,
    font: fontBold,
    color: darkText,
  });

  page.drawText(`No. Seri Perforasi : ${b.noPorporasi || record.noPorporasi || '-'}`, {
    x: 360,
    y: y,
    size: 10,
    font: fontBold,
    color: gold,
  });
  y -= 16;

  page.drawText(`Hari / Tanggal Akad : ${b.hariAkad || 'Sabtu'}, ${b.tglAkad || '2026-08-15'}`, {
    x: 45,
    y: y,
    size: 9.5,
    font: fontRegular,
    color: darkText,
  });
  y -= 18;

  // Section divider line
  page.drawLine({
    start: { x: 45, y: y },
    end: { x: width - 45, y: y },
    thickness: 1,
    color: darkGreen,
  });
  y -= 20;

  // --- SECTION I: MEMPELAI PRIA (SUAMI) ---
  page.drawText('I. DATA SUAMI (MEMPELAI PRIA)', {
    x: 45,
    y: y,
    size: 10,
    font: fontBold,
    color: darkGreen,
  });
  y -= 16;

  const suamiFields = [
    ['Nama Lengkap Suami', b.namaSuami || '-'],
    ['Bin (Nama Ayah)', b.binSuami || '-'],
    ['Nomor Induk Kependudukan (NIK)', b.nikSuami || '-'],
    ['Tempat & Tanggal Lahir', b.ttlSuami || '-'],
    ['Status Pernikahan', b.statusSuami || 'Jejaka'],
    ['Pekerjaan', b.pekerjaanSuami || 'Karyawan'],
    ['Alamat / Domisili', b.alamatSuami || '-'],
  ];

  suamiFields.forEach(([label, val]) => {
    page.drawText(`${label}`, { x: 55, y: y, size: 8.5, font: fontRegular, color: mutedText });
    page.drawText(`:  ${val}`, { x: 230, y: y, size: 9, font: fontBold, color: darkText });
    y -= 15;
  });

  y -= 10;
  // Section divider line
  page.drawLine({
    start: { x: 45, y: y },
    end: { x: width - 45, y: y },
    thickness: 0.75,
    color: rgb(0.8, 0.85, 0.82),
  });
  y -= 18;

  // --- SECTION II: MEMPELAI WANITA (ISTRI) ---
  page.drawText('II. DATA ISTRI (MEMPELAI WANITA)', {
    x: 45,
    y: y,
    size: 10,
    font: fontBold,
    color: darkGreen,
  });
  y -= 16;

  const istriFields = [
    ['Nama Lengkap Istri', b.namaIstri || '-'],
    ['Binti (Nama Ayah)', b.bintiIstri || '-'],
    ['Nomor Induk Kependudukan (NIK)', b.nikIstri || '-'],
    ['Tempat & Tanggal Lahir', b.ttlIstri || '-'],
    ['Status Pernikahan', b.statusIstri || 'Perawan'],
    ['Pekerjaan', b.pekerjaanIstri || 'Guru'],
    ['Alamat / Domisili', b.alamatIstri || '-'],
  ];

  istriFields.forEach(([label, val]) => {
    page.drawText(`${label}`, { x: 55, y: y, size: 8.5, font: fontRegular, color: mutedText });
    page.drawText(`:  ${val}`, { x: 230, y: y, size: 9, font: fontBold, color: darkText });
    y -= 15;
  });

  y -= 10;
  // Section divider line
  page.drawLine({
    start: { x: 45, y: y },
    end: { x: width - 45, y: y },
    thickness: 0.75,
    color: rgb(0.8, 0.85, 0.82),
  });
  y -= 18;

  // --- SECTION III: WALI & MAHAR ---
  page.drawText('III. WALI NIKAH & MAS KAWIN (MAHAR)', {
    x: 45,
    y: y,
    size: 10,
    font: fontBold,
    color: darkGreen,
  });
  y -= 16;

  const waliFields = [
    ['Nama Wali Nikah', b.namaWali || '-'],
    ['Hubungan Wali', b.hubunganWali || 'Ayah Kandung (Nasab)'],
    ['Mas Kawin / Mahar', b.masKawin || '-'],
    ['Status Pembayaran Mahar', b.statusMahar || 'Tunai'],
  ];

  waliFields.forEach(([label, val]) => {
    page.drawText(`${label}`, { x: 55, y: y, size: 8.5, font: fontRegular, color: mutedText });
    page.drawText(`:  ${val}`, { x: 230, y: y, size: 9, font: fontBold, color: darkText });
    y -= 15;
  });

  y -= 15;

  // --- SECTION IV: PENGHULU & TANDA TANGAN ---
  page.drawRectangle({
    x: 45,
    y: 35,
    width: width - 90,
    height: 105,
    borderColor: rgb(0.8, 0.85, 0.82),
    borderWidth: 1,
    color: rgb(0.98, 0.99, 0.98),
  });

  page.drawText('Pegawai Pencatat Nikah / Penghulu:', {
    x: 60,
    y: 125,
    size: 8.5,
    font: fontRegular,
    color: mutedText,
  });

  page.drawText(b.penghulu || 'Drs. H. M. Zainuddin, M.Ag.', {
    x: 60,
    y: 52,
    size: 9.5,
    font: fontBold,
    color: darkText,
  });

  page.drawText('NIP. 19740512 200212 1 003', {
    x: 60,
    y: 40,
    size: 8,
    font: fontRegular,
    color: mutedText,
  });

  // Stamp simulation
  page.drawCircle({
    x: 450,
    y: 85,
    size: 30,
    borderColor: rgb(0.1, 0.4, 0.8),
    borderWidth: 1.5,
  });
  page.drawText('KUA KECAMATAN', {
    x: 418,
    y: 88,
    size: 6.5,
    font: fontBold,
    color: rgb(0.1, 0.4, 0.8),
  });
  page.drawText('CAP RESMI KEMENAG', {
    x: 412,
    y: 78,
    size: 6,
    font: fontBold,
    color: rgb(0.1, 0.4, 0.8),
  });

  return await pdfDoc.save();
}

/**
 * Generate an in-memory sample folder containing multiple Akta Nikah PDF files
 * @param {Array} records - Array of records
 * @returns {Promise<Array<{ name: string, file: File }>>}
 */
export async function createSamplePDFFolderFiles(records = SAMPLE_RECORDS) {
  const files = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const pdfBytes = await generateSampleAktaPDF(rec);
    const safeAktaNo = (rec.book.noAkta || `Akta_${i+1}`).replace(/[\/\\]/g, '_');
    const fileName = `Akta_${safeAktaNo}_${rec.book.namaSuami.split(' ')[0]}.pdf`;

    const file = new File([pdfBytes], fileName, {
      type: 'application/pdf',
      lastModified: Date.now()
    });

    // Attach mock folder path to simulate webkitRelativePath
    Object.defineProperty(file, 'webkitRelativePath', {
      value: `Folder_Scan_Akta_KUA_2026/${fileName}`,
      writable: false
    });

    files.push(file);
  }

  return files;
}
