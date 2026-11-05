/**
 * VerifAkta - Excel & Spreadsheet Engine
 * Handles XLSX/XLS/CSV parsing, smart header detection, and exporting corrected data sheets.
 */
import * as XLSX from 'xlsx';

// Smart header synonyms mapping dictionary (prioritized order)
const HEADER_SYNONYMS = {
  tglAkad: [
    'tanggal dokumen (tahun-bulan-hari)', 'tgl dokumen (tahun-bulan-hari)',
    'tanggal dokumen', 'tgl dokumen',
    'tanggal akad nikah', 'tgl akad nikah', 'tanggal akad', 'tgl akad',
    'tanggal nikah', 'tgl nikah', 'tanggal pernikahan', 'tgl pernikahan',
    'tanggal perkawinan', 'tgl perkawinan', 'waktu akad', 'tgl_akad', 'tanggal', 'tgl'
  ],
  noAkta: [
    'nomor dokumen', 'nomer dokumen', 'no dokumen', 'no. dokumen',
    'nomor akta nikah', 'nomer akta nikah', 'nomor akta', 'nomer akta',
    'no akta nikah', 'no. akta nikah', 'no akta', 'no. akta',
    'no_akta', 'no_register', 'no reg', 'no register', 'akta nikah', 'nomor akta'
  ],
  namaSuami: [
    'pengantin laki', 'nama pengantin laki', 'pengantin laki laki', 'pengantin laki-laki',
    'nama pengantin laki laki', 'nama pengantin laki-laki', 'nama pengantin pria', 'pengantin pria',
    'nama suami', 'suami', 'mempelai pria', 'calon suami', 'nama pria',
    'nama_suami', 'suami/pria', 'pria'
  ],
  namaIstri: [
    'pengantin perempuan', 'nama pengantin perempuan', 'nama pengantin wanita',
    'pengantin wanita', 'nama istri', 'istri', 'mempelai wanita',
    'calon istri', 'nama wanita', 'nama_istri', 'istri/wanita', 'wanita', 'perempuan'
  ],
  fileName: [
    'nama file', 'nama berkas', 'nama_file', 'filename', 'file_name'
  ],
  no: [
    'no', 'no.', 'nomor urut', 'no urut'
  ],
  noPorporasi: ['no porporasi', 'porporasi', 'no seri', 'nomor seri', 'seri perforasi', 'no perforasi'],
  hariAkad: ['hari', 'hari akad', 'hari nikah'],
  kuaKecamatan: ['kua', 'kua kecamatan', 'kecamatan', 'kantor kua'],
  binSuami: ['bin', 'bin suami', 'ayah suami', 'nama ayah suami'],
  bintiIstri: ['binti', 'binti istri', 'ayah istri', 'nama ayah istri'],
  nikSuami: ['nik suami', 'ktp suami', 'nik pria', 'no ktp suami'],
  nikIstri: ['nik istri', 'ktp istri', 'nik wanita', 'no ktp istri'],
  ttlSuami: ['ttl suami', 'tempat tgl lahir suami', 'tempat tanggal lahir suami', 'lahir suami'],
  ttlIstri: ['ttl istri', 'tempat tgl lahir istri', 'tempat tanggal lahir istri', 'lahir istri'],
  statusSuami: ['status suami', 'status pria', 'status pernikahan suami'],
  statusIstri: ['status istri', 'status wanita', 'status pernikahan istri'],
  pekerjaanSuami: ['pekerjaan suami', 'profesi suami'],
  pekerjaanIstri: ['pekerjaan istri', 'profesi istri'],
  alamatSuami: ['alamat suami', 'domisili suami'],
  alamatIstri: ['alamat istri', 'domisili istri'],
  namaWali: ['nama wali', 'wali', 'wali nikah', 'nama_wali'],
  hubunganWali: ['hubungan wali', 'status wali', 'sebab wali'],
  masKawin: ['mas kawin', 'mahar', 'jumlah mahar', 'maskawin'],
  statusMahar: ['status mahar', 'keterangan mahar', 'tunai/hutang', 'status maskawin'],
  penghulu: ['penghulu', 'kepala kua', 'petugas']
};

/**
 * Safely format Excel date values to standard Indonesian date string DD-MM-YYYY
 * to match exact KUA physical scan notation (e.g. 26-07-1983)
 * without timezone shift.
 */
export function formatExcelDate(cellValue) {
  if (cellValue === null || cellValue === undefined || cellValue === '') return '';

  // 1. If Excel serial number (e.g. 30523 -> 26-07-1983)
  if (typeof cellValue === 'number' && cellValue > 10000 && cellValue < 65000) {
    if (XLSX && XLSX.SSF && typeof XLSX.SSF.parse_date_code === 'function') {
      const p = XLSX.SSF.parse_date_code(cellValue);
      if (p) {
        const day = String(p.d).padStart(2, '0');
        const month = String(p.m).padStart(2, '0');
        const year = p.y;
        return `${day}-${month}-${year}`;
      }
    }
  }

  // 2. If JS Date object from SheetJS cellDates
  if (cellValue instanceof Date && !isNaN(cellValue.getTime())) {
    // Add 12 hours to safely land on noon local time, preventing any UTC negative day shift
    const noon = new Date(cellValue.getTime() + 12 * 3600 * 1000);
    const day = String(noon.getUTCDate()).padStart(2, '0');
    const month = String(noon.getUTCMonth() + 1).padStart(2, '0');
    const year = noon.getUTCFullYear();
    return `${day}-${month}-${year}`;
  }

  // 3. If string, standardize to DD-MM-YYYY
  const s = String(cellValue).trim();
  const parts = s.match(/\d+/g);
  if (parts && parts.length >= 3) {
    let day, month, year;
    if (parts[0].length === 4) {
      // YYYY-MM-DD
      year = parts[0];
      month = parts[1].padStart(2, '0');
      day = parts[2].padStart(2, '0');
    } else {
      // DD-MM-YYYY
      day = parts[0].padStart(2, '0');
      month = parts[1].padStart(2, '0');
      year = parts[2];
    }
    if (year.length === 2) year = parseInt(year, 10) > 40 ? `19${year}` : `20${year}`;
    if (year.length === 4) return `${day}-${month}-${year}`;
  }

  return s;
}

export function matchHeaderToField(headerName) {
  if (!headerName) return null;
  const clean = headerName.toString().trim().toLowerCase();

  // First pass: exact match
  for (const [fieldKey, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    if (synonyms.some(syn => clean === syn)) {
      return fieldKey;
    }
  }

  // Second pass: phrase substring match (min length 4 to avoid greedy matches)
  for (const [fieldKey, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const syn of synonyms) {
      if (syn.length >= 4 && clean.includes(syn)) {
        return fieldKey;
      }
    }
  }

  return null;
}

// Parse Spreadsheet file (ArrayBuffer or Base64)
export function parseSpreadsheet(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  
  // Convert sheet to JSON array
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (rawRows.length === 0) {
    throw new Error('Spreadsheet kosong!');
  }

  // Find header row (usually row 0 or 1)
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
    const row = rawRows[i];
    const matchCount = row.filter(cell => matchHeaderToField(cell) !== null).length;
    if (matchCount >= 2) {
      headerRowIndex = i;
      break;
    }
  }

  const rawHeaders = rawRows[headerRowIndex].map(h => (h ?? '').toString().trim());
  const columnMapping = {};
  rawHeaders.forEach((header, colIdx) => {
    const mappedField = matchHeaderToField(header);
    if (mappedField) {
      columnMapping[colIdx] = mappedField;
    }
  });

  const parsedRecords = [];
  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    // Skip completely empty rows
    if (row.every(cell => !cell || cell.toString().trim() === '')) continue;

    const entry = {};


    row.forEach((cellValue, colIdx) => {
      const fieldKey = columnMapping[colIdx];
      if (fieldKey) {
        let val = '';
        if (fieldKey === 'tglAkad') {
          val = formatExcelDate(cellValue);
        } else if (cellValue instanceof Date) {
          val = cellValue.toISOString().split('T')[0];
        } else {
          val = (cellValue ?? '').toString().trim();
        }
        entry[fieldKey] = val;
      }
    });

    // Parsed values are strings, so a frozen shallow copy preserves the import snapshot.
    const originalEntry = Object.freeze({ ...entry });

    parsedRecords.push({
      id: `imported-${r}`,
      no: entry.no || (r - headerRowIndex),
      fileName: entry.fileName || '',
      noPorporasi: entry.noPorporasi || '',
      statusVerifikasi: 'Belum Diperiksa',
      catatan: 'Diimpor dari file spreadsheet.',
      book: {},
      entry: entry,
      originalEntry
    });
  }

  return {
    headers: rawHeaders,
    mapping: columnMapping,
    records: parsedRecords,
    sheetNames: workbook.SheetNames
  };
}

// Export Corrected Records back to Excel
export function exportCorrectedExcel(records, filename = 'Data_Akta_Nikah_Terkoreksi.xlsx') {
  if (!records || records.length === 0) return;

  const exportRows = records.map((rec, index) => {
    const e = rec.entry;
    return {
      'No': index + 1,
      'Status Verifikasi': rec.statusVerifikasi || 'Belum Diperiksa',
      'Nomor Akta Nikah': e.noAkta || '',
      'Tanggal Akad Nikah': e.tglAkad || '',
      'Nama Pengantin Laki-laki': e.namaSuami || '',
      'Nama Pengantin Perempuan': e.namaIstri || '',
      'Catatan Koreksi': rec.catatan || '',
      'Tanggal Selesai Koreksi': new Date().toLocaleDateString('id-ID')
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(exportRows);

  // Set column widths
  worksheet['!cols'] = [
    { wch: 6 },  // No
    { wch: 20 }, // Status Verifikasi
    { wch: 25 }, // Nomor Akta Nikah
    { wch: 22 }, // Tanggal Akad Nikah
    { wch: 32 }, // Nama Pengantin Laki-laki
    { wch: 32 }, // Nama Pengantin Perempuan
    { wch: 35 }, // Catatan Koreksi
    { wch: 20 }  // Tanggal Selesai
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Hasil Verifikasi 4 Bidang');

  XLSX.writeFile(workbook, filename);
}

/**
 * Format any date string to YYYY/M/D (e.g. 1983/7/26) to match the official archive inventory template
 */
export function formatToYMD(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  const months = {
    januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
    juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6, jul: 7, agu: 8, sep: 9, okt: 10, nov: 11, des: 12
  };

  // If already YYYY/M/D or YYYY-M-D
  const isoMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}/${parseInt(isoMatch[2], 10)}/${parseInt(isoMatch[3], 10)}`;
  }

  // If DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}/${parseInt(dmyMatch[2], 10)}/${parseInt(dmyMatch[1], 10)}`;
  }

  // If date with Indonesian month name (e.g. 26 Juli 1983)
  const textMonthMatch = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]+)[\s\-]+(\d{4})$/);
  if (textMonthMatch) {
    const day = parseInt(textMonthMatch[1], 10);
    const mStr = textMonthMatch[2].toLowerCase();
    const year = textMonthMatch[3];
    const month = months[mStr] || 1;
    return `${year}/${month}/${day}`;
  }

  return s;
}

/**
 * Calculate Excel serial date number (e.g. 1983-07-26 -> 30524)
 */
export function getExcelDateSerial(dateStr) {
  if (!dateStr) return '';
  const ymd = formatToYMD(dateStr);
  const parts = ymd.split('/');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d) && y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const utc = Date.UTC(y, m - 1, d);
      const epoch = Date.UTC(1899, 11, 30);
      const diffDays = Math.round((utc - epoch) / (24 * 3600 * 1000));
      return diffDays;
    }
  }
  return '';
}

/**
 * Export records to the exact Kemenag / Srikandi Vital Archive Inventory Template
 * Matching the columns in the user's template (1983-4.xlsx):
 * - Col A: No
 * - Col B: Tipe Dokumen ("Register Nikah")
 * - Col C: Nomor Dokumen ("309/46/VII/1983")
 * - Col D: Tanggal Dokumen (Tahun-Bulan-Hari) ("1983/7/26")
 * - Col E: Deskripsi ( Penambahan kata diisi sesuai kebutuhan ) (formula ="Register Nikah a/n "&N2&" dan "&O2)
 * - Col F: Klasifikasi (Kode atau Nama Lengkap Klasifikasi) ("PW.01")
 * - Col G: Keamanan Dokumen ("Terbatas")
 * - Col H: Kategori Dokumen ("Vital")
 * - Col I: Item Dokumen ('["Register Nikah"]')
 * - Col J: Tipe Penyimpanan ("Rak Besi")
 * - Col K: Kode Penyimpanan ("")
 * - Col L: Lokasi Penyimpanan ("")
 * - Col M: Nama File ("1.pdf")
 * - Col N: Pengantin Laki ("SUMARI")
 * - Col O: Pengantin Perempuan ("ENDAH MADE RUSWATI")
 * - Col P: Sum (Serial date, e.g. 30524)
 */
export function exportArsipInventarisExcel(records, filename = '1983-4.xlsx') {
  if (!records || records.length === 0) {
    alert('Tidak ada data yang dapat diekspor.');
    return;
  }

  const headers = [
    'No',
    'Tipe Dokumen',
    'Nomor Dokumen',
    'Tanggal Dokumen (Tahun-Bulan-Hari)',
    'Deskripsi ( Penambahan kata diisi sesuai kebutuhan )',
    'Klasifikasi (Kode atau Nama Lengkap Klasifikasi)',
    'Keamanan Dokumen',
    'Kategori Dokumen',
    'Item Dokumen',
    'Tipe Penyimpanan',
    'Kode Penyimpanan',
    'Lokasi Penyimpanan',
    'Nama File',
    'Pengantin Laki',
    'Pengantin Perempuan',
    'Sum'
  ];

  const aoa = [headers];

  records.forEach((rec, idx) => {
    const rowNum = idx + 2;
    const entryData = rec.entry || {};
    const bookData = rec.book || {};

    const noAkta = (entryData.noAkta || bookData.noAkta || '').trim();
    const rawTgl = (entryData.tglAkad || bookData.tglAkad || '').trim();
    const tglYMD = formatToYMD(rawTgl);
    const suami = (entryData.namaSuami || bookData.namaSuami || '').trim().toUpperCase();
    const istri = (entryData.namaIstri || bookData.namaIstri || '').trim().toUpperCase();
    
    // File name: use exact PDF file name if available (e.g. 1.pdf, 2.pdf)
    let fileName = rec.fileName || (rec.pdfDoc ? rec.pdfDoc.fileName : '');
    if (!fileName) {
      fileName = `${idx + 1}.pdf`;
    }

    const dateSerial = getExcelDateSerial(rawTgl);

    const descText = (suami && istri)
      ? `Register Nikah a/n ${suami} dan ${istri}`
      : (suami ? `Register Nikah a/n ${suami}` : (istri ? `Register Nikah a/n ${istri}` : 'Register Nikah'));

    aoa.push([
      idx + 1,                                       // A: No
      'Register Nikah',                              // B: Tipe Dokumen
      noAkta,                                        // C: Nomor Dokumen
      tglYMD,                                        // D: Tanggal Dokumen (Tahun-Bulan-Hari)
      descText,                                      // E: Deskripsi
      'PW.01',                                       // F: Klasifikasi (Kode atau Nama Lengkap Klasifikasi)
      'Terbatas',                                    // G: Keamanan Dokumen
      'Vital',                                       // H: Kategori Dokumen
      '["Register Nikah"]',                          // I: Item Dokumen
      'Rak Besi',                                    // J: Tipe Penyimpanan
      '',                                            // K: Kode Penyimpanan
      '',                                            // L: Lokasi Penyimpanan
      fileName,                                      // M: Nama File
      suami,                                         // N: Pengantin Laki
      istri,                                         // O: Pengantin Perempuan
      dateSerial || ''                               // P: Sum
    ]);
  });

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);

  // Apply dynamic formula for Column E: ="Register Nikah a/n "&N2&" dan "&O2
  records.forEach((_, idx) => {
    const rowNum = idx + 2;
    const cellRefE = `E${rowNum}`;
    if (worksheet[cellRefE]) {
      worksheet[cellRefE].f = `="Register Nikah a/n "&N${rowNum}&" dan "&O${rowNum}`;
    }

    // Ensure serial date in Column P has numeric type if present
    const cellRefP = `P${rowNum}`;
    if (worksheet[cellRefP] && typeof worksheet[cellRefP].v === 'number') {
      worksheet[cellRefP].t = 'n';
    }
  });

  // Set column widths matching original Excel template
  worksheet['!cols'] = [
    { wch: 6 },  // A: No
    { wch: 18 }, // B: Tipe Dokumen
    { wch: 24 }, // C: Nomor Dokumen
    { wch: 34 }, // D: Tanggal Dokumen (Tahun-Bulan-Hari)
    { wch: 64 }, // E: Deskripsi ( Penambahan kata diisi sesuai kebutuhan )
    { wch: 45 }, // F: Klasifikasi (Kode atau Nama Lengkap Klasifikasi)
    { wch: 20 }, // G: Keamanan Dokumen
    { wch: 18 }, // H: Kategori Dokumen
    { wch: 20 }, // I: Item Dokumen
    { wch: 20 }, // J: Tipe Penyimpanan
    { wch: 20 }, // K: Kode Penyimpanan
    { wch: 22 }, // L: Lokasi Penyimpanan
    { wch: 16 }, // M: Nama File
    { wch: 30 }, // N: Pengantin Laki
    { wch: 30 }, // O: Pengantin Perempuan
    { wch: 12 }  // P: Sum
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');

  // If filename doesn't end with .xlsx, append it
  const safeFilename = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  XLSX.writeFile(workbook, safeFilename);
}
