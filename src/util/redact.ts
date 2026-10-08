const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (!value || value.length < 8) return;
  secrets.add(value);
  try {
    secrets.add(decodeURIComponent(value));
  } catch {
    // valore non codificato: nessuna variante decodificata
  }
  secrets.add(encodeURIComponent(value));
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out
    .replace(/substack\.sid=[^;\s"']+/gi, 'substack.sid=[REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
