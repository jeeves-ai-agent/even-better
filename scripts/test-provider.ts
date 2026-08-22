import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasScreenModel,
  hasTranscript,
  herdrAgentKind,
  normalizeProvider,
  providerForAgent,
  PROVIDERS,
  sessionTitle,
} from "../src/provider.js";

// Object.prototype keys: the allowlist is looked up with untrusted request text
// (POST /prompt's `provider`/`kind`), so a lookup that inherited from
// Object.prototype would answer these with a truthy non-Provider (a function,
// or Object itself) and let it through validation.
const PROTOTYPE_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];

// ── normalizeProvider: the strict allowlist (agent kinds AND request values) ──

test("normalizeProvider: canonical provider names map to themselves", () => {
  for (const p of PROVIDERS) assert.equal(normalizeProvider(p), p);
});

test("normalizeProvider: the Cursor CLI's own binary names resolve to cursor", () => {
  assert.equal(normalizeProvider("cursor-agent"), "cursor");
  assert.equal(normalizeProvider("cursor-cli"), "cursor");
});

test("normalizeProvider: case and surrounding whitespace are tolerated", () => {
  assert.equal(normalizeProvider("  Cursor "), "cursor");
  assert.equal(normalizeProvider("CLAUDE"), "claude");
});

test("normalizeProvider: an unknown name is undefined, not defaulted", () => {
  assert.equal(normalizeProvider("gemini"), undefined);
  assert.equal(normalizeProvider(""), undefined);
});

test("normalizeProvider: a non-string value is undefined", () => {
  assert.equal(normalizeProvider(undefined), undefined);
  assert.equal(normalizeProvider(null), undefined);
  assert.equal(normalizeProvider(7), undefined);
  assert.equal(normalizeProvider({ provider: "cursor" }), undefined);
});

test("normalizeProvider: Object.prototype keys are not providers", () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(normalizeProvider(key), undefined, key);
    assert.equal(normalizeProvider(key.toUpperCase()), undefined, key.toUpperCase());
    assert.equal(normalizeProvider(`  ${key} `), undefined, key);
  }
});

// ── providerForAgent: what the app is told a pane is ─────────────────────────

test("providerForAgent: a herdr cursor pane reports provider cursor", () =>
  assert.equal(providerForAgent("cursor"), "cursor"));
test("providerForAgent: a cursor-agent pane reports provider cursor", () =>
  assert.equal(providerForAgent("cursor-agent"), "cursor"));
test("providerForAgent: claude and codex are unchanged", () => {
  assert.equal(providerForAgent("claude"), "claude");
  assert.equal(providerForAgent("codex"), "codex");
});
test("providerForAgent: an unknown or missing agent kind still defaults to claude", () => {
  // pre-existing behavior for every non-codex pane — must not change.
  assert.equal(providerForAgent("aider"), "claude");
  assert.equal(providerForAgent(undefined), "claude");
});

test("providerForAgent: an Object.prototype key falls back to claude, never a function", () => {
  for (const key of PROTOTYPE_KEYS) {
    const provider = providerForAgent(key);
    assert.equal(provider, "claude", key);
    assert.equal(typeof provider, "string", key);
  }
});

// ── hasScreenModel: only a real Claude pane's status bar is scraped for a
// model (/api/info). Keyed on the raw agent kind, NOT on the defaulted
// provider — an unknown agent reports provider claude but paints its own TUI. ─

test("hasScreenModel: a claude pane can be scraped for its model", () =>
  assert.equal(hasScreenModel("claude"), true));

test("hasScreenModel: cursor and codex panes are never scraped as Claude", () => {
  assert.equal(hasScreenModel("cursor"), false);
  assert.equal(hasScreenModel("cursor-agent"), false);
  assert.equal(hasScreenModel("codex"), false);
});

test("hasScreenModel: an unknown agent kind is never scraped as Claude", () => {
  // it still REPORTS provider claude — the two must not be conflated.
  assert.equal(providerForAgent("aider"), "claude");
  assert.equal(hasScreenModel("aider"), false);
  assert.equal(hasScreenModel(undefined), false);
  for (const key of PROTOTYPE_KEYS) assert.equal(hasScreenModel(key), false, key);
});

// ── hasTranscript: the one capability that actually differs ──────────────────

test("hasTranscript: claude and codex have transcript parsers", () => {
  assert.equal(hasTranscript("claude"), true);
  assert.equal(hasTranscript("codex"), true);
});
test("hasTranscript: cursor has none (screen-mirrored, empty history)", () =>
  assert.equal(hasTranscript("cursor"), false));
test("hasTranscript: an unrecognized agent kind (undefined provider) has none", () => {
  assert.equal(hasTranscript(normalizeProvider("aider")), false);
  for (const key of PROTOTYPE_KEYS) assert.equal(hasTranscript(normalizeProvider(key)), false, key);
});

// ── herdrAgentKind: what `agent.start` launches ──────────────────────────────

test("herdrAgentKind: cursor starts herdr with kind cursor", () =>
  assert.equal(herdrAgentKind("cursor"), "cursor"));
test("herdrAgentKind: claude/codex keep their existing kinds", () => {
  assert.equal(herdrAgentKind("claude"), "claude");
  assert.equal(herdrAgentKind("codex"), "codex");
});

// ── sessionTitle: /api/sessions rows ─────────────────────────────────────────

test("sessionTitle: a cursor pane's title names cursor and its directory", () => {
  const title = sessionTitle("cursor", "/home/me/even-better");
  assert.ok(title.includes("cursor"), title);
  assert.equal(title, "cursor · even-better");
});

test("sessionTitle: claude titles are unchanged", () =>
  assert.equal(sessionTitle("claude", "/home/me/even-better"), "claude · even-better"));

// path.basename("/") is "" — unchanged from the inline title this replaced.
test("sessionTitle: an empty cwd still names the agent", () =>
  assert.equal(sessionTitle("cursor", ""), "cursor · "));
