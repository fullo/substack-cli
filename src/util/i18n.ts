// Lingua dei messaggi del CLI. L'inglese è il default; l'italiano si attiva con "lang": "it"
// in config.json oppure con SUBSTACK_LANG=it (che ha la precedenza). La lingua viene fissata
// all'inizio di ogni comando dal router, prima che qualsiasi messaggio venga costruito.

export const LANGS = ['en', 'it'] as const;
export type Lang = (typeof LANGS)[number];

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Sceglie il testo nella lingua attiva. Le due versioni stanno affiancate nel punto d'uso. */
export function t(en: string, it: string): string {
  return current === 'it' ? it : en;
}
