// A small GraphQL executor for the fixed document set the suite sends: a lexer and parser for
// operations, variables, arguments (including object literals and lists), aliases and inline
// fragments, plus resolvers for Query, Repository, Issue, PullRequest, __type, node(id:) and the
// five mutations. Unknown fields produce HTTP 200 with an errors array naming the field (and the
// valid fields still resolve); an unknown repository resolves to null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  errorJson,
  isAuthorized,
  isRecord,
  newRequestId,
  parseJsonBody,
  readBody,
  sendJson,
} from './httputil.ts';
import { type Forge, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'variable'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number(raw) });
      else tokens.push({ kind: 'int', value: Number(raw) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlSelection {
  alias?: string;
  name: string;
  arguments: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
  inlineType?: string;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; type: string }>;
  selections: GqlSelection[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek()) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const nameToken = this.peek();
      if (nameToken?.kind === 'name') name = this.next().value;
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const varToken = this.next();
        if (varToken.kind !== 'variable') throw new Error('expected a variable in a variable definition');
        this.expectPunct(':');
        // A type is a name with optional ! and [ ] wrappers; it ends at the next variable or ')'.
        // (Commas are insignificant whitespace in GraphQL and never reach this parser.)
        let type = '';
        for (;;) {
          const part = this.peek();
          if (part?.kind === 'name') {
            type += this.next().value;
            continue;
          }
          if (part?.kind === 'punct' && (part.value === '!' || part.value === '[' || part.value === ']')) {
            type += this.next().value;
            continue;
          }
          break;
        }
        if (type === '') throw new Error('expected a type in a variable definition');
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          this.parseValue();
        }
        variables.push({ name: varToken.value, type });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): GqlSelection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const onToken = this.peek();
      if (onToken?.kind === 'name' && onToken.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('expected a type name after ... on');
        const selections = this.parseSelectionSet();
        return { name: '', arguments: [], selections, inlineType: typeToken.value };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | undefined;
    let name = first.value;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected a field name after an alias');
      alias = name;
      name = nameToken.value;
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.push({ name: argName.value, value: this.parseValue() });
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    let selections: GqlSelection[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, arguments: args, selections };
  }

  parseValue(): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'variable':
        return { kind: 'variable', name: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const values: GqlValue[] = [];
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
            values.push(this.parseValue());
            const next = this.peek();
            if (next?.kind === 'punct' && next.value === ',') this.next();
          }
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: GqlValue }> = [];
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
            const nameToken = this.next();
            if (nameToken.kind !== 'name') throw new Error('expected an object field name');
            this.expectPunct(':');
            fields.push({ name: nameToken.value, value: this.parseValue() });
            const next = this.peek();
            if (next?.kind === 'punct' && next.value === ',') this.next();
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${token.value} in a value`);
      default:
        throw new Error('unexpected token in a value');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(value: GqlValue, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(selection: GqlSelection, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.arguments) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

class UnknownField extends Error {
  readonly field: string;
  readonly typeName: string;

  constructor(field: string, typeName: string) {
    super(`Cannot query field "${field}" on type "${typeName}".`);
    this.field = field;
    this.typeName = typeName;
  }
}

interface NodeValue {
  __type: string;
  __value: unknown;
}

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'TOPIC', 'CODE', 'WIKI', 'PROJECT', 'ORGANIZATION', 'TEAM', 'APP', 'GIST', 'RELEASE'],
};

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqFromCursor(cursor: string | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export class GraphqlExecutor {
  private errors: Array<{ message: string }> = [];
  private readonly forge: Forge;

  constructor(forge: Forge) {
    this.forge = forge;
  }

  executeOperation(operation: GqlOperation, variables: Variables): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    this.errors = [];
    const data: Record<string, unknown> = {};
    const isMutation = operation.kind === 'mutation';
    for (const selection of operation.selections) {
      const key = selection.alias ?? selection.name;
      try {
        data[key] = this.resolveRoot(selection, variables, isMutation);
      } catch (err) {
        if (err instanceof UnknownField) {
          this.errors.push({ message: err.message });
          continue;
        }
        throw err;
      }
    }
    return this.errors.length ? { data, errors: this.errors } : { data };
  }

  private resolveRoot(selection: GqlSelection, variables: Variables, isMutation: boolean): unknown {
    const args = argsOf(selection, variables);
    if (!isMutation) {
      switch (selection.name) {
        case 'viewer':
          return this.resolveFields('User', { __type: 'User', __value: this.forge.viewer }, selection.selections, variables);
        case 'repository': {
          const owner = args.owner as string;
          const name = args.name as string;
          const repo = this.forge.isViewerOwner(owner) ? this.forge.getRepo(owner, name) : undefined;
          if (!repo) return null;
          return this.resolveFields('Repository', { __type: 'Repository', __value: repo }, selection.selections, variables);
        }
        case 'node': {
          const node = this.resolveNode(args.id as string);
          if (!node) return null;
          return this.resolveFields('Node', node, selection.selections, variables);
        }
        case '__type': {
          const typeName = args.name as string;
          return this.resolveTypeFields(typeName, selection.selections, variables);
        }
        default:
          throw new UnknownField(selection.name, 'Query');
      }
    }
    switch (selection.name) {
      case 'createIssue':
        return this.mutateCreateIssue(args.input as Record<string, unknown>, selection.selections, variables);
      case 'closeIssue':
        return this.mutateCloseIssue(args.input as Record<string, unknown>, selection.selections, variables);
      case 'createPullRequest':
        return this.mutateCreatePullRequest(args.input as Record<string, unknown>, selection.selections, variables);
      case 'mergePullRequest':
        return this.mutateMergePullRequest(args.input as Record<string, unknown>, selection.selections, variables);
      case 'addComment':
        return this.mutateAddComment(args.input as Record<string, unknown>, selection.selections, variables);
      default:
        throw new UnknownField(selection.name, 'Mutation');
    }
  }

  private resolveNode(id: string): NodeValue | null {
    if (typeof id !== 'string' || !id.startsWith('R_')) return null;
    try {
      const text = Buffer.from(id.slice(2), 'base64url').toString('utf8');
      const match = /^github-core-clone-01:(\w+):(.+)$/.exec(text);
      if (!match) return null;
      const kind = match[1] as string;
      const key = match[2] as string;
      if (kind === 'Repository') {
        const [owner, name] = key.split('/');
        if (!owner || !name) return null;
        const repo = this.forge.isViewerOwner(owner) ? this.forge.getRepo(owner, name) : undefined;
        return repo ? { __type: 'Repository', __value: repo } : null;
      }
      if (kind === 'Issue') {
        const [ownerRepo, numberText] = key.split(':');
        const [owner, name] = (ownerRepo ?? '').split('/');
        const issue = this.findIssue(owner, name, Number(numberText));
        return issue ? { __type: 'Issue', __value: issue } : null;
      }
      if (kind === 'PullRequest') {
        const [ownerRepo, numberText] = key.split(':');
        const [owner, name] = (ownerRepo ?? '').split('/');
        const pull = this.findPull(owner, name, Number(numberText));
        return pull ? { __type: 'PullRequest', __value: pull } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private findRepoByGlobalId(globalId: string): Repo | null {
    const node = this.resolveNode(globalId);
    return node && node.__type === 'Repository' ? (node.__value as Repo) : null;
  }

  private findIssue(owner: string | undefined, name: string | undefined, number: number): { repo: Repo; issue: Issue } | null {
    if (!owner || !name || !Number.isInteger(number)) return null;
    const repo = this.forge.isViewerOwner(owner) ? this.forge.getRepo(owner, name) : undefined;
    if (!repo) return null;
    const issue = repo.issues.find((item) => item.number === number);
    return issue ? { repo, issue } : null;
  }

  private findPull(owner: string | undefined, name: string | undefined, number: number): { repo: Repo; pull: Pull } | null {
    if (!owner || !name || !Number.isInteger(number)) return null;
    const repo = this.forge.isViewerOwner(owner) ? this.forge.getRepo(owner, name) : undefined;
    if (!repo) return null;
    const pull = repo.pulls.find((item) => item.number === number);
    return pull ? { repo, pull } : null;
  }

  private resolveTypeFields(typeName: string, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        out[key] = names.map((name) => ({ name }));
      } else if (selection.name === 'enumValues') {
        const names = ENUM_VALUES[typeName] ?? [];
        out[key] = names.map((name) => ({ name }));
      } else if (selection.name === 'name') {
        out[key] = typeName;
      } else {
        throw new UnknownField(selection.name, '__Type');
      }
    }
    void variables;
    return out;
  }

  private resolveFields(typeName: string, node: NodeValue, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.name;
      if (selection.inlineType !== undefined) {
        // An inline fragment applies only when the node's type matches.
        if (selection.inlineType !== node.__type) continue;
        Object.assign(out, this.resolveFields(node.__type, node, selection.selections, variables));
        continue;
      }
      try {
        out[key] = this.resolveField(typeName, node, selection, variables);
      } catch (err) {
        if (err instanceof UnknownField) {
          // Partial data: record the error, keep the sibling fields.
          this.errors.push({ message: err.message });
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  private resolveField(typeName: string, node: NodeValue, selection: GqlSelection, variables: Variables): unknown {
    const args = argsOf(selection, variables);
    const value = node.__value;
    // Every node carries its global id, whatever its concrete type.
    if (selection.name === 'id') {
      if (node.__type === 'Repository') return (value as Repo).globalId;
      if (node.__type === 'Issue') return (value as { issue: Issue }).issue.globalId;
      if (node.__type === 'PullRequest') return (value as { pull: Pull }).pull.globalId;
    }
    if (typeName === 'User') {
      const user = value as { login: string; id: number; name: string; email: string };
      if (selection.name === 'login') return user.login;
      if (selection.name === 'id') return user.id;
      if (selection.name === 'name') return user.name;
      throw new UnknownField(selection.name, 'User');
    }
    if (typeName === 'Repository') {
      const repo = value as Repo;
      switch (selection.name) {
        case 'id':
          return repo.globalId;
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'owner':
          return this.resolveFields('RepositoryOwner', { __type: 'RepositoryOwner', __value: repo }, selection.selections, variables);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return this.resolveFields('Ref', { __type: 'Ref', __value: { name: repo.defaultBranch, oid: tip } }, selection.selections, variables);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const found = this.findIssue(repo.owner, repo.name, args.number as number);
          if (!found) return null;
          return this.resolveFields('Issue', { __type: 'Issue', __value: { repo, issue: found.issue } }, selection.selections, variables);
        }
        case 'issues':
          return this.issuesConnection(repo, args, selection.selections, variables);
        case 'pullRequest': {
          const found = this.findPull(repo.owner, repo.name, args.number as number);
          if (!found) return null;
          return this.resolveFields('PullRequest', { __type: 'PullRequest', __value: { repo, pull: found.pull } }, selection.selections, variables);
        }
        case 'pullRequests':
          return this.pullsConnection(repo, args, selection.selections, variables);
        default:
          throw new UnknownField(selection.name, 'Repository');
      }
    }
    if (typeName === 'RepositoryOwner') {
      const repo = value as Repo;
      if (selection.name === 'login') return repo.owner;
      throw new UnknownField(selection.name, 'RepositoryOwner');
    }
    if (typeName === 'Ref') {
      const ref = value as { name: string; oid: string };
      if (selection.name === 'name') return ref.name;
      if (selection.name === 'target') return ref.oid;
      throw new UnknownField(selection.name, 'Ref');
    }
    if (typeName === 'Issue') {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      void repo;
      switch (selection.name) {
        case 'id':
          return issue.globalId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        default:
          throw new UnknownField(selection.name, 'Issue');
      }
    }
    if (typeName === 'PullRequest') {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      switch (selection.name) {
        case 'id':
          return pull.globalId;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return this.forge.mergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'createdAt':
          return pull.createdAt;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = this.forge.pullFiles(repo, pull).slice(0, first);
          return this.resolveFields('PullRequestFileConnection', { __type: 'PullRequestFileConnection', __value: files }, selection.selections, variables);
        }
        default:
          throw new UnknownField(selection.name, 'PullRequest');
      }
    }
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
      const items = value as unknown[];
      if (selection.name === 'nodes') {
        const typeFor = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
        return items.map((item) => this.resolveFields(typeFor, { __type: typeFor, __value: item }, selection.selections, variables));
      }
      throw new UnknownField(selection.name, typeName);
    }
    if (typeName === 'PullRequestFile') {
      const file = value as { filename: string; status: string; additions: number; deletions: number; changes: number };
      if (selection.name === 'path') return file.filename;
      if (selection.name === 'additions') return file.additions;
      if (selection.name === 'deletions') return file.deletions;
      if (selection.name === 'changeType') return file.status;
      throw new UnknownField(selection.name, 'PullRequestFile');
    }
    throw new UnknownField(selection.name, typeName);
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    let issues = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    if (orderBy?.field === 'CREATED_AT') {
      issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    } else {
      issues.sort((a, b) => b.seq - a.seq);
    }
    const afterSeq = seqFromCursor(args.after as string | undefined);
    if (afterSeq !== null) issues = issues.filter((issue) => issue.seq < afterSeq);
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > page.length;
    const endCursor = page.length ? cursorFor(page[page.length - 1]?.seq ?? 0) : null;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') {
        out[key] = page.map((issue) => this.resolveFields('Issue', { __type: 'Issue', __value: { repo, issue } }, selection.selections, variables));
      } else if (selection.name === 'pageInfo') {
        const pageInfo: Record<string, unknown> = {};
        for (const field of selection.selections) {
          if (field.name === 'hasNextPage') pageInfo.hasNextPage = hasNextPage;
          else if (field.name === 'endCursor') pageInfo.endCursor = endCursor;
          else throw new UnknownField(field.name, 'PageInfo');
        }
        out[key] = pageInfo;
      } else {
        throw new UnknownField(selection.name, 'IssueConnection');
      }
    }
    return out;
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    let pulls = [...repo.pulls];
    pulls.sort((a, b) => b.seq - a.seq);
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    const page = pulls.slice(0, first);
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') {
        out[key] = page.map((pull) => this.resolveFields('PullRequest', { __type: 'PullRequest', __value: { repo, pull } }, selection.selections, variables));
      } else {
        throw new UnknownField(selection.name, 'PullRequestConnection');
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // mutations
  // -------------------------------------------------------------------------------------------

  private mutateCreateIssue(input: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const repo = this.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) throw new Error('repository not found');
    const created = this.forge.createIssue(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
    });
    if ('error' in created) throw new Error(created.error);
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.name === 'issue') {
        out[selection.alias ?? 'issue'] = this.resolveFields('Issue', { __type: 'Issue', __value: { repo, issue: created.issue } }, selection.selections, variables);
      } else {
        throw new UnknownField(selection.name, 'CreateIssuePayload');
      }
    }
    return out;
  }

  private mutateCloseIssue(input: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const node = this.resolveNode(String(input.issueId ?? ''));
    if (!node || node.__type !== 'Issue') throw new Error('issue not found');
    const { repo, issue } = node.__value as { repo: Repo; issue: Issue };
    issue.state = 'closed';
    issue.updatedAt = this.forge.isoNow();
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.name === 'issue') {
        out[selection.alias ?? 'issue'] = this.resolveFields('Issue', { __type: 'Issue', __value: { repo, issue } }, selection.selections, variables);
      } else {
        throw new UnknownField(selection.name, 'CloseIssuePayload');
      }
    }
    return out;
  }

  private mutateCreatePullRequest(input: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const repo = this.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) throw new Error('repository not found');
    const created = this.forge.createPull(repo, {
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
    });
    if ('error' in created) throw new Error(created.error);
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.name === 'pullRequest') {
        out[selection.alias ?? 'pullRequest'] = this.resolveFields('PullRequest', { __type: 'PullRequest', __value: { repo, pull: created.pull } }, selection.selections, variables);
      } else {
        throw new UnknownField(selection.name, 'CreatePullRequestPayload');
      }
    }
    return out;
  }

  private mutateMergePullRequest(input: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const node = this.resolveNode(String(input.pullRequestId ?? ''));
    if (!node || node.__type !== 'PullRequest') throw new Error('pull request not found');
    const { repo, pull } = node.__value as { repo: Repo; pull: Pull };
    const mergeSha = this.forge.mergePull(repo, pull);
    if (mergeSha === null) throw new Error('merge conflict');
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.name === 'pullRequest') {
        out[selection.alias ?? 'pullRequest'] = this.resolveFields('PullRequest', { __type: 'PullRequest', __value: { repo, pull } }, selection.selections, variables);
      } else {
        throw new UnknownField(selection.name, 'MergePullRequestPayload');
      }
    }
    return out;
  }

  private mutateAddComment(input: Record<string, unknown>, selections: GqlSelection[], variables: Variables): Record<string, unknown> {
    const node = this.resolveNode(String(input.subjectId ?? ''));
    if (!node || node.__type !== 'Issue') throw new Error('subject not found');
    const { repo, issue } = node.__value as { repo: Repo; issue: Issue };
    const comment = this.forge.addComment(repo, issue, String(input.body ?? ''));
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const field of selection.selections) {
          if (field.name === 'node') {
            const nodeOut: Record<string, unknown> = {};
            for (const sub of field.selections) {
              if (sub.name === 'id') nodeOut.id = comment.globalId;
              else if (sub.name === 'body') nodeOut.body = comment.body;
              else throw new UnknownField(sub.name, 'IssueComment');
            }
            edge.node = nodeOut;
          } else {
            throw new UnknownField(field.name, 'IssueCommentEdge');
          }
        }
        out[selection.alias ?? 'commentEdge'] = edge;
      } else {
        throw new UnknownField(selection.name, 'AddCommentPayload');
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export async function handleGraphql(request: IncomingMessage, response: ServerResponse, forge: Forge): Promise<void> {
  const requestId = newRequestId();
  const headers = { 'x-github-request-id': requestId };
  if (!isAuthorized(request, forge)) {
    errorJson(response, 401, 'Bad credentials', headers);
    return;
  }
  const body = await readBody(request);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    errorJson(response, 400, 'Invalid JSON body', headers);
    return;
  }
  const executor = new GraphqlExecutor(forge);
  const run = (payload: unknown): Record<string, unknown> => {
    if (!isRecord(payload) || typeof payload.query !== 'string') {
      return { data: null, errors: [{ message: 'A query is required.' }] };
    }
    const variables = isRecord(payload.variables) ? (payload.variables as Variables) : {};
    let operations: GqlOperation[];
    try {
      operations = new Parser(tokenize(payload.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query.' }] };
    }
    const operation = operations[0];
    if (!operation) return { data: null, errors: [{ message: 'The document holds no operation.' }] };
    try {
      return executor.executeOperation(operation, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error.' }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(response, 200, parsed.value.map((item) => run(item)), headers);
    return;
  }
  sendJson(response, 200, run(parsed.value), headers);
}
