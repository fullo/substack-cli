import { readImageFile } from '../../util/image.ts';
import { UsageError } from '../../util/errors.ts';
import { t } from '../../util/i18n.ts';
import { emit, flag, makeClient } from '../shared.ts';
import type { Command } from '../shared.ts';

export const imageCommands: Command[] = [
  {
    path: 'image upload',
    summary: { en: 'Upload a local image (PNG, JPEG, GIF, WebP) to Substack and print its URL', it: "Carica un'immagine locale (PNG, JPEG, GIF, WebP) su Substack e stampa l'URL" },
    options: { 'dry-run': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const file = positionals[0];
      if (!file) throw new UsageError(t('Usage: substack image upload <file> [--dry-run]', 'Uso: substack image upload <file> [--dry-run]'));
      // Validazione completa prima di qualsiasi richiesta di rete.
      const img = await readImageFile(file);
      if (flag(values, 'dry-run')) {
        emit(ctx, values, { dryRun: true, bytes: img.bytes.length, mime: img.mime },
          t(`[dry-run] Image ${file} (${img.mime}, ${img.bytes.length} bytes): no request sent`,
            `[dry-run] Immagine ${file} (${img.mime}, ${img.bytes.length} byte): nessuna richiesta inviata`));
        return 0;
      }
      const { url } = await (await makeClient(ctx)).uploadImage(img);
      emit(ctx, values, { url, bytes: img.bytes.length, mime: img.mime }, url);
      return 0;
    },
  },
];
