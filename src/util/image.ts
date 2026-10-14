import { readFile, stat } from 'node:fs/promises';
import { UsageError } from './errors.ts';
import { t } from './i18n.ts';

/** Dimensione massima di un'immagine da caricare: il corpo in base64 cresce di circa un terzo. */
export const MAX_IMAGE_BYTES = 10_000_000;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageFile { bytes: Buffer; mime: ImageMime }

/** Riconosce il formato dai primi byte, non dall'estensione. */
export function sniffImage(bytes: Buffer): ImageMime | undefined {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/** Legge un'immagine locale: solo file regolari, entro il limite, in un formato supportato. */
export async function readImageFile(path: string): Promise<ImageFile> {
  const st = await stat(path).catch(() => undefined);
  if (!st || !st.isFile()) throw new UsageError(t(`Image not found: ${path}`, `Immagine non trovata: ${path}`));
  if (st.size === 0) throw new UsageError(t(`Empty image file: ${path}`, `File immagine vuoto: ${path}`));
  if (st.size > MAX_IMAGE_BYTES) throw new UsageError(t('Image too large (max 10 MB)', 'Immagine troppo grande (max 10 MB)'));
  const bytes = await readFile(path);
  if (bytes.length > MAX_IMAGE_BYTES) throw new UsageError(t('Image too large (max 10 MB)', 'Immagine troppo grande (max 10 MB)'));
  const mime = sniffImage(bytes);
  if (!mime) throw new UsageError(t(`Unsupported image format: ${path} (PNG, JPEG, GIF or WebP)`, `Formato immagine non supportato: ${path} (PNG, JPEG, GIF o WebP)`));
  return { bytes, mime };
}

export function toDataUri(img: ImageFile): string {
  return `data:${img.mime};base64,${img.bytes.toString('base64')}`;
}

/** URL di un'immagine già caricata: solo https, senza credenziali, di lunghezza ragionevole. */
export function parseImageUrl(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new UsageError(t(`Invalid image URL: ${value}`, `URL immagine non valido: ${value}`)); }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || value.length > 2048) {
    throw new UsageError(t(`Image URL must be https without credentials: ${value}`, `L'URL dell'immagine deve essere https e senza credenziali: ${value}`));
  }
  return u.toString();
}

/** Un argomento che inizia con https:// è un URL; ogni altro valore è un file locale. */
export function isImageUrl(value: string): boolean {
  return /^https:\/\//i.test(value);
}
