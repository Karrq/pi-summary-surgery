# /summary — summarize a marked stretch of the conversation

## Goal

Mark an explicit range of the current branch, then have a model summarize exactly that range
with a clean context, without the summary or its retrieval work polluting the conversation it
is summarizing.

The summarizer runs as the normal agent loop, in the same session, on a branch off the current
leaf whose context has been reset to nothing by a retain-none compaction. It reads the marked
range through two dedicated tools that walk the session tree in-process.

No subagent, no child process, no session file parsing, no context_edit fan-out.

## Shape

```
main branch ... ─ [leaf] ─┬─ (next user message, after you navigate back)
                          │
                          └─ [compaction: retain-none, §summary]   ← context resets here
                             └─ [user: summarizer prompt]
                                └─ [assistant: summary]
                                   └─ (follow-up Q&A, same clean context)
```

The compaction entry is the branch header. It carries three things at once:

- `summary` — the brief, which is the only thing in context besides the prompt;
- `details` — `{ kind: "summary-surgery", startId, endId, model, thinking }`, the durable record of
  what was marked;
- `systemMessage` — the prompt/tool checkpoint pi snapshots automatically.

Everything before it is out of context. Everything about the range is recoverable from it.

## Files

`extensions/summary/` in this repo, loaded as a pi package (`pi.extensions` in `package.json`).

| File | Contents |
|---|---|
| `index.ts` | extension factory: command, tools, `before_agent_start`, settings load |
| `range.ts` | branch slicing, ancestry validation, entry previews, index/read primitives |
| `picker.ts` | `TreeSelectorComponent` wrapper: tab-marking, `[start]`/`[end]` tags, `?` overlay |
| `tools.ts` | `section_index` / `section_read` definitions over `range.ts` |
| `prompt.ts` | brief text, summarizer prompt, forced system prompt |
| `settings.ts` | read/write the `summary-surgery` key in `~/.pi/agent/settings.json` |

`range.ts` and `picker.ts` know nothing about summarization; they are the reusable half.

## Data model

```ts
type SectionRange = { startId: string; endId: string };

type SummaryHeader = {
  kind: "summary-surgery";
  startId: string;
  endId: string;
  model?: string;      // provider/id actually used
  thinking?: string;
  entryCount: number;
  approxTokens: number;
};
```

Markers are in-memory only, from picker open to `sendUserMessage`. Their durable form is
`SummaryHeader` inside the compaction entry's `details`.

## Flow

`/summary`:

1. `ctx.waitForIdle()`, then open the picker overlay via `ctx.ui.custom()`.
2. Picker returns `{ startId, endId }` or cancels. `endId` defaults to the current leaf.
3. Apply settings: `pi.setActiveTools(["section_index", "section_read"])`, plus
   `pi.setModel()` / `pi.setThinkingLevel()` if the overlay changed them.
4. `ctx.sessionManager.appendCompaction(brief, null, tokensBefore, header, true)`.
   `null` for `firstKeptEntryId` is what makes it retain-none (`session-manager.js:890`
   stores the entry's own id), so nothing before it survives into context.
5. `pi.setLabel(compactionId, "§summary")` so it is findable in `/tree`.
6. `pi.sendUserMessage(summarizerPrompt)` — triggers the turn immediately when idle.
7. The user reads the summary, asks follow-ups on the branch, and leaves via `/tree`
   whenever they want. Nothing auto-navigates.

Leaving restores the main tool loadout by itself: `navigateTree` calls
`_restoreToolsFromTranscript` (`agent-session.js:3003`), and tool state is branch-scoped.
The model is not auto-restored — the user changed it deliberately in the overlay, so they
own changing it back.

## Picker

Wraps `TreeSelectorComponent` (exported from the package) inside `ctx.ui.custom()`, same
pattern as `branch-view.ts`, restricted to the active root→leaf path so start/end are
guaranteed to be ancestrally ordered by construction.

| Key | Action |
|---|---|
| `tab` | toggle a mark on the selected entry |
| `enter` | execute with the current marks |
| `?` | settings overlay (model, thinking) |
| `esc` | cancel |

Stock `/tree` keys (navigation, folding, search, filter cycling) keep working. Label editing
is disabled — this picker does not write labels.

Mark rules:

- max 2 marks; a third replaces the **closest** existing mark, so a mark is always an
  expand/shrink rather than a start/end flip;
- earlier-in-branch is start regardless of mark order;
- 1 mark means start, with end = current leaf;
- 0 marks means the whole branch.

Marked rows render an inline `[start]` / `[end]` tag, recomputed on every toggle. The status
line shows the resolved range and its size (entries, approx tokens).

Settings overlay writes through to `~/.pi/agent/settings.json` under `"summary-surgery"`
(`{ model?, thinking? }`), read at `session_start`. There is no timeout setting — the run is
a normal turn and esc aborts it like any other.

## Tools

Both run in-process against `ctx.sessionManager`, and both resolve their own range: walk
leaf→root for the first compaction entry whose `details.kind === "summary-surgery"`, read
`startId`/`endId` from it. Any other compaction encountered on the way is skipped, not a
stop — see [System prompt](#system-prompt) for why. The model never passes a session path or range, so it cannot point
at the wrong thing. `getBranch(endId)` stays valid from anywhere in the tree because it walks
parent links, so the sibling summarizer branch does not disturb it.

### `section_index({ from?, direction?, limit? })`

- `from` — entry id to start at; defaults to `startId`
- `direction` — `"forward"` (default, toward `endId`) or `"backward"` (toward root, past
  `startId`)
- `limit` — default 100

Returns one line per entry plus `nextCursor` and `atRangeEdge`:

```
id | role/type | size | shape
a1b2c3d4 | user       | ~120t  | text
b2c3d4e5 | assistant  | ~840t  | text + toolCall(bash, read)
c3d4e5f6 | toolResult | ~4.2kt | bash → 312 lines
f1e2d3c4 | compaction | ~1.1kt | compaction tokensBefore=180k
```

Size is tokens when the entry carries usage, otherwise characters — one or the other, never
both. Shape lists tool names only, never arguments.

`direction: "backward"` from `startId` is the deliberate escape hatch: the summarizer can
widen past the marked start when it needs earlier context, and results outside the range are
flagged so it knows it is reaching. It cannot go past `endId`, and cross-branch access is not
expressible — a start/end pair defines exactly one path.

### `section_read({ ids, offset?, limit? })`

Full content for the named entries. `offset`/`limit` are character-based, for oversized tool
results. Compaction entries read as their summary; bash entries as command + output.

Both tools are the only active tools on the branch, so the summarizer has no way to read
files, run commands, or otherwise wander.

## System prompt

`before_agent_start` checks whether *any* compaction on the current path is a `§summary`
header; if so it returns a forced `systemPrompt` describing the summarizer's job and its two
tools. Forcing is per-turn, so the check re-applies on every follow-up turn, which makes the
branch durably a summarizer context.

"Any", not "nearest": a very long summarization run can itself trigger a real compaction
after our header, and that must not flip the branch back to the coding prompt. Summary
headers are only ever written onto summarizer branches, so their presence anywhere on the
path is sufficient. The summarizer is not expected to become a workhorse afterwards, so a
summary branch staying a summary branch forever is the intended behavior. Section surgery via
`systemPromptOptions.sections` would be recorded in the transcript rather than forced, and is
the later refinement if forcing proves awkward.

## Primitives used

| Need | API |
|---|---|
| command | `pi.registerCommand("summary-surgery", { handler })` |
| picker overlay | `ctx.ui.custom()`, `TreeSelectorComponent`, `matchesKey`, `Container`, `Text` |
| tree data | `sessionManager.getTree()`, `getLeafId()`, `getBranch(id)`, `getEntry(id)` |
| context reset | `sessionManager.appendCompaction(summary, null, tokensBefore, details, true)` |
| findability | `pi.setLabel(id, "§summary")` |
| tool loadout | `pi.setActiveTools([...])` |
| model/thinking | `pi.setModel()`, `pi.setThinkingLevel()` |
| kick off the turn | `pi.sendUserMessage(prompt)` |
| prompt override | `pi.on("before_agent_start")` → `{ systemPrompt }` |
| sizing | `estimateTokens`, `calculateContextTokens`, `ctx.getContextUsage()` |
| tools | `pi.registerTool()` with typebox schemas |

## Known behaviors

- **Our brief is what lands, not OM's.** `session_before_compact` is emitted only from
  `AgentSession.compact()` (`agent-session.js:1889, :2176`); `appendCompaction` writes
  directly with no event, so observational-memory's compaction hook never runs for it.
- **OM auto-compaction is suppressed on the branch.** Its trigger measures
  `rawTokensSinceLastCompaction(getBranch())`, and our entry is the latest compaction on that
  path, so the counter reads ~0 from the split onward.
- **OM consolidation still fires** on the summarizer's turns and appends observations to the
  summary branch. Those disappear from the main path when the user navigates back; the cost is
  a couple of background worker calls per turn.
- **A real compaction after our header is not clean.** If a long run trips pi's or OM's
  auto-compaction on the summary branch, the resulting summary is built from `getBranch()`,
  which includes the main history the branch descends from. The system prompt and tools stay
  correct (the header is still on the path), but the context would regain main-branch
  material. Accepted for now; the fix, if needed, is a `session_before_compact` handler that
  re-emits a retain-none summary-surgery compaction on summary branches.
- **Cache.** The branch's first request is a full miss on a tiny body, so it is cheap. Coming
  back hits the main prefix only within the cache TTL (300s / 3600s on the configured models);
  a long summarizer session costs one cache re-write on the next main-branch turn.
- **The checkpoint's tool list is one request stale.** `appendCompaction` snapshots the system
  message from the current projection, which still declares the main loadout; the first request
  patches it with the tool delta. Net context is correct.
- **`/subagents` does not list it,** because there is no subagent. `/tree` and the `§summary`
  label are the entry points.

## Build order

1. `range.ts` + `picker.ts` — exercise marking, validation, and slicing with a temporary
   command that just reports the resolved range. No model involved.
2. `tools.ts` — index/read, testable from the main branch against a hand-written range.
3. `index.ts` + `prompt.ts` — compaction header, prompt, forced system prompt, settings.

## Non-goals

- No injection of the summary back into the main branch. Navigating back is the user's call.
- No automatic return to the pre-split leaf.
- No cross-branch ranges.
- No external model process; model diversity comes from the `?` overlay.
