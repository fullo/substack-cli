import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, isImageUrl, parseImageUrl, readImageFile, sniffImage, toDataUri } from '../../../src/util/image.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('sniffImage riconosce i formati dai primi byte', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(GIF), 'image/gif');
  assert.equal(sniffImage(Buffer.from('GIF87a', 'latin1')), 'image/gif');
  assert.equal(sniffImage(WEBP), 'image/webp');
});

test('sniffImage rifiuta formati non supportati o troncati', () => {
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), undefined);
  assert.equal(sniffImage(Buffer.from('GIF88a', 'latin1')), undefined);
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVE')), undefined);
  assert.equal(sniffImage(PNG.subarray(0, 7)), undefined);
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});

test('readImageFile: legge un PNG e lo converte in data URI', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'copertina.png');
    await writeFile(p, PNG);
    const img = await readImageFile(p);
    assert.equal(img.mime, 'image/png');
    assert.equal(toDataUri(img), `data:image/png;base64,${PNG.toString('base64')}`);
  });
});

test('readImageFile: il formato viene dai byte, non dall\'estensione', async () => {
  await withTmpDir(async (dir) => {
    const finto = join(dir, 'finta.png');
    await writeFile(finto, '%PDF-1.7 non un\'immagine');
    await assert.rejects(readImageFile(finto), (e: Error) => e instanceof UsageError && /non supportato|Unsupported/.test(e.message));
    const vero = join(dir, 'senza-estensione');
    await writeFile(vero, JPEG);
    assert.equal((await readImageFile(vero)).mime, 'image/jpeg');
  });
});

test('readImageFile: file mancante, cartella, vuoto o troppo grande → UsageError', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(readImageFile(join(dir, 'manca.png')), UsageError);
    await assert.rejects(readImageFile(dir), UsageError);
    const vuoto = join(dir, 'vuoto.png');
    await writeFile(vuoto, '');
    await assert.rejects(readImageFile(vuoto), (e: Error) => e instanceof UsageError && /vuoto|Empty/.test(e.message));
    const grande = join(dir, 'grande.png');
    await writeFile(grande, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await assert.rejects(readImageFile(grande), (e: Error) => e instanceof UsageError && /10 MB/.test(e.message));
  });
});

test('readImageFile: esattamente al limite è accettato', async () => {
  await withTmpDir(async (dir) => {
    const p = join(dir, 'limite.png');
    await writeFile(p, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]));
    assert.equal((await readImageFile(p)).bytes.length, MAX_IMAGE_BYTES);
  });
});

test('parseImageUrl: solo https senza credenziali', () => {
  assert.equal(parseImageUrl('https://substack-post-media.s3.amazonaws.com/public/images/a.png'),
    'https://substack-post-media.s3.amazonaws.com/public/images/a.png');
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'https://user:pw@example.com/a.png',
    'https://user@example.com/a.png', 'file:///etc/passwd', 'non un url', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => parseImageUrl(bad), UsageError, bad);
  }
});

test('isImageUrl: solo il prefisso https:// indica un URL', () => {
  assert.equal(isImageUrl('https://example.com/a.png'), true);
  assert.equal(isImageUrl('HTTPS://example.com/a.png'), true);
  assert.equal(isImageUrl('http://example.com/a.png'), false);
  assert.equal(isImageUrl('./https:/a.png'), false);
  assert.equal(isImageUrl('copertina.png'), false);
});
