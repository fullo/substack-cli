import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../src/cli/router.ts';
import { testContext } from '../../helpers/context.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const BASE_ENV = { SUBSTACK_SID: 's%3AunitTestCookie1234567890.sig', SUBSTACK_BASE_URL: 'http://127.0.0.1:9', SUBSTACK_PUBLICATION: 'p',
  SUBSTACK_CLI_CONFIG_DIR: 'Z:/inesistente/substack-cli-test' };

function setup(answer: string, lang?: 'it') {
  const calls: Call[] = [];
  const questions: string[] = [];
  const fetchImpl = makeFetch(() => json({ id: 7, draft_title: 'Il mio pezzo' }), calls);
  const env = lang ? { ...BASE_ENV, SUBSTACK_LANG: lang } : BASE_ENV;
  const ctx = testContext({ env, isInteractive: true, fetchImpl, prompt: async (q) => { questions.push(q); return answer; } });
  return { ctx, calls, questions };
}

const published = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/publish')).length;

test('conferma di pubblicazione: la parola segue la lingua attiva (publish / pubblica)', async () => {
  const en = setup('publish');
  assert.equal(await run(['article', 'publish', '7'], en.ctx), 0, en.ctx.stderr.join('\n'));
  assert.match(en.questions[0]!, /^Type "publish" to confirm: $/);
  assert.equal(published(en.calls), 1);

  const it = setup('pubblica', 'it');
  assert.equal(await run(['article', 'publish', '7'], it.ctx), 0, it.ctx.stderr.join('\n'));
  assert.match(it.questions[0]!, /^Scrivi "pubblica" per confermare: $/);
  assert.equal(published(it.calls), 1);
});

test('conferma di pubblicazione: la parola dell\'altra lingua non vale e non pubblica', async () => {
  const en = setup('pubblica');
  assert.equal(await run(['article', 'publish', '7'], en.ctx), 64);
  assert.match(en.ctx.stderr.join('\n'), /Publishing cancelled/);
  assert.equal(published(en.calls), 0);

  const it = setup('publish', 'it');
  assert.equal(await run(['article', 'publish', '7'], it.ctx), 64);
  assert.match(it.ctx.stderr.join('\n'), /Pubblicazione annullata/);
  assert.equal(published(it.calls), 0);
});

test('conferme di schedulazione e aggiornamento in italiano: programma / aggiorna', async () => {
  const sch = setup('programma', 'it');
  assert.equal(await run(['article', 'schedule', '7', '--at', '2999-01-01T00:00:00Z'], sch.ctx), 0, sch.ctx.stderr.join('\n'));
  assert.match(sch.questions[0]!, /"programma"/);
  assert.match(sch.ctx.stderr.join('\n'), /email agli iscritti: no/);

  const upd = setup('aggiorna', 'it');
  assert.equal(await run(['article', 'update', '7', '--title', 'Il mio pezzo', '--subtitle', 'Nuovo'], upd.ctx), 3);
  // Il server finto non applica il sottotitolo: la verifica dopo il PUT lo segnala, in italiano.
  assert.match(upd.questions[0]!, /"aggiorna"/);
  assert.match(upd.ctx.stderr.join('\n'), /non risulta aggiornata \(sottotitolo\)/);
});
