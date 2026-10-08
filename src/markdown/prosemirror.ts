import { Lexer, Tokenizer, getDefaults } from 'marked';
import type { Links, Token, Tokens } from 'marked';
import { UsageError } from '../util/errors.ts';
import { hasForbiddenChars } from '../util/text.ts';

export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}
export interface PMDoc { type: 'doc'; content: PMNode[] }

// Nomi dei nodi attesi da Substack: confermati/corretti nella Fase 0 (Task 7).
const NODE = {
  paragraph: 'paragraph',
  heading: 'heading',
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  blockquote: 'blockquote',
  codeBlock: 'code_block',
  rule: 'horizontal_rule',
  hardBreak: 'hard_break',
  image: (src: string, alt: string | null): PMNode => ({
    type: 'captionedImage',
    content: [{ type: 'image2', attrs: { src, alt } }],
  }),
};

const MAX_DEPTH = 20;
const MAX_INPUT_BYTES = 300_000;
// Budget di lavoro del tokenizer inline di marked, in caratteri esaminati (vedi GuardedTokenizer).
const INLINE_WORK_BUDGET = 3_000_000;
// Annidamento massimo di costrutti ricorsivi durante il lexing (oltre MAX_DEPTH comunque rifiutato dopo).
const MAX_LEX_DEPTH = MAX_DEPTH + 5;
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_SCHEMES = new Set(['https:']);

export function unescapeHtml(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => map[e] ?? '');
}

function safeUrl(href: string, allowed: Set<string>, what: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new UsageError(`${what} non valido (serve un URL assoluto): ${href}`);
  }
  if (!allowed.has(url.protocol)) {
    throw new UsageError(`${what} con schema non consentito (${url.protocol}): ${href}`);
  }
  return url.href;
}

function pushText(out: PMNode[], text: string, marks: PMMark[]): void {
  if (text === '') return;
  out.push(marks.length > 0 ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text });
}

function guard(depth: number): void {
  if (depth > MAX_DEPTH) throw new UsageError('Markdown troppo annidato');
}

function inline(tokens: Token[], marks: PMMark[], depth: number): PMNode[] {
  guard(depth);
  const out: PMNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape': {
        const tt = t as Tokens.Text | Tokens.Escape;
        const children = 'tokens' in tt ? tt.tokens : undefined;
        if (children && children.length > 0) out.push(...inline(children, marks, depth + 1));
        else pushText(out, unescapeHtml(tt.text), marks);
        break;
      }
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: 'strong' }], depth + 1));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: 'em' }], depth + 1));
        break;
      case 'codespan':
        pushText(out, unescapeHtml((t as Tokens.Codespan).text), [...marks, { type: 'code' }]);
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const href = safeUrl(l.href, LINK_SCHEMES, 'Link');
        out.push(...inline(l.tokens, [...marks, { type: 'link', attrs: { href } }], depth + 1));
        break;
      }
      case 'br':
        out.push({ type: NODE.hardBreak });
        break;
      case 'image':
        throw new UsageError('Immagine inline non supportata: mettila in un paragrafo a sé');
      default:
        throw new UsageError(`Markdown non supportato (inline): ${t.type}`);
    }
  }
  return out;
}

function paragraph(tokens: Token[], depth: number): PMNode | undefined {
  const meaningful = tokens.filter((t) => !(t.type === 'text' && (t as Tokens.Text).text.trim() === ''));
  if (meaningful.length === 1 && meaningful[0]!.type === 'image') {
    const img = meaningful[0] as Tokens.Image;
    return NODE.image(safeUrl(img.href, IMAGE_SCHEMES, 'Immagine'), unescapeHtml(img.text) || null);
  }
  const content = inline(tokens, [], depth + 1);
  return content.length > 0 ? { type: NODE.paragraph, content } : undefined;
}

function blocks(tokens: Token[], depth: number): PMNode[] {
  guard(depth);
  const out: PMNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        if (h.depth > 4) throw new UsageError(`Titoli supportati solo fino al livello 4 (trovato h${h.depth})`);
        const content = inline(h.tokens, [], depth + 1);
        if (content.length > 0) out.push({ type: NODE.heading, attrs: { level: h.depth }, content });
        break;
      }
      case 'paragraph':
      case 'text': {
        const tt = t as Tokens.Paragraph | Tokens.Text;
        const tokensOfBlock = ('tokens' in tt && tt.tokens ? tt.tokens : [t]) as Token[];
        const p = paragraph(tokensOfBlock, depth);
        if (p) out.push(p);
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        const items = l.items.map((it): PMNode => {
          if (it.task) throw new UsageError('Le task list non sono supportate');
          return { type: NODE.listItem, content: blocks(it.tokens, depth + 1) };
        });
        out.push({ type: l.ordered ? NODE.orderedList : NODE.bulletList, content: items });
        break;
      }
      case 'blockquote':
        out.push({ type: NODE.blockquote, content: blocks((t as Tokens.Blockquote).tokens, depth + 1) });
        break;
      case 'code': {
        const c = t as Tokens.Code;
        out.push({
          type: NODE.codeBlock,
          attrs: { language: c.lang ? c.lang : null },
          content: c.text ? [{ type: 'text', text: c.text }] : [],
        });
        break;
      }
      case 'hr':
        out.push({ type: NODE.rule });
        break;
      default:
        throw new UsageError(`Markdown non supportato: ${t.type}`);
    }
  }
  return out;
}

// Caratteri su cui la regex "inlineText" di marked fa un lookahead (autolink email) che scorre
// l'intera sequenza contigua di questi caratteri.
const EMAIL_RUN = /[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]*/y;

/**
 * Il tokenizer inline di marked 18 è quadratico su delimitatori non chiusi (`*a *a ...`,
 * `_a_a...`, `~~a ...`) e su sequenze come `!!!!` (lookahead dell'autolink email ripetuto a ogni
 * token). Questo tokenizer conta un limite superiore del lavoro svolto da quelle regex (caratteri
 * scansionati) e interrompe la conversione con UsageError quando supera INLINE_WORK_BUDGET.
 * Il conteggio è deterministico: non dipende dalla velocità della macchina.
 */
class GuardedTokenizer extends Tokenizer {
  work = 0;
  private depth = 0;

  private charge(amount: number): void {
    this.work += amount;
    if (this.work > INLINE_WORK_BUDGET) {
      throw new UsageError(
        'Markdown troppo complesso da elaborare (troppi delimitatori *, _, ~ o ! non chiusi): semplifica il testo',
      );
    }
  }

  // Costrutti che ri-tokenizzano ricorsivamente il proprio contenuto: ogni livello costa O(n),
  // quindi l'annidamento va fermato PRIMA di scendere (non dopo, quando il lavoro è già fatto).
  private nested<T>(run: () => T): T {
    if (++this.depth > MAX_LEX_DEPTH) throw new UsageError('Markdown troppo annidato');
    try {
      return run();
    } finally {
      this.depth--;
    }
  }

  override blockquote(src: string): Tokens.Blockquote | undefined {
    return this.nested(() => super.blockquote(src));
  }

  override list(src: string): Tokens.List | undefined {
    return this.nested(() => super.list(src));
  }

  override link(src: string): Tokens.Link | Tokens.Image | undefined {
    return this.nested(() => super.link(src));
  }

  override reflink(src: string, links: Links): Tokens.Link | Tokens.Image | Tokens.Text | undefined {
    return this.nested(() => super.reflink(src, links));
  }

  // Vero se marked, non trovando la chiusura, ha scansionato tutto il resto del testo: replica le
  // condizioni iniziali di Tokenizer.emStrong/del (marked 18.1.0, versione bloccata in package.json).
  private canPunctuate(prevChar: string): boolean {
    return prevChar === '' || this.rules.inline.punctuation.test(prevChar);
  }

  private emStrongScans(src: string, prevChar: string): boolean {
    const m = this.rules.inline.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return false;
    if (m[4] && this.rules.other.unicodeAlphaNumeric.test(prevChar)) return false;
    return !(m[1] || m[3]) || this.canPunctuate(prevChar);
  }

  private delScans(src: string, prevChar: string): boolean {
    const m = this.rules.inline.delLDelim.exec(src);
    if (!m) return false;
    return !m[1] || this.canPunctuate(prevChar);
  }

  override emStrong(src: string, maskedSrc: string, prevChar = ''): Tokens.Em | Tokens.Strong | undefined {
    const token = this.nested(() => super.emStrong(src, maskedSrc, prevChar));
    if (token) this.charge(token.raw.length);
    else if (this.emStrongScans(src, prevChar)) this.charge(src.length);
    return token;
  }

  override del(src: string, maskedSrc: string, prevChar = ''): Tokens.Del | undefined {
    const token = this.nested(() => super.del(src, maskedSrc, prevChar));
    if (token) this.charge(token.raw.length);
    else if (this.delScans(src, prevChar)) this.charge(src.length);
    return token;
  }

  override inlineText(src: string): Tokens.Text | undefined {
    EMAIL_RUN.lastIndex = 0;
    EMAIL_RUN.test(src);
    this.charge(EMAIL_RUN.lastIndex);
    const token = super.inlineText(src);
    if (token) this.charge(token.raw.length);
    return token;
  }
}

function lex(markdown: string): Token[] {
  const tokenizer = new GuardedTokenizer();
  return new Lexer({ ...getDefaults(), gfm: true, tokenizer }).lex(markdown);
}

export function markdownToDoc(markdown: string): PMDoc {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_INPUT_BYTES) {
    throw new UsageError('Contenuto troppo grande (max 300 KB)');
  }
  if (hasForbiddenChars(markdown)) {
    throw new UsageError('Il testo contiene caratteri di controllo o di direzione non ammessi');
  }
  let content: PMNode[];
  try {
    content = blocks(lex(markdown), 0);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    // Qualsiasi altro errore (es. RangeError da ricorsione profonda nel lexer) diventa un errore d'uso.
    throw new UsageError(`Markdown non elaborabile: ${(e as Error)?.message ?? String(e)}`);
  }
  if (content.length === 0) throw new UsageError('Contenuto vuoto');
  return { type: 'doc', content };
}
