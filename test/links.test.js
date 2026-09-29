'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDriveLink, parseManyLinks } = require('../src/main/links');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

test('file links', () => {
  assert.deepEqual(parseDriveLink(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), { id: ID, resourceKey: null, kind: 'file' });
  assert.equal(parseDriveLink(`https://drive.google.com/file/u/1/d/${ID}/view`).id, ID);
  assert.equal(parseDriveLink(`https://drive.google.com/open?id=${ID}`).id, ID);
  assert.equal(parseDriveLink(`https://drive.google.com/uc?id=${ID}&export=download`).id, ID);
  assert.equal(parseDriveLink(`https://drive.usercontent.google.com/download?id=${ID}&export=download`).id, ID);
  assert.equal(parseDriveLink(`drive.google.com/file/d/${ID}`).id, ID);
});

test('folder links with resource key', () => {
  const r = parseDriveLink(`https://drive.google.com/drive/folders/${ID}?resourcekey=0-abc&usp=sharing`);
  assert.deepEqual(r, { id: ID, resourceKey: '0-abc', kind: 'folder' });
  assert.equal(parseDriveLink(`https://drive.google.com/drive/u/0/folders/${ID}`).kind, 'folder');
  assert.equal(parseDriveLink(`https://drive.google.com/drive/mobile/folders/${ID}`).kind, 'folder');
});

test('docs editors links', () => {
  assert.equal(parseDriveLink(`https://docs.google.com/document/d/${ID}/edit`).kind, 'document');
  assert.equal(parseDriveLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`).kind, 'spreadsheet');
  assert.equal(parseDriveLink(`https://docs.google.com/presentation/d/${ID}/edit`).kind, 'presentation');
});

test('bare id and rejects', () => {
  assert.deepEqual(parseDriveLink(ID), { id: ID, resourceKey: null, kind: 'unknown' });
  assert.equal(parseDriveLink('https://example.com/file/d/abcdefghijklmnop'), null);
  assert.equal(parseDriveLink('hello'), null);
  assert.equal(parseDriveLink(''), null);
});

test('many links, de-duplicated', () => {
  const blob = `https://drive.google.com/file/d/${ID}/view\n https://drive.google.com/drive/folders/${ID}X ,https://drive.google.com/open?id=${ID}`;
  const out = parseManyLinks(blob);
  assert.equal(out.length, 2);
  assert.equal(out[1].kind, 'folder');
});
