# substack-cli

CLI in Node/TypeScript per scrivere e pubblicare su Substack da terminale: bozze di articoli da file Markdown, pubblicazione e schedulazione, coda locale di note con pubblicazione programmata, generazione di testi con un LLM (Anthropic oppure un server compatibile OpenAI come llama.cpp). Dipendenze di runtime: solo `marked`, `yaml`, `zod`.

## 1. Cos'è e avvertenze

- **Le API di Substack usate qui sono interne e non documentate.** Possono cambiare senza preavviso; l'uso è a tuo rischio e pericolo e potrebbe violare i termini del servizio. Quando una risposta non ha più la forma attesa il CLI esce con codice 3 (vedi "Risoluzione problemi").
- Un articolo **non viene mai pubblicato senza `--yes`** (o conferma interattiva). L'email ai iscritti parte **solo con `--send-email`**.
- Il cookie di sessione `substack.sid` equivale a una password: non committarlo, non incollarlo in chat o log.

## 2. Requisiti e installazione

Node.js >= 22.18 (esegue direttamente i file `.ts` in sviluppo; il build produce JavaScript).

```bash
npm ci
npm run build
npm i -g .          # installa il comando `substack`
substack help
```

## 3. Configurazione

I file stanno in `~/.config/substack-cli` (config e segreti) e `~/.local/share/substack-cli` (note, bozze generate). Si possono spostare con `SUBSTACK_CLI_CONFIG_DIR` e `SUBSTACK_CLI_DATA_DIR`.

```bash
substack config init --publication miapubblicazione
# oppure con un LLM locale:
substack config init --publication miapubblicazione \
  --provider openai-compat --llm-base-url http://localhost:8080 --model locale
substack config show        # configurazione effettiva, senza segreti
```

`--publication` è il sottodominio (la parte prima di `.substack.com`). `config init` non sovrascrive un file esistente senza `--force`.

Variabili d'ambiente (hanno la precedenza su `secrets.json`; valori vuoti equivalgono a non impostati):

| Variabile | Uso |
|---|---|
| `SUBSTACK_SID` | cookie di sessione Substack |
| `ANTHROPIC_API_KEY` | chiave del provider `anthropic` |
| `SUBSTACK_LLM_API_KEY` | chiave per il server `openai-compat`, se la richiede |
| `SUBSTACK_CLI_CONFIG_DIR` | cartella di `config.json` e `secrets.json` |
| `SUBSTACK_CLI_DATA_DIR` | cartella dei dati (coda note, `drafts/`) |

Solo per i test: `SUBSTACK_NOW` (data ISO) sostituisce l'orologio, ma soltanto se anche `SUBSTACK_ALLOW_TEST_CLOCK=1`. Quando l'orologio di test è attivo ogni comando stampa un avviso su stderr: non impostare queste variabili in produzione (anticiperebbero o ritarderebbero la pubblicazione delle note).

## 4. Autenticazione (tutorial passo passo)

Il testo seguente è lo stesso di `substack auth guide`.

Substack non ha API key: il CLI usa il cookie `substack.sid` del tuo account. Trattalo come una password: chi lo possiede può agire come te.

1. Sul tuo PC apri https://substack.com e fai login.
2. Apri gli strumenti sviluppatore del browser (F12).
3. Chrome/Edge: scheda "Application" -> "Cookies" -> "https://substack.com". Firefox: scheda "Storage" -> "Cookies". Safari: "Archiviazione" -> "Cookie".
4. Trova la riga `substack.sid` e copia il suo VALORE (inizia di solito con `s%3A`).
5. Salvalo sul dispositivo/VM dove gira il CLI, in uno di questi modi (mai il valore scritto sulla riga di comando: finirebbe nella cronologia della shell e in `ps`):
   - a) interattivo (il valore non viene mostrato): `substack auth set`
   - b) da stdin (utile via SSH o in uno script): `read -rs SID && printf '%s' "$SID" | substack auth set; unset SID`
   - c) variabile d'ambiente (senza file): `read -rs SUBSTACK_SID && export SUBSTACK_SID`
6. Verifica: `substack auth check`. Se risponde "Sessione valida", sei a posto.

**Senza poter caricare file sulla VM:** usa (b) o (c) da una sessione SSH.

**Senza browser a portata di mano:** sul tuo PC installa Playwright (`npm install --no-save playwright && npx playwright install chromium`) ed esegui `substack auth login`: si apre un browser, fai login a mano e il cookie viene salvato; con `--print` viene stampato per poterlo copiare sulla VM.

**Kubernetes (k3s):** crea o aggiorna il Secret leggendo il valore da stdin:

```bash
read -rs SID
printf '%s' "$SID" | kubectl -n substack create secret generic substack-secrets \
  --from-file=SUBSTACK_SID=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
unset SID
```

Il cookie scade ogni tanto: quando `substack auth check` esce con codice 2, ripeti la procedura.

Il file `secrets.json` viene scritto con permessi `0600`; su Windows i permessi POSIX non hanno effetto (vedi "Limitazioni note").

## 5. Uso

Opzione comune a tutti i comandi: `--json` (output per macchine).

### Articoli

Un articolo è un file Markdown con front-matter YAML (`title` obbligatorio, `subtitle` opzionale; nessun'altra chiave):

```markdown
---
title: Il mio primo articolo
subtitle: Una riga di sottotitolo
---

Testo con **grassetto**, *corsivo*, [link](https://example.com), elenchi e citazioni.
```

```bash
substack article draft articolo.md              # crea la bozza online; stampa id e URL di modifica
substack article draft articolo.md --dry-run    # valida e converte senza chiamare Substack
cat articolo.md | substack article draft -      # da stdin
substack article list                           # bozze più recenti
substack article publish 123                    # chiede conferma
substack article publish 123 --yes              # pubblica senza email
substack article publish 123 --yes --send-email # pubblica e invia l'email agli iscritti
substack article schedule 123 --at 2026-10-09T09:00:00+02:00   # schedulazione nativa Substack: chiede conferma ("programma")
substack article schedule 123 --at 2026-10-09T09:00:00+02:00 --yes        # senza prompt (obbligatorio da script/cron)
substack article schedule 123 --at 2026-10-09T09:00:00+02:00 --dry-run    # mostra titolo, data ed email senza schedulare
substack article schedule 123 --cancel                          # annulla la schedulazione
```

### Note

Le note vivono in una coda locale; `notes run-due` pubblica quelle schedulate scadute.

```bash
substack note add "Testo della nota"            # oppure: echo "testo" | substack note add -
substack note list --status draft
substack note schedule <id> --at 2026-10-09T09:00:00+02:00
substack note unschedule <id>                   # torna a draft
substack note publish <id>                      # pubblica subito
substack notes run-due                          # da cron / systemd / k3s
substack notes run-due --dry-run                # mostra cosa pubblicherebbe
substack note resolve <id> --published          # oppure --retry, per una nota bloccata in "publishing"
```

Stati di una nota: `draft`, `scheduled`, `publishing`, `published`, `failed`.

Ogni comando che modifica la coda (`note add/schedule/unschedule/publish/resolve`, `generate note`, `notes run-due`) prende il lock `<dataDir>/notes/.lock`: se un altro comando lo tiene, esce con codice 6 ("Operazione già in corso") e va semplicemente ripetuto. `run-due` rilegge ogni nota sotto lock prima di pubblicarla (una nota tolta o rimandata durante il giro non parte), rinnova il lock prima di ogni nota e si interrompe se un altro processo lo ha preso in carico; su SIGTERM/SIGINT il lock viene rilasciato prima di uscire.

### Generazione con un LLM

```bash
substack generate article --topic "Perché scrivere ogni settimana" --lang it
substack generate article --topic "..." --draft          # salva anche la bozza online
substack generate note --topic "Idea per una nota"       # aggiunge una nota draft alla coda
substack generate article --topic "..." --provider anthropic
```

Gli articoli generati vengono salvati in `<dataDir>/drafts/`; un output non valido viene salvato come `rifiutato-<data>.md` e il comando esce con codice 5. Nulla viene mai pubblicato automaticamente.

Con llama.cpp:

```bash
llama-server -m modello.gguf --port 8080
substack config init --publication miapubblicazione \
  --provider openai-compat --llm-base-url http://localhost:8080 --force
```

Con Anthropic: `export ANTHROPIC_API_KEY=...` e `--provider anthropic` (oppure `generate.provider` in `config.json`).

La chiave Anthropic viene inviata **solo** a `https://api.anthropic.com`: `generate.baseUrl` vale esclusivamente per il provider `openai-compat` (server LLM locale o di rete) e non riceve mai `ANTHROPIC_API_KEY`, nemmeno con `--provider anthropic`. Il campo opzionale `generate.anthropicBaseUrl` accetta soltanto `https://api.anthropic.com` (qualsiasi altro valore rende la configurazione non valida).

## 6. Exit code

| Codice | Significato |
|---|---|
| 0 | successo |
| 1 | errore generico/inatteso |
| 2 | autenticazione: cookie mancante, non valido o scaduto |
| 3 | risposta dell'API Substack con forma inattesa (API cambiata) |
| 4 | errore di rete o rate limit |
| 5 | errore del provider LLM o output generato non valido |
| 6 | stato incoerente (es. nota rimasta in `publishing`) |
| 64 | uso errato: argomenti, front-matter o Markdown non validi |

## 7. Deploy

### Docker

```bash
docker build -f deploy/Dockerfile -t substack-cli:0.1.0 .
docker run --rm substack-cli:0.1.0 help
```

L'immagine esegue come utente `node` (uid 1000), con `/config` e `/data` come cartelle di configurazione e dati.

L'immagine finale non contiene npm, npx, corepack né yarn (rimossi dopo `npm ci`): solo `node` e il CLI compilato. Per build riproducibili fissa l'immagine base al digest (`node:22-alpine@sha256:...`), come indicato nel Dockerfile.

### k3s

```bash
# importa l'immagine nel containerd di k3s
docker save substack-cli:0.1.0 | sudo k3s ctr images import -

# modifica prima deploy/k3s/configmap.yaml (publication e, se serve, baseUrl del server LLM)
kubectl apply -f deploy/k3s/namespace.yaml
kubectl apply -f deploy/k3s/configmap.yaml
kubectl apply -f deploy/k3s/pvc.yaml

# Secret: NON committare valori reali e non scriverli sulla riga di comando (cronologia della shell, ps)
read -rs SID
printf '%s' "$SID" | kubectl -n substack create secret generic substack-secrets \
  --from-file=SUBSTACK_SID=/dev/stdin
unset SID
# Con più chiavi (ANTHROPIC_API_KEY, SUBSTACK_LLM_API_KEY): un file temporaneo leggibile solo da te
#   (umask 077; cat > /dev/shm/substack.env)    # incolla le righe CHIAVE=valore, poi Ctrl+D
#   kubectl -n substack create secret generic substack-secrets --from-env-file=/dev/shm/substack.env
#   shred -u /dev/shm/substack.env
# deploy/k3s/secret.example.yaml mostra solo la forma.

kubectl apply -f deploy/k3s/job-auth-check.yaml      # verifica il cookie
kubectl -n substack logs job/substack-auth-check
kubectl apply -f deploy/k3s/cronjob.yaml             # run-due ogni minuto
kubectl apply -f deploy/k3s/toolbox.yaml             # opzionale, per kubectl exec (parte con replicas: 0)
kubectl -n substack scale deploy/substack-toolbox --replicas=1
kubectl -n substack exec -it deploy/substack-toolbox -- node /app/dist/cli/main.js article list
kubectl -n substack scale deploy/substack-toolbox --replicas=0   # spegnilo quando hai finito
```

Il toolbox tiene il cookie nel proprio ambiente per tutto il tempo in cui è acceso: tienilo a 0 repliche quando non serve. Tutti i pod girano senza token del service account (`automountServiceAccountToken: false`), con profilo seccomp `RuntimeDefault`, filesystem di root in sola lettura e limiti di CPU/memoria (richieste 50m/64Mi, limiti 500m/256Mi).

Rinnovo del cookie: rieseguire il comando `kubectl ... create secret ... --dry-run=client -o yaml | kubectl apply -f -` mostrato nella sezione 4; i prossimi Job leggono il nuovo valore (il toolbox va riavviato: `kubectl -n substack rollout restart deploy/substack-toolbox`). Per rieseguire il controllo: `kubectl -n substack delete job substack-auth-check` e di nuovo `apply`.

Lettura dei fallimenti del CronJob (il Job fallisce se `run-due` esce con codice diverso da 0):

```bash
kubectl -n substack get jobs
kubectl -n substack logs job/<nome-del-job-fallito>
```

La PVC è `ReadWriteOnce` (`local-path`): CronJob e toolbox funzionano perché k3s a nodo singolo li schedula sullo stesso nodo. `concurrencyPolicy: Forbid` evita esecuzioni sovrapposte.

### systemd

Su una VM, con il progetto compilato in `/opt/substack-cli`, un utente `substack` e le cartelle `/etc/substack-cli` (con `config.json`) e `/var/lib/substack-cli` (scrivibile da `substack`):

```bash
sudo install -m 0600 -o substack /dev/null /etc/substack-cli/env
read -rs SID && printf 'SUBSTACK_SID=%s\n' "$SID" | sudo sh -c 'cat > /etc/substack-cli/env'; unset SID
sudo cp deploy/systemd/substack-notes.service deploy/systemd/substack-notes.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now substack-notes.timer
systemctl list-timers substack-notes.timer
journalctl -u substack-notes.service -n 50
```

Il file `env` contiene i segreti (`SUBSTACK_SID`, ecc.); tienilo leggibile solo dall'utente del servizio.

Il servizio gira con `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp`, `PrivateDevices`, nessuna capability (`CapabilityBoundingSet=` vuoto), solo socket `AF_UNIX`/`AF_INET`/`AF_INET6` (AF_UNIX per la risoluzione DNS locale), `MemoryMax=256M` e `UMask=0077`.

## 8. Sviluppo

```bash
npm test               # unit + security + functional
npm run test:unit
npm run test:functional
npm run typecheck
npm run coverage
npm run mutation       # Stryker
```

Struttura: `src/util` (errori, redazione segreti, fs atomico, orologio), `src/config`, `src/auth` (cookie, guida, login Playwright), `src/markdown` (front-matter e conversione Markdown -> ProseMirror), `src/substack` (client HTTP e schemi), `src/notes` (coda e pubblicazione), `src/generate` (provider LLM), `src/cli` (router e comandi), `tests/`, `scripts/probe.ts` (sonda di sola lettura per verificare le API), `deploy/`, `docs/`.

## 9. Risoluzione problemi

- **Exit 2 (cookie):** il cookie manca o è scaduto. Ripeti la procedura della sezione 4 e verifica con `substack auth check`.
- **Exit 3 (API cambiata):** Substack ha modificato un endpoint o la forma di una risposta. Apri una issue indicando endpoint e campo che non corrispondono (senza cookie né dati personali).
- **Exit 6 (nota in `publishing`):** una pubblicazione è stata interrotta e non si sa se sia andata a buon fine. Esegui `substack note list --status publishing`, controlla su Substack se la nota esiste, poi `substack note resolve <id> --published` oppure `--retry`.
- **Exit 4:** errore di rete o rate limit; riprova più tardi (`run-due` ritenterà alla prossima esecuzione).
- **Exit 64:** leggi il messaggio: indica il vincolo violato (front-matter, Markdown non supportato, data senza offset).

## 10. Limitazioni note

- Le API interne di Substack sono non documentate; gli endpoint restano marcati "candidati" finché non vengono confermati nella Fase 0 (vedi `tests/fixtures/README.md`).
- Le entità HTML con nome (ad es. `&copy;`) restano letterali nel testo.
- HTML grezzo, tabelle, liste di task, testo barrato, link in stile reference e titoli h5/h6 vengono rifiutati con un errore esplicito.
- Input oltre 300 KB o con markup inline patologico viene rifiutato.
- Il numero iniziale delle liste ordinate non viene preservato.
- `--at` richiede una data ISO 8601 con offset (es. `2026-10-09T09:00:00+02:00` oppure `...Z`).
- Nel front-matter v1 non sono supportati tag e sezione.
- I permessi del file dei segreti (`0600`) sono solo POSIX: su Windows ci si affida alle ACL dell'utente.
