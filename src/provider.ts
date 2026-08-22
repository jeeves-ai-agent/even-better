// Which coding agent a pane runs, and what the bridge may assume about it.
// One module so every surface — the session list, /info, history, New Session —
// answers "which provider is this?" the same way instead of re-deriving it from
// an agent string per call site.
//
// A provider is NOT an AgentAdapter (see AGENTS.md "Extension roadmap"): it is
// only an identity plus the one capability that actually differs today, whether
// the agent has a structured transcript parser. Cursor has none, so it mirrors
// the screen (ScreenTimeline) and reports no model/history.

import path from "node:path";

export type Provider = "claude" | "codex" | "cursor";

export const PROVIDERS: readonly Provider[] = ["claude", "codex", "cursor"];

// Multiplexer agent kinds → provider. herdr reports the kind it launched the
// agent with (`agent.start --kind cursor`), but the Cursor CLI itself ships as
// `cursor-agent`, so its aliases are resolved here rather than guessed at each
// call site. Also the allowlist for provider values arriving over HTTP.
//
// A Map, not an object literal: this is looked up with untrusted request text,
// and an object would answer `__proto__`/`constructor`/`toString` from
// Object.prototype — a truthy non-Provider that would pass the allowlist check
// and be handed on as if it were a provider. A Map only ever returns what was
// put in it.
const AGENT_KINDS = new Map<string, Provider>([
  ["claude", "claude"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["cursor-agent", "cursor"],
  ["cursor-cli", "cursor"],
]);

/** A provider name or agent kind → the provider, or undefined when it is not
 *  one we know. Strict on purpose: request validation and "does this agent have
 *  a transcript parser?" both need "unrecognized" to stay distinguishable from
 *  the claude default. */
export function normalizeProvider(raw: unknown): Provider | undefined {
  if (typeof raw !== "string") return undefined;
  return AGENT_KINDS.get(raw.trim().toLowerCase());
}

/** Provider reported for a multiplexer-detected agent kind. An unrecognized
 *  kind stays `claude` — the pre-existing default for every non-codex pane, so
 *  what the app is told about an unknown agent does not change. */
export function providerForAgent(agent: string | undefined): Provider {
  return normalizeProvider(agent) ?? "claude";
}

/** Whether even-better can read this provider's structured transcript (jsonl).
 *  False for cursor (no parser — deliberately out of scope) and for `undefined`,
 *  i.e. an agent kind we do not recognize at all. */
export function hasTranscript(provider: Provider | undefined): boolean {
  return provider === "claude" || provider === "codex";
}

/** Whether a pane's SCREEN can be scraped for a model string (parse.ts's
 *  extractModel reads Claude's status bar). Keyed on the normalized RAW agent
 *  kind, never on `provider`: an unrecognized kind reports provider `claude` to
 *  the app, but its TUI is some other agent's, so scraping it as Claude's would
 *  invent a model. Only an actual Claude pane qualifies. */
export function hasScreenModel(agent: string | undefined): boolean {
  return normalizeProvider(agent) === "claude";
}

/** The `kind` a provider is started with on herdr (`agent.start`). Identity
 *  today, but this is the single seam where a provider's herdr kind is decided,
 *  so a future rename (e.g. cursor → cursor-agent) touches one line. */
export function herdrAgentKind(provider: Provider): string {
  return provider;
}

/** Title for the app's session list: the agent kind the mux reported plus the
 *  working directory's basename (`cursor · even-better`). The kind is used
 *  verbatim, so the provider is always visible in the title. */
export function sessionTitle(agent: string, cwd: string): string {
  return `${agent} · ${path.basename(cwd || "/")}`;
}
