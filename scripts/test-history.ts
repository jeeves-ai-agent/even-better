import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampHistoryLimit,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  readClaudeHistory,
  readCodexHistory,
  readHistory,
} from "../src/history.js";

// ── clampHistoryLimit: pure, no filesystem ─────────────

test("clampHistoryLimit: undefined falls back to the default", () =>
  assert.equal(clampHistoryLimit(undefined), DEFAULT_HISTORY_LIMIT));
test("clampHistoryLimit: NaN falls back to the default", () =>
  assert.equal(clampHistoryLimit(Number.NaN), DEFAULT_HISTORY_LIMIT));
test("clampHistoryLimit: zero falls back to the default", () => assert.equal(clampHistoryLimit(0), DEFAULT_HISTORY_LIMIT));
test("clampHistoryLimit: negative falls back to the default", () =>
  assert.equal(clampHistoryLimit(-5), DEFAULT_HISTORY_LIMIT));
test("clampHistoryLimit: a sane requested value passes through", () => assert.equal(clampHistoryLimit(3), 3));
test("clampHistoryLimit: fractional values truncate", () => assert.equal(clampHistoryLimit(7.9), 7));
test("clampHistoryLimit: values above the cap are clamped to it", () =>
  assert.equal(clampHistoryLimit(9999), MAX_HISTORY_LIMIT));

// ── readClaudeHistory: real jsonl fixture under a temp HOME ────────────────
// os.homedir() (and so findSessionFile's ~/.claude/projects) resolves via
// $HOME on POSIX — same override trick the existing codex-home-session-file
// test in test-transcript.ts uses for $CODEX_HOME, so this exercises the SAME
// discovery path the bridge uses rather than a parallel one.

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "even-better-claude-home-"));
  try {
    process.env.HOME = home;
    return await run(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeClaudeFixture(home: string, sessionId: string, lines: string[]): void {
  const dir = join(home, ".claude", "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

const claudeFixtureLines = [
  JSON.stringify({ type: "user", message: { content: "first question" } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "first answer" }], usage: { input_tokens: 10, output_tokens: 5 } },
  }),
  // tool_use / tool_result must not appear in history — only text turns do.
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file1\nfile2" }] }] },
  }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "here are the files" }] } }),
  // malformed line: must be skipped without throwing.
  "this is not json at all",
  // harness/command wrapper: already excluded by parseEntry — must stay excluded.
  JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
  // sub-agent internal traffic: already excluded by parseEntry — must stay excluded.
  JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "internal subagent chatter" }] } }),
  JSON.stringify({ type: "user", message: { content: "second question" } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second answer" }] } }),
];

test("readClaudeHistory: parses a real jsonl fixture into ordered user/assistant turns", () =>
  withTempHome(async (home) => {
    writeClaudeFixture(home, "session-a", claudeFixtureLines);
    const history = await readClaudeHistory("session-a", 10);
    assert.deepEqual(history, [
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
      { role: "assistant", text: "here are the files" },
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer" },
    ]);
  }));

test("readClaudeHistory: a malformed line does not throw and is simply skipped", () =>
  withTempHome(async (home) => {
    writeClaudeFixture(home, "session-malformed", ["not json", JSON.stringify({ type: "user", message: { content: "ok" } })]);
    await assert.doesNotReject(readClaudeHistory("session-malformed", 10));
    assert.deepEqual(await readClaudeHistory("session-malformed", 10), [{ role: "user", text: "ok" }]);
  }));

test("readClaudeHistory: limit returns the most recent N, still in chronological order", () =>
  withTempHome(async (home) => {
    writeClaudeFixture(home, "session-b", claudeFixtureLines);
    const history = await readClaudeHistory("session-b", 2);
    assert.deepEqual(history, [
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer" },
    ]);
  }));

test("readClaudeHistory: an unresolved session id yields an empty array, not an error", () =>
  withTempHome(async (home) => {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    assert.deepEqual(await readClaudeHistory("no-such-session", 10), []);
  }));

test("readClaudeHistory: no ~/.claude/projects at all yields an empty array", () =>
  withTempHome(async () => {
    assert.deepEqual(await readClaudeHistory("no-such-session", 10), []);
  }));

// ── readCodexHistory: real rollout fixture under a temp CODEX_HOME ─────────

async function withTempCodexHome<T>(run: (codexHome: string) => Promise<T>): Promise<T> {
  const old = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "even-better-codex-home-"));
  try {
    process.env.CODEX_HOME = codexHome;
    return await run(codexHome);
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
    rmSync(codexHome, { recursive: true, force: true });
  }
}

function writeCodexFixture(codexHome: string, sessionId: string, lines: string[]): void {
  const dir = join(codexHome, "sessions", "2026", "07", "07");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`), lines.join("\n") + "\n");
}

const codexFixtureLines = [
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "implement codex support" }] },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will read the code first." }] },
  }),
  // function_call / output must not appear in history — only text turns do.
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_1", output: "file1\nfile2" },
  }),
  "not json either",
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  }),
];

test("readCodexHistory: parses a real rollout fixture into ordered user/assistant turns", () =>
  withTempCodexHome(async (codexHome) => {
    writeCodexFixture(codexHome, "codex-session-a", codexFixtureLines);
    const history = await readCodexHistory("codex-session-a", 10);
    assert.deepEqual(history, [
      { role: "user", text: "implement codex support" },
      { role: "assistant", text: "I will read the code first." },
      { role: "assistant", text: "Done." },
    ]);
  }));

test("readCodexHistory: an unresolved session id yields an empty array, not an error", () =>
  withTempCodexHome(async () => {
    assert.deepEqual(await readCodexHistory("no-such-codex-session", 10), []);
  }));

// ── readHistory: provider dispatch. Cursor has no transcript parser, so its
// history is empty — and must NOT be parsed as Claude jsonl even when a Claude
// session with the same id exists (the route stays HTTP 200 either way). ─────

test("readHistory: claude dispatches to the Claude transcript parser", () =>
  withTempHome(async (home) => {
    writeClaudeFixture(home, "session-dispatch", claudeFixtureLines);
    assert.deepEqual(await readHistory("claude", "session-dispatch", 2), [
      { role: "user", text: "second question" },
      { role: "assistant", text: "second answer" },
    ]);
  }));

test("readHistory: codex dispatches to the Codex rollout parser", () =>
  withTempCodexHome(async (codexHome) => {
    writeCodexFixture(codexHome, "codex-dispatch", codexFixtureLines);
    assert.deepEqual(await readHistory("codex", "codex-dispatch", 1), [{ role: "assistant", text: "Done." }]);
  }));

test("readHistory: cursor returns an empty history without parsing anything", () =>
  withTempHome(async (home) => {
    // A Claude transcript exists under this very session id: cursor must still
    // return [] rather than replaying someone else's conversation.
    writeClaudeFixture(home, "shared-id", claudeFixtureLines);
    assert.deepEqual(await readHistory("cursor", "shared-id", 10), []);
  }));

test("readHistory: cursor never throws, even for an unresolvable session id", async () =>
  assert.deepEqual(await readHistory("cursor", "no-such-session", 10), []));
