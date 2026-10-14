# Immagini e copertina — Design

Data: 2026-10-14 · Stato: bozza per revisione

## 1. Obiettivo

Permettere a chi usa il CLI (anche da script, ad esempio la pipeline della newsletter Sustainable ITC) di:

- caricare un'immagine locale sul CDN di Substack e ottenerne l'URL;
- impostare la copertina di una bozza (l'immagine usata nell'anteprima del post e nella condivisione social), partendo da un file locale o da un URL già caricato;
- farlo anche in fase di creazione della bozza, con un solo comando.

Oggi il CLI accetta immagini solo come URL `https` in un paragrafo a sé del Markdown, non carica file e non imposta la copertina.

## 2. Fuori ambito

- Caricamento automatico delle immagini locali citate nel Markdown (`![alt](./grafico.png)`): passo successivo, che riusa `uploadImage`.
- Didascalie e attributi avanzati delle immagini nel corpo.
- Modifica della copertina di post già pubblicati.

## 3. Endpoint (candidati, NON CONFERMATI)

| Operazione | Metodo e percorso | Corpo | Risposta attesa |
|---|---|---|---|
| Caricamento immagine | `POST https://<subdomain>.substack.com/api/v1/image` | `{ "image": "data:<mime>;base64,<dati>" }` | oggetto con `url` (`https://...`) |
| Copertina della bozza | `PUT https://<subdomain>.substack.com/api/v1/drafts/<id>` | `{ "cover_image": "<url>" }` | 2xx; la rilettura della bozza riporta `cover_image` uguale all'URL inviato |

Il caricamento è quello usato dalle librerie non ufficiali esistenti (dove però il corpo è inviato come form-urlencoded: se il JSON viene rifiutato, è la prima variante da provare). Il campo `cover_image` della bozza va verificato. Il `PUT` parziale su `/api/v1/drafts/<id>` è già confermato per `draft_title` (tests/fixtures/README.md, sezione 9).

Verifica (Fase 0, sezione 10 del README delle fixture), solo con ok esplicito dell'utente:

1. `substack image upload prova.png` su un'immagine qualsiasi: il caricamento non pubblica nulla e non è visibile agli iscritti.
2. `substack article update <id-bozza-di-prova> --cover <url> --dry-run`, poi senza `--dry-run`, su una bozza di prova mai pubblicata; controllo nell'editor web.

Finché la verifica non è fatta, il codice tratta le risposte con schemi permissivi (`passthrough`) e rilegge la bozza dopo l'aggiornamento: se `cover_image` non risulta impostata esce con codice 3 (API cambiata), senza ritentare.

## 4. Comandi

### `substack image upload <file> [--dry-run] [--json]`

- Accetta PNG, JPEG, GIF e WebP, riconosciuti dai primi byte del file (non dall'estensione).
- Dimensione massima 10 MB (il corpo in base64 cresce di circa un terzo).
- `--dry-run` valida il file senza richieste di rete.
- Output: l'URL (con `--json`: `{ url, bytes, mime }`).
- Non idempotente lato server (ogni chiamata crea un nuovo file), quindi nessun retry automatico: un errore di rete va ripetuto a mano.

### `substack article update <id> --cover <file|url>`

- Un argomento che inizia con `https://` è un URL; qualsiasi altro valore è un file locale, caricato prima dell'aggiornamento.
- Si combina con `--title`, `--subtitle`, `--file`; compare nel riepilogo (`copertina: impostata (<origine>)`) ed è soggetto alla stessa conferma (`update`/`aggiorna`) o a `--yes`.
- Con `--dry-run` il file viene validato ma non caricato.
- URL non `https` o con credenziali → errore di uso (exit 64), prima di qualsiasi richiesta.
- Dopo l'aggiornamento la bozza viene riletta e confrontata.

### `substack article draft <file|-> --cover <file|url>`

- L'immagine viene caricata **prima** di creare la bozza: se il caricamento fallisce non resta una bozza orfana.
- Poi bozza creata e copertina impostata con un `PUT`. Se il `PUT` fallisce la bozza esiste già: il messaggio di errore riporta id e URL di modifica, così si può ripetere solo `article update <id> --cover <url>`.

## 5. Sicurezza

- Il file viene letto solo se è un file regolare, entro il limite di dimensione; il contenuto non compare mai nei log.
- Il cookie continua a essere inviato solo a `publicationUrl`/`globalUrl`; l'URL restituito dal caricamento viene validato (`https`, nessuna credenziale) prima di essere inviato a Substack come copertina.
- Nessuna dipendenza nuova: base64 e riconoscimento del formato con `Buffer`.

## 6. Test

- Unitari sul client: corpo della richiesta (data URI, content-type JSON), validazione della risposta, nessun retry sul `POST`, `cover_image` nel `PUT`.
- Unitari sul riconoscimento del formato e sui limiti (file vuoto, troppo grande, formato non supportato, estensione ingannevole).
- Funzionali contro il server finto: `image upload`, `article update --cover` con file e con URL, `article draft --cover` incluso il caso di `PUT` fallito, gating non interattivo, `--dry-run` senza richieste.
