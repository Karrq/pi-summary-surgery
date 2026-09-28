// Text the summarizer sees: the forced system prompt, the compaction brief that replaces the
// whole prior context, and the request that kicks off the first turn.

import type { SummaryHeader } from "./header.ts";
import { INDEX_TOOL, READ_TOOL } from "./tools.ts";

export const SUMMARIZER_SYSTEM_PROMPT = `You summarize a marked range of an earlier coding-agent session for the user who ran it.

None of that session is in your context. You read it only through two tools:
- ${INDEX_TOOL}: lists the range's entries (id, kind, size, shape), paged.
- ${READ_TOOL}: returns full entries by id, tool arguments and results included.

Method:
- Index the whole range first, then read what matters. Skim large tool results by reading them in slices rather than skipping them when they carry the outcome.
- The range is the subject, not a wall. If something in it only makes sense with earlier context, page ${INDEX_TOOL} backward and read what you need, but keep the summary about the range.
- Report what actually happened, as the entries show it: attempts that failed, reversals, errors, and work left unfinished, not only the final state. Do not take the assistant's own claims of success at face value when the tool results say otherwise.
- Cite entry ids for claims the user may want to check, like (a1b2c3d4).

Summary shape, adapted to the range:
- What the range was about and where it started from.
- What was done, in order, including dead ends.
- Decisions made and why, when the entries say why.
- State at the end of the range: what works, what is broken, what is unverified.
- Open questions and loose ends.

After the summary, the user may ask follow-up questions about the range; answer them the same way, from the entries.`;

export function summaryBrief(header: SummaryHeader): string {
	return [
		"This branch of the session was reset to summarize a marked range of it. Nothing from the conversation before this point is in context; it is only reachable through the section tools.",
		`Range: ${header.startId} → ${header.endId}, ${header.entryCount} entries, ≈${header.approxTokens} tokens.`,
	].join("\n");
}

/** The visible card that marks the branch in the transcript. */
export function summaryCard(header: SummaryHeader): string {
	const model = header.model ? ` · ${header.model}${header.thinking ? `:${header.thinking}` : ""}` : "";
	return `Summarizing ${header.startId} → ${header.endId} · ${header.entryCount} entries · ≈${header.approxTokens} tokens${model}`;
}

export function summaryRequest(focus: string | undefined): string {
	const base = "Summarize the marked range.";
	return focus ? `${base} Focus: ${focus}` : base;
}
