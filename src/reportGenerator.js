/**
 * VerifAkta - Berita Acara & Audit Report Generator
 * Generates an official printable government report (Berita Acara Rekapitulasi Hasil Koreksi Akta Nikah Kemenag/KUA).
 */
import { evaluateRecord } from './validation.js';

export function generateBeritaAcaraHTML(records, auditorName = 'Petugas Verifikasi KUA', kuaName = 'KUA Kecamatan Sawahan') {
  const today = new Date();
  const dateFormatted = today.toLocaleDateString('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const discrepancies = [];
  let totalChecked = records.length;
  let totalClean = 0;

  records.forEach((rec, idx) => {
    const evalResult = evaluateRecord(rec.book, rec.entry);
    const issues = evalResult.evaluations.filter(e => e.status !== 'match');

    if (issues.length === 0 && evalResult.crossFieldNotes.length === 0) {
      totalClean++;
    } else {
      issues.forEach(issue => {
        discrepancies.push({
          noIndex: idx + 1,
          noAkta: rec.book.noAkta || rec.entry.noAkta,
          pasangan: `${rec.book.namaSuami} & ${rec.book.namaIstri}`,
          field: issue.label,
          bukuVal: issue.bookValue || '(Kosong)',
          entryVal: issue.entryValue || '(Kosong)',
          tipe: issue.status === 'typo' ? 'Typo / Salah Ketik' : issue.status === 'format_error' ? 'Format NIK Salah' : 'Selisih Data',
          status: rec.statusVerifikasi || 'Telah Dikoreksi'
        });
      });

      evalResult.crossFieldNotes.forEach(cf => {
        discrepancies.push({
          noIndex: idx + 1,
          noAkta: rec.book.noAkta || rec.entry.noAkta,
          pasangan: `${rec.book.namaSuami} & ${rec.book.namaIstri}`,
          field: cf.field,
          bukuVal: '-',
          entryVal: '-',
          tipe: 'Peringatan Hukum (UU 16/2019)',
          status: 'Perlu Konfirmasi',
          customMsg: cf.message
        });
      });
    }
  });

  const errorCount = discrepancies.length;
  const accuracy = Math.round(((totalChecked - (totalChecked - totalClean)) / totalChecked) * 100) || 0;

  return `
    <div class="ba-report-container">
      <!-- Printable KOP SURAT -->
      <div class="ba-kop">
        <div class="ba-kop-emblem">
          <svg width="64" height="64" viewBox="0 0 100 100" fill="none">
            <circle cx="50" cy="50" r="46" stroke="#065f46" stroke-width="3" fill="#ecfdf5"/>
            <polygon points="50,15 62,38 87,38 67,54 75,78 50,63 25,78 33,54 13,38 38,38" fill="#047857" stroke="#064e3b" stroke-width="1.5"/>
            <circle cx="50" cy="50" r="16" fill="#fbbf24" stroke="#d97706" stroke-width="1"/>
            <text x="50" y="54" font-family="sans-serif" font-size="10" font-weight="900" fill="#064e3b" text-anchor="middle">RI</text>
          </svg>
        </div>
        <div class="ba-kop-text">
          <div class="kop-instansi">KEMENTERIAN AGAMA REPUBLIK INDONESIA</div>
          <div class="kop-kantor">KANTOR KEMENTERIAN AGAMA KOTA SURABAYA</div>
          <div class="kop-kua">${kuaName.toUpperCase()}</div>
          <div class="kop-alamat">Jl. Dukuh Kupang Timur X/8, Pakis, Kec. Sawahan, Kota Surabaya, Jawa Timur 60256-</div>
        </div>
      </div>
      <div class="ba-divider-line"></div>
      <div class="ba-divider-sub"></div>

      <!-- Judul Dokumen -->
      <div class="ba-title-block">
        <div class="ba-title">BERITA ACARA HASIL PROOFREADING & REKAPITULASI KOREKSI AKTA NIKAH</div>
        <div class="ba-nomor">Nomor: B-421/Kua.13.29.08/PW.01/${new Date().getMonth() + 1}/${new Date().getFullYear()}</div>
      </div>

      <!-- Pembukaan -->
      <div class="ba-body-text">
        Pada hari ini, <strong>${dateFormatted}</strong>, telah dilaksanakan verifikasi, pencocokan silang (cross-matching), dan proofreading menyeluruh antara <strong>Buku Kutipan Akta Nikah Fisik (Model N)</strong> dengan <strong>Data Hasil Entry Spreadsheet / SIMKAH</strong>, dengan hasil pemeriksaan sebagai berikut:
      </div>

      <!-- Ringkasan Statistik -->
      <div class="ba-stats-grid">
        <div class="ba-stat-box">
          <div class="stat-num">${totalChecked}</div>
          <div class="stat-lbl">Total Berkas Diperiksa</div>
        </div>
        <div class="ba-stat-box">
          <div class="stat-num text-success">${totalClean}</div>
          <div class="stat-lbl">Berkas Langsung Sesuai</div>
        </div>
        <div class="ba-stat-box">
          <div class="stat-num text-warning">${discrepancies.length}</div>
          <div class="stat-lbl">Total Kesalahan Ditemukan</div>
        </div>
        <div class="ba-stat-box">
          <div class="stat-num">${accuracy}%</div>
          <div class="stat-lbl">Tingkat Akurasi Entry Awal</div>
        </div>
      </div>

      <!-- Tabel Daftar Kesalahan & Koreksi -->
      <div class="ba-table-section">
        <div class="ba-table-title">Daftar Rincian Selisih Data & Perbaikan:</div>
        ${discrepancies.length === 0 ? `
          <div class="ba-empty-msg">
            ✓ Luar biasa! Tidak ditemukan satupun selisih data atau kesalahan pengetikan pada seluruh berkas yang diperiksa.
          </div>
        ` : `
          <table class="ba-table">
            <thead>
              <tr>
                <th width="4%">No</th>
                <th width="16%">No. Akta Nikah</th>
                <th width="18%">Pasangan Pengantin</th>
                <th width="14%">Field Data</th>
                <th width="18%">Data Buku Fisik</th>
                <th width="18%">Data Entry Semula</th>
                <th width="12%">Status Tindak Lanjut</th>
              </tr>
            </thead>
            <tbody>
              ${discrepancies.map((d, i) => `
                <tr>
                  <td align="center">${i + 1}</td>
                  <td><strong>${d.noAkta}</strong></td>
                  <td>${d.pasangan}</td>
                  <td><span class="badge-field">${d.field}</span></td>
                  <td class="text-correct">${d.customMsg ? '-' : d.bukuVal}</td>
                  <td class="text-wrong">${d.customMsg ? d.customMsg : d.entryVal}</td>
                  <td align="center"><span class="badge-status-report">${d.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <!-- Penutup & Tanda Tangan -->
      <div class="ba-closing">
        Demikian Berita Acara Rekapitulasi Proofreading ini dibuat dengan sebenar-benarnya untuk dipergunakan sebagai dasar perbaikan database SIMKAH dan pertanggungjawaban administrasi pencatatan nikah.
      </div>

      <div class="ba-signatures">
        <div class="sig-col">
          <div>Mengetahui,</div>
          <div>Kepala KUA Kecamatan Sawahan</div>
          <div class="sig-space"></div>
          <div class="sig-name"><strong>Drs. H. M. Zainuddin, M.Ag.</strong></div>
          <div class="sig-nip">NIP. 19710815 199803 1 002</div>
        </div>
        <div class="sig-col">
          <div>Surabaya, ${new Date().toLocaleDateString('id-ID')}</div>
          <div>Petugas Verifikator / Proofreader,</div>
          <div class="sig-space"></div>
          <div class="sig-name"><strong>${auditorName}</strong></div>
          <div class="sig-nip">NIP. 19880412 201402 1 003</div>
        </div>
      </div>
    </div>
  `;
}
