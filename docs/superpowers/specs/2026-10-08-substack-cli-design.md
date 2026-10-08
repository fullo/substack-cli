# Substack CLI — Design

Data: 2026-10-08 · Stato: bozza per revisione

## 1. Obiettivo

Un CLI in TypeScript per gestire una newsletter Substack da un device o una VM dedicati (anche in k3s):

- generare articoli e note con un LLM (opzionale, provider intercambiabili, anche locali come llama.cpp);
- creare **bozze online** di articoli a partire da Markdown;
- gestire **note** tramite una coda locale (Substack non ha bozze lato server per le note);
- pubblicare e schedulare articoli e note, con salvaguardie contro pubblicazioni accidentali.

Il percorso di default **non genera nulla**: il testo arriva da file o stdin (ad esempio scritto da Claude Code, che usa il CLI come strumento). La generazione integrata è un modulo opzionale.

## 2. Vincoli di progetto

| Vincolo | Decisione |
|---|---|
| Dipendenze di runtime | **Minime, solo standard di mercato solidi, niente micro-dipendenze.** Tre pacchetti, tutti senza dipendenze transitive: `marked` (lexer Markdown), `yaml` (front-matter), `zod` (validazione delle risposte API e della config). Versioni esatte nel `package-lock.json`. Tutto il resto è nativo: `fetch`, `node:util` `parseArgs`, `node:test`, `node:fs`, `node:crypto`. Retry/backoff, scritture atomiche, lock file, redazione dei segreti e prompt nascosto si scrivono a mano (poche righe ciascuno). Nessun SDK dei provider LLM: una chiamata `fetch` per provider. |
| Regola per nuove dipendenze | Si aggiunge una libreria solo se sostituisce codice complesso o rischioso (parsing, crittografia, date con fusi), è uno standard diffuso, manutenuta e senza dipendenze transitive. Mai per risparmiare poche righe. |
| Dipendenze di sviluppo | Solo `typescript`, `@types/node` e `@stryker-mutator/core` (con il runner a comando). Nessun framework di test: si usa `node:test`. |
| Linguaggio | TypeScript "vanilla": `tsc` compila in `dist/` (ESM, `strict`, `noUncheckedIndexedAccess`). Nessun bundler, nessun transpiler esterno. |
| Runtime | Node.js 22 LTS o superiore. |
| Playwright | **Non** è una dipendenza. Il login di fallback lo importa dinamicamente solo se è installato a parte sul PC dell'utente; altrimenti il comando spiega come installarlo. Non è presente nell'immagine Docker. |
| API Substack | Interne e non documentate. Tutto il codice che le conosce sta in `src/substack/`. |
| Qualità | Test unitari, funzionali (end-to-end del CLI contro server finti) e di mutazione. Fase finale di red team. |

## 3. Struttura

```
src/
  cli/          entrypoint, routing dei comandi (sottile), formattazione output, exit code
  config/       caricamento config.json + variabili d'ambiente, validazione con zod
  auth/         store del cookie (file 0600 / env), auth check, guida, login Playwright opzionale
  substack/     SubstackClient (HTTP, retry, errori tipizzati) + schemi zod delle risposte
  markdown/     token di `marked` → documento ProseMirror; front-matter (`yaml`)
  notes/        coda locale su file, macchina a stati, run-due
  generate/     interfaccia Provider, anthropic.ts, openai-compat.ts
  util/         fs atomico, lock file, redazione segreti, tempo
tests/
  unit/         per modulo
  functional/   CLI reale (processo figlio) contro server HTTP finti
  fixtures/     risposte Substack registrate (anonimizzate)
deploy/
  Dockerfile
  k3s/          Secret, ConfigMap, PVC, CronJob, Job di esempio, toolbox
  systemd/      substack-notes.service + .timer
```

Confini:

- Solo `substack/` fa richieste a Substack. L'URL base è configurabile (`SUBSTACK_BASE_URL`) per poter testare contro un server finto.
- `generate/` produce solo testo Markdown e non conosce Substack. `substack/` non conosce nessun LLM.
- `cli/` orchestra: nessuna logica di dominio nei comandi.

## 4. Comandi

```
substack auth guide                 tutorial passo passo per ottenere il cookie
substack auth set                   salva il cookie (prompt nascosto o stdin)
substack auth check                 verifica la sessione; exit 2 se scaduta
substack auth login                 login via Playwright (opzionale, interattivo)

substack article draft <file|->     crea una bozza online da Markdown
substack article list               elenca le bozze/articoli
substack article publish <id>       pubblica una bozza esistente
substack article schedule <id> --at <data> | --cancel

substack note add <testo|file|->    aggiunge una nota alla coda locale (draft)
substack note list [--status ...]
substack note schedule <id> --at <data>
substack note publish <id>
substack note resolve <id> --published | --retry   risolve una nota rimasta in `publishing`
substack notes run-due              pubblica le note schedulate scadute (per cron/timer)

substack generate article --topic ... [--provider ...] [--draft]
substack generate note --topic ... [--provider ...]

substack config init | show
```

Opzioni comuni: `--dry-run` (su tutto ciò che scrive), `--json` (output leggibile da macchina), `--config <path>`.

### Salvaguardie di pubblicazione

- `article publish` mostra un riepilogo (titolo, sezione, destinatari) e chiede conferma. In modalità non interattiva funziona **solo con `--yes`**; senza, esce con errore.
- Di default **non invia l'email** agli iscritti; serve `--send-email`.
- `article schedule` usa la schedulazione **nativa di Substack** (lato server); `--cancel` la annulla.
- `generate` non pubblica né schedula mai. Con `--draft` crea solo una bozza.
- Le date di schedulazione devono essere nel futuro e in ISO 8601 con offset esplicito o `Z` (es. `2026-10-09T09:00:00+02:00`); senza offset il comando fallisce. L'orario locale con fuso IANA configurato è rimandato oltre la v1.

## 5. Flusso dei dati

1. **Articolo:** Markdown con front-matter (`title`, `subtitle`, `tags`, `section`) da file/stdin → parser → documento ProseMirror → `createDraft()` → stampa id e URL di modifica.
2. **Generazione:** `generate article` chiama il provider, ottiene Markdown con front-matter, lo salva in `drafts/` (rivedibile) e, solo con `--draft`, prosegue come al punto 1.
3. **Nota:** `note add` scrive un file JSON in `data/notes/<id>.json` con stato `draft`. `schedule` → `scheduled` con `publishAt`. `publish`/`run-due` → `publishing` → `published` (con id Substack) o `failed`.

### Macchina a stati delle note

```
draft ──schedule──▶ scheduled ──(run-due | publish)──▶ publishing ──ok──▶ published
  ▲                     │                                   │
  └──────unschedule─────┘                                   └─errore definitivo─▶ failed
```

- La transizione a `publishing` è scritta su disco **prima** della chiamata HTTP, con scrittura atomica (file temporaneo + rename) e lock file per evitare esecuzioni concorrenti.
- Se il processo cade con una nota in `publishing`, `run-due` **non la ripubblica**: la segnala e richiede un intervento (`note list --status publishing`, poi `note resolve <id> --published|--retry`). Meglio una nota non pubblicata che una duplicata.

## 6. Autenticazione

- Metodo principale: cookie `substack.sid` fornito dall'utente. Sorgenti, in ordine di precedenza: `SUBSTACK_SID`, file segreti `0600` in `~/.config/substack-cli/secrets.json`.
- `auth guide` stampa il tutorial (apri substack.com, login, strumenti sviluppatore → Application → Cookies → copia `substack.sid`, `auth set`, controllo automatico con `auth check`). Include la variante per SSH/senza accesso al filesystem e quella per k3s (aggiornamento del Secret).
- Fallback `auth login`: Playwright interattivo sul PC dell'utente; il cookie risultante si trasferisce con `auth set`.
- Il cookie e le chiavi API non compaiono mai in output, log, messaggi di errore o file di dati: una funzione di redazione centrale è applicata a ogni messaggio in uscita.

## 7. Client Substack

`SubstackClient` espone: `getProfile()`, `createDraft()`, `listDrafts()`, `publishDraft()`, `scheduleDraft()`, `cancelSchedule()`, `postNote()`.

- **Endpoint da verificare** (Fase 0, vedi §11): candidati noti `POST /api/v1/drafts`, `PUT /api/v1/drafts/{id}`, `GET /api/v1/post_management/drafts`, `POST /api/v1/drafts/{id}/publish`, `POST /api/v1/drafts/{id}/scheduled_release`, `POST /api/v1/comment/feed` (note). Nulla viene dato per certo finché non è confermato con richieste di sola lettura e fixture.
- Ogni risposta è validata da uno schema zod; se non corrisponde, `ApiShapeError` indica endpoint e campo (dai path degli issue di zod).
- Retry con backoff esponenziale (max 3) **solo** su operazioni idempotenti (GET, annullamento). Le creazioni e le pubblicazioni non si ritentano alla cieca.
- Timeout su ogni richiesta (`AbortSignal.timeout`), User-Agent esplicito, rispetto di `Retry-After`.

### Errori e exit code

| Errore | Causa | Exit |
|---|---|---|
| `UsageError` | argomenti non validi | 64 |
| `AuthError` | 401/403, cookie scaduto o assente | 2 |
| `ApiShapeError` | risposta inattesa (API cambiata) | 3 |
| `RateLimitError` / `NetworkError` | 429, rete, timeout | 4 |
| `ProviderError` | errore dell'LLM (non tocca mai lo stato Substack) | 5 |
| `StateError` | stato locale incoerente (es. nota in `publishing`) | 6 |

## 8. Convertitore Markdown

Sottoinsieme supportato: titoli (h1–h4), paragrafi, **grassetto**, *corsivo*, `codice`, blocchi di codice, link, liste puntate e numerate (anche annidate), citazioni, separatori `---`, immagini da URL remoto. Il front-matter è YAML letto con `yaml` e validato con uno schema zod (`title` obbligatorio, `subtitle`, `tags`, `section` opzionali).

- Il parsing Markdown è delegato a `marked.lexer()` (token annidati); il codice nostro è un **mapper token → nodi ProseMirror** che costituisce il vero oggetto di test e di mutazione. I token non supportati (HTML grezzo, tabelle, ecc.) producono errore esplicito.
- Sicurezza: i link ammettono solo schemi `http`, `https`, `mailto`; gli altri (es. `javascript:`) vengono rifiutati. Le immagini ammettono solo `https`. Nessun HTML grezzo: viene trattato come testo.
- Input non supportato → errore esplicito con riga e colonna, mai perdita silenziosa di contenuto.

## 9. Generazione (opzionale)

```ts
interface Provider {
  generate(req: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}
```

- `anthropic`: chiamata HTTP diretta all'API Messages con `fetch`, chiave da `ANTHROPIC_API_KEY`.
- `openai-compat`: `POST {baseUrl}/v1/chat/completions`. Copre llama.cpp (`llama-server`), Ollama, vLLM, LM Studio. `apiKey` opzionale.
- Il testo generato è **dato non fidato**: passa dallo stesso parser sicuro del §8 e non può mai attivare pubblicazioni.

## 10. Deploy

- **Build:** `npm run build` (`tsc`) → `dist/`. Il CLI è `dist/cli/main.js` con shebang, esposto come `substack` nel `bin`.
- **Dockerfile** multi-stage: stage di build con `tsc`; immagine finale `node:22-alpine` con `dist/` e solo le 3 dipendenze di runtime (`npm ci --omit=dev --ignore-scripts`), utente non root, `ENTRYPOINT ["substack"]`.
- **k3s** (`deploy/k3s/`): `Secret` (`SUBSTACK_SID`, opzionale `ANTHROPIC_API_KEY`), `ConfigMap` (config.json), `PVC` local-path per i dati, `CronJob` ogni minuto con `concurrencyPolicy: Forbid` per `notes run-due`, `Job` di esempio per `auth check`, pod "toolbox" opzionale per `kubectl exec`. Rinnovo del cookie: `kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -`.
- **systemd:** `substack-notes.service` + `.timer` (ogni minuto); in alternativa una riga cron.

## 11. Strategia di test e qualità

**Fase 0 — Scoperta API (prima di scrivere il client):** con il cookie dell'utente, solo richieste di **lettura** per confermare forma di profilo e bozze; le forme di scrittura (creazione bozza, nota, pubblicazione) si confermano su una bozza/nota di prova che l'utente approva. Le risposte, anonimizzate, diventano fixture.

**Unitari** (`node:test`): mapper Markdown → ProseMirror e front-matter, schemi di risposta, macchina a stati e coda note (scritture atomiche, lock), redazione segreti, parsing date/fusi, config. Un test per ogni regola di sicurezza (schemi di link, `--yes`, `--send-email`).

**Funzionali:** il CLI compilato viene eseguito come processo figlio contro:
- un **server Substack finto** (`node:http`) che riproduce le fixture, incluse risposte di errore (401, 429, forma errata, timeout);
- un **server LLM finto** compatibile OpenAI.

Scenari: setup auth → `auth check`; Markdown → bozza; list; publish con e senza `--yes`; schedule/cancel; nota draft → schedule → `run-due` con orologio controllato (variabile `SUBSTACK_NOW` solo in test); crash simulato durante `publishing`; cookie scaduto con exit code 2; `--dry-run` senza effetti.

**Mutazione:** Stryker con runner a comando che esegue `node --test` sul codice compilato. Obiettivo: **mutation score ≥ 80%** sui moduli `markdown/`, `notes/`, `config/`, `util/` e sui validatori/retry di `substack/`; i sopravvissuti vengono analizzati (test mancante o mutante equivalente documentato). La soglia è un gate in CI.

**Copertura:** misurata con `node --test --experimental-test-coverage`, come indicatore (non sostituisce la mutazione).

## 12. Red team (dopo l'implementazione)

Revisione avversaria dedicata, con un elenco di attacchi da tentare davvero e di test di regressione per ogni problema trovato:

- **Segreti:** il cookie/chiave API finisce in log, errori, `--json`, `config show`, file di dati, variabili nel pod? Permessi dei file (`0600`)?
- **Input ostili:** Markdown con `javascript:`, HTML, URL immagine verso reti interne (SSRF), front-matter malevolo, file giganti, caratteri di controllo/Unicode ingannevoli, path traversal negli id/nei percorsi (`../`).
- **Prompt injection:** testo generato o contenuto di file che tenta di indurre pubblicazione, cambio di destinatari o esfiltrazione.
- **Concorrenza e stato:** doppia esecuzione di `run-due`, crash a metà scrittura, orologio che salta, file di coda corrotti o modificati a mano.
- **Rete:** risposte di Substack/LLM malformate, enormi o lente; redirect verso host diversi; `baseUrl` ostile.
- **Salvaguardie:** aggirare `--yes` o `--send-email`, pubblicare da una pipeline non interattiva senza volerlo.
- **Fuzzing** del parser Markdown e del front-matter (proprietà: nessun crash, nessun output con schemi vietati, nessuna perdita silenziosa).
- **Container/k3s:** utente non root, filesystem root in sola lettura dove possibile, nessun segreto nell'immagine.
- **Supply chain:** versioni esatte e lockfile, `npm ci --ignore-scripts`, `npm audit`, verifica che le 3 dipendenze non abbiano dipendenze transitive e che non ne vengano aggiunte senza motivo (controllo in CI sull'albero di `package-lock.json`).

Esito: un report con i problemi trovati, correzioni e test di regressione, prima di considerare la v1 completa.

## 13. Fuori dalla v1

Orario locale con fuso IANA (`--at "2026-10-09 09:00"`), upload di immagini locali, note con immagini/allegati, più pubblicazioni o profili, statistiche e iscritti, interfaccia web, daemon residente.

## 14. Rischi

- Le API interne di Substack possono cambiare senza preavviso → isolamento in un modulo, validatori, errori chiari, fixture da aggiornare.
- L'automazione può violare i termini d'uso di Substack: l'uso è a rischio dell'utente, con pubblicazione sempre esplicita.
- Il cookie scade: guida dedicata ed errore con exit code 2 per renderlo visibile in cron/k3s.
