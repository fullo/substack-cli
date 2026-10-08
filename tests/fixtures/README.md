# Fixture e contratto API Substack (Fase 0)

Template da compilare durante la Fase 0 (Task 7). Ogni voce resta **NON CONFERMATO** finché non è verificata con l'utente. Non annotare mai cookie, token o valori reali: solo forme e dati anonimizzati. Le richieste di scrittura si verificano solo con ok esplicito dell'utente, oppure ispezionando la scheda Network del browser senza eseguirle.

Data di compilazione: ____-__-__

## 1. Profilo (GET, sonda)

- [x] Data verifica: 2026-10-08 — CONFERMATO (sonda di sola lettura, stato 200)
- [x] Metodo: GET — CONFERMATO
- [x] Percorso: `https://substack.com/api/v1/user/profile/self` — CONFERMATO
- [x] Corpo della richiesta: n/a per GET
- [x] Forma della risposta: oggetto con `id` (number), `name` e `handle` (string), `publicationUsers[]` (ognuno con `publication.subdomain`, `role`, `is_primary`), `primaryPublication.subdomain`, più molti altri campi (ignorati: schema passthrough) — CONFERMATO
- [x] Note: `id` è numerico come atteso da ProfileSchema; `publicationUsers` permette di mostrare a quale pubblicazione dà accesso il cookie

## 2. Elenco bozze (GET, sonda)

- [x] Data verifica: 2026-10-08 — CONFERMATO (sonda di sola lettura, stato 200)
- [x] Metodo: GET — CONFERMATO
- [x] Percorso: `https://<subdomain>.substack.com/api/v1/post_management/drafts` — CONFERMATO
- [x] Parametri query usati: offset, limit, order_by=draft_updated_at, order_direction=desc — CONFERMATO (accettati)
- [x] Corpo della richiesta: n/a per GET
- [x] Forma della risposta: `{ posts: [...], offset, limit, total, isCapped }`; ogni post ha `id` (number), `uuid`, `draft_title` (string), `title` (string|null), `audience`, `is_published`, `post_date` (string|null), `draft_updated_at`, `draft_created_at`, `draftBylines[]`, `stats`… — CONFERMATO
- [x] Note: il campo titolo delle bozze è `draft_title`, come in DraftSchema

## 3. Creazione bozza

- [x] Data verifica: 2026-10-08 — CONFERMATO (una bozza "TEST-CLI" creata dal CLI sulla pubblicazione dell'utente, mai pubblicata né inviata)
- [x] Metodo: POST — CONFERMATO
- [x] Percorso: `https://<subdomain>.substack.com/api/v1/drafts` — CONFERMATO
- [x] Corpo della richiesta (campi inviati dal client): `draft_title`, `draft_subtitle`, `draft_body` (stringa JSON del documento ProseMirror), `type: "newsletter"`, `audience: "everyone"`, `draft_bylines: [{ id, is_guest: false }]` — ACCETTATO dal server (nessun errore)
- [x] Forma della risposta: contiene `id` (number); il client costruisce l'URL di modifica `/publish/post/<id>` — CONFERMATO (id restituito; URL di modifica non aperto dal CLI)
- [x] Nomi dei nodi del corpo (vedi sezione 8) — CONFERMATO

## 4. Lettura bozza (GET)

- [x] Data verifica: 2026-10-08 — CONFERMATO (stato 200)
- [x] Metodo: GET — CONFERMATO
- [x] Percorso: `https://<subdomain>.substack.com/api/v1/drafts/<id>` — CONFERMATO
- [x] Corpo della richiesta: n/a per GET
- [x] Forma della risposta: oggetto con `id` (number), `draft_title`, `draft_subtitle` (string), `draft_body` (**stringa** JSON, da fare `JSON.parse`), `audience`, `type`, `is_published`, `post_date` (null per bozza), `postBylines[]`, `postSchedules[]`, molti altri campi — CONFERMATO. Il campo `body` (non-draft) è `null` per le bozze.
- [x] Nomi dei nodi del corpo (vedi sezione 8) — CONFERMATO

## 5. Pubblicazione (solo ispezione del browser, non eseguire)

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Metodo — NON CONFERMATO
- [ ] Percorso — NON CONFERMATO
- [ ] Corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Forma della risposta — NON CONFERMATO

## 6. Schedule / cancel schedule (solo ispezione del browser, non eseguire)

- [x] Data verifica: 2026-10-09 — schedulazione CONFERMATA su Substack reale con una bozza di prova (poi cancellata dall'utente); cancel e publish NON CONFERMATI
- [x] Schedule: metodo POST — CONFERMATO
- [x] Schedule: percorso `https://<subdomain>.substack.com/api/v1/drafts/<id>/scheduled_release` — CONFERMATO
- [x] Schedule: corpo della richiesta `{ "trigger_at": "<ISO 8601 UTC, es. 2026-10-10T19:00:00.000Z>", "post_audience": "everyone", "email_audience": "founding" }` — CONFERMATO (stato 200)
- [x] Schedule: **valori ammessi per `email_audience`**: `everyone`, `founding`, `only_paid`, `only_free` (verificati con una sonda che non può programmare nulla: data volutamente non valida). `null` e assente passano la validazione. **Rifiutati con 400 «Invalid value»**: `no_one`, `none`, `nobody`, `off`, `disabled`, `paid` — quindi **non esiste un valore «nessuna email»**, e il valore `no_one` usato finora dal client è sbagliato (il comando `article schedule` fallisce con 400, senza programmare nulla)
- [ ] Schedule: cosa significhi `email_audience: null`/assente (nessuna email? oppure «usa `should_send_email` della bozza», che per default è `true`?) — NON CONFERMATO: non va usato senza verifica, perché potrebbe inviare l'email a tutti gli iscritti
- [x] Schedule: forma della risposta: 200 con l'**intera bozza**; `postSchedules` contiene `[{ "id", "trigger_at", "post_audience", "email_audience" }]` e `is_published` resta `false`, `post_date` resta `null` — CONFERMATO
- [x] Nota: la bozza creata ha `should_send_email: true` di default
- [ ] Cancel: metodo — NON CONFERMATO
- [ ] Cancel: percorso — NON CONFERMATO
- [ ] Cancel: corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Cancel: forma della risposta — NON CONFERMATO

## 7. Creazione nota (ispezione del browser durante una pubblicazione manuale)

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Metodo — NON CONFERMATO
- [ ] Percorso — NON CONFERMATO
- [ ] Corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Forma della risposta — NON CONFERMATO

## 8. Nomi dei nodi del corpo JSON

- [x] Data verifica: 2026-10-08 — i nodi sotto sono stati inviati e poi riletti dal server: tornano **identici**
- [x] Liste puntate: `bullet_list` — CONFERMATO (annidamento incluso)
- [x] Liste numerate: `ordered_list` — CONFERMATO (senza attributo `start`)
- [x] Elemento di lista: `list_item` (contiene `paragraph`) — CONFERMATO
- [x] Titoli: `heading` con `attrs.level` — CONFERMATO (livello 2 provato)
- [x] Paragrafo e nodo testo: `paragraph`, `text` — CONFERMATO
- [x] Marks: `strong`, `em`, `code`, `link` con `attrs.href` — CONFERMATO
- [x] Blocco di codice: `code_block` con `attrs.language` — CONFERMATO
- [x] Citazione: `blockquote` (contiene `paragraph`) — CONFERMATO
- [x] Separatore: `horizontal_rule` — CONFERMATO
- [ ] `hard_break` — NON CONFERMATO (non incluso nella prova)
- [ ] Struttura delle immagini (nodo, attributi `src`/`alt`): `captionedImage`/`image2` è ancora un'ipotesi — NON CONFERMATO
- [ ] Altri nodi osservati — NON CONFERMATO
