import net from "node:net";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Explanation,
  Multiplexer,
  PaneInfo,
  PaneStatus,
  StatusSub,
} from "./multiplexer.js";

// Default is herdr's unnamed session socket. HERDR_SOCKET overrides it so
// even-better can attach to a named session (e.g. `herdr --session jeeves`),
// whose socket lives under .config/herdr/sessions/<name>/herdr.sock.
const SOCKET_PATH =
  process.env.HERDR_SOCKET?.trim() ||
  path.join(os.homedir(), ".config", "herdr", "herdr.sock");

// Methods we allow ourselves to call. Anything server.* is deliberately
// excluded — reload/stop/handoff must never be reachable from the bridge.
const SAFE_METHODS = new Set([
  "agent.list",
  "pane.get",
  "pane.read",
  "pane.send_input",
  "events.subscribe",
  "agent.explain",
  // used by the self-test only:
  "workspace.create",
  "workspace.close",
  "pane.report_agent",
  // New Session flow (new-session.ts): starts a Claude agent in a
  // freshly created workspace's pane. Launches a process in an existing pane
  // only — never reachable to reconfigure or stop the herdr server itself.
  "agent.start",
]);

/** Pulls the session name out of a named-session socket path
 *  (.config/herdr/sessions/<name>/herdr.sock); undefined for the default
 *  (unnamed-session) socket, which has no /sessions/ segment. Pure — takes the
 *  socket path as a parameter so it's testable without touching env/module state. */
function parseHerdrSessionName(socketPath: string): string | undefined {
  const m = socketPath.replace(/\\/g, "/").match(/\/sessions\/([^/]+)\/herdr\.sock$/);
  return m?.[1];
}

/** Derives the Herdr session name the New Session flow labels its new
 *  workspace/agent with — HERDR_SESSION wins when set, else it's parsed from
 *  the socket path. Throws rather than guessing when neither yields a name
 *  (e.g. the default unnamed-session socket with no HERDR_SESSION), since New
 *  Session must create the workspace in the SAME named session the bridge is
 *  attached to, not silently fall back to some other one. Exported as a pure
 *  function (explicit socketPath/envSession) so it's unit-testable; see
 *  herdrSessionName() for the env-reading wrapper actually used at runtime. */
export function deriveHerdrSessionName(socketPath: string, envSession: string | undefined): string {
  const fromEnv = envSession?.trim();
  if (fromEnv) return fromEnv;
  const fromSocket = parseHerdrSessionName(socketPath);
  if (fromSocket) return fromSocket;
  throw new Error(
    `cannot determine the Herdr session name: set HERDR_SESSION explicitly, or point HERDR_SOCKET ` +
      `at a named session's socket (…/sessions/<name>/herdr.sock); current HERDR_SOCKET=${socketPath}`,
  );
}

/** The Herdr session name the running process is attached to, for the New
 *  Session flow (new-session.ts). */
export function herdrSessionName(): string {
  return deriveHerdrSessionName(SOCKET_PATH, process.env.HERDR_SESSION);
}

/** True when herdr's socket is present — used for startup mux auto-selection. */
export function herdrAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    // A stale socket file can linger after herdr exits, so actually connect —
    // a listening server accepts, a dead one refuses (ECONNREFUSED).
    if (!existsSync(SOCKET_PATH)) return resolve(false);
    const conn = net.connect(SOCKET_PATH);
    const finish = (v: boolean): void => {
      conn.destroy();
      resolve(v);
    };
    conn.once("connect", () => finish(true));
    conn.once("error", () => finish(false));
    conn.setTimeout(1000, () => finish(false));
  });
}

let seq = 0;

/** One-shot RPC: fresh connection, one request line, one response line. */
export function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!SAFE_METHODS.has(method)) {
    return Promise.reject(new Error(`method not allowed: ${method}`));
  }
  return new Promise((resolve, reject) => {
    const conn = net.connect(SOCKET_PATH);
    let buf = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };
    conn.on("connect", () => {
      conn.write(
        JSON.stringify({ id: `bridge-${++seq}`, method, params }) + "\n",
      );
    });
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      settled = true;
      conn.end();
      try {
        const resp = JSON.parse(line) as {
          result?: T;
          error?: { code: string; message: string };
        };
        if (resp.error) {
          reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        } else {
          resolve(resp.result as T);
        }
      } catch (err) {
        reject(err as Error);
      }
    });
    conn.on("error", fail);
    conn.setTimeout(10_000, () => fail(new Error(`herdr call timeout: ${method}`)));
  });
}

export interface SubscriptionSpec extends Record<string, unknown> {
  type: string;
}

export interface SubscribeHandle {
  close: () => void;
}

/**
 * Long-lived subscription connection. herdr pushes one JSON line per event:
 * {"event":"pane.output_matched","data":{...}}. The connection stays open
 * until closed. onClose fires on any disconnect (caller decides to retry).
 */
export function subscribe(
  subs: SubscriptionSpec[],
  onEvent: (event: string, data: Record<string, unknown>) => void,
  onClose: (err?: Error) => void,
): SubscribeHandle {
  const conn = net.connect(SOCKET_PATH);
  let buf = "";
  let closedByUs = false;
  conn.on("connect", () => {
    conn.write(
      JSON.stringify({
        id: "bridge-sub",
        method: "events.subscribe",
        params: { subscriptions: subs },
      }) + "\n",
    );
  });
  conn.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          event?: string;
          data?: Record<string, unknown>;
          error?: { code: string; message: string };
        };
        if (msg.error) {
          console.error(`[herdr-sub] error: ${msg.error.code}: ${msg.error.message}`);
        } else if (msg.event) {
          onEvent(msg.event, msg.data ?? {});
        }
        // the initial {id, result:{type:"subscription_started"}} ack is ignored
      } catch {
        // ignore unparseable lines
      }
    }
  });
  conn.on("error", (err) => {
    if (!closedByUs) onClose(err);
  });
  conn.on("close", () => {
    if (!closedByUs) onClose();
  });
  return {
    close: () => {
      closedByUs = true;
      conn.end();
    },
  };
}

// ── typed wrappers ─────────────────────────────────────

export interface AgentInfo {
  terminal_id: string;
  agent: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  agent_session?: { source: string; agent: string; kind: string; value: string };
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd: string;
  interactive_ready?: boolean;
}

export async function agentList(): Promise<AgentInfo[]> {
  const r = await call<{ agents: AgentInfo[] }>("agent.list");
  return r.agents ?? [];
}

// ── New Session flow (new-session.ts) ──────────────────

export interface WorkspaceCreateResult {
  workspaceId: string;
  paneId: string;
}

/** Creates a workspace (unfocused, so it doesn't steal the terminal's
 *  foreground) and returns its root pane — the pane New Session starts a
 *  Claude agent in. */
export async function workspaceCreate(cwd: string, label: string): Promise<WorkspaceCreateResult> {
  const r = await call<{
    workspace: { workspace_id: string };
    root_pane: { pane_id: string };
  }>("workspace.create", { cwd, label, focus: false });
  return { workspaceId: r.workspace.workspace_id, paneId: r.root_pane.pane_id };
}

export async function workspaceClose(workspaceId: string): Promise<void> {
  await call("workspace.close", { workspace_id: workspaceId });
}

/** Starts a Claude agent in an existing pane (must be at its interactive shell
 *  prompt — true for a pane workspaceCreate just made). Returns as soon as the
 *  launch is accepted; it does NOT wait for interactive readiness — poll
 *  paneInteractiveReady for that (see new-session.ts's waitUntilReady). Always
 *  passes --remote-control as a Claude executable arg (equivalent to CLI
 *  `herdr agent start ... -- --remote-control`, via AgentStartParams.args in
 *  Herdr 0.7.5's socket schema) so a New Session pane comes up with Claude
 *  Code Remote Control enabled — never --dangerously-skip-permissions, see
 *  index.ts's herdrRpc wiring comment. */
export async function agentStart(opts: { name: string; paneId: string; timeoutMs: number }): Promise<void> {
  const params = {
    name: opts.name,
    kind: "claude",
    pane_id: opts.paneId,
    timeout_ms: opts.timeoutMs,
    args: ["--remote-control"],
  };
  // A pane workspace.create just returned can briefly reject agent.start with
  // agent_pane_busy ("not an available shell") — its shell prompt hasn't
  // finished initializing yet (observed live; not reproducible with a
  // dedicated fresh pane, so likely load-dependent). Bounded retry rather than
  // failing New Session on a race that clears itself in well under a second.
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await call("agent.start", params);
      return;
    } catch (err) {
      const transient = (err as Error).message.startsWith("agent_pane_busy");
      if (!transient || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

/** Whether the agent in `paneId` is ready to receive input (past its startup
 *  banner/trust screen). Reuses the already-allowlisted agent.list rather than
 *  adding a second allowlisted method for a single-pane lookup. */
export async function paneInteractiveReady(paneId: string): Promise<boolean> {
  const agents = await agentList();
  return agents.find((a) => a.pane_id === paneId)?.interactive_ready === true;
}

export async function paneRead(
  paneId: string,
  source: "visible" | "recent" | "recent_unwrapped",
  lines: number,
): Promise<string> {
  const r = await call<{ read: { text: string } }>("pane.read", {
    pane_id: paneId,
    source,
    lines,
  });
  return r.read?.text ?? "";
}

/** Type text into a pane; keys (e.g. ["Enter"]) are pressed after the text. */
export async function sendInput(
  paneId: string,
  text: string,
  keys?: string[],
): Promise<void> {
  const params: Record<string, unknown> = { pane_id: paneId, text };
  if (keys && keys.length > 0) params.keys = keys;
  await call("pane.send_input", params);
}

/**
 * Type text into a pane and submit it with a real Enter key, in two separate
 * send_input calls. Sending text+keys together makes TUI line editors (claude
 * prompt box, zsh ZLE) treat the Enter as part of the paste and the text just
 * sits unsubmitted. Between the two steps we wait (bounded) until the pane
 * visibly echoes the text, mirroring herdr-plus's runCommand pacing.
 */
export async function typeAndSubmit(paneId: string, text: string): Promise<void> {
  await sendInput(paneId, text);
  const probe = text.split("\n")[0].slice(0, 12).trim();
  if (probe) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const visible = await paneRead(paneId, "visible", 40);
        if (visible.includes(probe)) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await sendInput(paneId, "", ["Enter"]);
}

export interface AgentExplain {
  rule?: string;
  state?: string;
  evidence?: string;
  visibleBlocker?: boolean;
}

interface EvaluatedRule {
  id?: string;
  state?: string;
  priority?: number;
  matched?: boolean;
  evidence?: { region_preview?: string };
}

/** Ask herdr WHY it classified a pane's agent state — which detection rule
 *  matched. The socket returns every evaluated rule with a `matched` flag; we
 *  reduce to the highest-priority matched rule (what the CLI reports as the
 *  active `rule:`). Used to type blocked menus without our own regexes. */
export async function agentExplain(target: string): Promise<AgentExplain> {
  const r = await call<{ explain?: { evaluated_rules?: EvaluatedRule[]; state?: string; visible_blocker?: boolean } }>(
    "agent.explain",
    { target },
  );
  const e = r.explain;
  const rules = e?.evaluated_rules ?? [];
  let best: EvaluatedRule | undefined;
  for (const rule of rules) {
    if (!rule.matched) continue;
    if (!best || (rule.priority ?? 0) > (best.priority ?? 0)) best = rule;
  }
  return {
    rule: best?.id,
    state: best?.state ?? e?.state,
    evidence: best?.evidence?.region_preview,
    visibleBlocker: e?.visible_blocker,
  };
}

/** Current agent session id of a pane, if herdr has detected one. */
export async function paneSessionId(paneId: string): Promise<string | undefined> {
  const r = await call<{ pane?: { agent_session?: { value?: string } } }>(
    "pane.get",
    { pane_id: paneId },
  );
  return r.pane?.agent_session?.value ?? undefined;
}

export async function paneExists(paneId: string): Promise<boolean> {
  try {
    await call("pane.get", { pane_id: paneId });
    return true;
  } catch {
    return false;
  }
}

// ── Multiplexer adapter ────────────────────────────────

/** herdr's agent_status vocabulary → the neutral PaneStatus. */
function mapHerdrStatus(s: string | undefined): PaneStatus {
  switch (s) {
    case "working":
      return "busy";
    case "blocked":
      return "awaiting";
    default:
      return "idle";
  }
}

/** Wraps the herdr socket functions above as a Multiplexer. Behavior-preserving:
 *  each method is a thin delegation; the only new logic is normalizing status
 *  and folding the two subscribed event types into one status callback. */
export class HerdrMultiplexer implements Multiplexer {
  readonly name = "herdr";

  async listPanes(): Promise<PaneInfo[]> {
    const agents = await agentList();
    return agents.map((a) => ({
      paneId: a.pane_id,
      agent: a.agent,
      cwd: a.cwd,
      focused: a.focused,
      status: mapHerdrStatus(a.agent_status),
      sessionId: a.agent_session?.value,
    }));
  }

  watchStatus(
    paneId: string,
    onStatus: (s: PaneStatus, session?: string) => void,
    onClose: (err?: Error) => void,
  ): StatusSub {
    return subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: paneId },
        { type: "pane.closed", pane_id: paneId },
      ],
      (event, data) => {
        if (event === "pane.closed") {
          onStatus("closed");
          return;
        }
        if (event === "pane.agent_status_changed") {
          const raw = (data.state as string | undefined) ?? (data.agent_status as string | undefined);
          const session = (data.agent_session as { value?: string } | undefined)?.value;
          onStatus(mapHerdrStatus(raw), session);
        }
      },
      onClose,
    );
  }

  read(paneId: string, lines: number): Promise<string> {
    return paneRead(paneId, "visible", lines);
  }

  send(paneId: string, text: string, keys?: string[]): Promise<void> {
    return sendInput(paneId, text, keys);
  }

  sessionId(paneId: string): Promise<string | undefined> {
    return paneSessionId(paneId);
  }

  exists(paneId: string): Promise<boolean> {
    return paneExists(paneId);
  }

  explain(paneId: string): Promise<Explanation> {
    return agentExplain(paneId);
  }
}
