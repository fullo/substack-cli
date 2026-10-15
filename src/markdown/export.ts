import type { PMDoc, PMNode } from './prosemirror.ts';

/** Risultato della conversione: il Markdown e i tipi di nodo che non si sanno rappresentare. */
export interface ExportedMarkdown { markdown: string; unsupported: string[] }

const MAX_DEPTH = 30;

function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

function inlineNode(n: PMNode, unsupported: Set<string>): string {
  if (n.type === 'hard_break') return '  \n';
  if (n.type !== 'text') {
    unsupported.add(n.type);
    return '';
  }
  const marks = n.marks ?? [];
  const isCode = marks.some((m) => m.type === 'code');
  let out = isCode ? `\`${n.text ?? ''}\`` : escapeText(n.text ?? '');
  for (const m of marks) {
    if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `*${out}*`;
    else if (m.type === 'link') {
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
      // Solo gli schemi che il CLI stesso accetta in scrittura.
      if (/^(https?:|mailto:)/i.test(href)) out = `[${out}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    } else if (m.type !== 'code' && m.type !== 'textStyle') unsupported.add(`mark:${m.type}`);
  }
  return out;
}

function inline(nodes: PMNode[] | undefined, unsupported: Set<string>): string {
  return (nodes ?? []).map((n) => inlineNode(n, unsupported)).join('');
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => (l.length > 0 ? prefix + l : l)).join('\n');
}

function blocks(nodes: PMNode[] | undefined, unsupported: Set<string>, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  const parts: string[] = [];
  for (const n of nodes ?? []) {
    const md = block(n, unsupported, depth);
    if (md !== '') parts.push(md);
  }
  return parts.join('\n\n');
}

function block(n: PMNode, unsupported: Set<string>, depth: number): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content, unsupported);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(n.content, unsupported)}`;
    }
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = n.type === 'ordered_list';
      return (n.content ?? []).map((item, i) => {
        const marker = ordered ? `${i + 1}. ` : '- ';
        const body = blocks(item.content, unsupported, depth + 1);
        return marker + indent(body, ' '.repeat(marker.length)).slice(marker.length);
      }).join('\n');
    }
    case 'blockquote':
      return indent(blocks(n.content, unsupported, depth + 1), '> ').replace(/^(?!> )/gm, '>');
    case 'code_block': {
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      const lang = typeof n.attrs?.language === 'string' && /^[\w+#-]{1,30}$/.test(n.attrs.language) ? n.attrs.language : '';
      const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((m) => m.length + 1)));
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'horizontal_rule':
      return '---';
    case 'captionedImage': {
      const img = (n.content ?? []).find((c) => c.type === 'image2');
      const src = typeof img?.attrs?.src === 'string' ? img.attrs.src : '';
      if (!/^https:/i.test(src)) return '';
      const alt = typeof img?.attrs?.alt === 'string' ? img.attrs.alt.replace(/[[\]]/g, '') : '';
      return `![${alt}](${src})`;
    }
    default:
      // Embed, widget, bottoni: non hanno una forma Markdown. Si lascia un segnaposto visibile.
      unsupported.add(n.type);
      return `<!-- substack: ${n.type.replace(/[^\w-]/g, '')} non esportato -->`;
  }
}

/** Converte il documento ProseMirror di Substack in Markdown (l'inverso di markdownToDoc, per i nodi che il CLI sa scrivere). */
export function docToMarkdown(doc: PMDoc): ExportedMarkdown {
  const unsupported = new Set<string>();
  const markdown = blocks(doc.content, unsupported, 0);
  return { markdown, unsupported: [...unsupported].sort() };
}
