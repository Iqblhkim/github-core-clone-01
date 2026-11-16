// Entrypoint of the forge: it brings the server up, tells the trial suite
// where to find it, and stays alive until the suite says the trial is over.
//
// The trial handshake, in order:
//   1. the forge binds a port the kernel picks (never 8080 — that is the suite's),
//   2. this process POSTs {"port": <that port>} to $MAKEFUN_ENV_URL/register,
//   3. the suite drives the forge as a client while this process polls
//      GET $MAKEFUN_ENV_URL/done, and
//   4. on {"done": true} the server is closed and the process exits 0.
//
// The forge itself lives in app.ts; this file only owns the handshake and the
// process lifetime. It keeps no state of its own, so nothing here can leak a
// wall clock or a random value into a trial's export.

import { createApp } from './app.ts';

/** How long to wait between /done polls. */
const POLL_GAP_MS = 500;
/** How many times to retry the register call before giving up. */
const REGISTER_TRIES = 3;
/** How long to wait between register retries. */
const REGISTER_GAP_MS = 500;
/** How long to wait for the server socket to drain on shutdown. */
const SHUTDOWN_GRACE_MS = 2000;

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function problemText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The suite's base URL, without a trailing slash. */
function suiteBase(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim();
  if (raw === '') throw new Error('MAKEFUN_ENV_URL is not set');
  return raw.replace(/\/+$/, '');
}

/** Tell the suite which port the forge listens on, with a few retries. */
async function announcePort(base: string, port: number): Promise<void> {
  let lastFailure: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      const text = await reply.text();
      if (!reply.ok) {
        throw new Error(`register answered HTTP ${reply.status}: ${text.slice(0, 120)}`);
      }
      return;
    } catch (err) {
      lastFailure = err;
      if (attempt < REGISTER_TRIES) await pause(REGISTER_GAP_MS);
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

/** Ask the suite whether the trial is finished, until it says yes. */
async function awaitSuiteDone(base: string): Promise<number> {
  let polls = 0;
  for (;;) {
    polls += 1;
    try {
      const reply = await fetch(`${base}/done`);
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return polls;
      }
    } catch {
      // The suite may be briefly unreachable; asking again costs nothing.
    }
    await pause(POLL_GAP_MS);
  }
}

/** Stop accepting traffic and drain the listening socket, with a time cap. */
async function stopServer(server: ReturnType<typeof createApp>): Promise<void> {
  server.closeIdleConnections();
  await Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    pause(SHUTDOWN_GRACE_MS),
  ]);
}

async function run(): Promise<number> {
  let server: ReturnType<typeof createApp> | null = null;
  try {
    const base = suiteBase();
    server = createApp();

    const bound = new Promise<void>((resolve, reject) => {
      const onFailure = (err: Error): void => reject(err);
      server?.once('error', onFailure);
      server?.listen(0, () => {
        server?.removeListener('error', onFailure);
        resolve();
      });
    });
    try {
      await bound;
    } catch (err) {
      console.error(`could not bind the forge: ${problemText(err)}`);
      return 1;
    }

    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    if (port === 0) {
      console.error('forge bound no port');
      return 1;
    }
    console.log(`forge listening on port ${port}`);

    await announcePort(base, port);
    console.log(`registered port ${port} with the suite`);

    const polls = await awaitSuiteDone(base);
    console.log(`suite done after ${polls} polls; stopping`);
    return 0;
  } catch (err) {
    console.error(`forge entrypoint failed: ${problemText(err)}`);
    return 1;
  } finally {
    if (server !== null) await stopServer(server);
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`forge entrypoint failed: ${problemText(err)}`);
    process.exit(1);
  });
