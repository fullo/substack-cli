// Caratteri non ammessi nel testo pubblicato: controlli C0 (tranne tab, a capo e CR), DEL e controlli C1
// (U+0080-009F, es. CSI U+009B), soft hyphen (U+00AD), segni/override/isolati di direzione (U+061C,
// U+200E/F, U+202A-202E, U+2066-2069), caratteri invisibili di formato (U+180E, U+200B-200D, U+2060-2064),
// separatori di riga/paragrafo (U+2028/2029), BOM (U+FEFF), annotazioni interlineari (U+FFF9-FFFB) e
// caratteri tag Unicode (U+E0000-E007F, testo invisibile). Il flag u serve per i tag (fuori dal BMP).
export const FORBIDDEN_TEXT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;

export function hasForbiddenChars(text: string): boolean {
  return FORBIDDEN_TEXT_CHARS.test(text);
}

// Caratteri che un terminale interpreta (ESC, BEL, CR, backspace, controlli C1 come CSI U+009B) o che
// alterano la direzione/visibilità del testo. Tab e a capo restano.
const TERMINAL_UNSAFE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Rende visibili come `\uXXXX` i caratteri pericolosi per il terminale. Testo non fidato (titoli dal
 * server, front-matter, output di un LLM) non può così inviare sequenze di escape. Su output JSON
 * il risultato resta JSON valido e con lo stesso valore: questi caratteri vi compaiono solo
 * dentro le stringhe, dove `\uXXXX` è un escape ammesso.
 */
export function escapeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Testo su una sola riga (titoli, sottotitoli): niente caratteri vietati e niente tab/a capo.
export function isSafeSingleLine(text: string): boolean {
  return !hasForbiddenChars(text) && !/[\t\r\n]/.test(text);
}
