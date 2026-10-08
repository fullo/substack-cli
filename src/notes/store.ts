import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { markdownToDoc } from '../markdown/prosemirror.ts';
import { StateError, UsageError } from '../util/errors.ts';
import { atomicWriteFile } from '../util/fs.ts';

const STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type NoteStatus = (typeof STATUSES)[number];

const NoteSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    text: z.string().min(1).max(5000),
    status: z.enum(STATUSES),
    createdAt: z.string(),
    publishAt: z.string().optional(),
    prevStatus: z.enum(['draft', 'scheduled']).optional(),
    publishedAt: z.string().optional(),
    substackId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type Note = z.infer<typeof NoteSchema>;

const ID_RE = /^[0-9a-f]{12}$/;

export class NoteStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get lockPath(): string {
    return join(this.dir, '.lock');
  }

  private path(id: string): string {
    if (!ID_RE.test(id)) throw new UsageError(`Id nota non valido: "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  private async write(note: Note): Promise<Note> {
    await atomicWriteFile(this.path(note.id), JSON.stringify(note, null, 2) + '\n');
    return note;
  }

  async add(text: string, now: Date): Promise<Note> {
    if (text.length > 5000) throw new UsageError('La nota supera i 5000 caratteri');
    markdownToDoc(text); // valida subito: errori di Markdown emergono qui, non alla pubblicazione
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(6).toString('hex');
    return this.write({ id, text, status: 'draft', createdAt: now.toISOString() });
  }

  async get(id: string): Promise<Note> {
    const path = this.path(id);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new UsageError(`Nota non trovata: ${id}`);
      throw e;
    }
    try {
      return NoteSchema.parse(JSON.parse(raw));
    } catch {
      throw new StateError(`File nota corrotto o modificato in modo non valido: ${path}`);
    }
  }

  async list(status?: NoteStatus): Promise<{ notes: Note[]; corrupt: string[] }> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const notes: Note[] = [];
    const corrupt: string[] = [];
    for (const name of names.filter((n) => /^[0-9a-f]{12}\.json$/.test(n))) {
      try {
        notes.push(await this.get(name.slice(0, -5)));
      } catch {
        corrupt.push(name);
      }
    }
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { notes: status ? notes.filter((n) => n.status === status) : notes, corrupt };
  }

  private async transition(id: string, from: NoteStatus[], change: (n: Note) => Note): Promise<Note> {
    const note = await this.get(id);
    if (!from.includes(note.status)) {
      throw new StateError(`Nota ${id}: operazione non consentita dallo stato "${note.status}"`);
    }
    return this.write(change(note));
  }

  async schedule(id: string, at: Date, now: Date): Promise<Note> {
    if (at.getTime() <= now.getTime()) throw new UsageError('La data di pubblicazione deve essere nel futuro');
    return this.transition(id, ['draft', 'scheduled'], (n) => {
      const { error: _e, ...rest } = n;
      return { ...rest, status: 'scheduled', publishAt: at.toISOString() };
    });
  }

  async unschedule(id: string): Promise<Note> {
    return this.transition(id, ['scheduled'], (n) => {
      const { publishAt: _p, error: _e, ...rest } = n;
      return { ...rest, status: 'draft' };
    });
  }

  async beginPublish(id: string): Promise<Note> {
    return this.transition(id, ['draft', 'scheduled'], (n) => {
      const { error: _e, ...rest } = n;
      return { ...rest, status: 'publishing', prevStatus: n.status as 'draft' | 'scheduled' };
    });
  }

  async completePublish(id: string, substackId: string, now: Date): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus: _p, error: _e, ...rest } = n;
      return { ...rest, status: 'published', substackId, publishedAt: now.toISOString() };
    });
  }

  async revert(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus, ...rest } = n;
      return { ...rest, status: prevStatus ?? 'draft', error };
    });
  }

  async fail(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus: _p, ...rest } = n;
      return { ...rest, status: 'failed', error };
    });
  }

  async markUncertain(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => ({ ...n, error }));
  }

  async resolve(id: string, how: 'published' | 'retry', now: Date): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus, error: _e, ...rest } = n;
      if (how === 'published') return { ...rest, status: 'published', publishedAt: now.toISOString() };
      return { ...rest, status: prevStatus ?? 'draft' };
    });
  }
}
