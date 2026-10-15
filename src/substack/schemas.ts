import { z } from 'zod';

export const ProfileSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    handle: z.string().nullable().optional(),
  })
  .passthrough();

export const DraftCreatedSchema = z.object({ id: z.number().int().positive() }).passthrough();

export const DraftSchema = z
  .object({
    id: z.number().int().positive(),
    draft_title: z.string().nullable().optional(),
    draft_subtitle: z.string().nullable().optional(),
    audience: z.string().nullable().optional(),
    is_published: z.boolean().nullable().optional(),
    cover_image: z.string().nullable().optional(),
    draft_body: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    canonical_url: z.string().nullable().optional(),
    post_date: z.string().nullable().optional(),
  })
  .passthrough();

/** Articolo pubblicato, come lo restituiscono elenco e ricerca (campi NON CONFERMATI: tests/fixtures/README.md, sezione 11). */
export const PostSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().nullable().optional(),
    draft_title: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    canonical_url: z.string().nullable().optional(),
    post_date: z.string().nullable().optional(),
    is_published: z.boolean().nullable().optional(),
  })
  .passthrough();

export const PostListSchema = z.object({ posts: z.array(PostSchema) }).passthrough();
/** L'archivio pubblico risponde con un array nudo. */
export const PostArraySchema = z.array(PostSchema);

export const DraftListSchema = z.object({ posts: z.array(DraftSchema) }).passthrough();

export const ImageUploadedSchema = z.object({ url: z.string().url() }).passthrough();

export const NoteCreatedSchema = z.object({ id: z.union([z.number().int(), z.string().min(1)]) }).passthrough();

export const AnySchema = z.unknown();

export type Profile = z.infer<typeof ProfileSchema>;
export type Post = z.infer<typeof PostSchema>;
export type Draft = z.infer<typeof DraftSchema>;
