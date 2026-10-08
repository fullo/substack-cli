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

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Metodo — NON CONFERMATO
- [ ] Percorso — NON CONFERMATO
- [ ] Corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Forma della risposta — NON CONFERMATO
- [ ] Nomi dei nodi del corpo (vedi sezione 8) — NON CONFERMATO

## 4. Lettura bozza (GET)

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Metodo — NON CONFERMATO
- [ ] Percorso — NON CONFERMATO
- [ ] Corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Forma della risposta — NON CONFERMATO
- [ ] Nomi dei nodi del corpo (vedi sezione 8) — NON CONFERMATO

## 5. Pubblicazione (solo ispezione del browser, non eseguire)

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Metodo — NON CONFERMATO
- [ ] Percorso — NON CONFERMATO
- [ ] Corpo della richiesta (anonimizzato) — NON CONFERMATO
- [ ] Forma della risposta — NON CONFERMATO

## 6. Schedule / cancel schedule (solo ispezione del browser, non eseguire)

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Schedule: metodo — NON CONFERMATO
- [ ] Schedule: percorso — NON CONFERMATO
- [ ] Schedule: corpo della richiesta (anonimizzato, formato data/ora) — NON CONFERMATO
- [ ] Schedule: forma della risposta — NON CONFERMATO
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

- [ ] Data verifica: ____-__-__ — NON CONFERMATO
- [ ] Liste puntate: `bullet_list` vs `bulletList` — NON CONFERMATO
- [ ] Liste numerate: `ordered_list` vs `orderedList` — NON CONFERMATO
- [ ] Elemento di lista: `list_item` vs `listItem` — NON CONFERMATO
- [ ] Titoli (`heading`) e attributo `level` — NON CONFERMATO
- [ ] Paragrafo e nodo testo — NON CONFERMATO
- [ ] Marks (bold/strong, italic/em, link, code) — NON CONFERMATO
- [ ] Blocco di codice — NON CONFERMATO
- [ ] Citazione (`blockquote`) — NON CONFERMATO
- [ ] Struttura delle immagini (nodo, attributi `src`/`alt`) — NON CONFERMATO
- [ ] Altri nodi osservati — NON CONFERMATO
