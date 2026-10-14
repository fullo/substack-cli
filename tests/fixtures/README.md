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

- [x] Data verifica: 2026-10-14, con `image upload` e `article draft - --cover <url>` su una bozza di prova mai pubblicata
- [x] Caricamento: metodo POST, percorso `https://<subdomain>.substack.com/api/v1/image`, corpo JSON `{ "image": "data:<mime>;base64,..." }` — CONFERMATO (PNG da 1,28 MB accettato, non serve il form-urlencoded)
- [x] Caricamento: forma della risposta, oggetto con `url` https, nella forma `https://substack-post-media.s3.amazonaws.com/public/images/<uuid>_<larghezza>x<altezza>.<ext>` — CONFERMATO
- [x] Copertina: `PUT https://<subdomain>.substack.com/api/v1/drafts/<id>` con `{ "cover_image": "<url>" }`, aggiornamento parziale come per `draft_title` — CONFERMATO
- [x] Copertina: la rilettura della bozza (`GET /api/v1/drafts/<id>`) riporta `cover_image` uguale all'URL inviato — CONFERMATO
- [x] Copertina visibile nell'editor web, nelle impostazioni del post — CONFERMATO. Non compare nel corpo del post: Substack la usa per l'elenco dei post, l'anteprima dell'email e le condivisioni. Chi la vuole anche nel testo la inserisce come immagine nel Markdown
- [ ] `article update <id> --cover`: stesso `PUT`, non ancora provato dal comando `update`

Procedura (solo con ok esplicito dell'utente, su una bozza di prova mai pubblicata):

1. `substack image upload prova.png --json`: il caricamento non pubblica nulla e non è visibile agli iscritti.
2. `substack article update <id-prova> --cover <url> --dry-run`, poi senza `--dry-run`; controllo nell'editor web.
3. `substack article draft prova.md --cover prova.png`, poi cancellare la bozza dall'editor web.
