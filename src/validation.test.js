import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSimilarity, evaluateRecord, normalizeDateToStandard } from './validation.js';

const complete = {
  noAkta: '17/002/I/2020',
  tglAkad: '02-01-2020',
  namaSuami: 'AHMAD FAUZI',
  namaIstri: 'SITI AMINAH'
};
const keys = Object.keys(complete);

function assertNotClean(result, matchesCount) {
  assert.equal(result.isClean, false);
  assert.equal(result.totalFields, 4);
  assert.equal(result.evaluations.length, 4);
  assert.equal(result.matchesCount, matchesCount);
  assert.equal(result.overallScore, matchesCount * 25);
  assert.equal(result.evaluations.filter(field => field.status === 'match').length, matchesCount);
  for (const field of result.evaluations.filter(field => field.status === 'match')) {
    assert.ok(field.bookValue);
    assert.ok(field.entryValue);
  }
}

test('empty and whitespace-only strings never have positive similarity', () => {
  for (const left of ['', '  ', null, undefined]) {
    for (const right of ['', '\t', null, undefined, 'AHMAD']) {
      assert.equal(calculateSimilarity(left, right), 0);
      assert.equal(calculateSimilarity(right, left), 0);
    }
  }
  assert.equal(calculateSimilarity(' Ahmad ', 'AHMAD'), 100);
});

test('blank or absent records are unread, not clean', () => {
  for (const [book, entry] of [[{}, {}], [null, null], [undefined, undefined]]) {
    const result = evaluateRecord(book, entry);
    assertNotClean(result, 0);
    assert.equal(result.totalWarnings, 4);
    for (const field of result.evaluations) {
      assert.equal(field.status, 'unread');
      assert.equal(field.similarity, 0);
      assert.equal(field.missingBook, true);
      assert.equal(field.missingEntry, true);
    }
  }
});

test('every missing book or spreadsheet field prevents a clean result', () => {
  for (const key of keys) {
    const partial = { ...complete, [key]: ' \t ' };
    const unread = evaluateRecord(partial, complete);
    assertNotClean(unread, 3);
    assert.equal(unread.evaluations.find(field => field.key === key).status, 'unread');
    assert.equal(unread.totalWarnings, 1);

    const incomplete = evaluateRecord(complete, partial);
    assertNotClean(incomplete, 3);
    assert.equal(incomplete.evaluations.find(field => field.key === key).status, 'empty');
    assert.equal(incomplete.totalErrors, 1);

    assertNotClean(evaluateRecord(partial, partial), 3);
  }
});

test('fully unread books and entirely missing Excel values never match', () => {
  assertNotClean(evaluateRecord({}, complete), 0);
  assertNotClean(evaluateRecord(complete, {}), 0);
});

test('without a spreadsheet all fields remain pending even with populated entry data', () => {
  for (const book of [{}, complete]) {
    for (const entry of [{}, complete]) {
      const result = evaluateRecord(book, entry, false);
      assertNotClean(result, 0);
      assert.equal(result.totalWarnings, 4);
      assert.ok(result.evaluations.every(field => field.status === 'pending' && field.similarity === 0));
    }
  }
});

test('all four real matches are clean, allowing case, whitespace and date formatting', () => {
  const result = evaluateRecord(complete, {
    noAkta: ' 17/002/I/2020 ',
    tglAkad: '2020-01-02',
    namaSuami: 'ahmad fauzi',
    namaIstri: ' SITI AMINAH '
  });
  assert.equal(result.isClean, true);
  assert.equal(result.matchesCount, 4);
  assert.equal(result.overallScore, 100);
  assert.equal(result.totalErrors, 0);
  assert.equal(result.totalWarnings, 0);
  assert.deepEqual(result.crossFieldNotes, []);
  assert.ok(result.evaluations.every(field => field.status === 'match' && field.similarity === 100));
});

test('recognized title typography compares equally while retaining both original strings', () => {
  for (const [bookName, excelName] of [
    ['SITI AMINAH A MD', 'SITI AMINAH, A.Md.'],
    ['AHMAD FAUZI S H', 'AHMAD FAUZI, S.H.'],
    ['SITI AMINAH, S.Si.', 'SITI AMINAH SSI']
  ]) {
    const book = { ...complete, namaIstri: bookName };
    const entry = { ...complete, namaIstri: excelName };
    const before = JSON.stringify({ book, entry });
    const result = evaluateRecord(book, entry);
    const field = result.evaluations.find(f => f.key === 'namaIstri');
    assert.equal(field.status, 'match');
    assert.equal(field.normalization, 'academic-title-format');
    assert.equal(field.bookValue, bookName);
    assert.equal(field.entryValue, excelName);
    assert.ok(field.diff.some(d => d.type !== 'same'), 'raw differences remain available');
    assert.equal(result.matchesCount, 4);
    assert.equal(JSON.stringify({ book, entry }), before);
  }
});

test('title normalization cannot hide different names, missing titles or meaningful punctuation', () => {
  for (const [bookName, excelName] of [
    ['SITI AMINA A MD', 'SITI AMINAH, A.Md.'],
    ['SITI AMINAH', 'SITI AMINAH, A.Md.'],
    ['SITI AMINAH, S.H.', 'SITI AMINAH, S.S.'],
    ['SITI-AMINAH A MD', 'SITI AMINAH, A.Md.'],
    ["SITI MA'RIFAH A MD", 'SITI MARIFAH, A.Md.'],
    ['SITI AMINAH A MD', 'SITI AMINAH AMD'],
    ['SITI AMINAH, XYZ', 'SITI AMINAH X Y Z']
  ]) {
    const result = evaluateRecord({ ...complete, namaIstri: bookName }, { ...complete, namaIstri: excelName });
    const field = result.evaluations.find(f => f.key === 'namaIstri');
    assert.notEqual(field.status, 'match', `${bookName} / ${excelName}`);
    assert.equal(field.normalization, null);
    assertNotClean(result, 3);
  }
});

test('I versus 1 in the month segment requires review and never becomes a match', () => {
  for (const [bookNumber, excelNumber] of [['17/002/1/2020', '17/002/I/2020'], ['17/002/I/2020', '17/002/1/2020']]) {
    const result = evaluateRecord({ ...complete, noAkta: bookNumber }, { ...complete, noAkta: excelNumber });
    const field = result.evaluations.find(f => f.key === 'noAkta');
    assert.equal(field.status, 'review');
    assert.equal(field.bookValue, bookNumber);
    assert.equal(field.entryValue, excelNumber);
    assert.equal(field.severity, 'warning');
    assert.equal(result.totalErrors, 0);
    assert.equal(result.totalWarnings, 1);
    assertNotClean(result, 3);
  }
});

test('other act number differences remain mismatches rather than I/1 review', () => {
  for (const other of ['18/002/1/2020', '17/003/1/2020', '17/002/1/2021', '17/002/2/2020', '17/002/II/2020']) {
    const result = evaluateRecord(complete, { ...complete, noAkta: other });
    assert.equal(result.evaluations[0].status, 'mismatch', other);
    assert.equal(result.totalErrors, 1);
    assertNotClean(result, 3);
  }
});

test('only names receive typo warnings; differing act numbers and dates are mismatches', () => {
  const changes = {
    noAkta: '17/002/I/2021',
    tglAkad: '03-01-2020',
    namaSuami: 'AHMAD FAUZA',
    namaIstri: 'SITI AMINA'
  };
  for (const key of keys) {
    const result = evaluateRecord(complete, { ...complete, [key]: changes[key] });
    assertNotClean(result, 3);
    const field = result.evaluations.find(field => field.key === key);
    const isName = key.startsWith('nama');
    assert.equal(field.status, isName ? 'typo' : 'mismatch');
    assert.equal(result.totalWarnings, isName ? 1 : 0);
    assert.equal(result.totalErrors, isName ? 0 : 1);
  }
  const result = evaluateRecord(complete, { ...complete, namaSuami: 'BUDI' });
  assertNotClean(result, 3);
  assert.equal(result.evaluations.find(field => field.key === 'namaSuami').status, 'mismatch');
});

function evaluateDates(bookDate, entryDate) {
  return evaluateRecord({ ...complete, tglAkad: bookDate }, { ...complete, tglAkad: entryDate });
}

test('identical impossible or unparseable dates are format errors, never matches', () => {
  const invalidDates = [
    '31-02-2020', '2020-02-31', '31-04-2020',
    '29-02-2023', '29-02-1900', '29-02-2100', '29-02-23',
    '00-01-2020', '01-00-2020', '01-13-2020', '32-01-2020', '01-01-0000',
    'not a date', '2 Januari 2020', '2020', '02-01-202',
    '2020-01-02 trailing', '2020-01-02-03', '02/01-2020'
  ];
  for (const date of invalidDates) {
    const result = evaluateDates(date, date);
    assertNotClean(result, 3);
    const field = result.evaluations.find(field => field.key === 'tglAkad');
    assert.equal(field.status, 'format_error', date);
    assert.equal(field.severity, 'danger', date);
    assert.equal(field.similarity, 0, date);
    assert.equal(result.totalErrors, 1, date);
    assert.equal(result.totalWarnings, 0, date);
  }
});

test('an invalid date on either side is a format error, including normalized impossible pairs', () => {
  for (const [bookDate, entryDate] of [
    ['31-02-2020', '2020-02-31'],
    ['29-02-2023', '2024-02-29'],
    ['2024-02-29', '29-02-2023'],
    ['not a date', '02-01-2020'],
    ['02-01-2020', 'not a date']
  ]) {
    const result = evaluateDates(bookDate, entryDate);
    assertNotClean(result, 3);
    assert.equal(result.evaluations.find(field => field.key === 'tglAkad').status, 'format_error');
    assert.equal(result.totalErrors, 1);
  }
});

test('valid leap years, numeric date formats and existing two-digit year pivot still match', () => {
  for (const [bookDate, entryDate] of [
    ['29-02-2024', '2024-02-29'],
    ['29-02-2000', '2000-02-29'],
    ['29-02-24', '2024-02-29'],
    ['2-1-2020', '2020-1-2'],
    ['02/01/2020', '2020/01/02'],
    ['02.01.20', '2020.01.02'],
    [' 02-01-2020 ', ' 2020-01-02 '],
    ['31-12-99', '1999-12-31'],
    ['01-01-40', '2040-01-01'],
    ['01-01-41', '1941-01-01']
  ]) {
    const result = evaluateDates(bookDate, entryDate);
    assert.equal(result.isClean, true, `${bookDate} / ${entryDate}`);
    assert.equal(result.matchesCount, 4);
    assert.equal(result.overallScore, 100);
    assert.equal(result.totalErrors, 0);
    assert.equal(result.evaluations.find(field => field.key === 'tglAkad').status, 'match');
  }
});

test('different valid calendar dates remain mismatches rather than typos or format errors', () => {
  for (const [bookDate, entryDate] of [
    ['28-02-2024', '2024-02-29'],
    ['02-01-2020', '2020-02-01'],
    ['01-01-40', '1940-01-01']
  ]) {
    const result = evaluateDates(bookDate, entryDate);
    assertNotClean(result, 3);
    assert.equal(result.totalErrors, 1);
    assert.equal(result.totalWarnings, 0);
    assert.equal(result.evaluations.find(field => field.key === 'tglAkad').status, 'mismatch');
  }
});

test('public date normalization retains its existing permissive output', () => {
  assert.equal(normalizeDateToStandard('2020-02-31'), '31-02-2020');
  assert.equal(normalizeDateToStandard('not a date'), 'notadate');
  assert.equal(normalizeDateToStandard('2/1/20'), '02-01-2020');
});
