import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  createNewSession,
  resolveNewSessionCwd,
  shouldAutoTrustCwd,
  uniqueSessionName,
  waitForAttach,
  waitUntilReady,
  type NewSessionRpc,
} from "../src/new-session.js";

const noopSleep = async (_ms: number): Promise<void> => {};

function fakeRpc(overrides: Partial<NewSessionRpc> = {}): NewSessionRpc {
  return {
    createWorkspace: async () => ({ workspaceId: "wZ", paneId: "wZ:p1" }),
    startAgent: async () => {},
    isReady: async () => true,
    closeWorkspace: async () => {},
    ...overrides,
  };
}

// no cwd requested → NEW_SESSION_CWD env wins over HOME/cwd()
test("resolveNewSessionCwd: uses NEW_SESSION_CWD when no cwd requested", () => {
  const got = resolveNewSessionCwd(undefined, { NEW_SESSION_CWD: os.tmpdir() });
  assert.equal(got, os.tmpdir());
});

test("resolveNewSessionCwd: falls back to HOME when NEW_SESSION_CWD unset", () => {
  const got = resolveNewSessionCwd(undefined, { HOME: os.tmpdir() });
  assert.equal(got, os.tmpdir());
});

test("resolveNewSessionCwd: falls back to process.cwd() when nothing else is set", () => {
  const got = resolveNewSessionCwd(undefined, {});
  assert.equal(got, process.cwd());
});

test("resolveNewSessionCwd: accepts an absolute existing directory", () => {
  const got = resolveNewSessionCwd(os.tmpdir(), {});
  assert.equal(got, os.tmpdir());
});

test("resolveNewSessionCwd: rejects a relative path", () => {
  assert.throws(() => resolveNewSessionCwd("relative/path", {}), /absolute/);
});

test("resolveNewSessionCwd: rejects a missing directory", () => {
  assert.throws(
    () => resolveNewSessionCwd("/definitely/does/not/exist/eb-test", {}),
    /does not exist|not a directory/,
  );
});

test("resolveNewSessionCwd: rejects a non-string value", () => {
  assert.throws(() => resolveNewSessionCwd(42, {}), /string/);
});

// two "near-simultaneous" calls (same millisecond in practice, but even in the
// same tick here) must never produce the same name.
test("uniqueSessionName: concurrent calls never collide", () => {
  const names = new Set(Array.from({ length: 50 }, () => uniqueSessionName("eb-new")));
  assert.equal(names.size, 50);
});

test("uniqueSessionName: includes the given prefix", () => {
  assert.match(uniqueSessionName("eb-new-jeeves"), /^eb-new-jeeves-/);
});

test("waitUntilReady: returns true as soon as isReady reports true", async () => {
  let calls = 0;
  const ready = await waitUntilReady(
    { isReady: async () => { calls += 1; return calls >= 3; } },
    "w0:p1",
    5000,
    noopSleep,
  );
  assert.equal(ready, true);
  assert.equal(calls, 3);
});

test("waitUntilReady: returns false once the timeout elapses", async () => {
  const ready = await waitUntilReady({ isReady: async () => false }, "w0:p1", 0, noopSleep);
  assert.equal(ready, false);
});

test("createNewSession: creates a workspace, starts the agent, waits ready, returns the pane", async () => {
  const calls: string[] = [];
  const rpc = fakeRpc({
    createWorkspace: async (cwd, label) => {
      calls.push(`createWorkspace(${cwd},${label})`);
      return { workspaceId: "wZ", paneId: "wZ:p1" };
    },
    startAgent: async (opts) => {
      calls.push(`startAgent(${opts.paneId},${opts.name})`);
    },
    isReady: async (paneId) => {
      calls.push(`isReady(${paneId})`);
      return true;
    },
    closeWorkspace: async () => {
      calls.push("closeWorkspace");
    },
  });
  const result = await createNewSession(rpc, { cwd: "/tmp", sessionLabel: "jeeves", sleep: noopSleep });
  assert.deepEqual(result, { paneId: "wZ:p1", workspaceId: "wZ" });
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^createWorkspace\(\/tmp,/);
  assert.match(calls[1], /^startAgent\(wZ:p1,/);
  assert.equal(calls[2], "isReady(wZ:p1)");
  // the workspace/agent name threaded through createWorkspace and startAgent must match
  const labelFromCreate = calls[0].split(",")[1].slice(0, -1);
  const nameFromStart = calls[1].split(",")[1].slice(0, -1);
  assert.equal(labelFromCreate, nameFromStart);
});

test("createNewSession: closes the workspace when the agent never becomes ready", async () => {
  const rpc = fakeRpc({ isReady: async () => false });
  let closed: string | undefined;
  rpc.closeWorkspace = async (workspaceId) => {
    closed = workspaceId;
  };
  await assert.rejects(
    createNewSession(rpc, { cwd: "/tmp", sessionLabel: "jeeves", readyTimeoutMs: 0, sleep: noopSleep }),
    /interactive-ready/,
  );
  assert.equal(closed, "wZ");
});

test("createNewSession: closes the workspace when starting the agent fails", async () => {
  const rpc = fakeRpc({
    startAgent: async () => {
      throw new Error("unsupported_agent_kind");
    },
  });
  let closed: string | undefined;
  rpc.closeWorkspace = async (workspaceId) => {
    closed = workspaceId;
  };
  await assert.rejects(
    createNewSession(rpc, { cwd: "/tmp", sessionLabel: "jeeves", sleep: noopSleep }),
    /unsupported_agent_kind/,
  );
  assert.equal(closed, "wZ");
});

test("createNewSession: a close failure does not mask the original error", async () => {
  const rpc = fakeRpc({
    startAgent: async () => {
      throw new Error("start failed");
    },
    closeWorkspace: async () => {
      throw new Error("close also failed");
    },
  });
  await assert.rejects(
    createNewSession(rpc, { cwd: "/tmp", sessionLabel: "jeeves", sleep: noopSleep }),
    /start failed/,
  );
});

// ── waitForAttach: review finding #1 — a New Session whose pane never gets
// picked up by the caller's own bookkeeping (e.g. getBridge) must not leak the
// workspace/Claude process it already created. ─────────────────────────────

test("waitForAttach: returns the value as soon as attach succeeds, never closes", async () => {
  let calls = 0;
  let closed = false;
  const value = await waitForAttach(
    async () => {
      calls += 1;
      return calls >= 3 ? "bridge-3" : undefined;
    },
    async () => {
      closed = true;
    },
    "wZ",
    5,
    0,
    noopSleep,
  );
  assert.equal(value, "bridge-3");
  assert.equal(calls, 3);
  assert.equal(closed, false);
});

test("waitForAttach: succeeds on the very first attempt without ever sleeping or closing", async () => {
  let slept = false;
  const value = await waitForAttach(
    async () => "bridge-1",
    async () => {
      throw new Error("closeWorkspace must not be called on success");
    },
    "wZ",
    5,
    0,
    async () => {
      slept = true;
    },
  );
  assert.equal(value, "bridge-1");
  assert.equal(slept, false);
});

test("waitForAttach: closes the workspace exactly once when attach never succeeds", async () => {
  let attempts = 0;
  let closedWith: string | undefined;
  let closeCalls = 0;
  const value = await waitForAttach(
    async () => {
      attempts += 1;
      return undefined;
    },
    async (workspaceId) => {
      closeCalls += 1;
      closedWith = workspaceId;
    },
    "wZ-leaked",
    4,
    0,
    noopSleep,
  );
  assert.equal(value, undefined);
  assert.equal(attempts, 4);
  assert.equal(closeCalls, 1);
  assert.equal(closedWith, "wZ-leaked");
});

test("waitForAttach: a close failure on the give-up path is swallowed, not thrown", async () => {
  const value = await waitForAttach(
    async () => undefined,
    async () => {
      throw new Error("close also failed");
    },
    "wZ",
    2,
    0,
    noopSleep,
  );
  assert.equal(value, undefined);
});

// ── shouldAutoTrustCwd: review finding #2 — Claude's startup workspace-trust
// dialog is only auto-accepted for the server's own configured/default cwd,
// never for a caller-supplied one. ──────────────────────────────────────────

test("shouldAutoTrustCwd: true when the caller did not supply an explicit cwd (server default)", () =>
  assert.equal(shouldAutoTrustCwd(false), true));
test("shouldAutoTrustCwd: false when the caller supplied an explicit cwd", () =>
  assert.equal(shouldAutoTrustCwd(true), false));
