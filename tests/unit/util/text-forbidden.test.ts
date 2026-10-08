// Caratteri invisibili o di controllo aggiunti dalla revisione di sicurezza: controlli C1, soft hyphen,
// invisibili di formato (U+2060-2064, U+180E), annotazioni interlineari (U+FFF9-FFFB) e tag Unicode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasForbiddenChars, isSafeSingleLine } from '../../../src/util/text.ts';
import { markdownToDoc } from '../../../src/markdown/prosemirror.ts';
import { parseArticle } from '../../../src/markdown/frontmatter.ts';
import { NoteStore } from '../../../src/notes/store.ts';
import { runDue } from '../../../src/notes/publish.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const ch = (cp: number) => String.fromCodePoint(cp);

const NEW_FORBIDDEN = [0x80, 0x85, 0x9b, 0x9f, 0xad, 0x180e, 0x2060, 0x2062, 0x2064, 0xfff9, 0xfffb,
  0xe0000, 0xe0001, 0xe0041, 0xe007f];
const NEIGHBOURS_ALLOWED = [0xa0, 0xac, 0xae, 0x180d, 0x180f, 0x205f, 0x2065, 0xfff8, 0xfffc, 0xdffff, 0xe0080,
  0x1f600, 0x10000, 0xe8];

test('caratteri vietati estesi: C1, U+00AD, U+180E, U+2060-2064, U+FFF9-FFFB, tag U+E0000-E007F', () => {
  for (const cp of NEW_FORBIDDEN) assert.equal(hasForbiddenChars(`a${ch(cp)}b`), true, cp.toString(16));
  for (const cp of NEIGHBOURS_ALLOWED) assert.equal(hasForbiddenChars(`a${ch(cp)}b`), false, cp.toString(16));
  // Un surrogato isolato di un tag non va confuso con il carattere intero (flag u).
  assert.equal(hasForbiddenChars('a\udb40b'), false);
  assert.equal(hasForbiddenChars('riga\n\tindentata\r\n'), false);
});

test('markdownToDoc rifiuta C1 (CSI U+009B) e tag Unicode', () => {
  for (const text of ['a\u009bb', 'a\u{E0041}', 'x\u00ady', 'x\u2061y', 'x\ufffay']) {
    assert.throws(() => markdownToDoc(text), UsageError, JSON.stringify(text));
  }
  assert.equal(markdownToDoc('emoji \u{1F600} ok').content.length, 1);
});

test('titoli e sottotitoli con i nuovi caratteri vietati sono rifiutati', () => {
  assert.equal(isSafeSingleLine('a\u009bb'), false);
  assert.equal(isSafeSingleLine('a\u{E0041}'), false);
  assert.throws(() => parseArticle('---\ntitle: "a\\u009bb"\n---\n'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: T\nsubtitle: "x\\U000E0041"\n---\n'), UsageError);
});

test('nota modificata a mano con caratteri vietati: segnalata come corrotta e mai pubblicata', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('pulita', new Date('2026-10-08T10:00:00Z'));
    await store.schedule(n.id, new Date('2026-10-08T11:00:00Z'), new Date('2026-10-08T10:00:00Z'));
    const raw = JSON.parse(JSON.stringify(await store.get(n.id))) as Record<string, unknown>;
    raw.text = 'testo \u{E0041}\u009b nascosto';
    await writeFile(join(dir, `${n.id}.json`), JSON.stringify(raw));
    const listed = await store.list();
    assert.deepEqual(listed.notes, []);
    assert.deepEqual(listed.corrupt, [`${n.id}.json`]);
    let calls = 0;
    const r = await runDue(store, async () => { calls++; return { id: 'x' }; }, new Date('2026-10-08T12:00:00Z'));
    assert.equal(calls, 0);
    assert.deepEqual(r.corrupt, [`${n.id}.json`]);
  });
});
