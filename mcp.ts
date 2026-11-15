// The MCP surface (JSON-RPC 2.0 streamable HTTP at POST /mcp): the modern 2026-07-28 era via
// server/discover (supportedVersions, capabilities, serverInfo), the legacy initialize handshake,
// tools/list and tools/call for the six github-mcp-server tools, and JSON-RPC errors for unknown
// tools (-32602), missing arguments (isError), and parse errors (HTTP 400, -32700). Tools act on
// the same store as REST and GraphQL. No sessions are held.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorJson, isAuthorized, isRecord, parseJsonBody, readBody, sendJson } from './httputil.ts';
import { type Forge, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Map a call's arguments onto a tool's documented property names (synonyms + full_name). */
function normalizeArgs(tool: ToolDef, raw: Record<string, unknown>): Record<string, unknown> {
  const synonyms: Record<string, string> = {
    repository: 'repo',
    repository_name: 'repo',
    owner_login: 'owner',
    org: 'owner',
    issue_title: 'title',
    issue_body: 'body',
    description: 'body',
    head_ref: 'head',
    head_branch: 'head',
    base_ref: 'base',
    base_branch: 'base',
    pr_number: 'pull_number',
    number: 'pull_number',
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_meta') continue;
    const canonical = synonyms[key] ?? key;
    if (out[canonical] === undefined) out[canonical] = value;
  }
  if (typeof out.full_name === 'string' && (out.owner === undefined || out.repo === undefined)) {
    const [owner, repo] = (out.full_name as string).split('/');
    if (out.owner === undefined && owner) out.owner = owner;
    if (out.repo === undefined && repo) out.repo = repo;
  }
  void tool;
  return out;
}

function toolText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: toolText(value), structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: toolText(message), isError: true };
}

function repoSummary(repo: Repo, forge: Forge): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(forge: Forge, name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_BY_NAME.get(name.toLowerCase());
  if (!tool) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const args = normalizeArgs(tool, rawArgs);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const loadRepo = (): Repo | null => {
    if (!forge.isViewerOwner(owner)) return null;
    return forge.getRepo(owner, repoName) ?? null;
  };
  switch (tool.name) {
    case 'create_repo': {
      const { repo } = forge.createRepo({
        name: String(args.name ?? ''),
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoSummary(repo, forge));
    }
    case 'get_repo': {
      const repo = loadRepo();
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoSummary(repo, forge));
    }
    case 'create_issue': {
      const repo = loadRepo();
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const created = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      const issue = created.issue;
      return toolResult({ id: issue.id, node_id: issue.globalId, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      const repo = loadRepo();
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = loadRepo();
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const created = forge.createPull(repo, {
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      const pull = created.pull;
      return toolResult({ id: pull.id, node_id: pull.globalId, number: pull.number, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef, headRefName: pull.headRef, baseRefName: pull.baseRef });
    }
    case 'merge_pull_request': {
      const repo = loadRepo();
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return toolError(`Pull request #${args.pull_number} not found`);
      const mergeSha = forge.mergePull(repo, pull);
      if (mergeSha === null) return toolError('merge conflict');
      return toolResult({ merged: true, number: pull.number, sha: mergeSha, state: pull.state });
    }
    default:
      return toolError(`Tool ${tool.name} is not implemented`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcp(request: IncomingMessage, response: ServerResponse, forge: Forge): Promise<void> {
  const method = (request.method ?? 'POST').toUpperCase();
  if (method === 'DELETE') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (method !== 'POST') {
    errorJson(response, 405, 'Method not allowed');
    return;
  }
  if (!isAuthorized(request, forge)) {
    errorJson(response, 401, 'Bad credentials');
    return;
  }
  const body = await readBody(request);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    // A non-JSON body is a JSON-RPC parse error: HTTP 400 carrying -32700.
    sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const payload = parsed.value;
  if (!isRecord(payload) || typeof payload.method !== 'string') {
    sendJson(response, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = payload.id ?? null;
  const params = isRecord(payload.params) ? (payload.params as Record<string, unknown>) : {};
  switch (payload.method) {
    case 'server/discover': {
      sendJson(response, 200, rpcResult(id, {
        protocolVersion: PREFERRED_REVISION,
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '';
      const revision = SUPPORTED_REVISIONS.includes(offered) ? offered : PREFERRED_REVISION;
      sendJson(response, 200, rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      // Notifications carry no id and expect no result body.
      response.writeHead(202);
      response.end();
      return;
    }
    case 'ping': {
      sendJson(response, 200, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendJson(response, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callTool(forge, name, args);
      if ('__rpcError' in outcome) {
        const rpcErr = outcome.__rpcError as { code: number; message: string };
        sendJson(response, 200, rpcError(id, rpcErr.code, rpcErr.message));
        return;
      }
      sendJson(response, 200, rpcResult(id, outcome));
      return;
    }
    default: {
      sendJson(response, 200, rpcError(id, -32601, `Method not found: ${payload.method}`));
      return;
    }
  }
}
