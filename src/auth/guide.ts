export const AUTH_GUIDE = `GUIDA: ottenere il cookie di sessione di Substack

Substack non ha API key: il CLI usa il cookie "substack.sid" del tuo account.
Trattalo come una password: chi lo possiede può agire come te.

1. Sul tuo PC apri https://substack.com e fai login.
2. Apri gli strumenti sviluppatore del browser (F12).
3. Chrome/Edge: scheda "Application" -> "Cookies" -> "https://substack.com".
   Firefox: scheda "Storage" -> "Cookies". Safari: "Archiviazione" -> "Cookie".
4. Trova la riga "substack.sid" e copia il suo VALORE (inizia di solito con "s%3A").
5. Salvalo sul dispositivo/VM dove gira il CLI, in uno di questi modi
   (mai il valore scritto sulla riga di comando: finirebbe nella cronologia della shell e in "ps"):
   a) interattivo (il valore non viene mostrato):   substack auth set
   b) da stdin (utile via SSH o in uno script):
        read -rs SID && printf '%s' "$SID" | substack auth set; unset SID
   c) variabile d'ambiente (senza file):
        read -rs SUBSTACK_SID && export SUBSTACK_SID
6. Verifica:  substack auth check
   Se risponde "Sessione valida", sei a posto.

Se non puoi caricare file sulla VM: usa (b) o (c) da una sessione SSH.
Se non hai un browser a portata di mano: sul tuo PC installa Playwright
(npm install --no-save playwright && npx playwright install chromium) ed esegui
"substack auth login": apre un browser, fai login a mano e il cookie viene salvato;
con "--print" lo stampa per copiarlo sulla VM.

Kubernetes (k3s): crea o aggiorna il Secret leggendo il valore da stdin:
   read -rs SID
   printf '%s' "$SID" | kubectl -n substack create secret generic substack-secrets \\
     --from-file=SUBSTACK_SID=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
   unset SID

Il cookie scade ogni tanto: quando "substack auth check" esce con codice 2,
ripeti questa guida.
`;
