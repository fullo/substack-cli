import type { ZodIssue } from 'zod';

const MAX_LISTED = 5;
const MAX_ISSUES = 10;

function shortList(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).map((k) => (k.length > 40 ? `${k.slice(0, 40)}…` : k)).join(', ');
  return items.length > MAX_LISTED ? `${shown} (e altre ${items.length - MAX_LISTED})` : shown;
}

/**
 * Messaggio leggibile e di dimensione limitata per gli errori di validazione: le chiavi sconosciute
 * (che arrivano da input non fidato, potenzialmente migliaia) sono elencate solo in parte.
 */
export function formatIssues(issues: ZodIssue[]): string {
  const parts = issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.join('.') || '(radice)';
    if (i.code === 'unrecognized_keys') return `${where}: chiavi non ammesse: ${shortList(i.keys)}`;
    return `${where}: ${i.message}`;
  });
  if (issues.length > MAX_ISSUES) parts.push(`(e altri ${issues.length - MAX_ISSUES} problemi)`);
  return parts.join('; ');
}
