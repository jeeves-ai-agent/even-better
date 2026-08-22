import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneBridge } from "../src/bridge.js";
import { setMux, type Multiplexer, type PaneInfo, type PaneStatus, type StatusSub } from "../src/multiplexer.js";
import { getMessages } from "../src/sse.js";

// Which content source a pane gets is decided inside PaneBridge, so drive it
// through a fake Multiplexer instead of asserting on a private field: a
// screen-mirrored agent (cursor) READS the pane and never asks for a session
// id, while a transcript agent (claude) does the opposite and streams nothing
// until its jsonl resolves.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeMux implements Multiplexer {
  readonly name = "fake";
  reads = 0;
  sessionIdCalls = 0;
  /** Successive screens returned by read(); the last one repeats. */
  constructor(private readonly screens: string[]) {}

  async listPanes(): Promise<PaneInfo[]> {
    return [];
  }
  watchStatus(_paneId: string, _onStatus: (s: PaneStatus, session?: string) => void, _onClose: (err?: Error) => void): StatusSub {
    return { close: () => {} };
  }
  async read(_paneId: string, _lines: number): Promise<string> {
    const i = Math.min(this.reads, this.screens.length - 1);
    this.reads += 1;
    return this.screens[i];
  }
  async send(_paneId: string, _text: string, _keys?: string[]): Promise<void> {}
  async sessionId(_paneId: string): Promise<string | undefined> {
    this.sessionIdCalls += 1;
    return undefined;
  }
  async exists(_paneId: string): Promise<boolean> {
    return true;
  }
}

// A distinct pane id per case — the SSE ring buffer is keyed by pane id and
// lives for the whole process, so cases must not share one.
let paneSeq = 0;
function paneInfo(agent: string, sessionId?: string): PaneInfo {
  return { paneId: `w1:p${++paneSeq}-${agent}`, agent, cwd: "/tmp/repo", focused: true, status: "idle", sessionId };
}

/** Runs a bridge long enough for at least two poll ticks (POLL_INTERVAL_MS=300:
 *  ScreenTimeline primes on the first and diffs on the second). */
async function runBridge(mux: FakeMux, info: PaneInfo): Promise<PaneBridge> {
  setMux(mux);
  const bridge = new PaneBridge(info);
  bridge.start();
  await sleep(900);
  bridge.dispose();
  return bridge;
}

test("a cursor pane reports provider cursor", () => {
  assert.equal(new PaneBridge(paneInfo("cursor")).provider, "cursor");
  assert.equal(new PaneBridge(paneInfo("cursor-agent")).provider, "cursor");
});

test("a cursor pane mirrors the screen (ScreenTimeline fallback), streaming its new lines", async () => {
  const mux = new FakeMux(["banner", "banner\nCursor answered here"]);
  const info = paneInfo("cursor");
  await runBridge(mux, info);
  assert.ok(mux.reads >= 2, `expected the pane to be read, got ${mux.reads} read(s)`);
  const streamed = getMessages(info.paneId, 0)
    .filter((m) => (m as { type?: string }).type === "text_delta")
    .map((m) => (m as { text?: string }).text ?? "")
    .join("");
  assert.ok(streamed.length > 0, "cursor output should stream to the app");
  assert.ok("Cursor answered here".startsWith(streamed.trim()), `unexpected stream: ${JSON.stringify(streamed)}`);
});

test("a cursor pane never chases a Claude/Codex transcript", async () => {
  const mux = new FakeMux(["banner", "banner\nmore"]);
  // Even with a session id already attached (herdr may detect one), a cursor
  // pane must not try to resolve or tail a transcript for it.
  await runBridge(mux, paneInfo("cursor", "some-session-id"));
  assert.equal(mux.sessionIdCalls, 0);
});

test("a claude pane is unchanged: it waits for its transcript instead of scraping", async () => {
  const mux = new FakeMux(["banner", "banner\nclaude prose"]);
  const info = paneInfo("claude");
  await runBridge(mux, info);
  assert.equal(mux.reads, 0, "claude content must never come from the screen");
  assert.ok(mux.sessionIdCalls >= 1, "claude keeps retrying the transcript upgrade");
  assert.deepEqual(getMessages(info.paneId, 0), []);
});

// ── the two "which parser?" answers must agree ──────────────────────────────
// PaneBridge asks twice: `transcriptBacked` decides whether to WAIT for a
// transcript (normalized agent kind), and upgradeToTranscript decides WHICH one
// to attach. When the second used a raw string compare, an aliased or
// odd-cased kind answered yes/no — the pane waited for a transcript nothing
// would ever attach and stayed permanently blank.

async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "even-better-bridge-home-"));
  try {
    process.env.HOME = home;
    return await run();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A Claude session jsonl under the (temp) HOME findSessionFile searches. */
function claudeTranscript(sessionId: string): string {
  const dir = join(process.env.HOME ?? "", ".claude", "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "user", message: { content: "already answered" } }) + "\n");
  return file;
}

test("an odd-cased claude kind still attaches (and tails) the Claude transcript", () =>
  withTempHome(async () => {
    const file = claudeTranscript("session-cased");
    const mux = new FakeMux(["screen must not be used", "screen must not be used\nnor this"]);
    setMux(mux);
    const info = paneInfo("Claude", "session-cased");
    const bridge = new PaneBridge(info);
    bridge.start();
    // Attached at EOF, so only text written AFTER the upgrade should stream.
    appendFileSync(
      file,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "live answer" }] } }) + "\n",
    );
    await sleep(900);
    bridge.dispose();

    assert.equal(mux.reads, 0, "a claude pane's content never comes from the screen");
    assert.equal(mux.sessionIdCalls, 0, "the transcript resolved at once — nothing left to re-fetch");
    const streamed = getMessages(info.paneId, 0)
      .filter((m) => (m as { type?: string }).type === "text_delta")
      .map((m) => (m as { text?: string }).text ?? "")
      .join("");
    assert.ok(streamed.length > 0, "the transcript's new text should stream");
    assert.ok("live answer".startsWith(streamed.trim()), `unexpected stream: ${JSON.stringify(streamed)}`);
  }));

test("a cursor-agent kind keeps the screen fallback and never tails a transcript", () =>
  withTempHome(async () => {
    // A Claude jsonl exists under this session id: the alias must not select it.
    claudeTranscript("session-shared");
    const mux = new FakeMux(["banner", "banner\nCursor alias output"]);
    const info = paneInfo("cursor-agent", "session-shared");
    await runBridge(mux, info);
    assert.ok(mux.reads >= 2, `expected the pane to be read, got ${mux.reads} read(s)`);
    assert.equal(mux.sessionIdCalls, 0);
    const streamed = getMessages(info.paneId, 0)
      .filter((m) => (m as { type?: string }).type === "text_delta")
      .map((m) => (m as { text?: string }).text ?? "")
      .join("");
    assert.ok("Cursor alias output".startsWith(streamed.trim()), `unexpected stream: ${JSON.stringify(streamed)}`);
    assert.ok(!streamed.includes("already answered"), "a cursor pane must never replay a Claude transcript");
  }));
