/**
 * VerifAkta - Validation & Matching Engine
 * Handles Fuzzy Matching, Levenshtein Distance, Indonesian NIK format & gender date verification,
 * Marriage law age checks (UU No. 16/2019), and KUA administrative consistency.
 */

// Calculate Levenshtein Distance between two strings
export function levenshteinDistance(a, b) {
  if (!a && !b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const strA = String(a).trim().toLowerCase();
  const strB = String(b).trim().toLowerCase();

  const matrix = Array.from({ length: strA.length + 1 }, () =>
    new Array(strB.length + 1).fill(0)
  );

  for (let i = 0; i <= strA.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= strB.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= strA.length; i++) {
    for (let j = 1; j <= strB.length; j++) {
      const cost = strA[i - 1] === strB[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[strA.length][strB.length];
}

// Calculate Similarity Score (0 - 100%)
export function calculateSimilarity(str1, str2) {
  const s1 = (str1 ?? '').toString().trim();
  const s2 = (str2 ?? '').toString().trim();

  if (s1 === '' || s2 === '') return 0;
  if (s1.toLowerCase() === s2.toLowerCase()) return 100;

  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshteinDistance(s1, s2);
  const similarity = ((maxLen - distance) / maxLen) * 100;
  return Math.round(similarity * 10) / 10;
}

// Compute Character Diffs for visual highlighting of typos
export function computeCharDiff(original, modified) {
  const s1 = (original ?? '').toString();
  const s2 = (modified ?? '').toString();

  if (s1 === s2) {
    return [{ type: 'same', text: s2 }];
  }

  // Simple diff by dynamic programming
  const n = s1.length;
  const m = s2.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (s1[i - 1].toLowerCase() === s2[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diffs = [];
  let i = n, j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && s1[i - 1].toLowerCase() === s2[j - 1].toLowerCase()) {
      diffs.unshift({ type: 'same', text: s2[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffs.unshift({ type: 'ins', text: s2[j - 1] }); // added/changed in spreadsheet
      j--;
    } else {
      diffs.unshift({ type: 'del', text: s1[i - 1] }); // missing from spreadsheet
      i--;
    }
  }

  // Merge contiguous same types
  const merged = [];
  for (const chunk of diffs) {
    if (merged.length > 0 && merged[merged.length - 1].type === chunk.type) {
      merged[merged.length - 1].text += chunk.text;
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}

// Indonesian NIK Validator (16 digits, numeric)
export function validateNIK(nik) {
  const cleaned = (nik ?? '').toString().replace(/[\s-]/g, '');
  if (!cleaned) return { valid: false, message: 'NIK belum diisi' };
  if (!/^\d+$/.test(cleaned)) return { valid: false, message: 'NIK harus berupa angka' };
  if (cleaned.length !== 16) return { valid: false, message: `NIK harus 16 digit (terdeteksi ${cleaned.length} digit)` };

  return { valid: true, cleaned, message: 'Format NIK 16 digit valid' };
}

// Decode NIK Date & Gender (Ditjen Dukcapil standards)
export function decodeNIKBirthDate(nik) {
  const check = validateNIK(nik);
  if (!check.valid) return null;

  const raw = check.cleaned;
  const dayRaw = parseInt(raw.substring(6, 8), 10);
  const month = parseInt(raw.substring(8, 10), 10);
  const yearTwoDigits = parseInt(raw.substring(10, 12), 10);

  // Female: day is offset by +40
  const isFemale = dayRaw > 40;
  const day = isFemale ? dayRaw - 40 : dayRaw;

  // Estimate full year (assume 1900-2025)
  const currentYearTwoDigits = new Date().getFullYear() % 100;
  const fullYear = yearTwoDigits > currentYearTwoDigits ? 1900 + yearTwoDigits : 2000 + yearTwoDigits;

  return {
    raw,
    day,
    month,
    year: fullYear,
    isFemale,
    formattedDate: `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${fullYear}`
  };
}

// Compare NIK with declared Date of Birth & Gender
export function verifyNIKWithBirthDate(nik, birthDateStr, expectedGender = 'male') {
  const nikData = decodeNIKBirthDate(nik);
  if (!nikData) {
    return { valid: false, error: 'NIK tidak valid atau kosong' };
  }

  // Check gender
  if (expectedGender === 'female' && !nikData.isFemale) {
    return {
      valid: false,
      error: 'Untuk mempelai wanita, kode tanggal pada NIK harus ditambah 40 (format Dukcapil)'
    };
  }
  if (expectedGender === 'male' && nikData.isFemale) {
    return {
      valid: false,
      error: 'Kode tanggal pada NIK terdeteksi perempuan (+40), padahal mempelai pria'
    };
  }

  // If birthDateStr provided (e.g. "1998-05-14" or "14-05-1998")
  if (birthDateStr) {
    const parts = birthDateStr.match(/\d+/g);
    if (parts && parts.length >= 3) {
      let bDay, bMonth, bYear;
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        bYear = parseInt(parts[0], 10);
        bMonth = parseInt(parts[1], 10);
        bDay = parseInt(parts[2], 10);
      } else {
        // DD-MM-YYYY
        bDay = parseInt(parts[0], 10);
        bMonth = parseInt(parts[1], 10);
        bYear = parseInt(parts[2], 10);
      }

      if (bDay !== nikData.day || bMonth !== nikData.month) {
        return {
          valid: false,
          error: `Tanggal lahir di NIK (${nikData.formattedDate}) tidak cocok dengan data lahir (${bDay}-${bMonth}-${bYear})`
        };
      }
    }
  }

  return { valid: true, message: 'NIK sesuai dengan jenis kelamin & tanggal lahir' };
}

// Calculate Age at Marriage (UU No. 16/2019: Minimal 19 Tahun untuk Pria & Wanita)
export function calculateAgeAtDate(birthDateStr, marriageDateStr) {
  if (!birthDateStr || !marriageDateStr) return null;

  const parseDate = (str) => {
    const parts = str.match(/\d+/g);
    if (!parts || parts.length < 3) return null;
    if (parts[0].length === 4) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
  };

  const birthDate = parseDate(birthDateStr);
  const marriageDate = parseDate(marriageDateStr);

  if (!birthDate || !marriageDate || isNaN(birthDate) || isNaN(marriageDate)) return null;

  let age = marriageDate.getFullYear() - birthDate.getFullYear();
  const m = marriageDate.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && marriageDate.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

// Verify Marriage Age according to Indonesian Marriage Law (UU No. 16/2019)
export function verifyMarriageAge(birthDateStr, marriageDateStr) {
  const age = calculateAgeAtDate(birthDateStr, marriageDateStr);
  if (age === null) return { valid: true, warning: 'Tanggal lahir/akad belum lengkap' };

  if (age < 19) {
    return {
      valid: false,
      age,
      warning: `Usia saat menikah adalah ${age} tahun. Sesuai UU No. 16 Tahun 2019, batas minimal usia nikah adalah 19 tahun (Perlu Dispensasi Pengadilan Agama).`
    };
  }

  return { valid: true, age, message: `Usia ${age} tahun memenuhi syarat minimal (≥19 th)` };
}

// Verify Wali Nasab consistency
export function verifyWali(namaWali, hubunganWali, namaAyahIstri) {
  if (!namaWali) return { valid: false, error: 'Nama wali belum diisi' };
  
  const rel = (hubunganWali ?? '').toLowerCase();
  if (rel.includes('ayah') || rel.includes('kandung') || rel.includes('nasab')) {
    if (namaAyahIstri) {
      const sim = calculateSimilarity(namaWali, namaAyahIstri);
      if (sim < 80) {
        return {
          valid: false,
          warning: `Hubungan wali "${hubunganWali}", tetapi nama wali (${namaWali}) berbeda dengan nama ayah istri (${namaAyahIstri}). Mohon pastikan keabsahan wali.`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Normalize date strings for semantic comparison across formats (DD-MM-YYYY vs YYYY-MM-DD etc.)
 */
export function normalizeDateToStandard(str) {
  if (!str) return '';
  const s = String(str).trim();
  const parts = s.match(/\d+/g);
  if (parts && parts.length >= 3) {
    let day, month, year;
    if (parts[0].length === 4) {
      year = parts[0];
      month = parts[1].padStart(2, '0');
      day = parts[2].padStart(2, '0');
    } else {
      day = parts[0].padStart(2, '0');
      month = parts[1].padStart(2, '0');
      year = parts[2];
    }
    if (year.length === 2) year = parseInt(year, 10) > 40 ? `19${year}` : `20${year}`;
    return `${day}-${month}-${year}`;
  }
  return s.toLowerCase().replace(/\s+/g, '');
}

// Keep the public normalizer permissive for existing callers; comparisons require a real date.
function isValidComparisonDate(value) {
  const numericDate = /^(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{1,2}([-/.])\d{1,2}\2(?:\d{4}|\d{2}))$/;
  if (!numericDate.test(value)) return false;

  const [day, month, year] = normalizeDateToStandard(value).split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// Overall Record Evaluator: Compares Book Data (Physical/PDF Scan) with Spreadsheet Data (Entry)
// Specifically matches ONLY the 4 requested fields:
// 1. Nomor Akta Nikah (noAkta)
// 2. Tanggal Akad Nikah (tglAkad)
// 3. Nama Pengantin Laki-laki (namaSuami)
// 4. Nama Pengantin Perempuan (namaIstri)
// Compare typography only in recognized academic suffixes. Never strip
// punctuation from the person's name or discard a missing/different title.
function sameAcademicTitleFormatting(left, right) {
  for (const title of ['AMD', 'SS', 'SSI', 'SH', 'SPD', 'SE', 'SKOM', 'MSI', 'MH', 'MPD', 'MM']) {
    const letters = [...title].join('\\s*\\.?\\s*');
    const pattern = new RegExp(`^(.+?)(\\s*,\\s*|\\s+)(${letters}\\.?)$`, 'i');
    const a = left.match(pattern);
    const b = right.match(pattern);
    if (a && b && a[1].toLowerCase() === b[1].toLowerCase()
      && /[,.]/.test(a[2] + a[3] + b[2] + b[3])) return true;
  }
  return false;
}

function ambiguousRomanMonth(left, right) {
  const pattern = /^(\d+\/\d+\/)(I|1)(\/(?:19|20)\d{2})$/i;
  const a = left.match(pattern);
  const b = right.match(pattern);
  return a && b && a[1] === b[1] && a[3] === b[3]
    && a[2].toUpperCase() !== b[2].toUpperCase();
}

export function evaluateRecord(bookData, entryData = {}, isSpreadsheetLoaded = true) {
  const fields = [
    { key: 'noAkta', label: 'Nomor Akta Nikah', category: 'Identitas Akta' },
    { key: 'tglAkad', label: 'Tanggal Akad Nikah', category: 'Identitas Akta' },
    { key: 'namaSuami', label: 'Nama Pengantin Laki-laki', category: 'Data Pengantin' },
    { key: 'namaIstri', label: 'Nama Pengantin Perempuan', category: 'Data Pengantin' }
  ];

  const evaluations = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let matchesCount = 0;

  for (const field of fields) {
    const bookVal = (bookData?.[field.key] ?? '').toString().trim();
    const entryVal = (entryData?.[field.key] ?? '').toString().trim();

    let similarity = 0;
    let diff = [];
    let status;
    let message;
    let severity;
    let normalization = null;

    if (!isSpreadsheetLoaded) {
      status = 'pending';
      message = 'Menunggu spreadsheet untuk perbandingan';
      severity = 'warning';
      totalWarnings++;
    } else if (!bookVal) {
      status = 'unread';
      message = entryVal
        ? 'Data buku belum terbaca (perlu OCR atau input manual)'
        : 'Data buku belum terbaca dan kolom entry spreadsheet masih kosong';
      severity = 'warning';
      totalWarnings++;
    } else if (!entryVal) {
      status = 'empty';
      message = 'Kolom pada entry spreadsheet masih kosong!';
      severity = 'danger';
      totalErrors++;
    } else if (field.key === 'tglAkad' &&
      (!isValidComparisonDate(bookVal) || !isValidComparisonDate(entryVal))) {
      status = 'format_error';
      message = 'Tanggal akad pada buku atau spreadsheet tidak valid (gunakan DD-MM-YYYY atau YYYY-MM-DD)';
      severity = 'danger';
      diff = computeCharDiff(bookVal, entryVal);
      totalErrors++;
    } else if (field.key === 'noAkta' && ambiguousRomanMonth(bookVal, entryVal)) {
      status = 'review';
      message = 'Periksa scan: huruf Romawi I dan angka 1 pada bagian bulan belum dapat dibedakan. Belum dihitung cocok.';
      severity = 'warning';
      diff = computeCharDiff(bookVal, entryVal);
      totalWarnings++;
    } else {
      diff = computeCharDiff(bookVal, entryVal);
      const isName = field.key === 'namaSuami' || field.key === 'namaIstri';
      if (isName && bookVal.toLowerCase() !== entryVal.toLowerCase()
        && sameAcademicTitleFormatting(bookVal, entryVal)) normalization = 'academic-title-format';
      const isEqual = field.key === 'tglAkad'
        ? normalizeDateToStandard(bookVal) === normalizeDateToStandard(entryVal)
        : bookVal.toLowerCase() === entryVal.toLowerCase() || !!normalization;
      similarity = isEqual ? 100 : (isName ? calculateSimilarity(bookVal, entryVal) : 0);

      // Similarity is rounded for display; only actual equality establishes a match.
      if (isEqual) {
        status = 'match';
        message = normalization
          ? 'Nama dan gelar sama setelah normalisasi titik, koma, dan spasi pada gelar. Teks asli tetap ditampilkan.'
          : 'Data cocok 100%';
        severity = 'success';
        if (!normalization) diff = [{ type: 'same', text: entryVal }];
        matchesCount++;
      } else if (isName && similarity >= 75) {
        status = 'typo';
        message = `Terdapat selisih / salah ketik (kemiripan ${similarity}%)`;
        severity = 'warning';
        totalWarnings++;
      } else {
        status = 'mismatch';
        message = isName ? `Data berbeda (kemiripan ${similarity}%)` : 'Data berbeda';
        severity = 'danger';
        totalErrors++;
      }
    }

    evaluations.push({
      ...field,
      bookValue: bookVal,
      entryValue: entryVal,
      missingBook: !bookVal,
      missingEntry: !entryVal,
      similarity,
      diff,
      status,
      message,
      severity,
      normalization
    });
  }

  const crossFieldNotes = [];
  const overallScore = Math.round((matchesCount / fields.length) * 100);

  return {
    evaluations,
    crossFieldNotes,
    totalErrors,
    totalWarnings,
    matchesCount,
    totalFields: fields.length,
    overallScore,
    isClean: matchesCount === fields.length
  };
}
