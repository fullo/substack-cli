# Mutanti sopravvissuti: equivalenti o non osservabili

Mutation testing con Stryker (`npm run mutation`, runner a comando sui soli test unitari).
Ultima analisi completa: 2026-10-08, 1523 mutanti, punteggio totale **96.06%**
(1401 uccisi, 62 timeout, 60 sopravvissuti, 0 senza copertura). Tutti i 60 sopravvissuti sono
elencati qui: nessuno è stato escluso con `// Stryker disable`.
Dopo il red team (Task 15) le righe modificate sono state rianalizzate con `--mutate` mirato
(67 mutanti, 92.54%): i 3 nuovi sopravvissuti equivalenti sono aggiunti sotto e i numeri di riga aggiornati.

Categorie del motivo:

- **ridondante**: il mutante toglie un controllo che un altro controllo successivo ripete
  (difesa in profondità); il comportamento osservabile non cambia.
- **irraggiungibile**: il ramo mutato non può essere eseguito con i valori che arrivano lì.
- **libreria**: codice che si limita a delegare a una libreria (marked, yaml, zod, Buffer, fs);
  il mutante cambia solo un dettaglio interno della libreria senza effetti osservabili del nostro
  modulo. Per regola del progetto non si scrivono test sul comportamento delle librerie.
- **contabilità interna**: cambia di pochi caratteri il conteggio del budget di lavoro del
  tokenizer; è osservabile solo confrontando il valore esatto del contatore, che dipende da come
  marked spezza i token (un test del genere fallirebbe a ogni aggiornamento di marked senza che il
  nostro modulo cambi comportamento). Le regole del budget sono verificate a livello di
  comportamento in `tests/unit/markdown/prosemirror-details.test.ts` (input patologici rifiutati,
  testo con delimitatori intra-parola accettato) e `prosemirror-limits.test.ts`.

## src/util/clock.ts (13)

`parseInstant` valida in due strati: regex + controlli sui campi, poi `new Date(text)` deve essere
valida. V8 rifiuta da solo mese 00/13, giorno 00, minuti/secondi 60 e qualsiasi carattere prima o
dopo la data (verificato), quindi togliere questi controlli non cambia nulla.
I controlli che V8 *non* fa (31 aprile, 29 febbraio non bisestile, ora 24, offset +24:00) sono
coperti da test e i relativi mutanti sono uccisi.

| riga | mutatore | motivo |
|---|---|---|
| 11 | Regex (senza `^`) | ridondante: `new Date` rifiuta testo prima della data |
| 11 | Regex (senza `$`) | ridondante: `new Date` rifiuta testo dopo la data |
| 27 | ConditionalExpression ×5, LogicalOperator ×2 (su `month < 1`, `month > 12`, `day < 1`; `day > lastDay` resta e i suoi mutanti sono uccisi) | ridondante: V8 rifiuta mese 00/13 e giorno 00 |
| 28 | ConditionalExpression `Number(mi) > 59` → false | ridondante: V8 rifiuta minuti 60 |
| 28 | ConditionalExpression/EqualityOperator su `s !== undefined && Number(s) > 59` (3) | ridondante: V8 rifiuta secondi 60; `Number(undefined) > 59` è comunque false |

## src/markdown/frontmatter.ts (10)

| riga | mutatore | motivo |
|---|---|---|
| 31 | ConditionalExpression (`end === -1` → false) | ridondante: la riga 32 controlla di nuovo `end === -1` e lancia lo stesso errore |
| 31 | UnaryOperator (`-1` → `+1`) | ridondante: `end` non vale mai 1 (`indexOf` parte da 4); la riga 32 intercetta -1 |
| 32 | ConditionalExpression (`end === -1` → false) | ridondante: con `end === -1` `afterFence` è `undefined` e il secondo ramo lancia lo stesso errore |
| 32 | UnaryOperator (`-1` → `+1`) | come sopra |
| 32 | OptionalChaining (`afterFence?.` → `afterFence.`) | irraggiungibile: `afterFence` è `undefined` solo se `end === -1`, già cortocircuitato |
| 40 | StringLiteral (`schema: 'core'` → `''`) | libreria: yaml usa comunque lo schema core di default; nessun effetto osservabile |
| 40 | StringLiteral (`logLevel: 'error'` → `''`) | libreria: con un livello sconosciuto yaml non emette avvisi, come con `'error'`; il test verifica che non arrivino avvisi di processo |
| 47 | StringLiteral (`join('.')` → `join('')`) | irraggiungibile: lo schema del front-matter è piatto, i percorsi hanno un solo segmento |
| 51 | StringLiteral (`afterFence ?? ''`) | irraggiungibile: qui `afterFence` è sempre definito |
| 51 | Regex (`/^\n/` → `/\n/`) | ridondante: `afterFence` è `''` oppure inizia con `\n` (garantito dalla riga 32) |

## src/markdown/prosemirror.ts (19)

| riga | mutatore | motivo |
|---|---|---|
| 44 | StringLiteral (`map[e] ?? ''`) | irraggiungibile: la regex ammette solo le chiavi presenti in `map` |
| 189 | EqualityOperator (`>` → `>=` sul budget) | contabilità interna: differisce solo con lavoro esattamente pari a 3 000 000 |
| 199 | EqualityOperator (`>` → `>=` su `MAX_LEX_DEPTH`) | ridondante: a 24 o 25 livelli scatta comunque lo stesso errore "Markdown troppo annidato" (la guardia dei blocchi a 20 è più stretta) |
| 219 | BlockStatement (`reflink` vuoto) | libreria: i riferimenti sono comunque rifiutati (`def` non supportato); senza definizione marked produce lo stesso testo |
| 220 | ArrowFunction (`reflink` → undefined) | come sopra |
| 226 | ConditionalExpression, StringLiteral (`prevChar === ''`) (2) | contabilità interna: marked passa sempre `prevChar`; a inizio testo il ramo cambia solo l'addebito di una scansione |
| 231 | ConditionalExpression, BooleanLiteral (condizioni su `m[3]`) (2) | contabilità interna |
| 233 | ConditionalExpression (`!(m[1] \|\| m[3])` → true) | contabilità interna |
| 242 | StringLiteral (default `prevChar = ''` di `emStrong`) | irraggiungibile: marked passa sempre il terzo argomento |
| 244 | CallExpression (addebito dei token em/strong riusciti) | contabilità interna: addebito lineare, non cambia l'esito sugli input patologici |
| 249 | StringLiteral (default `prevChar = ''` di `del`) | irraggiungibile: come sopra |
| 251 | ConditionalExpression, CallExpression (addebito dei token `del` riusciti) (2) | contabilità interna; inoltre `del` è poi rifiutato come non supportato |
| 261 | ConditionalExpression ×2, CallExpression (addebito di `inlineText`) (3) | contabilità interna (lineare); `inlineText` è l'ultimo tokenizer e non restituisce mai `undefined` |
| 272 | StringLiteral (`Buffer.byteLength(markdown, 'utf8')` → `''`) | libreria: Buffer usa UTF-8 di default |

## src/notes/publish.ts (6)

| riga | mutatore | motivo |
|---|---|---|
| 13 | ConditionalExpression (`httpStatus !== undefined` → true) | ridondante: `undefined >= 400` è false |
| 56 | ArrayDeclaration (`stuck`, `corrupt` iniziali) (2) | irraggiungibile: entrambi vengono sovrascritti subito dopo |
| 62 | ConditionalExpression (`publishAt !== undefined` → true) | ridondante: `new Date(undefined)` è NaN e il confronto `<= now` è false |
| 63 | StringLiteral (`publishAt ?? ''`) (2) | irraggiungibile: le note scadute hanno sempre `publishAt` |

## src/notes/store.ts (3)

| riga | mutatore | motivo |
|---|---|---|
| 63 | StringLiteral (`readFile(path, 'utf8')` → `''`) | libreria: senza codifica valida si ottiene un Buffer che `JSON.parse` converte comunque in testo UTF-8 |
| 72 | StringLiteral (messaggio dell'errore interno sull'id diverso dal nome del file) | equivalente: l'errore è intercettato subito e sostituito dallo StateError "File nota corrotto" |
| 80 | ArrayDeclaration (`names` iniziale) | irraggiungibile: usato solo se la cartella manca; il valore finto non supera il filtro sui nomi |

## src/config/config.ts (1)

| riga | mutatore | motivo |
|---|---|---|
| 20 | BlockStatement (`catch { return undefined; }` → `{}`) | equivalente: un blocco vuoto restituisce comunque `undefined` |

## src/substack/client.ts (6)

| riga | mutatore | motivo |
|---|---|---|
| 31 | ConditionalExpression (`value === undefined` → false) | ridondante: la regex su `"undefined"` fallisce e il messaggio usa `value ?? ''` |
| 38 | ConditionalExpression (`!header` → false) | ridondante: `null`/`''` non passano la regex e `Date.parse` dà NaN → `undefined` |
| 51 | StringLiteral (`Buffer.byteLength(text, 'utf8')` → `''`) | libreria: Buffer usa UTF-8 di default |
| 113 | ConditionalExpression (`init.body === undefined` → false) | equivalente: `JSON.stringify(undefined)` è `undefined` |
| 130 | EqualityOperator (`>= 300` → `> 300`) | irraggiungibile: lo stato 300 è già gestito come redirect |
| 134 | StringLiteral (`?? '0'` → `''`) | equivalente: `Number('')` è 0 |

## src/generate/generate.ts (4)

| riga | mutatore | motivo |
|---|---|---|
| 32 | StringLiteral (`m[1] ?? ''`) | irraggiungibile: il gruppo è sempre definito quando la regex corrisponde |
| 73 | Regex (`^-+` → `^-`, `-+$` → `-$`) (2) | ridondante: il passo precedente riduce ogni sequenza di separatori a un solo `-` |
| 75 | Regex (`-+$` → `-$`) | ridondante: come sopra, dopo il taglio a 60 resta al più un `-` finale |

## src/generate/openai-compat.ts (1)

| riga | mutatore | motivo |
|---|---|---|
| 48 | OptionalChaining (`choices[0]?.` → `choices[0].`) | irraggiungibile: lo schema impone almeno un elemento in `choices` |
