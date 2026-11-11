import test from 'node:test';
import assert from 'node:assert/strict';
import { MAPPING_FIELDS, createMapping, validateMapping, updateMappingRegion,
  mappingReviewed, cropBounds, mappingDocumentKey } from './fieldMapping.js';

test('A.1 maps four fields on one spread; N requires the actual spouse page', () => {
  const a = createMapping('model-a1','doc',1);
  assert.equal(Object.keys(a.fields).length,4);
  assert.ok(MAPPING_FIELDS.every(f=>a.fields[f.key].page===1));
  assert.equal(mappingReviewed(a),false);
  assert.throws(()=>createMapping('model-n','doc',1),/jumlah halaman/);
  const n = createMapping('model-n','doc',3);
  assert.equal(n.fields.noAkta.page,1);
  assert.ok(['tglAkad','namaSuami','namaIstri'].every(k=>n.fields[k].page===2));
  assert.throws(()=>createMapping('1983','doc',1),/Pilih profil/);
  assert.throws(()=>createMapping('toString','doc',1),/Pilih profil/);
});

test('editing a box resets its confirmation without changing other fields or its prior mapping', () => {
  const a = createMapping('model-a1','doc',1);
  for (const r of Object.values(a.fields)) r.confirmed=true;
  assert.equal(mappingReviewed(a),true);
  const b = updateMappingRegion(a,'namaSuami',{...a.fields.namaSuami,x:.3},1);
  assert.equal(mappingReviewed(b),false);
  assert.equal(a.fields.namaSuami.confirmed,true);
  assert.deepEqual(b.fields.namaIstri,a.fields.namaIstri);
  assert.throws(()=>updateMappingRegion(a,'entry.namaSuami',{},1),/tidak dikenal/);
});

test('invalid, missing, nonfinite, out-of-page and cross-document areas cannot be saved', () => {
  const a = createMapping('model-a1','doc',1);
  for (const patch of [{x:-.1},{y:1},{w:0},{h:-1},{x:.9,w:.2},{page:2},{page:1.1},
    {x:NaN},{y:Infinity},{w:'0.3'},{confirmed:'true'}]) {
    const bad=structuredClone(a);Object.assign(bad.fields.noAkta,patch);
    assert.throws(()=>validateMapping(bad,'doc',1),undefined,JSON.stringify(patch));
  }
  const missing=structuredClone(a);delete missing.fields.namaIstri;
  assert.throws(()=>validateMapping(missing,'doc',1));
  assert.throws(()=>validateMapping(a,'another-book',1),/tidak cocok/);
});

test('crops retain all selected pixels at different raster sizes and stay inside the image', () => {
  const r={x:.1,y:.2,w:.3,h:.4};
  assert.deepEqual(cropBounds(r,1000,500),{x:100,y:100,w:300,h:200});
  assert.deepEqual(cropBounds(r,2000,1000),{x:200,y:200,w:600,h:400});
  assert.deepEqual(cropBounds({x:.999,y:.999,w:.001,h:.001},1000,1000),{x:999,y:999,w:1,h:1});
  assert.deepEqual(cropBounds({x:0,y:0,w:1e-12,h:1e-12},1000,1000),{x:0,y:0,w:1,h:1});
  assert.throws(()=>cropBounds({...r,w:2},100,100));
});

test('same filename cannot reuse areas from different PDF content or book folders; reload preserves binding', async () => {
  const doc=(folderName,bytes)=>({folderName,fileName:'1.pdf',file:new Blob([bytes])});
  const original=await mappingDocumentKey(doc('Buku 1983','one'));
  assert.equal(original,await mappingDocumentKey(doc('Buku 1983','one')));
  assert.notEqual(original,await mappingDocumentKey(doc('Buku 1990','one')));
  assert.notEqual(original,await mappingDocumentKey(doc('Buku 1983','two')));
  assert.notEqual(await mappingDocumentKey({...doc('Buku','one'),folderPath:'Buku/1983/1.pdf'}),
    await mappingDocumentKey({...doc('Buku','one'),folderPath:'Buku/1990/1.pdf'}));
  const m=createMapping('model-a1',original,1);
  assert.deepEqual(validateMapping(JSON.parse(JSON.stringify(m)),original,1),m);
  await assert.rejects(mappingDocumentKey({fileName:'1.pdf'}),/asli belum tersedia/);
});
