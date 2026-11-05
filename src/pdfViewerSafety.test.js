import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Exercise the real parser without PDF.js or browser initialization.
const source = await readFile(new URL('./pdfViewer.js', import.meta.url), 'utf8');
const parserSource = source.slice(
  source.indexOf('export function parseKUAFieldsFromText'),
  source.indexOf('export async function loadPDFFolder')
);
const { parseKUAFieldsFromText } = await import(`data:text/javascript;base64,${Buffer.from(parserSource).toString('base64')}`);
const dateFrom = text => parseKUAFieldsFromText(text).tglAkad ?? '';
const modelN = 'Pada hari ini SABTU tanggal 05 bulan NOVEMBER tahun 2016 Masehi';

for (const [description, text, expected] of [
  ['birth date cannot override explicit akad date', 'Tanggal lahir: 10 Januari 1990\nTanggal Akad Nikah: 05-11-2016', '05-11-2016'],
  ['month dictionary order does not choose January birth date', 'Tanggal lahir: 10 Januari 1990\nTanggal Nikah: 05 November 2016', '05-11-2016'],
  ['month dictionary order does not choose January marriage date from unrelated text', 'Tanggal lahir: 10 November 1990\nTanggal Nikah: 05 Januari 2016', '05-01-2016'],
  ['same-line birth field is bounded', 'Tanggal Akad: 05-11-2016 Tanggal lahir: 10 Januari 1990', '05-11-2016'],
  ['historical numeric marriage date', 'Tanggal Akad Nikah: 09-07-1983', '09-07-1983'],
  ['historical named marriage date', 'Tanggal Perkawinan: 9 Juli 1983', '09-07-1983'],
  ['historical ISO marriage date', 'Tgl. Nikah: 1983-07-09', '09-07-1983'],
  ['weekday before explicit value', 'Tanggal Akad Nikah: Sabtu, 05 November 2016', '05-11-2016'],
  ['value immediately on next line', 'Tanggal Akad Nikah:\n05-11-2016', '05-11-2016'],
  ['explicit structured date', 'Tanggal Akad: tanggal 05 bulan November tahun 2016 Masehi', '05-11-2016'],
  ['waktu akad label', 'Waktu akad nikah dilangsungkan: 09/07/1983', '09-07-1983'],
  ['valid leap day', 'Tanggal Nikah: 29-02-2000', '29-02-2000'],
  ['valid historical leap day', 'Tanggal Nikah: 29 Februari 1984', '29-02-1984'],
  ['explicit field agrees with registration header', modelN + '\nTanggal Akad Nikah: 05-11-2016', '05-11-2016'],
  ['explicit marriage field beats examination formula', 'Pemeriksaan nikah: ' + modelN + '\nTanggal Akad Nikah: 06-11-2016', '06-11-2016'],
  ['duplicate agreeing labels', 'Tanggal Nikah: 05-11-2016\nTanggal Akad: 5 November 2016', '05-11-2016'],
  ['Model N Gregorian header', modelN, '05-11-2016'],
  ['birth field after Model N does not contaminate header', modelN + '\nTanggal lahir: 10 Januari 1990', '05-11-2016'],
  ['birth field before Model N does not contaminate header', 'Tanggal lahir: 10 Januari 1990\n' + modelN, '05-11-2016'],
  ['multiline Model N header', 'Pada hari ini SABTU\ntanggal 05 bulan NOVEMBER\ntahun 2016 Masehi', '05-11-2016'],
  ['historical Model N header', 'Pada hari ini SABTU tanggal 09 bulan JULI tahun 1983 Masehi', '09-07-1983'],
  ['Model N Gregorian followed by Hijri', modelN + ' bertepatan dengan tanggal 05 bulan SAFAR tahun 1438 Hijriyah', '05-11-2016'],
  ['Model N Hijri followed by Gregorian', 'Pada hari ini SABTU tanggal 05 bulan SAFAR tahun 1438 Hijriyah bertepatan dengan tanggal 05 bulan NOVEMBER tahun 2016 Masehi', '05-11-2016'],
  ['explicit Gregorian and Hijri pair', 'Tanggal Nikah: 05 November 2016 Masehi bertepatan dengan 05 Safar 1438 Hijriyah', '05-11-2016']
]) {
  test(description, () => assert.equal(dateFrom(text), expected));
}

for (const [description, text] of [
  ['birth date only', 'Tanggal lahir: 10 Januari 1990'],
  ['unlabelled numeric date', '05-11-2016'],
  ['unlabelled named date', '05 November 2016'],
  ['generic pada tanggal', 'Pada tanggal 05 November 2016'],
  ['document date is not marriage date', 'Tanggal Dokumen: 05-11-2016'],
  ['examination date', 'Tanggal pemeriksaan nikah: 05 November 2016'],
  ['birth date beneath a marriage heading is insufficient', 'AKTA NIKAH\nTanggal lahir: 10 Januari 1990'],
  ['month proximity cannot assemble a date', 'Akad nikah\nNomor 05\nNovember\nTahun cetak 2016'],
  ['missing marriage value cannot borrow next birth field', 'Tanggal Akad Nikah:\nTanggal lahir: 10 Januari 1990'],
  ['blank line cannot be jumped', 'Tanggal Akad Nikah:\n\n05-11-2016'],
  ['invalid day', 'Tanggal Akad Nikah: 32-11-2016'],
  ['invalid month', 'Tanggal Akad Nikah: 05-13-2016'],
  ['zero day', 'Tanggal Akad Nikah: 00-11-2016'],
  ['zero month', 'Tanggal Akad Nikah: 05-00-2016'],
  ['November has thirty days', 'Tanggal Akad Nikah: 31 November 2016'],
  ['nonleap February', 'Tanggal Akad Nikah: 29-02-1983'],
  ['century leap rule', 'Tanggal Akad Nikah: 29-02-1900'],
  ['invalid ISO date', 'Tanggal Akad Nikah: 1983-02-30'],
  ['unknown month is not repaired', 'Tanggal Akad Nikah: 05 Nowember 2016'],
  ['two-digit year is not guessed', 'Tanggal Akad Nikah: 05-11-16'],
  ['US month-first date is not swapped', 'Tanggal Akad Nikah: 11/23/1983'],
  ['mixed numeric separators', 'Tanggal Akad Nikah: 05/11-2016'],
  ['conflicting marriage labels', 'Tanggal Nikah: 05-11-2016\nTanggal Akad: 06-11-2016'],
  ['explicit marriage field conflicts with Model N header', modelN + '\nTanggal Akad Nikah: 06-11-2016'],
  ['alternative values within a field', 'Tanggal Nikah: 05-11-2016 atau 06-11-2016'],
  ['semicolon cannot hide a conflicting date', 'Tanggal Nikah: 05-11-2016; 06-11-2016'],
  ['invalid explicit value cannot fall back to header', 'Tanggal Akad: 31-11-2016\n' + modelN],
  ['invalid Model N calendar date', 'Pada hari ini SABTU tanggal 31 bulan NOVEMBER tahun 2016 Masehi'],
  ['Model N requires a calendar marker', 'Pada hari ini SABTU tanggal 05 bulan NOVEMBER tahun 2016'],
  ['Hijri-only header is not converted', 'Pada hari ini SABTU tanggal 05 bulan SAFAR tahun 1438 Hijriyah'],
  ['Hijri-only field cannot borrow nearby Gregorian year', 'Tanggal Nikah: 05 Safar 1438 Hijriyah\nTahun cetak: 2016'],
  ['examination header before formula', 'Pemeriksaan nikah: ' + modelN],
  ['examination heading on preceding line', 'PEMERIKSAAN NIKAH\n' + modelN],
  ['examination header after formula', modelN + ' telah dilakukan pemeriksaan nikah'],
  ['birth narrative after formula', modelN + ' telah dilahirkan seorang anak'],
  ['conflicting Model N headers', modelN + '\nPada hari ini MINGGU tanggal 06 bulan NOVEMBER tahun 2016 Masehi'],
  ['alternative date after Model N header', modelN + ' atau tanggal 06 bulan November tahun 2016 Masehi'],
  ['two conflicting Gregorian dates in one header', modelN + ' bertepatan dengan tanggal 06 bulan November tahun 2016 Masehi'],
  ['incomplete paired header date is ambiguous', modelN + ' bertepatan dengan tanggal 06 bulan November tahun 2016']
]) {
  test(`leaves empty: ${description}`, () => assert.equal(dateFrom(text), ''));
}

test('date safety leaves existing Akta and spouse extraction intact', () => {
  const fields = parseKUAFieldsFromText(
    'Nomor Akta 23/004/I/2020\nTanggal lahir: 10 Januari 1990\nTanggal Akad 02-01-2020\nNama Suami: AHMAD bin HASAN\nNama Istri: SITI binti HASAN',
    '1.pdf'
  );
  assert.deepEqual(fields, {
    noAkta: '23/004/I/2020', tglAkad: '02-01-2020',
    namaSuami: 'AHMAD bin HASAN', namaIstri: 'SITI binti HASAN'
  });
});
