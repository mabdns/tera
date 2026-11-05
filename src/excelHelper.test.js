import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseSpreadsheet } from './excelHelper.js';
import { evaluateRecord } from './validation.js';

function parseRows(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  return parseSpreadsheet(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

test('Excel entries never populate book data or become clean without an independent book', () => {
  const parsed = parseRows([
    ['Nomor Akta Nikah', 'Tanggal Akad Nikah', 'Nama Suami', 'Nama Istri'],
    ['17/002/I/2020', '2020-01-02', 'AHMAD FAUZI', 'SITI AMINAH']
  ]);
  assert.deepEqual(parsed.sheetNames, ['Data']);
  assert.equal(parsed.headers.length, 4);
  assert.deepEqual(parsed.mapping, { 0: 'noAkta', 1: 'tglAkad', 2: 'namaSuami', 3: 'namaIstri' });
  assert.equal(parsed.records.length, 1);
  const record = parsed.records[0];
  assert.deepEqual(record.entry, {
    noAkta: '17/002/I/2020', tglAkad: '02-01-2020',
    namaSuami: 'AHMAD FAUZI', namaIstri: 'SITI AMINAH'
  });
  assert.deepEqual(record.book, {});
  assert.notStrictEqual(record.book, record.entry);
  assert.deepEqual(record.originalEntry, record.entry);
  const result = evaluateRecord(record.book, record.entry);
  assert.equal(result.isClean, false);
  assert.equal(result.matchesCount, 0);
  assert.equal(result.overallScore, 0);
  assert.ok(result.evaluations.every(field => field.status === 'unread'));
});

test('missing columns do not fabricate act numbers, ceremony days, KUA or serial numbers', () => {
  const { records } = parseRows([
    ['Nama Suami', 'Nama Istri'],
    ['AHMAD', 'SITI']
  ]);
  const record = records[0];
  assert.deepEqual(record.entry, { namaSuami: 'AHMAD', namaIstri: 'SITI' });
  for (const key of ['noAkta', 'hariAkad', 'kuaKecamatan']) {
    assert.equal(record.entry[key], undefined);
    assert.equal(record.originalEntry[key], undefined);
  }
  assert.equal(record.noPorporasi, '');
  assert.deepEqual(record.book, {});
  const result = evaluateRecord({ ...record.entry }, record.entry);
  assert.equal(result.isClean, false);
  assert.equal(result.matchesCount, 2);
  assert.equal(result.overallScore, 50);
});

test('blank mapped cells stay blank while real day, KUA and serial values are retained', () => {
  const { records } = parseRows([
    ['Nomor Akta Nikah', 'Hari Akad', 'KUA Kecamatan', 'No Porporasi', 'Nama Suami', 'Nama Istri'],
    ['', '', '', '', 'AHMAD', 'SITI'],
    ['12/2020', 'Senin', 'KUA Sukamaju', 'SERIAL-12', 'BUDI', 'AMINAH']
  ]);
  const [blank, populated] = records;
  for (const key of ['noAkta', 'hariAkad', 'kuaKecamatan', 'noPorporasi']) {
    assert.equal(blank.entry[key], '');
    assert.equal(blank.originalEntry[key], '');
  }
  assert.equal(blank.noPorporasi, '');
  assert.equal(populated.entry.noAkta, '12/2020');
  assert.equal(populated.entry.hariAkad, 'Senin');
  assert.equal(populated.entry.kuaKecamatan, 'KUA Sukamaju');
  assert.equal(populated.noPorporasi, 'SERIAL-12');
  assert.deepEqual(populated.book, {});
});

test('originalEntry is a separate frozen snapshot unaffected by edits or other records', () => {
  const { records } = parseRows([
    ['Nama Suami', 'Nama Istri'],
    ['AHMAD', 'SITI'],
    ['BUDI', 'AMINAH']
  ]);
  const [first, second] = records;
  assert.notStrictEqual(first.entry, first.originalEntry);
  assert.equal(Object.isFrozen(first.originalEntry), true);
  first.entry.namaSuami = 'CORRECTED';
  first.book.namaIstri = 'BOOK VALUE';
  assert.deepEqual(first.originalEntry, { namaSuami: 'AHMAD', namaIstri: 'SITI' });
  assert.throws(() => { first.originalEntry.namaSuami = 'REPLACED'; }, TypeError);
  assert.throws(() => { delete first.originalEntry.namaIstri; }, TypeError);
  assert.throws(() => { first.originalEntry.noAkta = 'FABRICATED'; }, TypeError);
  assert.deepEqual(second.entry, { namaSuami: 'BUDI', namaIstri: 'AMINAH' });
  assert.deepEqual(second.book, {});
  assert.notStrictEqual(first.book, second.book);
});
