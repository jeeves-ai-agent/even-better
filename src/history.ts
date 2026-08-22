// GET /api/sessions/:id/history — recent conversation turns for the Even App's
// history view. Reuses each provider's existing transcript parser (no second
// discovery path, no new heuristics): a fresh, from-start JsonlTail pass over
// the SAME jsonl the live bridge tails, reduced to the text-only turns that
// live streaming already shows (tool calls/results excluded), matching
// even-terminal 0.8.1's own contract shape (`{ role, text }`, most-recent N in
// chronological order) — see docs/PROTOCOL.md for what interop means here.

import { findSessionFile, parseEntry } from "./transcript.js";
import { CodexEntryParser, findCodexSessionFile } from "./codex-transcript.js";
import { JsonlTail } from "./jsonl-tail.js";
import { hasTranscript, type Provider } from "./provider.js";
import type { AgentEvent } from "./spine.js";

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 50;

/** Clamps a requested `?limit=` to (0, MAX_HISTORY_LIMIT] — missing, non-finite,
 *  or non-positive values fall back to DEFAULT_HISTORY_LIMIT. */
export function clampHistoryLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(Math.trunc(requested), MAX_HISTORY_LIMIT);
}

/** AgentEvent -> HistoryItem: only user/assistant text turns (`prompt`/`say`)
 *  count as history, mirroring even-terminal's own getHistory (text content
 *  blocks only; tool_use/tool_result excluded). Whatever a provider's parser
 *  already decided counts as prose — wrapper/sidechain skips, codex's
 *  event/response-item dedupe — carries through unchanged, so history is never
 *  a second, divergent notion of "the conversation" from what live streaming shows. */
function eventsToHistory(events: AgentEvent[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const e of events) {
    if (e.t === "prompt") items.push({ role: "user", text: e.text });
    else if (e.t === "say") items.push({ role: "assistant", text: e.text });
  }
  return items;
}

/** Recent conversation turns for a Claude session, read from the same jsonl
 *  transcript the live bridge tails (findSessionFile + parseEntry). Never
 *  throws: an unresolved session or a file that vanishes mid-read both yield
 *  [] — the app must never see a hard error for a history fetch. */
export async function readClaudeHistory(sessionId: string, limit: number): Promise<HistoryItem[]> {
  const file = findSessionFile(sessionId);
  if (!file) return [];
  try {
    const events = await new JsonlTail(file, parseEntry, true).readNew();
    return eventsToHistory(events).slice(-limit);
  } catch {
    return [];
  }
}

/** Same as readClaudeHistory but for a Codex rollout transcript. A fresh
 *  CodexEntryParser per call (matching CodexTranscriptTimeline) — its
 *  cross-line dedupe state must not leak across unrelated reads. */
export async function readCodexHistory(sessionId: string, limit: number): Promise<HistoryItem[]> {
  const file = findCodexSessionFile(sessionId);
  if (!file) return [];
  try {
    const parser = new CodexEntryParser();
    const events = await new JsonlTail(file, (line) => parser.parse(line), true).readNew();
    return eventsToHistory(events).slice(-limit);
  } catch {
    return [];
  }
}

/** History for whichever provider a pane runs — the one entry point the HTTP
 *  route uses, so no call site has to re-decide which parser a provider gets.
 *
 *  LIMITATION (cursor): the Cursor CLI has no transcript parser here (its
 *  session log format is deliberately out of scope, like its live content —
 *  cursor mirrors the screen, see PaneBridge.selectTimeline), so its history is
 *  always empty. It must NOT fall through to readClaudeHistory: a cursor pane's
 *  session id is not a Claude session id, and parsing it as one would either
 *  return nothing or, worse, replay an unrelated Claude session that happens to
 *  share the id. Empty + HTTP 200 matches the route's fail-soft contract (see
 *  docs/PROTOCOL.md §History). */
export async function readHistory(
  provider: Provider,
  sessionId: string,
  limit: number,
): Promise<HistoryItem[]> {
  if (!hasTranscript(provider)) return [];
  return provider === "codex" ? readCodexHistory(sessionId, limit) : readClaudeHistory(sessionId, limit);
}
