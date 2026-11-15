// The git smart-HTTP surface: info/refs advertisements (v2 for upload-pack when the client asks
// for it, v0 otherwise and always for receive-pack), v2 ls-refs/fetch, v0 fetch, and receive-pack
// pushes. Framing follows the kit's git-client exactly: pkt-lines, sideband band 1 for packs and
// push reports, plain-object packs out, full delta resolution in.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { errorJson, sendRaw } from './httputil.ts';
import { peelInRepo, type Forge, type Repo } from './store.ts';

const AGENT = 'github-core-clone-01/1.0';
const ZERO_OID = '0'.repeat(40);

interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  refs.push({
    name: 'HEAD',
    oid: tip ?? ZERO_OID,
    symrefTarget: defaultRef,
    unborn: tip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: AdvertisedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelInRepo(repo, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const base = [`symref=HEAD:refs/heads/${repo.defaultBranch}`];
  if (service === 'git-upload-pack') {
    base.push('side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack', 'shallow', `agent=${AGENT}`);
  } else {
    base.push('report-status', 'side-band-64k', 'delete-refs', `agent=${AGENT}`);
  }
  return base.join(' ');
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const refs = sortedRefs(repo);
  const head = refs[0] as AdvertisedRef;
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (head.unborn) {
    items.push(`${ZERO_OID} capabilities^{}\0${v0Capabilities(service, repo)}\n`);
  } else {
    items.push(`${head.oid} HEAD\0${v0Capabilities(service, repo)}\n`);
    for (const ref of refs.slice(1)) {
      items.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  return encodePktLines(items);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn peel symrefs ref-prefix\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

export function handleInfoRefs(
  request: IncomingMessage,
  response: ServerResponse,
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = forge.getRepo(owner, repoName);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    errorJson(response, 400, `unknown service ${service}`);
    return;
  }
  if (!repo || !forge.isViewerOwner(owner)) {
    errorJson(response, 404, 'Not Found');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && request.headers['git-protocol'] === 'version=2';
  const body = wantsV2 ? v2Advertisement(repo) : v0Advertisement(service, repo);
  sendRaw(response, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------------------------
// pkt-body parsing
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

function parsePktBody(body: Buffer): { sections: string[][] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'delim') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'response-end') continue;
    if (packet.kind === 'data') {
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8'));
    }
  }
  return { sections };
}

function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function lsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  for (const ref of sortedRefs(repo)) {
    if (ref.unborn) {
      if (!unborn) continue;
      if (!keep('HEAD')) continue;
      lines.push(`unborn HEAD${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const peel = (oid: string): string | null => peelInRepo(repo, oid);
  // Walk objects from `commits`, stopping at the parents of any commit in `stopAt` (a shallow
  // boundary is included with its tree, but not its ancestry). Tag roots are visited as objects.
  const collectObjects = (roots: Iterable<string>, stopAt: ReadonlySet<string>): Map<string, GitObject> => {
    const objects = new Map<string, GitObject>();
    const visitObject = (oid: string): void => {
      if (objects.has(oid)) return;
      const object = lookup(oid);
      if (!object) return;
      objects.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        if (!stopAt.has(oid)) for (const parent of commit.parents) visitObject(parent);
        visitObject(commit.tree);
      } else if (object.type === 'tag') {
        visitObject(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') visitObject(entry.oid);
        }
      }
    };
    for (const root of roots) visitObject(root);
    return objects;
  };
  // Peel wants to commits and measure each commit's shortest distance from any want.
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    const peeled = peel(want);
    if (peeled === null) continue;
    if (!distances.has(peeled)) {
      distances.set(peeled, 0);
      queue.push({ oid: peeled, depth: 0 });
    }
  }
  const cutoff = request.depth !== null ? request.depth - 1 : Number.POSITIVE_INFINITY;
  const explicitCutoffs = new Set<string>();
  if (request.depth === null) {
    for (const boundary of request.shallow) {
      const peeled = peel(boundary);
      if (peeled !== null) explicitCutoffs.add(peeled);
    }
  }
  const sendCommits = new Set<string>();
  const boundaries = new Set<string>();
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    sendCommits.add(oid);
    if (depth === cutoff || explicitCutoffs.has(oid)) {
      boundaries.add(oid);
      continue;
    }
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) {
        distances.set(parent, depth + 1);
        queue.push({ oid: parent, depth: depth + 1 });
      }
    }
  }
  const unshallow: string[] = [];
  if (request.depth !== null) {
    for (const old of request.shallow) {
      const peeled = peel(old);
      if (peeled !== null && sendCommits.has(peeled) && !boundaries.has(peeled)) unshallow.push(old);
    }
  }
  const objects = collectObjects([...sendCommits, ...request.wants], boundaries);
  // What the client already has: the closure of its haves, stopped at the shallow boundaries it
  // declared. A shallow clone's have is only the boundary commit and its tree — the ancestry
  // below the boundary is exactly what a deepen fetch must deliver, so it must not be subtracted.
  const declaredBoundaries = new Set<string>();
  for (const boundary of request.shallow) {
    const peeled = peel(boundary);
    if (peeled !== null) declaredBoundaries.add(peeled);
  }
  const haveObjects = collectObjects(request.haves, declaredBoundaries);
  for (const oid of haveObjects.keys()) objects.delete(oid);
  return { objects, shallow: [...boundaries].sort(), unshallow };
}

function sortedPack(objects: Map<string, GitObject>): Buffer {
  const entries = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return writePack(entries.map((entry) => entry[1]));
}

function fetchCacheKey(request: FetchRequest): string {
  return JSON.stringify({
    w: [...request.wants].sort(),
    h: [...request.haves].sort(),
    s: [...request.shallow].sort(),
    d: request.depth,
  });
}

/**
 * The pack for a fetch, cached per repo: identical fetches (the benchmark's 50 concurrent
 * shallow clones of one tip) build the pack once. The cache is cleared on every mutation, so a
 * cached pack always matches the repo's current state, and pack bytes are deterministic anyway.
 */
function getFetchPack(repo: Repo, request: FetchRequest): { pack: Buffer | null; shallow: string[]; unshallow: string[] } {
  const key = fetchCacheKey(request);
  const cached = repo.fetchCache.get(key);
  if (cached) return cached;
  const plan = planFetch(repo, request);
  const result = { pack: plan.objects.size ? sortedPack(plan.objects) : null, shallow: plan.shallow, unshallow: plan.unshallow };
  if (repo.fetchCache.size >= 16) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, result);
  return result;
}

function v2FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = getFetchPack(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length) {
    const lines: Array<string | 'delim'> = ['acknowledgments\n'];
    for (const have of request.haves) {
      if (repo.objects.has(have) || peelInRepo(repo, have) !== null) lines.push(`ACK ${have}\n`);
    }
    lines.push('ready\n', 'delim');
    parts.push(encodePktLines(lines));
  }
  if (shallow.length || unshallow.length) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (pack !== null) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPackets(pack));
  } else {
    parts.push(pktFlush);
  }
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = getFetchPack(repo, request);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (request.haves.length) {
    let acked = false;
    for (const have of request.haves) {
      if (repo.objects.has(have) || peelInRepo(repo, have) !== null) {
        lines.push(`ACK ${have}\n`);
        acked = true;
      }
    }
    if (!acked) lines.push('NAK\n');
  } else {
    lines.push('NAK\n');
  }
  for (const oid of shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
  if (lines.length) parts.push(encodePktLines(lines));
  if (pack !== null) {
    parts.push(sidebandPackets(pack));
  } else {
    parts.push(pktFlush);
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(
  request: IncomingMessage,
  response: ServerResponse,
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo || !forge.isViewerOwner(owner)) {
    errorJson(response, 404, 'Not Found');
    return;
  }
  const parsed = parsePktBody(body);
  if (!parsed) {
    errorJson(response, 400, 'malformed pkt-line body');
    return;
  }
  const isV2 = request.headers['git-protocol'] === 'version=2';
  const sections = parsed.sections.filter((section) => section.length > 0);
  if (isV2) {
    const command = (sections[0]?.[0] ?? '').trim();
    const args = (sections[1] ?? []).map((line) => line.trim()).filter(Boolean);
    if (command === 'command=ls-refs') {
      sendRaw(response, 200, 'application/x-git-upload-pack-result', lsRefsV2(repo, args));
      return;
    }
    if (command === 'command=fetch') {
      const fetchRequest: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetchRequest.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchRequest.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchRequest.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) fetchRequest.depth = Number(arg.slice(7).trim());
        else if (arg === 'thin-pack') fetchRequest.thinPack = true;
      }
      if (!fetchRequest.wants.length || fetchRequest.wants.some((want) => !isObjectId(want))) {
        errorJson(response, 400, 'fetch needs at least one valid want');
        return;
      }
      sendRaw(response, 200, 'application/x-git-upload-pack-result', v2FetchResponse(repo, fetchRequest));
      return;
    }
    errorJson(response, 400, `unknown v2 command ${JSON.stringify(command)}`);
    return;
  }
  // v0: section 0 = wants (+ shallow/deepen), section 1 = haves + done.
  const fetchRequest: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  for (const line of sections[0] ?? []) {
    const text = line.trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      fetchRequest.wants.push(rest.split(/\s+/)[0] as string);
    } else if (text.startsWith('shallow ')) fetchRequest.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) fetchRequest.depth = Number(text.slice(7).trim());
  }
  for (const line of sections[1] ?? []) {
    const text = line.trim();
    if (text.startsWith('have ')) fetchRequest.haves.push(text.slice(5).trim());
  }
  if (!fetchRequest.wants.length || fetchRequest.wants.some((want) => !isObjectId(want))) {
    errorJson(response, 400, 'fetch needs at least one valid want');
    return;
  }
  sendRaw(response, 200, 'application/x-git-upload-pack-result', v0FetchResponse(repo, fetchRequest));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  request: IncomingMessage,
  response: ServerResponse,
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo || !forge.isViewerOwner(owner)) {
    errorJson(response, 404, 'Not Found');
    return;
  }
  const report = (lines: string[]): void => {
    const stream = encodePktLines(lines);
    sendRaw(response, 200, 'application/x-git-receive-pack-result', Buffer.concat([
      encodePktLine(Buffer.concat([Buffer.from([1]), stream])),
      pktFlush,
    ]));
  };
  // Split the command list (pkt-lines up to the first flush) from the pack that follows it.
  let flushOffset = -1;
  {
    let offset = 0;
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        flushOffset = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) break;
      offset += length;
    }
  }
  if (flushOffset < 0) {
    errorJson(response, 400, 'malformed push: no command flush');
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body.subarray(0, flushOffset));
  } catch {
    errorJson(response, 400, 'malformed push commands');
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text);
    if (!match) {
      errorJson(response, 400, 'malformed push command');
      return;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (!commands.length) {
    errorJson(response, 400, 'push needs at least one command');
    return;
  }
  // Unpack first: the objects land in the store even when a ref update is refused.
  const packBytes = body.subarray(flushOffset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      forge.touch(repo);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}\n`);
    for (const command of commands) lines.push(`ng ${command.ref} unpack error\n`);
    report(lines);
    return;
  }
  lines.push('unpack ok\n');
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let refsChanged = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const fail = (reason: string): void => {
      lines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) fail('ref does not exist');
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) fail('stale ref');
      else {
        repo.refs.delete(command.ref);
        refsChanged = true;
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const newObject = lookup(command.newOid);
    if (!newObject) {
      fail('object not found');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) fail('already exists');
      else {
        repo.refs.set(command.ref, command.newOid);
        refsChanged = true;
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      fail('ref does not exist');
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale ref');
      continue;
    }
    if (command.oldOid === command.newOid) {
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    // Fast-forward only: the old tip must be an ancestor of the new one.
    if (!isAncestor(command.oldOid, command.newOid, lookup)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
    lines.push(`ok ${command.ref}\n`);
  }
  if (refsChanged) forge.touch(repo);
  report(lines);
}
