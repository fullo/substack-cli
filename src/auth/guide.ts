export const AUTH_GUIDE = `GUIDA: ottenere il cookie di sessione di Substack

Substack non ha API key: il CLI usa il cookie "substack.sid" del tuo account.
Trattalo come una password: chi lo possiede può agire come te.

1. Sul tuo PC apri https://substack.com e fai login.
2. Apri gli strumenti sviluppatore del browser (F12).
3. Chrome/Edge: scheda "Application" -> "Cookies" -> "https://substack.com".
   Firefox: scheda "Storage" -> "Cookies". Safari: "Archiviazione" -> "Cookie".
4. Trova la riga "substack.sid" e copia il suo VALORE (inizia di solito con "s%3A").
5. Salvalo sul dispositivo/VM dove gira il CLI, in uno di questi modi:
   a) interattivo (il valore non viene mostrato):   substack auth set
   b) da stdin (utile via SSH):                       printf '%s' "<valore>" | substack auth set
   c) variabile d'ambiente (senza file):              export SUBSTACK_SID="<valore>"
6. Verifica:  substack auth check
   Se risponde "Sessione valida", sei a posto.

Se non puoi caricare file sulla VM: usa (b) o (c) da una sessione SSH.
Se non hai un browser a portata di mano: sul tuo PC installa Playwright
(npm install --no-save playwright && npx playwright install chromium) ed esegui
"substack auth login": apre un browser, fai login a mano e il cookie viene salvato;
con "--print" lo stampa per copiarlo sulla VM.

Kubernetes (k3s): aggiorna il Secret senza ricreare nulla:
   kubectl -n substack create secret generic substack-secrets \\
     --from-literal=SUBSTACK_SID="<valore>" --dry-run=client -o yaml | kubectl apply -f -

Il cookie scade ogni tanto: quando "substack auth check" esce con codice 2,
ripeti questa guida.
`;
