// Verifies agentStart's agent.start RPC call requests --remote-control as a
// Claude executable arg (New Session flow), and never --dangerously-skip-permissions
// (see index.ts's herdrRpc wiring comment). Spins up a fake herdr socket server
// so the exact wire params are inspectable — herdr.ts has no other seam for this.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

interface CapturedRequest {
  method: string;
  params: Record<string, unknown>;
}

async function withFakeHerdrSocket(
  run: (received: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const socketPath = path.join(os.tmpdir(), `herdr-test-${randomBytes(4).toString("hex")}.sock`);
  process.env.HERDR_SOCKET = socketPath;
  const received: CapturedRequest[] = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      const req = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      received.push({ method: req.method, params: req.params });
      conn.end(JSON.stringify({ id: req.id, result: { agent: {} } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(received);
  } finally {
    server.close();
  }
}

test("agentStart: requests --remote-control as a Claude executable arg, without --dangerously-skip-permissions", async () => {
  await withFakeHerdrSocket(async (received) => {
    const { agentStart } = await import("../src/herdr.js");
    await agentStart({ name: "test-agent", paneId: "w1:p1", timeoutMs: 30_000 });

    assert.equal(received.length, 1);
    assert.equal(received[0].method, "agent.start");
    assert.deepEqual(received[0].params.args, ["--remote-control"]);
    assert.ok(
      !((received[0].params.args as string[] | undefined) ?? []).includes("--dangerously-skip-permissions"),
    );

    // --remote-control is Claude's flag: other kinds must start without it.
    // Same socket on purpose — herdr.ts reads HERDR_SOCKET once at import.
    await agentStart({ name: "test-codex", paneId: "w1:p2", timeoutMs: 30_000, kind: "codex" });
    assert.equal(received.length, 2);
    assert.equal(received[1].params.kind, "codex");
    assert.equal(received[1].params.args, undefined);
  });
});
