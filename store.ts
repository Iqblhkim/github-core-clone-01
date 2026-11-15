// The forge's in-memory state: repositories (with their git object stores and refs), issues,
// labels, comments and pull requests, plus the operations the surfaces share (contents commits,
// three-way merges, diffs). No persistence: one trial is one process. No wall clock: every
// timestamp comes from MAKEFUN_TRIAL_NOW plus a monotonic sequence, so two runs that receive the
// same requests produce the same bytes.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { scenarioIdentities, type ScenarioUser } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  seq: number;
  createdAt: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
}

export interface Repo {
  id: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  labels: Map<string, Label>;
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  /** Cleared on every mutation; lets repeated identical fetches reuse one built pack. */
  fetchCache: Map<string, { pack: Buffer | null; shallow: string[]; unshallow: string[] }>;
}

export interface FileChange {
  path: string;
  content: Buffer | null; // null deletes
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Multiset line diff: lines present in `next` but not in `prev` count as added, and vice versa. */
function lineDiff(prev: string, next: string): { additions: number; deletions: number } {
  const prevLines = prev === '' ? [] : prev.split('\n');
  const nextLines = next === '' ? [] : next.split('\n');
  if (prevLines.length > 0 && prevLines[prevLines.length - 1] === '') prevLines.pop();
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
  const prevCounts = new Map<string, number>();
  for (const line of prevLines) prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of nextLines) {
    const left = prevCounts.get(line) ?? 0;
    if (left > 0) prevCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of prevCounts.values()) deletions += left;
  return { additions, deletions };
}

export class Forge {
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private seq = 0;
  private readonly nowBaseSec: number;

  constructor() {
    const identities = scenarioIdentities();
    this.viewer = identities.viewer;
    this.stranger = identities.stranger;
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let base = 1_700_000_000;
    if (/^\d+$/.test(raw)) base = Number(raw);
    else if (raw !== '') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
    }
    this.nowBaseSec = base;
  }

  /** A strictly increasing logical second, from the trial's now. */
  tickSec(): number {
    this.seq += 1;
    return this.nowBaseSec + this.seq;
  }

  isoNow(): string {
    return new Date(this.tickSec() * 1000).toISOString();
  }

  identityLine(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  globalId(kind: string, key: string): string {
    return `R_${base64url(`github-core-clone-01:${kind}:${key}`)}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** The viewer owns every repository this forge holds; any other owner is a 404. */
  isViewerOwner(owner: string): boolean {
    return owner === this.viewer.login;
  }

  createRepo(input: { name: string; private?: boolean; description?: string; defaultBranch?: string }): { repo: Repo; created: boolean } {
    const existing = this.getRepo(this.viewer.login, input.name);
    if (existing) return { repo: existing, created: false };
    const now = this.isoNow();
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      globalId: this.globalId('Repository', `${this.viewer.login}/${input.name}`),
      owner: this.viewer.login,
      name: input.name,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      labels: new Map(),
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      fetchCache: new Map(),
    };
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return { repo, created: true };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === this.viewer.login)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Mark a repo as mutated: any cached fetch pack for it is now stale. */
  touch(repo: Repo): void {
    repo.fetchCache.clear();
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.fetchCache.clear();
    }
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string): GitObject | undefined => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, full ref, or commit oid to a commit oid. */
  resolveToCommit(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const peeled = peelToCommit(ref, this.lookup(repo));
      return peeled ?? undefined;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(full);
    if (!oid) return undefined;
    return peelToCommit(oid, this.lookup(repo)) ?? undefined;
  }

  /** The file map at a commit: path -> {oid, mode}. Built by flattening the tree. */
  fileMapAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const treeOid = parseCommit(commit.data).tree;
    const walk = (tree: string, prefix: string): void => {
      const object = repo.objects.get(tree);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build the tree objects for a file map; returns the root tree oid. */
  buildTreeForFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Commit `changes` on `branch` (default branch when omitted). Creates the branch when the repo
   * is unborn. Returns the new commit oid.
   */
  commitFiles(
    repo: Repo,
    options: { branch?: string; changes: readonly FileChange[]; message: string },
  ): { commitSha: string; branch: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const files = tip ? this.fileMapAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
    for (const change of options.changes) {
      if (change.content === null) files.delete(change.path);
      else {
        const blobOid = this.putObject(repo, 'blob', change.content);
        files.set(change.path, { oid: blobOid, mode: '100644' });
      }
    }
    const treeOid = this.buildTreeForFiles(repo, files);
    const timestamp = this.tickSec();
    const who = this.identityLine();
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip ? [tip] : [],
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
      author: who,
      committer: who,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, branch };
  }

  /** Commits reachable from `tip`, newest first (depth-first pre-order over parents). */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * Three-way merge of the file maps: base (merge-base), head, ours (base tip). Returns the
   * merged map and whether any path conflicts (both sides changed it differently).
   */
  threeWayMerge(
    base: Map<string, { oid: string; mode: string }>,
    head: Map<string, { oid: string; mode: string }>,
    ours: Map<string, { oid: string; mode: string }>,
  ): { merged: Map<string, { oid: string; mode: string }>; conflict: boolean } {
    const merged = new Map<string, { oid: string; mode: string }>(ours);
    let conflict = false;
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...ours.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const o = ours.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) continue; // head did not change it
      if (same(o, b)) {
        // ours did not change it: take head's version
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (same(o, h)) continue; // both changed it the same way
      conflict = true;
    }
    return { merged, conflict };
  }

  /** The changed files between two file maps, with line counts. */
  diffFiles(
    base: Map<string, { oid: string; mode: string }>,
    head: Map<string, { oid: string; mode: string }>,
    repo: Repo,
  ): DiffFile[] {
    const out: DiffFile[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const textOf = (oid?: string): string => {
        if (oid === undefined) return '';
        const object = repo.objects.get(oid);
        return object && object.type === 'blob' ? object.data.toString('utf8') : '';
      };
      if (b === undefined && h !== undefined) {
        const additions = countLines(textOf(h.oid));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const deletions = countLines(textOf(b.oid));
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined) {
        const { additions, deletions } = lineDiff(textOf(b.oid), textOf(h.oid));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): { issue: Issue } | { error: string } {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `label "${name}" does not exist` };
    }
    const number = repo.nextIssueNumber++;
    const now = this.isoNow();
    const issue: Issue = {
      id: this.nextRepoId * 100000 + repo.id * 1000 + number,
      globalId: this.globalId('Issue', `${repo.owner}/${repo.name}:${number}`),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.seq,
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return { issue };
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = this.nextCommentId++;
    const comment: Comment = {
      id,
      globalId: this.globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${id}`),
      body,
      seq: this.seq,
      createdAt: this.isoNow(),
    };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body?: string },
  ): { pull: Pull } | { error: string } {
    const headTip = this.resolveToCommit(repo, input.head);
    const baseTip = this.resolveToCommit(repo, input.base);
    if (headTip === undefined) return { error: `head branch "${input.head}" does not exist` };
    if (baseTip === undefined) return { error: `base branch "${input.base}" does not exist` };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    const number = repo.nextPullNumber++;
    const now = this.isoNow();
    const pull: Pull = {
      id: this.nextRepoId * 100000 + repo.id * 1000 + number,
      globalId: this.globalId('PullRequest', `${repo.owner}/${repo.name}:${number}`),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha: headTip,
      baseSha: baseTip,
      seq: this.seq,
      createdAt: now,
    };
    repo.pulls.push(pull);
    return { pull };
  }

  /** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' for a pull request. */
  mergeable(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.resolveToCommit(repo, pull.headRef);
    const baseTip = this.resolveToCommit(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return 'UNKNOWN';
    const { conflict } = this.threeWayMerge(
      this.fileMapAt(repo, base),
      this.fileMapAt(repo, headTip),
      this.fileMapAt(repo, baseTip),
    );
    return conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null when
   * the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    const headTip = this.resolveToCommit(repo, pull.headRef);
    const baseTip = this.resolveToCommit(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return null;
    const { merged, conflict } = this.threeWayMerge(
      this.fileMapAt(repo, base),
      this.fileMapAt(repo, headTip),
      this.fileMapAt(repo, baseTip),
    );
    if (conflict) return null;
    const treeOid = this.buildTreeForFiles(repo, merged);
    const timestamp = this.tickSec();
    const who = this.identityLine();
    const message = pull.body !== '' ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(timestamp * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  /** Files changed by a pull request: merge-base tree vs head tip tree. */
  pullFiles(repo: Repo, pull: Pull): DiffFile[] {
    const headTip = this.resolveToCommit(repo, pull.headRef);
    const baseTip = this.resolveToCommit(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(repo, headTip, baseTip) ?? baseTip;
    return this.diffFiles(this.fileMapAt(repo, base), this.fileMapAt(repo, headTip), repo);
  }
}

export function isAncestorInRepo(repo: Repo, ancestor: string, tip: string): boolean {
  return isAncestor(ancestor, tip, (oid: string) => repo.objects.get(oid));
}

export function reachableInRepo(repo: Repo, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, (oid: string) => repo.objects.get(oid), { allowMissing: true });
}

export function peelInRepo(repo: Repo, oid: string): string | null {
  return peelToCommit(oid, (id: string) => repo.objects.get(id));
}
