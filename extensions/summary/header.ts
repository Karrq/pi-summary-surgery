// The summary branch header: a retain-none compaction whose details record the marked range.
// Its presence anywhere on the current path is what makes a branch a summary branch.

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUMMARY_KIND = "summary-surgery";
export const SUMMARY_LABEL = "§summary";

export interface SummaryHeader {
	kind: typeof SUMMARY_KIND;
	startId: string;
	endId: string;
	/** `provider/id` the summarizer ran with. */
	model?: string;
	thinking?: string;
	entryCount: number;
	approxTokens: number;
}

export type SummaryHeaderEntry = CompactionEntry<SummaryHeader>;

export function isSummaryHeader(entry: SessionEntry): entry is SummaryHeaderEntry {
	return entry.type === "compaction" && (entry.details as { kind?: unknown } | undefined)?.kind === SUMMARY_KIND;
}

/**
 * The latest summary header on the current path, or undefined off summary branches. Other
 * compactions are skipped rather than treated as a stop: a long summarizer run can trip a real
 * compaction after the header, and the branch must stay a summary branch regardless.
 */
export function findSummaryHeader(source: { getBranch(): SessionEntry[] }): SummaryHeaderEntry | undefined {
	const path = source.getBranch();
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (isSummaryHeader(entry)) return entry;
	}
	return undefined;
}
