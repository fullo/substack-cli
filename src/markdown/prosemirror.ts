import { marked } from 'marked';
import type { Token, Tokens } from 'marked';
import { UsageError } from '../util/errors.ts';

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
const MAX_INPUT = 1_000_000;
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_SCHEMES = new Set(['https:']);
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

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

export function markdownToDoc(markdown: string): PMDoc {
  if (markdown.length > MAX_INPUT) throw new UsageError('Contenuto troppo grande (max 1 MB)');
  if (FORBIDDEN_CHARS.test(markdown)) {
    throw new UsageError('Il testo contiene caratteri di controllo o di direzione non ammessi');
  }
  let content: PMNode[];
  try {
    content = blocks(marked.lexer(markdown, { gfm: true }), 0);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    // Qualsiasi altro errore (es. RangeError da ricorsione profonda nel lexer) diventa un errore d'uso.
    throw new UsageError(`Markdown non elaborabile: ${(e as Error)?.message ?? String(e)}`);
  }
  if (content.length === 0) throw new UsageError('Contenuto vuoto');
  return { type: 'doc', content };
}
