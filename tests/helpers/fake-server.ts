import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded { method: string; path: string; headers: IncomingHttpHeaders; body: string }
export type Handler = (req: Recorded, res: ServerResponse, raw: IncomingMessage) => void;

export class FakeServer {
  readonly requests: Recorded[] = [];
  handler: Handler;
  private server: Server;
  url = '';

  private constructor(handler: Handler) {
    this.handler = handler;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rec: Recorded = {
          method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
        };
        this.requests.push(rec);
        this.handler(rec, res, req);
      });
    });
  }

  static async start(handler: Handler): Promise<FakeServer> {
    const s = new FakeServer(handler);
    await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve));
    s.url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    return s;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  count(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
