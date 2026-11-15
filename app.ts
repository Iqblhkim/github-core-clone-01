// The server: one HTTP listener routing the four surfaces onto one store. /healthz needs no token;
// everything else checks the suite's Bearer token first (git smart HTTP included — the client
// sends it there too). Unknown routes answer JSON 404, never HTML.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { errorJson, isAuthorized, newRequestId, readBody } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestContext } from './rest.ts';
import { Forge } from './store.ts';

const forge = new Forge();

function json404(response: ServerResponse, requestId: string): void {
  errorJson(response, 404, 'Not Found', { 'x-github-request-id': requestId });
}

export function createApp(): ReturnType<typeof createServer> {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const requestId = newRequestId();
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const segments = url.pathname.split('/').filter((segment) => segment !== '');
        const method = (request.method ?? 'GET').toUpperCase();

        if (url.pathname === '/healthz') {
          if (method !== 'GET') {
            json404(response, requestId);
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
          response.end('{"ok":true}');
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          const context: RestContext = {
            request,
            response,
            forge,
            segments: segments.slice(2),
            url,
            requestId,
          };
          const handled = await handleRest(context);
          if (!handled) json404(response, requestId);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          await handleGraphql(request, response, forge);
          return;
        }

        if (segments[0] === 'mcp' && segments.length === 1) {
          await handleMcp(request, response, forge);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        if (segments.length >= 3 && segments[1]?.endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          if (!isAuthorized(request, forge)) {
            errorJson(response, 401, 'Bad credentials', { 'x-github-request-id': requestId });
            return;
          }
          if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service') ?? '';
            handleInfoRefs(request, response, forge, owner, repoName, service);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(request);
            handleUploadPack(request, response, forge, owner, repoName, body);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(request);
            handleReceivePack(request, response, forge, owner, repoName, body);
            return;
          }
          json404(response, requestId);
          return;
        }

        json404(response, requestId);
      } catch (err) {
        if (!response.headersSent) {
          errorJson(response, 500, err instanceof Error ? err.message : 'Internal Server Error', { 'x-github-request-id': requestId });
        } else {
          response.end();
        }
      }
    })();
  });
}
