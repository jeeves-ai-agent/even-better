// Orchestrates the "New Session" flow: a null-sessionId prompt creates a fresh
// Herdr workspace, starts an agent (Claude by default, or the provider the app
// asked for) in its root pane, waits for it to become interactive-ready, and
// hands the paneId back so index.ts can prompt it through the normal PaneBridge
// path. Kept dependency-injected (NewSessionRpc) so the orchestration itself is
// unit-testable without a live Herdr socket — src/herdr.ts and src/index.ts wire
// the real socket calls.

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { normalizeProvider, PROVIDERS, type Provider } from "./provider.js";

/** Thrown for a client-supplied cwd that fails validation — callers map this to a 400. */
export class InvalidCwdError extends Error {}

/** Thrown for a client-supplied provider that isn't one we know — callers map
 *  this to a 400. */
export class InvalidProviderError extends Error {}

/** Resolves the provider for a New Session request. Omitted (or null/empty) →
 *  `claude`, the pre-existing default. Anything else must name a known provider
 *  or agent kind; an unrecognized value is REJECTED rather than silently
 *  defaulted, because it decides which agent binary herdr launches — a typo
 *  would otherwise quietly start the wrong agent. The accepted value is one of
 *  a fixed set (never the raw request string), and it reaches herdr as an
 *  `agent.start` JSON parameter, never as part of a shell command. */
export function resolveNewSessionProvider(requested: unknown): Provider {
  if (requested === undefined || requested === null || requested === "") return "claude";
  const provider = normalizeProvider(requested);
  if (!provider) {
    const shown = typeof requested === "string" ? requested.slice(0, 40) : typeof requested;
    throw new InvalidProviderError(`unknown provider "${shown}" — use one of: ${PROVIDERS.join(", ")}`);
  }
  return provider;
}

/** Resolves the cwd for a new workspace. A requested cwd must be an absolute,
 *  existing directory or this throws InvalidCwdError; omit it to fall back to
 *  NEW_SESSION_CWD, then HOME, then the server's own cwd. */
export function resolveNewSessionCwd(
  requested: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  if (requested !== undefined) {
    if (typeof requested !== "string") {
      throw new InvalidCwdError(`cwd must be a string, got ${typeof requested}`);
    }
    if (!path.isAbsolute(requested)) {
      throw new InvalidCwdError(`cwd must be an absolute path, got "${requested}"`);
    }
    let isDir = false;
    try {
      isDir = statSync(requested).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new InvalidCwdError(`cwd "${requested}" does not exist or is not a directory`);
    }
    return requested;
  }
  const configured = env.NEW_SESSION_CWD?.trim();
  if (configured) return configured;
  const home = env.HOME?.trim();
  if (home) return home;
  return process.cwd();
}

const READY_POLL_INTERVAL_MS = 500;

/** Polls isReady until it reports true or timeoutMs elapses. `sleep` is
 *  injected so tests can drive this without real wall-clock delay. */
export async function waitUntilReady(
  rpc: { isReady(paneId: string): Promise<boolean> },
  paneId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await rpc.isReady(paneId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(READY_POLL_INTERVAL_MS);
  }
}

let nameCounter = 0;

/** A unique-enough label for a workspace/agent name: timestamp + a per-process
 *  monotonic counter + a random suffix, so two near-simultaneous New Session
 *  requests never collide even within the same millisecond. */
export function uniqueSessionName(prefix: string): string {
  nameCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nameCounter}-${randomBytes(3).toString("hex")}`;
}

/** The Herdr operations createNewSession needs, injected so the orchestration
 *  is testable without a live socket. src/index.ts wires these to src/herdr.ts. */
export interface NewSessionRpc {
  createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }>;
  startAgent(opts: { name: string; paneId: string; timeoutMs: number; kind: string }): Promise<void>;
  isReady(paneId: string): Promise<boolean>;
  closeWorkspace(workspaceId: string): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface CreateNewSessionOptions {
  cwd: string;
  /** The Herdr session name (see herdrSessionName in herdr.ts) — used only to
   *  make the generated workspace/agent name traceable to its session. */
  sessionLabel: string;
  /** herdr's agent kind for the new pane (provider.ts's herdrAgentKind).
   *  Defaults to `claude`, so a caller that doesn't ask for a provider gets the
   *  pre-existing behavior. */
  agentKind?: string;
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CreateNewSessionResult {
  paneId: string;
  workspaceId: string;
}

/** Creates a workspace, starts an agent (opts.agentKind, default claude) in its
 *  root pane, and waits for it to become interactive-ready. On any failure
 *  after the workspace exists, best-effort closes it (so a failed New Session
 *  never leaks an empty workspace) and rethrows the original error — a close
 *  failure is logged but never replaces it. */
export async function createNewSession(
  rpc: NewSessionRpc,
  opts: CreateNewSessionOptions,
): Promise<CreateNewSessionResult> {
  const timeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const name = uniqueSessionName(`eb-new-${opts.sessionLabel}`);
  const { workspaceId, paneId } = await rpc.createWorkspace(opts.cwd, name);
  try {
    await rpc.startAgent({ name, paneId, timeoutMs, kind: opts.agentKind ?? "claude" });
    const ready = await waitUntilReady(rpc, paneId, timeoutMs, opts.sleep);
    if (!ready) {
      throw new Error(`agent did not become interactive-ready within ${timeoutMs}ms`);
    }
    return { paneId, workspaceId };
  } catch (err) {
    try {
      await rpc.closeWorkspace(workspaceId);
    } catch (closeErr) {
      console.error(`[new-session] failed to close leaked workspace ${workspaceId}: ${(closeErr as Error).message}`);
    }
    throw err;
  }
}

/** Waits for `attach()` to resolve truthy — e.g. the caller's own bookkeeping
 *  (index.ts's getBridge map) picking up the pane createNewSession just made,
 *  which can lag a beat behind the mux's own listing. If it never does within
 *  `attempts` tries, closes the workspace so a pane the caller never attached
 *  to doesn't leak the workspace/Claude process createNewSession already
 *  created — the same failure-cleanup contract as createNewSession itself; a
 *  close failure here is likewise logged but never thrown. */
export async function waitForAttach<T>(
  attach: () => Promise<T | undefined>,
  closeWorkspace: (workspaceId: string) => Promise<void>,
  workspaceId: string,
  attempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await attach();
    if (value) return value;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  try {
    await closeWorkspace(workspaceId);
  } catch (closeErr) {
    console.error(`[new-session] failed to close leaked workspace ${workspaceId}: ${(closeErr as Error).message}`);
  }
  return undefined;
}

/** Claude's one-time startup workspace-trust dialog is auto-accepted only for
 *  the server's own configured/default cwd (NEW_SESSION_CWD, HOME, or the
 *  server's own process cwd — see resolveNewSessionCwd) — never for a
 *  caller-supplied cwd, since that value comes from the HTTP request, not the
 *  operator. A caller-supplied cwd's trust dialog is left for a human to
 *  approve through the normal permission/question flow instead. Only meaningful
 *  for a Claude pane — the dialog is Claude's, so callers gate on the provider
 *  before consulting this. */
export function shouldAutoTrustCwd(cwdWasExplicitlyRequested: boolean): boolean {
  return !cwdWasExplicitlyRequested;
}
