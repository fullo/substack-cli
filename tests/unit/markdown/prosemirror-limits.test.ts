import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tokenizer } from 'marked';
import { markdownToDoc } from '../../../src/markdown/prosemirror.ts';
import { UsageError } from '../../../src/util/errors.ts';

// Sotto mutation testing (Stryker) il codice è strumentato (ogni espressione passa da uno switch di
// mutanti, ~3x più lento qui) e girano più suite in parallelo: il budget a orologio di 2 s produrrebbe
// "uccisioni" false di ogni mutante. Lì il budget viene scalato (resta comunque ordini di grandezza sotto
// il tempo di un tokenizer quadratico senza guardie); con `npm test` resta 2000 ms. Il budget di lavoro
// deterministico (INLINE_WORK_BUDGET) è verificato senza orologio in prosemirror-details.test.ts.
const UNDER_MUTATION = '__stryker__' in globalThis;
const BUDGET_MS = UNDER_MUTATION ? 10_000 : 2000;
const SIZES = [20_000, 100_000, 290_000];

function fill(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

// Converte o rifiuta con UsageError entro il budget; qualsiasi altro errore fa fallire il test.
function convertsOrRejectsFast(input: string, label: string): void {
  const start = performance.now();
  try {
    markdownToDoc(input);
  } catch (e) {
    assert.ok(e instanceof UsageError, `${label}: errore inatteso ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < BUDGET_MS, `${label}: ${elapsed.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);
}

const FAMILIES: Record<string, string> = {
  'enfasi * non chiusa': '*a ',
  'enfasi ** non chiusa': '**a ',
  'enfasi _ intra-parola': '_a',
  'enfasi _ dopo spazio': ' _a',
  'barrato ~~ non chiuso': '~~a ',
  'parentesi quadre': '[',
  'backtick': '`',
  'immagine non chiusa': '![a](',
  'punto esclamativo': '!',
  'citazioni annidate': '> ',
  'liste numerate annidate': '1. ',
  'mix di delimitatori': '*_[`~!',
  'mix con testo': '**a __b [c `d ~e !f ',
  'mix enfasi': '*a_ ',
};

for (const [name, unit] of Object.entries(FAMILIES)) {
  test(`input patologico "${name}": converte o rifiuta entro ${BUDGET_MS} ms`, () => {
    for (const size of SIZES) convertsOrRejectsFast(fill(unit, size), `${name} @ ${size}`);
  });
}

test('run lunghissimi di delimitatori: rifiutati o convertiti in fretta', () => {
  convertsOrRejectsFast('*'.repeat(100_000) + 'a', 'run di *');
  convertsOrRejectsFast('a' + '_'.repeat(100_000), 'run di _');
  convertsOrRejectsFast('*'.repeat(50_000) + 'a' + '_'.repeat(50_000), 'run misti');
  convertsOrRejectsFast('*'.repeat(5_000) + 'a' + '*'.repeat(5_000), 'enfasi annidata profonda');
});

test('input oltre il limite in byte UTF-8 è rifiutato subito (anche se pochi caratteri)', () => {
  convertsOrRejectsFast('_a'.repeat(400_000), '_a x 400k');
  // 120k caratteri "è" = 240 KB; 160k = 320 KB in UTF-8: oltre il limite anche se < 300k caratteri.
  assert.throws(() => markdownToDoc('è'.repeat(160_000)), /troppo grande/);
});

function legitDocument(): string {
  const parts: string[] = ['# Un articolo lungo ma normale', ''];
  let i = 0;
  while (parts.join('\n').length < 100_000) {
    i++;
    parts.push(`## Sezione ${i}`, '');
    parts.push(
      `Questo è un paragrafo di prosa normale numero ${i}, con un po' di **grassetto**, del *corsivo*, ` +
        `un [link al sito](https://example.com/pagina/${i}) e un frammento di \`codice_${i}\`. ` +
        `Le persone scrivono frasi lunghe, con virgole, punti e due punti: tutto regolare. ` +
        `Ancora un po' di testo per arrivare a una lunghezza realistica, con _enfasi_ e una tilde ~ sparsa.`,
      '',
    );
    parts.push(`- punto **uno** della sezione ${i}`, `- punto *due* con \`snake_case_name\``, '');
    parts.push(`> Una citazione con [un link](https://example.org/${i}).`, '');
  }
  const underscores = Array.from({ length: 1500 }, (_, k) => `const __very_long_snake_case_name_${k}__ = __other_name__ * 2; // **`);
  parts.push('```js', ...underscores, '```', '');
  parts.push('Fine dell’articolo.');
  return parts.join('\n');
}

test('un documento legittimo grande (~100 KB + blocco di codice pieno di _ e *) viene convertito', () => {
  const md = legitDocument();
  assert.ok(md.length > 150_000, `documento di prova di ${md.length} caratteri`);
  const start = performance.now();
  const doc = markdownToDoc(md);
  const elapsed = performance.now() - start;
  assert.ok(doc.content.length > 100);
  assert.ok(doc.content.some((n) => n.type === 'code_block'));
  assert.ok(elapsed < BUDGET_MS, `${elapsed.toFixed(0)} ms`);
});

test('un paragrafo legittimo lungo con molta enfasi viene convertito', () => {
  const para = Array.from({ length: 400 }, (_, k) => `parola **forte ${k}** e *corsiva* e \`code_${k}\``).join(', ');
  const doc = markdownToDoc(para);
  assert.equal(doc.content.length, 1);
});

test('annidamento profondissimo (che farebbe traboccare lo stack di marked) è UsageError', () => {
  for (const md of ['> '.repeat(20_000) + 'x', '1. '.repeat(90_000), '*'.repeat(140_000) + 'a' + '*'.repeat(140_000)]) {
    const start = performance.now();
    assert.throws(() => markdownToDoc(md), UsageError);
    assert.ok(performance.now() - start < BUDGET_MS);
  }
});

test('un RangeError lanciato dentro marked (stack overflow) diventa UsageError "non elaborabile"', () => {
  // Le guardie di annidamento impediscono di arrivare a un vero stack overflow con input reali:
  // qui lo si simula dentro il tokenizer di marked per esercitare il catch-all di markdownToDoc.
  const original = Tokenizer.prototype.paragraph;
  Tokenizer.prototype.paragraph = function () {
    throw new RangeError('Maximum call stack size exceeded');
  };
  try {
    assert.throws(
      () => markdownToDoc('ciao'),
      (e: unknown) => e instanceof UsageError && /non elaborabile.*Maximum call stack/.test(e.message),
    );
  } finally {
    Tokenizer.prototype.paragraph = original;
  }
  assert.equal(markdownToDoc('ciao').content[0]!.type, 'paragraph');
});
