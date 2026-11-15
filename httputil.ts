// Shared HTTP helpers for the surfaces: request ids, bearer auth, JSON bodies, pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

let requestCounter = 0;

export function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function readBody(request: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface ParsedJson {
  ok: true;
  value: JsonBody;
}

export interface ParseFailure {
  ok: false;
  error: 'empty' | 'malformed';
}

/** Parse a JSON body. Empty body -> ok(null). Invalid JSON -> malformed. */
export function parseJsonBody(buffer: Buffer): ParsedJson | ParseFailure {
  if (buffer.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) as JsonBody };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  response.end(body);
}

export function errorJson(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(response, status, { message }, headers);
}

/** The Bearer token of the request, or null when the header is absent/malformed. */
export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

/** True when the request carries the suite's shop token. */
export function isAuthorized(request: IncomingMessage, forge: Forge): boolean {
  const token = bearerToken(request);
  return token !== null && forge.token !== '' && token === forge.token;
}

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(url: URL): PageParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Slice `items` to the requested page and build a GitHub-style Link header when more pages exist. */
export function paginate<T>(items: readonly T[], url: URL, pageParamsValue: PageParams): { page: T[]; link: string | null } {
  const { page, perPage } = pageParamsValue;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages) return { page: pageItems, link: null };
  const base = `${url.protocol}//${url.host}${url.pathname}`;
  const build = (pageNumber: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(pageNumber));
    params.set('per_page', String(perPage));
    return `<${base}?${params.toString()}>`;
  };
  const links = [`${build(page + 1)}; rel="next"`];
  links.push(`${build(totalPages)}; rel="last"`);
  if (page > 1) {
    links.push(`${build(1)}; rel="first"`);
    links.push(`${build(page - 1)}; rel="prev"`);
  }
  return { page: pageItems, link: links.join(', ') };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
