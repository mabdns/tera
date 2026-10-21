/**
 * VerifAkta - Authentic Buku Akta Nikah Renderer
 * Generates high-fidelity visual representations of Indonesian Marriage Certificate Books (Model N Kemenag)
 * with ornate green borders, official seal stamp, perforated serial number, and parchment texture.
 */

export function renderCertificateSVG(record) {
  if (!record || !record.book) return '<div class="no-cert">Tidak ada data buku</div>';

  const b = record.book;
  const noAkta = b.noAkta || '0000/000/0000';
  const porporasi = b.noPorporasi || record.noPorporasi || 'SB-0000000';
  const kua = b.kuaKecamatan || 'Kantor Urusan Agama Kecamatan';
  const tglAkad = b.tglAkad || '-';
  const hariAkad = b.hariAkad || 'Hari';

  return `
    <div class="cert-document-wrapper" id="cert-doc">
      <div class="cert-paper">
        <!-- Ornamental Outer Border -->
        <div class="cert-border-outer">
          <div class="cert-border-inner">
            <!-- Corner Florals -->
            <div class="cert-corner corner-tl">❧</div>
            <div class="cert-corner corner-tr">☙</div>
            <div class="cert-corner corner-bl">❧</div>
            <div class="cert-corner corner-br">☙</div>

            <!-- Header Section -->
            <div class="cert-header">
              <div class="cert-emblem">
                <svg width="48" height="48" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <!-- Simplified Kemenag Crest / Star of David / Shield emblem -->
                  <circle cx="50" cy="50" r="46" stroke="#065f46" stroke-width="3" fill="#ecfdf5"/>
                  <polygon points="50,15 62,38 87,38 67,54 75,78 50,63 25,78 33,54 13,38 38,38" fill="#047857" stroke="#064e3b" stroke-width="1.5"/>
                  <circle cx="50" cy="50" r="16" fill="#fbbf24" stroke="#d97706" stroke-width="1"/>
                  <text x="50" y="54" font-family="'Plus Jakarta Sans', sans-serif" font-size="10" font-weight="900" fill="#064e3b" text-anchor="middle">RI</text>
                </svg>
              </div>

              <div class="cert-header-titles">
                <div class="cert-subheading">KEMENTERIAN AGAMA REPUBLIK INDONESIA</div>
                <div class="cert-title">AKTA NIKAH</div>
                <div class="cert-model">MODEL N (BUKU KUTIPAN AKTA NIKAH)</div>
                <div class="cert-kua-name">${kua}</div>
              </div>

              <div class="cert-serial-tag">
                <span class="serial-label">NO. SERI PERFORASI:</span>
                <span class="serial-number">${porporasi}</span>
              </div>
            </div>

            <!-- Nomor Register Akta -->
            <div class="cert-register-bar">
              <span class="reg-label">NOMOR AKTA NIKAH:</span>
              <span class="reg-val">${noAkta}</span>
            </div>

            <!-- Intro text -->
            <div class="cert-intro">
              Pada hari ini <strong>${hariAkad}</strong>, tanggal <strong>${tglAkad}</strong> telah dilangsungkan akad pernikahan antara seorang pria dan seorang wanita dengan rincian data sebagai berikut:
            </div>

            <!-- Dual Columns: Suami vs Istri -->
            <div class="cert-parties-grid">
              <!-- Suami Box -->
              <div class="cert-party-box">
                <div class="party-box-title">I. CALON SUAMI (MEMPELAI PRIA)</div>
                <div class="cert-field-row">
                  <span class="f-label">Nama Lengkap:</span>
                  <span class="f-value primary-val">${b.namaSuami}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Bin (Nama Ayah):</span>
                  <span class="f-value">${b.binSuami}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Nomor Induk Kependudukan:</span>
                  <span class="f-value mono-val">${b.nikSuami}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Tempat, Tgl Lahir:</span>
                  <span class="f-value">${b.ttlSuami}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Status Sebelum Menikah:</span>
                  <span class="f-value bold-val">${b.statusSuami}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Pekerjaan:</span>
                  <span class="f-value">${b.pekerjaanSuami || '-'}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Alamat Domisili:</span>
                  <span class="f-value text-small">${b.alamatSuami || '-'}</span>
                </div>
              </div>

              <!-- Istri Box -->
              <div class="cert-party-box">
                <div class="party-box-title">II. CALON ISTRI (MEMPELAI WANITA)</div>
                <div class="cert-field-row">
                  <span class="f-label">Nama Lengkap:</span>
                  <span class="f-value primary-val">${b.namaIstri}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Binti (Nama Ayah):</span>
                  <span class="f-value">${b.bintiIstri}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Nomor Induk Kependudukan:</span>
                  <span class="f-value mono-val">${b.nikIstri}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Tempat, Tgl Lahir:</span>
                  <span class="f-value">${b.ttlIstri}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Status Sebelum Menikah:</span>
                  <span class="f-value bold-val">${b.statusIstri}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Pekerjaan:</span>
                  <span class="f-value">${b.pekerjaanIstri || '-'}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Alamat Domisili:</span>
                  <span class="f-value text-small">${b.alamatIstri || '-'}</span>
                </div>
              </div>
            </div>

            <!-- Wali & Mahar Section -->
            <div class="cert-section-mahar">
              <div class="party-box-title">III. WALI NIKAH & MAS KAWIN (MAHAR)</div>
              <div class="mahar-grid">
                <div class="cert-field-row">
                  <span class="f-label">Nama Wali Nikah:</span>
                  <span class="f-value bold-val">${b.namaWali}</span>
                </div>
                <div class="cert-field-row">
                  <span class="f-label">Hubungan / Status Wali:</span>
                  <span class="f-value">${b.hubunganWali}</span>
                </div>
                <div class="cert-field-row full-span">
                  <span class="f-label">Mas Kawin / Mahar:</span>
                  <span class="f-value highlight-mahar">${b.masKawin} (Status: <strong>${b.statusMahar}</strong>)</span>
                </div>
              </div>
            </div>

            <!-- Footer & Signatures with Authentic Stamp -->
            <div class="cert-footer">
              <div class="cert-stamp-container">
                <!-- Red Circular KUA Ink Stamp -->
                <div class="kua-stamp">
                  <svg viewBox="0 0 160 160" width="120" height="120">
                    <circle cx="80" cy="80" r="74" stroke="#dc2626" stroke-width="2.5" fill="none" opacity="0.85" stroke-dasharray="1000"/>
                    <circle cx="80" cy="80" r="66" stroke="#dc2626" stroke-width="1.2" fill="none" opacity="0.85"/>
                    <path id="curve-top" d="M 22,80 A 58,58 0 0,1 138,80" fill="none"/>
                    <path id="curve-bottom" d="M 138,80 A 58,58 0 0,1 22,80" fill="none"/>
                    <text font-size="9.5" font-weight="bold" fill="#dc2626" letter-spacing="1.5" opacity="0.9">
                      <textPath href="#curve-top" startOffset="50%" text-anchor="middle">KEMENTERIAN AGAMA RI</textPath>
                    </text>
                    <text font-size="8.5" font-weight="bold" fill="#dc2626" letter-spacing="1" opacity="0.9">
                      <textPath href="#curve-bottom" startOffset="50%" text-anchor="middle">KUA KEC. LOWOKWARU</textPath>
                    </text>
                    <!-- Inner Star & Text -->
                    <polygon points="80,50 83,58 91,58 84,63 87,71 80,66 73,71 76,63 69,58 77,58" fill="#dc2626" opacity="0.9"/>
                    <text x="80" y="86" font-size="10" font-weight="900" fill="#dc2626" text-anchor="middle" opacity="0.9">SAH</text>
                    <text x="80" y="100" font-size="7" font-weight="bold" fill="#dc2626" text-anchor="middle" opacity="0.85">TERDAFTAR</text>
                  </svg>
                </div>
              </div>

              <div class="cert-sign-box">
                <div class="sign-place-date">${kua}, ${tglAkad}</div>
                <div class="sign-role">Kepala KUA / Penghulu,</div>
                <div class="signature-cursive">
                  <svg width="140" height="50" viewBox="0 0 140 50">
                    <path d="M10,35 Q30,5 60,30 T90,20 Q110,45 130,25 M40,25 L50,45" stroke="#1e3a8a" stroke-width="2.2" fill="none" stroke-linecap="round"/>
                  </svg>
                </div>
                <div class="sign-name"><strong>${b.penghulu || 'Drs. H. M. Zainuddin, M.Ag.'}</strong></div>
                <div class="sign-nip">NIP. 19710815 199803 1 002</div>
              </div>
            </div>

            <!-- Perforation dots watermark at bottom -->
            <div class="cert-perforation-edge">
              <span>• • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • •</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
