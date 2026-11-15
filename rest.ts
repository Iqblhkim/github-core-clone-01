// The REST v3 surface: /api/v3/ root and meta, /user and /user/repos, /repos/{owner}/{name}
// (repos, branches, commits, contents, issues, labels, pulls, merges, git refs), plus the
// protocol invariants the suite checks: application/json everywhere, X-GitHub-Request-Id on every
// reply, X-OAuth-Scopes on the root, JSON {message} errors, Link pagination, 404 (never 403) for
// a repo under another owner.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, type GitObject } from './gitcore.ts';
import {
  errorJson,
  isAuthorized,
  isRecord,
  paginate,
  pageParams,
  parseJsonBody,
  readBody,
  sendJson,
  type JsonBody,
} from './httputil.ts';
import { type Forge, type Issue, type Pull, type Repo } from './store.ts';

const BASE_URL_PLACEHOLDER = 'https://api.github.com';

export interface RestContext {
  request: IncomingMessage;
  response: ServerResponse;
  forge: Forge;
  segments: string[];
  url: URL;
  requestId: string;
}

function repoJson(repo: Repo, forge: Forge): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${BASE_URL_PLACEHOLDER}/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${BASE_URL_PLACEHOLDER}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${BASE_URL_PLACEHOLDER}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(comment: { id: number; globalId: string; body: string; createdAt: string }, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${BASE_URL_PLACEHOLDER}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function notFound(context: RestContext, message = 'Not Found'): void {
  errorJson(context.response, 404, message, { 'x-github-request-id': context.requestId });
}

function unauthorized(context: RestContext): void {
  errorJson(context.response, 401, 'Bad credentials', { 'x-github-request-id': context.requestId });
}

async function readJson(context: RestContext): Promise<{ value: JsonBody } | null> {
  const body = await readBody(context.request);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    errorJson(context.response, 400, 'Invalid JSON body', { 'x-github-request-id': context.requestId });
    return null;
  }
  return { value: parsed.value };
}

function send(context: RestContext, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  sendJson(context.response, status, value, { 'x-github-request-id': context.requestId, ...extraHeaders });
}

function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

/** Load the repo for a /repos/{owner}/{name} route, or answer 404. */
function loadRepo(context: RestContext, owner: string, name: string): Repo | null {
  if (!context.forge.isViewerOwner(owner)) {
    notFound(context);
    return null;
  }
  const repo = context.forge.getRepo(owner, name);
  if (!repo) {
    notFound(context);
    return null;
  }
  return repo;
}

export async function handleRest(context: RestContext): Promise<boolean> {
  const { segments, forge, url } = context;
  const method = (context.request.method ?? 'GET').toUpperCase();

  // The API root and meta need no repo, but meta still needs auth (the suite sends the token).
  if (segments.length === 0) {
    if (method !== 'GET') {
      notFound(context);
      return true;
    }
    send(context, 200, {
      current_user_url: `${BASE_URL_PLACEHOLDER}/user`,
      repository_url: `${BASE_URL_PLACEHOLDER}/repos/{owner}/{repo}`,
      user_url: `${BASE_URL_PLACEHOLDER}/users/{user}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      notFound(context);
      return true;
    }
    if (!isAuthorized(context.request, forge)) {
      unauthorized(context);
      return true;
    }
    send(context, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') {
      notFound(context);
      return true;
    }
    if (!isAuthorized(context.request, forge)) {
      unauthorized(context);
      return true;
    }
    send(context, 200, {
      login: forge.viewer.login,
      id: forge.viewer.id,
      name: forge.viewer.name,
      email: forge.viewer.email,
      type: 'User',
      html_url: `https://github.com/${forge.viewer.login}`,
      url: `${BASE_URL_PLACEHOLDER}/user`,
    });
    return true;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (!isAuthorized(context.request, forge)) {
      unauthorized(context);
      return true;
    }
    if (method === 'GET') {
      const params = pageParams(url);
      const { page, link } = paginate(forge.listViewerRepos().map((repo) => repoJson(repo, forge)), url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.name !== 'string' || !validRepoName(body.name)) {
        errorJson(context.response, 422, 'name is invalid', { 'x-github-request-id': context.requestId });
        return true;
      }
      const { repo } = forge.createRepo({
        name: body.name,
        private: typeof body.private === 'boolean' ? body.private : false,
        description: typeof body.description === 'string' ? body.description : '',
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      send(context, 201, repoJson(repo, forge));
      return true;
    }
    notFound(context);
    return true;
  }

  if (segments[0] !== 'repos' || segments.length < 3) return false;
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const rest = segments.slice(3);
  if (!isAuthorized(context.request, forge)) {
    unauthorized(context);
    return true;
  }
  const repo = loadRepo(context, owner, repoName);
  if (!repo) return true;

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      send(context, 200, repoJson(repo, forge));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.name === 'string' && validRepoName(body.name) && body.name !== repo.name) {
          forge.repos.delete(forge.repoKey(repo.owner, repo.name));
          repo.name = body.name;
          forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
        }
        repo.updatedAt = forge.isoNow();
      }
      send(context, 200, repoJson(repo, forge));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      context.response.writeHead(204, { 'x-github-request-id': context.requestId });
      context.response.end();
      return true;
    }
    notFound(context);
    return true;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
          protected: false,
        }));
      const params = pageParams(url);
      const { page, link } = paginate(branches, url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        notFound(context, 'Branch not found');
        return true;
      }
      send(context, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    notFound(context);
    return true;
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveToCommit(repo, ref);
      if (tip === undefined) {
        notFound(context, 'No commit found for this ref');
        return true;
      }
      const history = forge.commitHistory(repo, tip).map((sha) => {
        const object = repo.objects.get(sha) as GitObject;
        const commit = parseCommit(object.data);
        const authorLine = commit.author;
        const authorName = authorLine.replace(/ <.*$/, '');
        const authorEmail = (/<([^>]*)>/.exec(authorLine)?.[1] ?? '');
        return {
          sha,
          commit: {
            message: commit.message.replace(/\n+$/, ''),
            author: { name: authorName, email: authorEmail },
            committer: { name: authorName, email: authorEmail },
          },
          author: { login: forge.viewer.login, id: forge.viewer.id },
          committer: { login: forge.viewer.login, id: forge.viewer.id },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        };
      });
      const params = pageParams(url);
      const { page, link } = paginate(history, url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    notFound(context);
    return true;
  }

  // Contents.
  if (rest[0] === 'contents') {
    return handleContents(context, repo, rest.slice(1), method);
  }

  // git refs (create branch / tag).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
        errorJson(context.response, 422, 'ref and sha are required', { 'x-github-request-id': context.requestId });
        return true;
      }
      const ref = body.ref;
      if (!ref.startsWith('refs/') || repo.refs.has(ref)) {
        errorJson(context.response, 422, 'ref already exists', { 'x-github-request-id': context.requestId });
        return true;
      }
      const peeled = forge.resolveToCommit(repo, body.sha);
      if (peeled === undefined && !repo.objects.has(body.sha)) {
        errorJson(context.response, 422, 'sha does not exist', { 'x-github-request-id': context.requestId });
        return true;
      }
      repo.refs.set(ref, body.sha);
      forge.touch(repo);
      send(context, 201, {
        ref,
        node_id: forge.globalId('Ref', `${repo.owner}/${repo.name}:${ref}`),
        url: `${BASE_URL_PLACEHOLDER}/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref.slice(5))}`,
        object: { sha: body.sha, type: (repo.objects.get(body.sha)?.type ?? 'commit') },
      });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        notFound(context, 'Reference not found');
        return true;
      }
      send(context, 200, {
        ref,
        node_id: forge.globalId('Ref', `${repo.owner}/${repo.name}:${ref}`),
        url: `${BASE_URL_PLACEHOLDER}/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref.slice(5))}`,
        object: { sha, type: (repo.objects.get(sha)?.type ?? 'commit') },
      });
      return true;
    }
    notFound(context);
    return true;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        errorJson(context.response, 422, 'name is required', { 'x-github-request-id': context.requestId });
        return true;
      }
      const existing = repo.labels.get(body.name);
      if (existing) {
        send(context, 201, { name: existing.name, color: existing.color, description: '' });
        return true;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(body.name, { name: body.name, color });
      send(context, 201, { name: body.name, color, description: '' });
      return true;
    }
    if (method === 'GET' && rest.length === 1) {
      send(context, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      return true;
    }
    notFound(context);
    return true;
  }

  // Issues.
  if (rest[0] === 'issues') {
    return handleIssues(context, repo, rest.slice(1), method);
  }

  // Pulls.
  if (rest[0] === 'pulls') {
    return handlePulls(context, repo, rest.slice(1), method);
  }

  notFound(context);
  return true;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

async function handleContents(context: RestContext, repo: Repo, pathSegments: string[], method: string): Promise<boolean> {
  const { forge, url } = context;
  const path = pathSegments.map((segment) => decodeURIComponent(segment)).join('/');
  const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = forge.resolveToCommit(repo, refParam);
  const files = tip !== undefined ? forge.fileMapAt(repo, tip) : new Map<string, { oid: string; mode: string }>();

  if (method === 'GET') {
    if (tip === undefined) {
      notFound(context, 'No commit found for this ref');
      return true;
    }
    const entry = files.get(path);
    if (entry) {
      const object = repo.objects.get(entry.oid) as GitObject;
      const content = object.data.toString('base64');
      send(context, 200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content,
        sha: entry.oid,
      });
      return true;
    }
    // Directory listing: entries whose parent directory is `path` ('' for the root).
    const prefix = path === '' ? '' : `${path}/`;
    const listed = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
    for (const [filePath, fileEntry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const object = repo.objects.get(fileEntry.oid) as GitObject;
        listed.set(rest, { type: 'file', name: rest, path: filePath, sha: fileEntry.oid, size: object.data.length });
      } else {
        const dirName = rest.slice(0, slash);
        if (!listed.has(dirName)) {
          listed.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
        }
      }
    }
    if (listed.size === 0) {
      notFound(context, 'Not Found');
      return true;
    }
    send(context, 200, [...listed.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    return true;
  }

  if (method === 'PUT') {
    const parsed = await readJson(context);
    if (!parsed) return true;
    const body = parsed.value;
    if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
      errorJson(context.response, 422, 'message and content are required', { 'x-github-request-id': context.requestId });
      return true;
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const branchTip = forge.resolveToCommit(repo, branch);
    const branchFiles = branchTip !== undefined ? forge.fileMapAt(repo, branchTip) : new Map<string, { oid: string; mode: string }>();
    const existing = branchFiles.get(path);
    const sha = typeof body.sha === 'string' ? body.sha : null;
    if (existing && sha === null) {
      errorJson(context.response, 422, 'file already exists', { 'x-github-request-id': context.requestId });
      return true;
    }
    if (existing && sha !== null && sha !== existing.oid) {
      errorJson(context.response, 409, 'sha does not match the current file', { 'x-github-request-id': context.requestId });
      return true;
    }
    if (!existing && sha !== null) {
      errorJson(context.response, 422, 'sha given for a file that does not exist', { 'x-github-request-id': context.requestId });
      return true;
    }
    let content: Buffer;
    try {
      content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    } catch {
      errorJson(context.response, 400, 'content is not valid base64', { 'x-github-request-id': context.requestId });
      return true;
    }
    const isCreate = existing === undefined;
    const { commitSha } = forge.commitFiles(repo, {
      branch,
      message: body.message,
      changes: [{ path, content }],
    });
    const blobOid = forge.fileMapAt(repo, commitSha).get(path)?.oid ?? '';
    send(context, isCreate ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commitSha },
    });
    return true;
  }

  if (method === 'DELETE') {
    const parsed = await readJson(context);
    if (!parsed) return true;
    const body = parsed.value;
    if (!isRecord(body) || typeof body.message !== 'string') {
      errorJson(context.response, 422, 'message is required', { 'x-github-request-id': context.requestId });
      return true;
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const branchTip = forge.resolveToCommit(repo, branch);
    const branchFiles = branchTip !== undefined ? forge.fileMapAt(repo, branchTip) : new Map<string, { oid: string; mode: string }>();
    const existing = branchFiles.get(path);
    if (!existing) {
      notFound(context, 'Not Found');
      return true;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      errorJson(context.response, 409, 'sha does not match the current file', { 'x-github-request-id': context.requestId });
      return true;
    }
    const { commitSha } = forge.commitFiles(repo, {
      branch,
      message: body.message,
      changes: [{ path, content: null }],
    });
    send(context, 200, { commit: { sha: commitSha } });
    return true;
  }

  notFound(context);
  return true;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

async function handleIssues(context: RestContext, repo: Repo, rest: string[], method: string): Promise<boolean> {
  const { forge, url } = context;
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
        errorJson(context.response, 422, 'title is required', { 'x-github-request-id': context.requestId });
        return true;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const created = forge.createIssue(repo, {
        title: body.title,
        body: typeof body.body === 'string' ? body.body : '',
        labels,
      });
      if ('error' in created) {
        errorJson(context.response, 422, created.error, { 'x-github-request-id': context.requestId });
        return true;
      }
      send(context, 201, issueJson(created.issue, repo));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const params = pageParams(url);
      const { page, link } = paginate(issues.map((issue) => issueJson(issue, repo)), url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    notFound(context);
    return true;
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    notFound(context);
    return true;
  }
  const issue = repo.issues.find((item) => item.number === number);
  if (!issue) {
    notFound(context, 'Not Found');
    return true;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      send(context, 200, issueJson(issue, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((label): label is string => typeof label === 'string');
          if (labels.some((name) => !repo.labels.has(name))) {
            errorJson(context.response, 422, 'a label does not exist', { 'x-github-request-id': context.requestId });
            return true;
          }
          issue.labels = labels;
        }
        issue.updatedAt = forge.isoNow();
      }
      send(context, 200, issueJson(issue, repo));
      return true;
    }
    notFound(context);
    return true;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.body !== 'string' || body.body === '') {
        errorJson(context.response, 422, 'body is required', { 'x-github-request-id': context.requestId });
        return true;
      }
      const comment = forge.addComment(repo, issue, body.body);
      send(context, 201, commentJson(comment, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const params = pageParams(url);
      const { page, link } = paginate(issue.comments.map((comment) => commentJson(comment, repo, issue)), url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    notFound(context);
    return true;
  }
  notFound(context);
  return true;
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

async function handlePulls(context: RestContext, repo: Repo, rest: string[], method: string): Promise<boolean> {
  const { forge, url } = context;
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(context);
      if (!parsed) return true;
      const body = parsed.value;
      if (!isRecord(body) || typeof body.head !== 'string' || typeof body.base !== 'string' || typeof body.title !== 'string') {
        errorJson(context.response, 422, 'head, base and title are required', { 'x-github-request-id': context.requestId });
        return true;
      }
      const created = forge.createPull(repo, {
        head: body.head,
        base: body.base,
        title: body.title,
        body: typeof body.body === 'string' ? body.body : '',
      });
      if ('error' in created) {
        errorJson(context.response, 422, created.error, { 'x-github-request-id': context.requestId });
        return true;
      }
      send(context, 201, pullJson(created.pull, repo));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      const params = pageParams(url);
      const { page, link } = paginate(pulls.map((pull) => pullJson(pull, repo)), url, params);
      send(context, 200, page, link ? { link } : {});
      return true;
    }
    notFound(context);
    return true;
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    notFound(context);
    return true;
  }
  const pull = repo.pulls.find((item) => item.number === number);
  if (!pull) {
    notFound(context, 'Not Found');
    return true;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      send(context, 200, pullJson(pull, repo));
      return true;
    }
    notFound(context);
    return true;
  }
  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    send(context, 200, files);
    return true;
  }
  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    if (pull.state !== 'open') {
      errorJson(context.response, 405, 'pull request is already closed', { 'x-github-request-id': context.requestId });
      return true;
    }
    const mergeSha = forge.mergePull(repo, pull);
    if (mergeSha === null) {
      errorJson(context.response, 405, 'merge conflict', { 'x-github-request-id': context.requestId });
      return true;
    }
    send(context, 200, { merged: true, sha: mergeSha, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` });
    return true;
  }
  notFound(context);
  return true;
}
