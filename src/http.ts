// Serves bounded HTTP requests with rate limits, strict JSON parsing, and redacted errors.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Use application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 8192) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
export function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Server {
  // ponytail: bounded per-process IP gate; add a shared edge limiter for public multi-instance deployment.
  const buckets = new Map<string, { minute: number; count: number }>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      const ip = req.socket.remoteAddress ?? '';
      const minute = Math.floor(Date.now() / 60_000);
      if (buckets.size >= 4096) for (const [key, value] of buckets) if (value.minute !== minute) buckets.delete(key);
      let bucket = buckets.get(ip);
      if (!bucket || bucket.minute !== minute) {
        if (!bucket && buckets.size >= 4096) throw new HttpError(429, 'Rate limited');
        bucket = { minute, count: 0 }; buckets.set(ip, bucket);
      }
      if (++bucket.count > 240) throw new HttpError(429, 'Rate limited');
      if ((req.url?.length ?? 0) > 512) throw new HttpError(414, 'URL too long');
      if (Number(req.headers['content-length'] ?? 0) > 8192) throw new HttpError(413, 'Body too large');
      await handler(req, res);
    })().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 503;
      // Only application-authored messages escape; never serialize errors, URLs, headers, or credentials.
      if (!res.headersSent) json(res, status, { error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid request' : 'Service unavailable' });
      else res.end();
    });
  });
  server.maxConnections = 128;
  server.timeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
