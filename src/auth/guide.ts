import { t } from '../util/i18n.ts';

export const AUTH_GUIDE_EN = `GUIDE: getting your Substack session cookie

Substack has no API keys: the CLI uses your account's "substack.sid" cookie.
Treat it like a password: whoever has it can act as you.

1. On your computer, open https://substack.com and sign in.
2. Open the browser's developer tools (F12).
3. Chrome/Edge: "Application" tab -> "Cookies" -> "https://substack.com".
   Firefox: "Storage" tab -> "Cookies". Safari: "Storage" -> "Cookies".
4. Find the "substack.sid" row and copy its VALUE (it usually starts with "s%3A").
   If it starts with "s:", your browser is showing it URL-decoded: replace "s:" with "s%3A".
5. Store it on the device/VM where the CLI runs, in one of these ways
   (never type the value on the command line: it would end up in the shell history and in "ps"):
   a) interactive (the value is not echoed):   substack auth set
   b) from stdin (handy over SSH or in a script):
        read -rs SID && printf '%s' "$SID" | substack auth set; unset SID
   c) environment variable (no file):
        read -rs SUBSTACK_SID && export SUBSTACK_SID
6. Check:  substack auth check
   If it answers "Valid session", you're done.

If you can't upload files to the VM: use (b) or (c) from an SSH session.
If you don't have a browser at hand: on your computer install Playwright
(npm install --no-save playwright && npx playwright install chromium) and run
"substack auth login": it opens a browser, you sign in by hand and the cookie is saved;
with "--print" it prints it so you can copy it to the VM.

Kubernetes (k3s): create or update the Secret reading the value from stdin:
   read -rs SID
   printf '%s' "$SID" | kubectl -n substack create secret generic substack-secrets \\
     --from-file=SUBSTACK_SID=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
   unset SID

The cookie expires every now and then: when "substack auth check" exits with code 2,
go through this guide again.
`;

export const AUTH_GUIDE_IT = `GUIDA: ottenere il cookie di sessione di Substack

Substack non ha API key: il CLI usa il cookie "substack.sid" del tuo account.
Trattalo come una password: chi lo possiede può agire come te.

1. Sul tuo PC apri https://substack.com e fai login.
2. Apri gli strumenti sviluppatore del browser (F12).
3. Chrome/Edge: scheda "Application" -> "Cookies" -> "https://substack.com".
   Firefox: scheda "Storage" -> "Cookies". Safari: "Archiviazione" -> "Cookie".
4. Trova la riga "substack.sid" e copia il suo VALORE (inizia di solito con "s%3A").
   Se inizia con "s:", il browser lo mostra decodificato: sostituisci "s:" con "s%3A".
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

/** La guida nella lingua attiva. */
export function authGuide(): string {
  return t(AUTH_GUIDE_EN, AUTH_GUIDE_IT);
}
