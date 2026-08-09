import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHerdrSessionName } from "../src/herdr.js";

test("deriveHerdrSessionName: HERDR_SESSION env wins even over a named socket path", () => {
  const got = deriveHerdrSessionName(
    "/home/ubuntu/.config/herdr/sessions/other/herdr.sock",
    "jeeves",
  );
  assert.equal(got, "jeeves");
});

test("deriveHerdrSessionName: parses the name out of a named-session socket path", () => {
  const got = deriveHerdrSessionName("/home/ubuntu/.config/herdr/sessions/jeeves/herdr.sock", undefined);
  assert.equal(got, "jeeves");
});

test("deriveHerdrSessionName: throws for the default (unnamed) socket with no HERDR_SESSION", () => {
  assert.throws(
    () => deriveHerdrSessionName("/home/ubuntu/.config/herdr/herdr.sock", undefined),
    /HERDR_SESSION/,
  );
});

test("deriveHerdrSessionName: throws for an empty HERDR_SESSION and an unnamed socket", () => {
  assert.throws(
    () => deriveHerdrSessionName("/home/ubuntu/.config/herdr/herdr.sock", "   "),
    /HERDR_SESSION/,
  );
});

// Review finding #5 (.review-fix-1.txt): independently verified live against
// the exact production HERDR_SOCKET from docs/VPS-HERDR-NAMED-SESSION.md — no
// HERDR_SESSION is set there, so this must resolve from the socket path alone.
// Kept as its own case (distinct from the identical-input test above) so a
// regression here fails with an unambiguous, traceable message.
test("deriveHerdrSessionName: resolves 'jeeves' from the documented production HERDR_SOCKET with no HERDR_SESSION set", () => {
  const productionSocket = "/home/ubuntu/.config/herdr/sessions/jeeves/herdr.sock";
  assert.equal(deriveHerdrSessionName(productionSocket, undefined), "jeeves");
});
