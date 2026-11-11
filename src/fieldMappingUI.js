import { MAPPING_FIELDS, MAPPING_PROFILES, createMapping, validateMapping,
  updateMappingRegion, cropBounds, mappingReviewed, mappingDocumentKey } from './fieldMapping.js';

export async function openFieldMapping({ doc, saved, onSave }) {
  const images = doc.pageImages?.length ? doc.pageImages : doc.dataURL ? [{ pageNumber: 1, dataURL: doc.dataURL }] : [];
  if (!images.length) throw new Error('Tunggu sampai halaman PDF selesai dimuat.');
  const documentKey = await mappingDocumentKey(doc);
  let draft = null, initialWarning = '';
  if (saved) {
    try { draft = structuredClone(validateMapping(saved, documentKey, images.length)); }
    catch { initialWarning = 'Pemetaan lama tidak cocok dengan PDF ini. Pilih profil dan periksa ulang kotaknya.'; }
  }
  let selected = 'noAkta', image = null, imagePage = 0, loadId = 0, start = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'field-map-dialog';
  dialog.setAttribute('aria-labelledby', 'field-map-title');
  dialog.innerHTML = `<header class="field-map-header"><div><h2 id="field-map-title">Pemetaan Bidang Scan</h2><p class="field-map-file"></p></div><button type="button" class="btn btn-secondary" data-action="close">Tutup</button></header>
    <p class="field-map-notice">Tahap 1: tentukan area empat bidang. Kotak awal adalah usulan posisi; periksa terhadap label pada scan. Pemetaan ini belum menjalankan atau mengganti mesin OCR tulisan tangan dan tidak mengubah nilai buku maupun Excel.</p>
    <label class="field-map-profile">Jenis formulir <select data-control="profile"><option value="">Pilih berdasarkan formulir pada scan</option></select></label>
    <div class="field-map-layout"><section class="field-map-image"><p>Tarik pada gambar untuk menggambar ulang kotak bidang terpilih. Gunakan pengaturan persentase untuk penyesuaian kecil.</p><canvas data-control="scan" aria-label="Scan dengan kotak pemetaan"></canvas></section>
    <section class="field-map-editor"><nav class="field-map-fields" aria-label="Bidang yang dipetakan"></nav><p class="field-map-source"></p><p class="field-map-excel"></p>
    <fieldset disabled><legend>Area pada gambar asli</legend><label>Halaman <select data-control="page"></select></label><div class="field-map-coordinates">
    ${[['x','Kiri'],['y','Atas'],['w','Lebar'],['h','Tinggi']].map(([k,label]) => `<label>${label} (%) <input data-coordinate="${k}" type="number" min="0" max="100" step="0.1"></label>`).join('')}
    </div><label class="field-map-confirm"><input type="checkbox" data-control="confirmed"> Area bidang ini sudah saya periksa pada scan</label></fieldset>
    <h3>Potongan bukti bidang terpilih</h3><canvas data-control="crop" aria-label="Potongan gambar bidang terpilih"></canvas>
    <button type="button" class="btn btn-secondary" data-action="download" disabled>Unduh potongan PNG</button>
    </section></div><p class="field-map-status" role="status" aria-live="polite"></p>
    <footer><button type="button" class="btn btn-secondary" data-action="cancel">Batal</button><button type="button" class="btn btn-primary" data-action="save" disabled>Simpan Pemetaan Dokumen Ini</button></footer>`;
  document.body.append(dialog);
  const get = selector => dialog.querySelector(selector);
  const profile = get('[data-control="profile"]'), scan = get('[data-control="scan"]'), crop = get('[data-control="crop"]');
  get('.field-map-file').textContent = `${doc.folderName ? doc.folderName + ' / ' : ''}${doc.fileName}`;
  for (const [key, p] of Object.entries(MAPPING_PROFILES)) {
    const option = document.createElement('option'); option.value = key; option.textContent = p.label;
    option.disabled = images.length < p.minimumPages; profile.append(option);
  }
  profile.value = draft?.profileId || '';
  const pages = get('[data-control="page"]');
  images.forEach((p, i) => { const o = document.createElement('option'); o.value = String(i + 1); o.textContent = `Halaman ${i + 1}`; pages.append(o); });
  for (const f of MAPPING_FIELDS) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary';
    button.textContent = f.label; button.dataset.field = f.key;
    button.onclick = () => { selected = f.key; refresh(); };
    get('.field-map-fields').append(button);
  }
  const status = text => { get('.field-map-status').textContent = text; };
  const close = () => dialog.close();
  get('[data-action="close"]').onclick = close; get('[data-action="cancel"]').onclick = close;
  dialog.addEventListener('close', () => { loadId++; dialog.remove(); }, { once: true });

  function draw() {
    const ctx = scan.getContext('2d');
    if (!image) { scan.width = 1; scan.height = 1; crop.width = 1; crop.height = 1; return; }
    scan.width = image.naturalWidth; scan.height = image.naturalHeight;
    ctx.drawImage(image, 0, 0);
    if (!draft) { crop.width = 1; crop.height = 1; return; }
    for (const [i, f] of MAPPING_FIELDS.entries()) {
      const r = draft.fields[f.key]; if (r.page !== imagePage) continue;
      const b = cropBounds(r, scan.width, scan.height), active = selected === f.key;
      ctx.strokeStyle = active ? '#2563eb' : '#059669'; ctx.lineWidth = Math.max(2, scan.width / 450);
      ctx.fillStyle = active ? 'rgba(37,99,235,.13)' : 'rgba(5,150,105,.06)';
      ctx.fillRect(b.x,b.y,b.w,b.h); ctx.strokeRect(b.x,b.y,b.w,b.h);
      const size = Math.max(16, scan.width / 65); ctx.font = `bold ${size}px sans-serif`;
      const label = `${i + 1}. ${f.label}`; const y = b.y >= size * 1.5 ? b.y - size * 1.5 : b.y;
      ctx.fillStyle = active ? '#1d4ed8' : '#047857'; ctx.fillRect(b.x,y,Math.min(ctx.measureText(label).width + 12,scan.width-b.x),size*1.5);
      ctx.fillStyle = '#fff'; ctx.fillText(label,b.x+5,y+size);
    }
    const r = draft.fields[selected], b = cropBounds(r, image.naturalWidth, image.naturalHeight);
    crop.width = b.w; crop.height = b.h;
    crop.getContext('2d').drawImage(image,b.x,b.y,b.w,b.h,0,0,b.w,b.h);
  }
  function refresh() {
    const field = MAPPING_FIELDS.find(f => f.key === selected);
    const r = draft?.fields[selected];
    get('fieldset').disabled = !draft;
    get('[data-action="save"]').disabled = !draft;
    get('[data-action="download"]').disabled = !draft || !image;
    get('.field-map-source').textContent = draft ? MAPPING_PROFILES[draft.profileId].sources[MAPPING_FIELDS.indexOf(field)] : 'Pilih profil terlebih dahulu. Tahun atau nama file tidak menentukan profil secara otomatis.';
    get('.field-map-excel').textContent = `Pembanding Excel: ${field.excel}. Excel tidak mengisi isi scan.`;
    dialog.querySelectorAll('[data-field]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.field === selected)));
    if (r) {
      pages.value = String(r.page);
      dialog.querySelectorAll('[data-coordinate]').forEach(i => { i.value = +(r[i.dataset.coordinate] * 100).toFixed(3); });
      get('[data-control="confirmed"]').checked = r.confirmed;
      const n = MAPPING_FIELDS.filter(f => draft.fields[f.key].confirmed).length;
      status(`${n}/4 area diperiksa. ${mappingReviewed(draft) ? 'Pemetaan diperiksa; isi tulisan tetap perlu dibaca dan diverifikasi.' : 'Draf pemetaan; belum semua area diperiksa.'}`);
    }
    const page = r?.page || 1;
    if (page === imagePage && image) { draw(); return; }
    const id = ++loadId; image = null; imagePage = page; draw();
    get('fieldset').disabled = true;
    get('[data-action="download"]').disabled = true;
    const next = new Image();
    next.onload = () => { if (id !== loadId || !dialog.isConnected) return; image = next; draw(); get('fieldset').disabled = !draft; get('[data-action="download"]').disabled = !draft; };
    next.onerror = () => { if (id === loadId) status('Gambar halaman gagal dimuat. Tutup dan muat ulang PDF.'); };
    next.src = images[page - 1].dataURL;
  }
  profile.onchange = () => {
    draft = profile.value ? createMapping(profile.value, documentKey, images.length) : null;
    refresh();
    if (!draft) status('Pilih profil sebelum menyimpan pemetaan.');
  };
  function changeRegion(region) {
    try { draft = updateMappingRegion(draft, selected, region, images.length); refresh(); }
    catch (e) { refresh(); status(e.message); }
  }
  pages.onchange = () => changeRegion({ ...draft.fields[selected], page: Number(pages.value) });
  dialog.querySelectorAll('[data-coordinate]').forEach(input => input.onchange = () => {
    const r = { ...draft.fields[selected] };
    dialog.querySelectorAll('[data-coordinate]').forEach(i => { r[i.dataset.coordinate] = Number(i.value) / 100; });
    changeRegion(r);
  });
  get('[data-control="confirmed"]').onchange = e => { draft.fields[selected].confirmed = e.target.checked; refresh(); };
  const point = e => { const b = scan.getBoundingClientRect(); return { x: Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)), y: Math.max(0,Math.min(1,(e.clientY-b.top)/b.height)) }; };
  scan.onpointerdown = e => { if (!draft || !image || e.button !== 0) return; start = point(e); scan.setPointerCapture(e.pointerId); e.preventDefault(); };
  scan.onpointermove = e => {
    if (!start || !image) return;
    draw(); const end = point(e), ctx = scan.getContext('2d');
    ctx.strokeStyle = '#dc2626'; ctx.setLineDash([8,5]);
    ctx.strokeRect(Math.min(start.x,end.x)*scan.width,Math.min(start.y,end.y)*scan.height,
      Math.abs(end.x-start.x)*scan.width,Math.abs(end.y-start.y)*scan.height);
    ctx.setLineDash([]);
  };
  scan.onpointerup = e => {
    if (!start) return;
    const end = point(e), begin = start; start = null;
    const r = { page: imagePage, x: Math.min(begin.x,end.x), y: Math.min(begin.y,end.y), w: Math.abs(end.x-begin.x), h: Math.abs(end.y-begin.y) };
    if (r.w * scan.width < 2 || r.h * scan.height < 2) { status('Tarik kotak dengan lebar dan tinggi sedikitnya 2 piksel.'); return; }
    changeRegion(r);
  };
  scan.onpointercancel = () => { start = null; refresh(); };
  get('[data-action="download"]').onclick = () => {
    const a = document.createElement('a'); a.download = `${doc.fileName}-${selected}.png`; a.href = crop.toDataURL('image/png'); a.click();
  };
  get('[data-action="save"]').onclick = async () => {
    try {
      validateMapping(draft,documentKey,images.length);
      await onSave({ ...structuredClone(draft), updatedAt: new Date().toISOString() });
      close();
    } catch (e) { status(e.message); }
  };
  dialog.showModal(); refresh(); if (initialWarning) status(initialWarning);
}
