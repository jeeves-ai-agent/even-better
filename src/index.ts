import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import readline from "node:readline";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import {
  disposeAll,
  focusedOrFirstBridge,
  getBridge,
  getOrCreateBridge,
  refreshAgents,
  type PaneBridge,
} from "./bridge.js";
import { emit, getMessages, sseHandler } from "./sse.js";
import { getMux, setMux, type Multiplexer } from "./multiplexer.js";
import {
  HerdrMultiplexer,
  herdrAvailable,
  herdrSessionName,
  workspaceCreate,
  workspaceClose,
  agentStart,
  paneInteractiveReady,
} from "./herdr.js";
import { CmuxMultiplexer, cmuxAvailable } from "./cmux.js";
import {
  createNewSession,
  resolveNewSessionCwd,
  shouldAutoTrustCwd,
  waitForAttach,
  InvalidCwdError,
  type NewSessionRpc,
} from "./new-session.js";
import { readClaudeHistory, readCodexHistory, clampHistoryLimit } from "./history.js";
import { logEvent, eventLogPath, logMode, writesEventLog, consoleLogPath, installConsoleTee } from "./log.js";
import { extractModel, isClaudeTrustPrompt } from "./parse.js";
import { readClaudeModel } from "./transcript.js";
import { readCodexModel } from "./codex-transcript.js";
import { startExpose, exposeProviderNames } from "./expose.js";
import { startHookEndpoint, hookSocketPath } from "./hook-endpoint.js";
import {
  installClaudeHooks,
  uninstallClaudeHooks,
  installCodexHooks,
  uninstallCodexHooks,
  codexHooksFeatureEnabled,
  codexConfigPath,
  hooksInstalled,
} from "./hook-install.js";
import { maskToken, printConnect } from "./connect-url.js";

// Tee the terminal diagnostics to a file before anything logs, so the lines needed to
// diagnose a live issue are on disk without re-running with a flag.
installConsoleTee();

const VERSION = "0.1.0";
const INSTANCE_ID = process.env.INSTANCE_ID ?? String(process.pid);

// CLI: install/uninstall the self-hook and exit, before touching the mux or server.
// (Stage 1 of docs/HOOK-MIGRATION.md — reporting only; the bridge is not wired yet.)
if (process.argv.includes("hook-install")) {
  // Explicit opt-in command (this invocation IS the consent) — install both agents and
  // walk the Codex user through the one manual step (trust) we can't safely automate.
  try {
    const claude = installClaudeHooks();
    console.log(`installed even-better Claude hooks → ${claude}`);
    const codex = installCodexHooks();
    console.log(`installed even-better Codex hooks  → ${codex}`);
    console.log("");
    console.log("Codex needs two manual steps (it won't run untrusted hooks):");
    if (codexHooksFeatureEnabled() === false) {
      console.log(`  1. enable hooks: set \`hooks = true\` under \`[features]\` in ${codexConfigPath()}`);
    } else {
      console.log("  1. hooks feature is already enabled ✓");
    }
    console.log("  2. run `/hooks` inside Codex, review the even-better hooks, and trust them.");
    console.log("");
    console.log("then restart already-running Claude/Codex panes to pick up the hooks.");
  } catch (err) {
    console.error(`hook-install failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}
if (process.argv.includes("hook-uninstall")) {
  try {
    const claude = uninstallClaudeHooks();
    console.log(claude ? `removed even-better Claude hooks ← ${claude}` : "no ~/.claude/settings.json to clean");
    const codex = uninstallCodexHooks();
    console.log(codex ? `removed even-better Codex hooks  ← ${codex}` : "no Codex hooks.json to clean");
    console.log("(Codex trust entries in config.toml, if any, are yours to remove via `/hooks`.)");
  } catch (err) {
    console.error(`hook-uninstall failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "auto") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`error: invalid PORT "${raw}". Use a number, 0, or auto.`);
    return process.exit(1);
  }
  return port;
}

const listenPort = parsePort(process.env.PORT);

// Pick the multiplexer once, before anything touches it. MUX=cmux|herdr forces
// it. Otherwise: use whichever backend is present; if BOTH are, never guess —
// prompt on a TTY, and fail fast without one (so nothing silently mirrors the
// wrong terminal). A missing backend surfaces later as NOT REACHABLE.
type MuxChoice = { name: string; make: () => Multiplexer };

function promptMux(found: MuxChoice[]): Promise<Multiplexer> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = found.map((f, i) => `  ${i + 1}) ${f.name}`).join("\n");
  return new Promise((resolve) => {
    rl.question(`\nMultiple multiplexers detected. Choose one:\n${list}\n> `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      const chosen = found[Number(a) - 1] ?? found.find((f) => f.name === a) ?? found[0];
      resolve(chosen.make());
    });
  });
}

async function selectMux(): Promise<Multiplexer> {
  const pick = (process.env.MUX ?? "").toLowerCase();
  if (pick === "herdr") return new HerdrMultiplexer();
  if (pick === "cmux") return new CmuxMultiplexer();
  if (pick) {
    console.error(`error: unknown MUX "${pick}". Use: herdr, cmux.`);
    return process.exit(1);
  }
  const found: MuxChoice[] = [];
  if (await herdrAvailable()) found.push({ name: "herdr", make: () => new HerdrMultiplexer() });
  if (await cmuxAvailable()) found.push({ name: "cmux", make: () => new CmuxMultiplexer() });
  if (found.length <= 1) return (found[0]?.make ?? (() => new HerdrMultiplexer()))();
  if (!process.stdin.isTTY) {
    const names = found.map((f) => f.name);
    console.error(
      `error: multiple multiplexers detected (${names.join(", ")}) and no TTY to prompt. ` +
        `Set MUX=${names.join("|")} to choose.`,
    );
    return process.exit(1);
  }
  return promptMux(found);
}

setMux(await selectMux());

// The bearer token is process-local by default. Set BRIDGE_TOKEN explicitly
// only when a stable token is wanted for a specific launch.
function resolveToken(): string {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  return randomBytes(24).toString("hex");
}
const TOKEN = resolveToken();
let defaultProvider = "claude";

function providerForAgent(agent: string | undefined): "codex" | "claude" {
  return agent === "codex" ? "codex" : "claude";
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function publicBasePath(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return normalizeBasePath(new URL(raw).pathname);
  } catch {
    console.error(`error: invalid PUBLIC_BASE_URL "${raw}"`);
    return process.exit(1);
  }
}

function normalizePublicAccess(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "none") return undefined;
  if (t === "tailscale-funnel" || t === "funnel") return "funnel";
  if (exposeProviderNames().includes(t)) return t;
  const providers = ["tailscale-funnel", ...exposeProviderNames().filter((n) => n !== "funnel")];
  console.error(`error: unknown PUBLIC_ACCESS "${raw}". Use: none, ${providers.join(", ")}.`);
  return process.exit(1);
}

function resolveQr(raw: string | undefined): boolean {
  if (raw === undefined || raw === "1") return true;
  if (raw === "0") return false;
  console.error(`error: invalid QR "${raw}". Use 1 or 0.`);
  return process.exit(1);
}

function validatePublicAccessBind(raw: string | undefined): void {
  if (!publicAccess) return;
  const b = (raw ?? "auto").trim().toLowerCase();
  if (!b || b === "auto" || b === "local" || b === "localhost" || b === "127.0.0.1") return;
  console.error("error: PUBLIC_ACCESS requires BIND_HOST=auto, local, localhost, or 127.0.0.1 because providers proxy to 127.0.0.1.");
  process.exit(1);
}

const publicAccess = normalizePublicAccess(process.env.PUBLIC_ACCESS);
const publicBase = process.env.PUBLIC_BASE_URL?.trim();
if (publicBase && publicAccess) {
  console.error("error: PUBLIC_BASE_URL and PUBLIC_ACCESS are mutually exclusive; use one external URL source.");
  process.exit(1);
}
if (publicBase && listenPort === 0) {
  console.error(
    "error: PUBLIC_BASE_URL requires a fixed PORT because external proxies cannot follow auto-assigned local ports.",
  );
  process.exit(1);
}
const publicBaseMountPath = publicBasePath(publicBase);
const funnelFallbackPath = publicAccess === "funnel" ? `/eb/${INSTANCE_ID}` : "";
const basePaths = [...new Set([publicBaseMountPath, funnelFallbackPath].filter(Boolean))];
const qrEnabled = resolveQr(process.env.QR);
validatePublicAccessBind(process.env.BIND_HOST);

/** Constant-time token check (avoids leaking the token via comparison timing). */
function tokenMatches(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (!tokenMatches(provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const api = express.Router();
app.use("/api", auth, api);
for (const basePath of basePaths) app.use(`${basePath}/api`, auth, api);

// Log every inbound app request (except the SSE stream itself) for debugging.
api.use((req, _res, next) => {
  if (req.path !== "/events") {
    const sessionId =
      (req.body?.sessionId as string) ??
      (req.query.sessionId as string) ??
      "";
    logEvent("in", sessionId, {
      method: req.method,
      path: req.path,
      ...(req.method === "POST" ? { body: req.body } : { query: req.query }),
    });
  }
  next();
});

// ── even-terminal protocol surface ─────────────────────

api.get("/events", (req, res) => {
  sseHandler(req, res);
  // Push a status snapshot to the fresh client so it knows immediately
  // whether a turn is running. Without this, an app that connects while the
  // agent is idle waits forever for a status/result that never comes (status
  // events are only emitted on transitions).
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    const bridge = getBridge(sessionId);
    if (bridge) {
      emit(sessionId, {
        type: "status",
        state: bridge.state,
        sessionId,
      });
    }
  }
});

api.get("/sessions", async (_req, res) => {
  try {
    const agents = await refreshAgents();
    const sessions = agents.map((a) => ({
      id: a.paneId,
      title: `${a.agent} · ${path.basename(a.cwd || "/")}`,
      timestamp: new Date().toISOString(),
      cwd: a.cwd,
      provider: providerForAgent(a.agent),
      status: getBridge(a.paneId)?.state ?? "idle",
    }));
    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], error: (err as Error).message });
  }
});

api.get("/info", async (_req, res) => {
  let model = "";
  let provider: "codex" | "claude" = "claude";
  try {
    const agents = await refreshAgents();
    const target = agents.find((a) => a.focused) ?? agents[0];
    provider = providerForAgent(target?.agent);
    // Prefer the structured model from the transcript (works for codex too, and
    // is exact); fall back to the claude status-bar scrape only if no session id
    // exists yet.
    if (target?.sessionId) {
      model =
        (target.agent === "codex"
          ? readCodexModel(target.sessionId)
          : readClaudeModel(target.sessionId)) ?? "";
    }
    if (!model && target?.agent === "claude") {
      model = extractModel(await getMux().read(target.paneId, 5));
    }
  } catch {
    // leave model unknown
  }
  res.json({
    account: {},
    model: model || "Unknown",
    version: `${VERSION} (even-better)`,
    provider,
  });
});

api.get("/update-check", (_req, res) => {
  res.json({
    currentVersion: VERSION,
    newestVersion: null,
    updateAvailable: false,
  });
});

// Real Herdr wiring for the New Session flow (src/new-session.ts). The agent
// launches without extra CLI args — a New Session pane behaves exactly like a
// `claude` a human typed into a fresh pane, including normal interactive
// permission prompts (handled by the existing PaneBridge machinery), rather
// than silently granting --dangerously-skip-permissions.
const herdrRpc: NewSessionRpc = {
  createWorkspace: (cwd, label) => workspaceCreate(cwd, label),
  startAgent: (opts) => agentStart(opts),
  isReady: (paneId) => paneInteractiveReady(paneId),
  closeWorkspace: (workspaceId) => workspaceClose(workspaceId),
};

// Claude's one-time "trust this folder?" dialog appears on a brand-new pane's
// very first launch, before any prompt has been sent — left alone it eats the
// first prompt's keystrokes (they land in the dialog, not the chat input), so
// a New Session's first message would silently vanish. Dismissed here, before
// refreshAgents() attaches a PaneBridge, so the pane is a normal ready-for-
// input agent by the time the shared bridge.prompt() path sends the real
// text. Narrowly pattern-matched (isClaudeTrustPrompt) — this never touches
// the general permission machinery, so a real tool-permission prompt during
// the actual conversation still always goes to the human via the app.
//
// Auto-trust policy (review finding #2, .review-fix-1.txt): this function is
// ONLY called for the server's own configured/default cwd (shouldAutoTrustCwd
// in new-session.ts) — never for a caller-supplied cwd, whose value comes
// from the HTTP request rather than the operator. Auto-accepting Claude's
// "let it read/edit/execute files here" prompt on the caller's behalf for an
// arbitrary directory would be an unreviewed grant of exactly the access that
// dialog exists to gate. For a caller-supplied cwd the dialog is left open;
// /api/prompt detects it below and asks the human to approve it explicitly
// (via the normal user_question the blocked pane already surfaces) instead of
// silently bypassing it.
async function dismissStartupTrustPrompt(paneId: string): Promise<void> {
  const mux = getMux();
  for (let attempt = 0; attempt < 10; attempt++) {
    const screen = await readStableScreen(mux, paneId);
    if (screen === null) return; // pane gone
    if (!isClaudeTrustPrompt(screen)) return; // stable AND not the dialog — genuinely done
    await mux.send(paneId, "", ["Enter"]);
  }
}

// Reads paneId's screen, waiting for it to stop changing (two consecutive
// identical, non-blank reads) before returning it. A screen caught mid-render
// — right after interactive_ready flips (herdr's own PTY-responsive signal
// fires before Claude has painted anything, measured: blank at +300ms, the
// dialog/banner not fully drawn until +800ms) or right after an Enter
// keypress before the TUI redraws — must never be classified: reading it too
// early made dismissStartupTrustPrompt conclude "no trust dialog to dismiss"
// while the dialog was still about to render, so the real first prompt's
// keystrokes landed in it once it did (reproduced live). Used both BEFORE
// classifying (so a not-yet-rendered dialog isn't missed) and AFTER pressing
// Enter (the loop's next iteration re-stabilizes before re-checking), closing
// the race on both sides. Bounded so a stuck render can't hang the request —
// falls back to the last read rather than blocking forever.
async function readStableScreen(mux: Multiplexer, paneId: string, maxAttempts = 10): Promise<string | null> {
  let prev: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let screen: string;
    try {
      screen = await mux.read(paneId, 45);
    } catch {
      return null;
    }
    if (prev !== null && screen === prev && screen.trim().length > 0) return screen;
    prev = screen;
    await new Promise((r) => setTimeout(r, 200));
  }
  return prev;
}

// A newly started pane needs a moment to be picked up by listPanes() before
// getOrCreateBridge finds it — mirrors the bounded-retry pattern used
// elsewhere in the bridge (e.g. waitUnblocked) rather than a single fixed
// wait. If the pane is never picked up, waitForAttach closes the workspace
// createNewSession already made (review finding #1) rather than leaking it.
async function bridgeForNewSession(cwd: string, autoTrust: boolean): Promise<PaneBridge | undefined> {
  const { paneId, workspaceId } = await createNewSession(herdrRpc, { cwd, sessionLabel: herdrSessionName() });
  if (autoTrust) await dismissStartupTrustPrompt(paneId);
  return waitForAttach(
    async () => {
      await refreshAgents();
      return getBridge(paneId);
    },
    workspaceClose,
    workspaceId,
    5,
    150,
  );
}

/** True while paneId is still sitting at Claude's startup trust dialog —
 *  used only to decide the response for a caller-supplied-cwd New Session
 *  (see shouldAutoTrustCwd); never wired into the general permission flow. */
async function isShowingTrustPrompt(paneId: string): Promise<boolean> {
  const screen = await readStableScreen(getMux(), paneId);
  return screen !== null && isClaudeTrustPrompt(screen);
}

api.post("/prompt", async (req, res) => {
  const { text, sessionId, cwd } = (req.body ?? {}) as {
    text?: string;
    sessionId?: string;
    cwd?: unknown;
  };
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  try {
    let bridge = sessionId ? await getOrCreateBridge(sessionId) : undefined;
    let newSessionNeedsTrustApproval = false;
    if (!bridge) {
      if (sessionId) {
        // Preserve the pre-existing fallback for a stale/unknown sessionId
        // byte-for-byte: route to the focused/first existing agent.
        const agents = await refreshAgents();
        bridge = focusedOrFirstBridge(agents);
      } else if (getMux().name === "herdr") {
        // A null sessionId ("New Session" in the app) creates a fresh Herdr
        // workspace + Claude agent instead of routing to an existing one.
        // cwd was not supplied by the caller only when it's exactly undefined
        // (an explicit cwd, even one that resolves to the same path as the
        // default, is still caller-supplied for trust purposes).
        const autoTrust = shouldAutoTrustCwd(cwd !== undefined);
        bridge = await bridgeForNewSession(resolveNewSessionCwd(cwd), autoTrust);
        if (bridge && !autoTrust && (await isShowingTrustPrompt(bridge.paneId))) {
          newSessionNeedsTrustApproval = true;
        }
      } else {
        // No named-session workspace API for cmux yet — keep the pre-feature
        // behavior (route to the focused/first existing agent) rather than
        // erroring, so cmux users aren't broken by a Herdr-only feature.
        const agents = await refreshAgents();
        bridge = focusedOrFirstBridge(agents);
      }
    }
    if (!bridge) {
      res.status(404).json({ error: "No agent pane found" });
      return;
    }
    if (newSessionNeedsTrustApproval) {
      // Never auto-approve a caller-supplied cwd's workspace-trust dialog (see
      // dismissStartupTrustPrompt) — the pane is fully tracked and its dialog
      // already surfaced as a normal user_question over SSE; the human must
      // answer it (POST /api/question-response) before a prompt can be typed,
      // same as any other blocked pane.
      res.status(202).json({
        ok: false,
        sessionId: bridge.paneId,
        provider: bridge.provider,
        error: "trust_required",
        message: "New session created — approve the workspace-trust prompt (the pending question) before sending messages.",
      });
      return;
    }
    console.log(`[prompt] pane=${bridge.paneId} text=${text.slice(0, 80)}`);
    await bridge.prompt(text);
    res.status(202).json({ ok: true, sessionId: bridge.paneId, provider: bridge.provider });
  } catch (err) {
    const status = err instanceof InvalidCwdError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

api.post("/permission-response", async (req, res) => {
  const { sessionId, decision } = (req.body ?? {}) as {
    sessionId?: string;
    decision?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.respondPermission(decision || "deny");
  res.json({ ok: true });
});

api.post("/question-response", async (req, res) => {
  const { sessionId, answer } = (req.body ?? {}) as {
    sessionId?: string;
    answer?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.respondQuestion(answer || "skip");
  res.json({ ok: true });
});

api.post("/interrupt", async (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.interrupt();
  res.json({ ok: true });
});

api.get("/status", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ state: bridge.state, sessionId, provider: bridge.provider });
});

api.get("/messages", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const after = parseInt((req.query.after as string) ?? "0", 10) || 0;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  res.json({
    messages: getMessages(sessionId, after),
    state: bridge?.state ?? "idle",
    sessionId,
    provider: bridge?.provider ?? null,
  });
});

// `:id` is the bridge's pane id (same identifier /api/sessions, /api/events,
// /api/prompt all use), resolved to the pane's CURRENT agent session id via
// the same field the bridge itself tails (bridge.agentSessionId) — no second
// pane->session discovery path. Mirrors even-terminal 0.8.1's own contract:
// always HTTP 200, `{ history: [...] }` on success or `{ history: [], error }`
// on failure — a history fetch must never surface as a hard error to the app.
api.get("/sessions/:id/history", async (req, res) => {
  const paneId = req.params.id;
  const rawLimit = req.query.limit;
  const limit = clampHistoryLimit(typeof rawLimit === "string" ? Number(rawLimit) : undefined);
  const bridge = getBridge(paneId);
  const sessionId = bridge?.agentSessionId;
  if (!sessionId) {
    // Unknown pane, or a known pane whose transcript hasn't resolved yet.
    res.json({ history: [] });
    return;
  }
  try {
    const history =
      bridge.provider === "codex" ? await readCodexHistory(sessionId, limit) : await readClaudeHistory(sessionId, limit);
    res.json({ history });
  } catch (err) {
    res.json({ history: [], error: (err as Error).message });
  }
});

// ── startup ────────────────────────────────────────────

// An IPv4 in 100.64.0.0/10 is Tailscale's CGNAT range — reachable from any
// device on the same tailnet, so the app can connect over it off-Wi-Fi.
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function ipv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const lanAddress = (): string | undefined => ipv4s().find((ip) => !isTailscale(ip));
const tailscaleAddress = (): string | undefined => ipv4s().find(isTailscale);

function withAuth(base: string): string {
  const u = new URL(base);
  u.searchParams.set("token", TOKEN);
  u.searchParams.set("defaultProvider", defaultProvider);
  return u.toString();
}

const urlFor = (host: string, port: number): string => withAuth(`http://${host}:${port}`);
const appUrlFromBase = (base: string): string => withAuth(base);

interface Bind {
  label: string;
  bindHost: string;
  qrHost?: string; // direct modes: host to encode in the QR (undefined => offline fallback)
}

function resolveBind(): Bind {
  const raw = (process.env.BIND_HOST ?? "auto").trim().toLowerCase();
  const b = raw === "auto" ? (publicAccess || publicBase ? "local" : "lan") : raw;
  if (b === "lan") return { label: "LAN (same Wi-Fi)", bindHost: "0.0.0.0", qrHost: lanAddress() };
  if (b === "local" || b === "localhost")
    return { label: "local only (same machine)", bindHost: "127.0.0.1", qrHost: "localhost" };
  if (b === "tailscale") {
    const ts = tailscaleAddress();
    if (!ts) {
      console.error("BIND_HOST=tailscale but no Tailscale (100.64/10) address found — is Tailscale up?");
      process.exit(1);
    }
    return { label: "Tailscale (private tailnet)", bindHost: ts, qrHost: ts };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(b)) {
    return { label: `${b} only`, bindHost: b, qrHost: b === "0.0.0.0" ? lanAddress() : b };
  }
  console.error(`error: unknown BIND_HOST "${raw}". Use: auto, lan, local, tailscale, or a literal IP.`);
  return process.exit(1);
}

const bind = resolveBind();

const server = app.listen(listenPort, bind.bindHost, async () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  console.log("");
  console.log(`  even-better v${VERSION}`);
  console.log(`  Instance : ${INSTANCE_ID}`);
  console.log(`  Mux      : ${getMux().name}`);
  console.log(`  Bind     : ${bind.label}`);
  console.log(`  Local    : http://${bind.bindHost === "0.0.0.0" ? "127.0.0.1" : bind.bindHost}:${actualPort}`);
  if (basePaths.length > 0) console.log(`  Paths    : ${basePaths.join(", ")}`);
  if (publicAccess) console.log(`  Public   : ${publicAccess}`);
  console.log(`  Token    : ${maskToken(TOKEN)}${process.env.BRIDGE_TOKEN ? " (from BRIDGE_TOKEN)" : " (ephemeral)"}`);
  console.log(`  Log mode : ${logMode}`);
  console.log(`  Log      : ${writesEventLog ? eventLogPath : "off"}`);
  if (logMode !== "off") console.log(`  Diag log : ${consoleLogPath}`);
  console.log("");
  try {
    const agents = await refreshAgents();
    const target = agents.find((a) => a.focused) ?? agents[0];
    defaultProvider = providerForAgent(target?.agent);
    for (const a of agents) {
      console.log(`  agent : ${a.agent} pane=${a.paneId} status=${a.status} cwd=${a.cwd}`);
    }
    if (agents.length === 0) {
      console.log(`  agent : none yet — start claude or codex inside ${getMux().name}; it's picked up automatically (no restart).`);
    }
  } catch (err) {
    console.error(`  ${getMux().name} : NOT REACHABLE — ${(err as Error).message}`);
  }

  // Receive self-hook reports. With SELF_HOOK=1 (Stage 3) they drive the matching
  // bridge's status/session via the per-pane cutover; off by default (log-only).
  // Install with `pnpm start hook-install`; remove with `hook-uninstall`.
  const selfHook = process.env.SELF_HOOK === "1";
  try {
    await startHookEndpoint((r) => {
      const extra = [
        r.sessionId ? `session=${r.sessionId}` : "",
        r.toolName ? `tool=${r.toolName}` : "",
        r.transcriptPath ? "hasPath" : "",
      ].filter(Boolean).join(" ");
      const pane = r.paneId || `pid:${r.pid ?? "?"}`;
      console.log(`  [hook] ${r.mux}/${pane} ${r.agent} ${r.event} seq=${r.seq}${extra ? " " + extra : ""}`);
      if (selfHook && r.paneId) {
        // Env-primary routing: r.paneId == the mux paneId. (pid fallback for env-less
        // reports + reconciliation land in Stage 3b.)
        getBridge(r.paneId)?.onHookReport(r);
      }
    });
    console.log(
      `  Hooks    : ${hookSocketPath()} (${selfHook ? "SELF_HOOK on — driving bridges" : "log-only; SELF_HOOK=1 to drive"})`,
    );
    // SELF_HOOK drives bridges only if our hook is actually installed — else no reports
    // arrive and the pane silently never cuts over. Warn so it isn't a silent no-op.
    // `inst.codex` = our hook.json entry + the feature on; Codex ALSO needs a `/hooks` trust
    // we can't verify here, so we never claim Codex "will report" — only flag it isn't set up
    // and, when it is, remind about the unverifiable trust step.
    if (selfHook) {
      const inst = hooksInstalled();
      if (!inst.claude && !inst.codex) {
        console.log("  ⚠ SELF_HOOK=1 but no even-better hooks are installed — no reports will arrive.");
        console.log("    Run `pnpm start hook-install`, then restart the agent panes.");
      } else {
        // Warn per agent that isn't set up (a codex-only pane must not be silently missed).
        if (!inst.claude) console.log("  ⚠ SELF_HOOK=1 — Claude hooks not installed; run hook-install.");
        if (!inst.codex)
          console.log("  ⚠ SELF_HOOK=1 — Codex hooks not active (need hooks.json + `[features] hooks=true`); run hook-install / enable the feature.");
        else console.log("    Codex: hooks installed — they report only once trusted via `/hooks` (not verifiable here).");
      }
    }
  } catch (err) {
    console.error(`  Hooks    : disabled — ${(err as Error).message}`);
  }

  if (publicBase) {
    console.log("");
    printConnect("Scan to connect", appUrlFromBase(publicBase), qrEnabled);
    return;
  }

  if (publicAccess) {
    // The public-access provider prints the one QR itself, once its URL is up.
    startExpose(publicAccess, actualPort, appUrlFromBase, {
      fallbackPath: funnelFallbackPath,
      instanceId: INSTANCE_ID,
      qrEnabled,
    });
    return;
  }

  const host = bind.qrHost ?? "localhost";
  if (!bind.qrHost) console.log("  (no LAN address found — showing localhost, which a phone can't reach)");
  console.log("");
  printConnect("Scan to connect", urlFor(host, actualPort), qrEnabled);
});

// Tear down both the bridges and the multiplexer (cmux holds a long-lived
// event-stream child that would otherwise outlive the process).
function teardown(): void {
  disposeAll();
  getMux().dispose?.();
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${process.env.PORT} already in use — choose another PORT or leave it unset for auto.`);
  } else {
    console.error(`[bridge] server error: ${err.message}`);
  }
  teardown();
  process.exit(1);
});

function shutdown(): void {
  teardown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error(`[bridge] uncaught: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[bridge] unhandled rejection: ${String(reason)}`);
});

// Re-export for potential programmatic use / tests.
export { emit };
