import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc } from '../../src/markdown/prosemirror.ts';
import { NoteStore } from '../../src/notes/store.ts';
import { loadConfig } from '../../src/config/config.ts';
import { normalizeSid } from '../../src/auth/store.ts';
import { SubstackClient } from '../../src/substack/client.ts';
import { CliError, UsageError } from '../../src/util/errors.ts';
import { json, makeFetch } from '../helpers/fetch.ts';
import { withTmpDir } from '../helpers/tmp.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.sig';

const BAD_LINKS = [
  '[x](javascript:alert(1))', '[x](  javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](java\tscript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox(1))', '[x](file:///etc/passwd)',
  '[x](//evil.example/a)', '[x](\\\\evil\\share)', '[x][ref]\n\n[ref]: javascript:alert(1)',
  '<a href="javascript:alert(1)">x</a>', '![x](javascript:alert(1))', '![x](http://169.254.169.254/latest/meta-data)',
  '[x](<javascript:alert(1)>)', '[x](&#106;avascript:alert(1))', '<javascript:alert(1)>', '![x](data:image/png;base64,AAAA)',
];

test('nessun link/immagine pericoloso supera il convertitore', () => {
  for (const md of BAD_LINKS) {
    let doc: unknown;
    try {
      doc = markdownToDoc(md);
    } catch (e) {
      assert.ok(e instanceof UsageError, `${md} → eccezione non tipizzata: ${e}`);
      continue;
    }
    const text = JSON.stringify(doc);
    assert.ok(!/javascript:|data:|vbscript:|file:|169\.254|evil\.example|"href"|"src"/i.test(text), `${md} → ${text}`);
  }
});

test('un id di nota non può uscire dalla cartella delle note', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const now = new Date('2026-10-08T10:00:00Z');
    for (const id of ['../../etc/passwd', '..%2f..%2fx', 'a/../../b', '\u0000', 'C:\\x', '../aaaaaaaaaaaa', 'aaaaaaaaaaaa/..', 'AAAAAAAAAAAA']) {
      await assert.rejects(store.get(id), UsageError, JSON.stringify(id));
      await assert.rejects(store.schedule(id, new Date('2999-01-01T00:00:00Z'), now), UsageError);
      await assert.rejects(store.beginPublish(id), UsageError);
      await assert.rejects(store.resolve(id, 'published', now), UsageError);
    }
  });
});

test('SUBSTACK_BASE_URL ostile viene rifiutato (il cookie non parte verso host arbitrari)', async () => {
  await withTmpDir(async (dir) => {
    for (const url of [
      'http://evil.example', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example',
      'https://u:p@evil.example@localhost', 'http://u:p@localhost:8080', 'https://evil.example',
      'https://substack.com.evil.example', 'https://evilsubstack.com', 'https://evil.example#.substack.com',
      'https://evil.example?x=.substack.com', 'http://substack.com', 'http://x.substack.com',
      'ftp://substack.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://substack.com.', 'http://0.0.0.0',
    ]) {
      const env = { SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_BASE_URL: url };
      await assert.rejects(loadConfig(env), UsageError, url);
    }
    for (const url of ['https://substack.com', 'https://pub.substack.com', 'http://127.0.0.1:9', 'http://localhost', 'http://[::1]:8080']) {
      await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_BASE_URL: url });
    }
  });
});

test('cookie con CRLF o separatori non può iniettare header', () => {
  for (const bad of ['abc\r\nX-Evil: 1xxxxxxxxxx', 'abcdefghijklmnop; admin=1', 'abcdefghijklmnop\nxx', 'abcdefghijklmnop,x=1', 'abcdefghijklmnop x', 'abcdefghijklmnop"x']) {
    assert.throws(() => normalizeSid(bad), UsageError, JSON.stringify(bad));
  }
});

test('risposta con redirect verso altro host non viene seguita', async () => {
  const calls: string[] = [];
  const c = new SubstackClient({
    sid: SID, publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch((call) => {
      calls.push(call.url);
      assert.equal(call.init.redirect, 'manual');
      return new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } });
    }),
    sleep: async () => {},
  });
  await assert.rejects(c.getProfile(), CliError);
  await assert.rejects(c.postNote({ type: 'doc', content: [] }), CliError);
  assert.ok(calls.length > 0 && calls.every((u) => !u.includes('evil.example')));
});

test('risposta JSON ostile (prototype pollution, enorme, non JSON) non rompe il client', async () => {
  const c = new SubstackClient({
    sid: SID, publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch(() => new Response('{"id":1,"__proto__":{"polluted":true},"constructor":{"x":1}}', { status: 200 })),
  });
  const p = await c.getProfile();
  assert.equal(p.id, 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const c2 = new SubstackClient({
    sid: SID, publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch(() => json({ id: 1, huge: 'x'.repeat(1_000_000) })),
  });
  await c2.getProfile();
  for (const body of ['x'.repeat(6_000_000), '<html>login</html>', '[]', 'null', '{"id":"1"}']) {
    const c3 = new SubstackClient({
      sid: SID, publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
      fetchImpl: makeFetch(() => new Response(body, { status: 200 })),
    });
    await assert.rejects(c3.getProfile(), CliError, body.slice(0, 20));
  }
});
