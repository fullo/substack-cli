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
  })
  .passthrough();

export const DraftListSchema = z.object({ posts: z.array(DraftSchema) }).passthrough();

export const NoteCreatedSchema = z.object({ id: z.union([z.number().int(), z.string().min(1)]) }).passthrough();

export const AnySchema = z.unknown();

export type Profile = z.infer<typeof ProfileSchema>;
export type Draft = z.infer<typeof DraftSchema>;
