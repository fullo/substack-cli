// Caratteri non ammessi nel testo pubblicato: controlli C0 (tranne tab, a capo e CR), DEL,
// segni/override/isolati di direzione (U+061C, U+200E/F, U+202A-202E, U+2066-2069),
// caratteri a larghezza zero (U+200B-200D), separatori di riga/paragrafo (U+2028/2029) e BOM (U+FEFF).
export const FORBIDDEN_TEXT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

export function hasForbiddenChars(text: string): boolean {
  return FORBIDDEN_TEXT_CHARS.test(text);
}

// Testo su una sola riga (titoli, sottotitoli): niente caratteri vietati e niente tab/a capo.
export function isSafeSingleLine(text: string): boolean {
  return !hasForbiddenChars(text) && !/[\t\r\n]/.test(text);
}
