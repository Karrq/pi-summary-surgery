// Range model over one root->leaf path of a session tree: marking, slicing, and the per-entry
// previews and full renderings the summarizer tools page through. Nothing here knows about
// summarization; it only needs something that can walk parent links.

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export interface BranchSource {
	getBranch(fromId?: string): SessionEntry[];
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
}

export interface Range {
	startId: string;
	endId: string;
}

export type EntrySize = { tokens: number } | { chars: number };

type AgentMessage = SessionMessageEntry["message"];

// Longest rendering section_read returns per entry unless the caller asks for more.
export const DEFAULT_READ_LIMIT = 20_000;
export const DEFAULT_INDEX_LIMIT = 100;

// ---------------------------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------------------------

/**
 * Toggle a mark on `id`. Marking an already-marked entry clears it. At most two marks are kept;
 * a third replaces whichever existing mark is closest along the path, so a new mark always
 * expands or shrinks the range from the nearer side instead of flipping start and end. On a
 * tie the later mark is replaced.
 */
export function applyMark(pathIds: readonly string[], marks: readonly string[], id: string): string[] {
	if (marks.includes(id)) return marks.filter((mark) => mark !== id);
	if (marks.length < 2) return [...marks, id];

	const at = pathIds.indexOf(id);
	const [a, b] = sortByPath(pathIds, marks);
	const replaceLater = Math.abs(pathIds.indexOf(b) - at) <= Math.abs(pathIds.indexOf(a) - at);
	return replaceLater ? [a, id] : [id, b];
}

/**
 * Resolve marks to a range. The earlier mark is start regardless of marking order; a single mark
 * is the start with the path's last entry as end; no marks means the whole path.
 */
export function resolveRange(pathIds: readonly string[], marks: readonly string[]): Range | undefined {
	if (pathIds.length === 0) return undefined;
	const [first, second] = sortByPath(pathIds, marks);
	return {
		startId: first ?? pathIds[0],
		endId: second ?? pathIds[pathIds.length - 1],
	};
}

function sortByPath(pathIds: readonly string[], ids: readonly string[]): string[] {
	return [...ids].sort((x, y) => pathIds.indexOf(x) - pathIds.indexOf(y));
}

// ---------------------------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------------------------

/** The root->end path for a range, plus where the range starts on it. */
export interface RangePath {
	path: SessionEntry[];
	startIndex: number;
}

/**
 * Walk parent links from `endId` to the root. Start must be an ancestor of end (or end itself);
 * a start/end pair defines exactly one path, which is what makes the range unambiguous no matter
 * where the leaf currently is.
 */
export function rangePath(source: BranchSource, range: Range): RangePath {
	if (!source.getEntry(range.endId)) throw new Error(`Range end ${range.endId} is not in this session`);
	const path = source.getBranch(range.endId);
	const startIndex = path.findIndex((entry) => entry.id === range.startId);
	if (startIndex < 0) throw new Error(`Range start ${range.startId} is not an ancestor of end ${range.endId}`);
	return { path, startIndex };
}

/** The latest content entry on a path, which is where an unmarked range ends. */
export function lastContentId(path: readonly SessionEntry[]): string | undefined {
	for (let i = path.length - 1; i >= 0; i--) if (isContentEntry(path[i])) return path[i].id;
	return undefined;
}

/** Content-bearing entries of the range, in order. */
export function sliceRange(source: BranchSource, range: Range): SessionEntry[] {
	const { path, startIndex } = rangePath(source, range);
	return path.slice(startIndex).filter(isContentEntry);
}

/**
 * Entries worth showing the summarizer. Bookkeeping (labels, usage, session info, context edits,
 * extension state) and system messages (prompt and tool loadout) are skipped.
 */
export function isContentEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role !== "system";
		case "custom_message":
		case "compaction":
		case "branch_summary":
		case "model_change":
		case "thinking_level_change":
			return true;
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------

/** `user`, `assistant`, `toolResult`, ... for messages; the entry type otherwise. */
export function entryKind(entry: SessionEntry): string {
	return entry.type === "message" ? entry.message.role : entry.type;
}

/**
 * Real token counts where the session has them (an assistant message's output usage), otherwise
 * the character length of what section_read would return for it.
 */
export function entrySize(entry: SessionEntry): EntrySize {
	if (entry.type === "message" && entry.message.role === "assistant") {
		const output = entry.message.usage?.output;
		if (typeof output === "number" && output > 0) return { tokens: output };
	}
	return { chars: entryText(entry).length };
}

export function formatSize(size: EntrySize): string {
	return "tokens" in size ? `~${compact(size.tokens)}t` : `${compact(size.chars)} chars`;
}

/** What an entry contains, with tool names but never tool arguments. */
export function entryShape(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return messageShape(entry.message);
		case "custom_message":
			return `custom(${entry.customType})`;
		case "compaction":
			return `compaction tokensBefore=${compact(entry.tokensBefore)}`;
		case "branch_summary":
			return "branch summary";
		case "model_change":
			return `model → ${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return `thinking → ${entry.thinkingLevel}`;
		default:
			return entry.type;
	}
}

function messageShape(message: AgentMessage): string {
	switch (message.role) {
		case "user": {
			const images = typeof message.content === "string" ? 0 : message.content.filter((c) => c.type === "image").length;
			return images > 0 ? `text + image×${images}` : "text";
		}
		case "assistant": {
			const parts: string[] = [];
			if (message.content.some((c) => c.type === "thinking")) parts.push("thinking");
			if (message.content.some((c) => c.type === "text" && c.text.trim())) parts.push("text");
			const tools = unique(message.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : [])));
			if (tools.length > 0) parts.push(`toolCall(${tools.join(", ")})`);
			if (message.stopReason === "error" || message.stopReason === "aborted") parts.push(message.stopReason);
			return parts.join(" + ") || "empty";
		}
		case "toolResult":
			return `${message.toolName} → ${lineCount(contentText(message.content))} lines${message.isError ? " (error)" : ""}`;
		case "bashExecution":
			return `user bash → ${lineCount(message.output)} lines`;
		case "custom":
			return `custom(${message.customType})`;
		case "branchSummary":
			return "branch summary";
		case "compactionSummary":
			return "compaction summary";
		default:
			return (message as { role: string }).role;
	}
}

/** One section_index line: `id | kind | size | shape`. */
export function formatIndexLine(entry: SessionEntry): string {
	return `${entry.id} | ${entryKind(entry)} | ${formatSize(entrySize(entry))} | ${entryShape(entry)}`;
}

// ---------------------------------------------------------------------------------------------
// Full rendering
// ---------------------------------------------------------------------------------------------

/** Everything the summarizer can learn from one entry, tool arguments included. */
export function entryText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return messageText(entry.message);
		case "custom_message":
			return `[Custom ${entry.customType}]: ${contentText(entry.content)}`;
		case "compaction":
			return `[Compaction, ${entry.tokensBefore} tokens before]: ${entry.summary}`;
		case "branch_summary":
			return `[Branch summary]: ${entry.summary}`;
		case "model_change":
			return `[Model changed]: ${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return `[Thinking level changed]: ${entry.thinkingLevel}`;
		default:
			return `[${entry.type}]`;
	}
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return `[User]: ${contentText(message.content)}`;
		case "assistant": {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "thinking" && block.thinking.trim()) parts.push(`[Assistant thinking]: ${block.thinking}`);
				else if (block.type === "text" && block.text.trim()) parts.push(`[Assistant]: ${block.text}`);
				else if (block.type === "toolCall") parts.push(`[Assistant tool call ${block.name}]: ${JSON.stringify(block.arguments)}`);
			}
			if (message.errorMessage) parts.push(`[Assistant error]: ${message.errorMessage}`);
			return parts.join("\n\n");
		}
		case "toolResult":
			return `[Tool result ${message.toolName}${message.isError ? ", error" : ""}]: ${contentText(message.content)}`;
		case "bashExecution":
			return `[User bash]: $ ${message.command}\n${message.output}`;
		case "custom":
			return `[Custom ${message.customType}]: ${contentText(message.content)}`;
		case "branchSummary":
			return `[Branch summary]: ${message.summary}`;
		case "compactionSummary":
			return `[Compaction summary]: ${message.summary}`;
		default:
			return `[${(message as { role: string }).role}]`;
	}
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

export interface IndexOptions {
	/** Inclusive cursor. Omit to page the range forward from its start, or backward from just before it. */
	from?: string;
	direction?: "forward" | "backward";
	limit?: number;
}

export interface IndexPage {
	/** Chronological, whichever direction was paged. */
	entries: { entry: SessionEntry; beforeRange: boolean }[];
	/** Where to continue in the same direction; absent when the page reached the edge. */
	nextCursor?: string;
	/** Forward: reached the range end. Backward: reached the session root. */
	atEdge: boolean;
}

/**
 * Page content entries along the range's path. Forward stops at the range end; backward walks
 * past the range start toward the root, so the summarizer can reach earlier context on purpose.
 */
export function indexPage(source: BranchSource, range: Range, options: IndexOptions = {}): IndexPage {
	const { path, startIndex } = rangePath(source, range);
	const direction = options.direction ?? "forward";
	const limit = Math.max(1, options.limit ?? DEFAULT_INDEX_LIMIT);
	const step = direction === "forward" ? 1 : -1;

	let at: number;
	if (options.from !== undefined) {
		at = path.findIndex((entry) => entry.id === options.from);
		if (at < 0) throw new Error(`Entry ${options.from} is not on the summarized path`);
	} else {
		at = direction === "forward" ? startIndex : startIndex - 1;
	}

	const picked: number[] = [];
	for (; at >= 0 && at < path.length && picked.length < limit; at += step) {
		if (isContentEntry(path[at])) picked.push(at);
	}
	// Skip bookkeeping so the cursor always names an entry the next page actually returns.
	while (at >= 0 && at < path.length && !isContentEntry(path[at])) at += step;

	const hasMore = at >= 0 && at < path.length;
	picked.sort((x, y) => x - y);
	return {
		entries: picked.map((index) => ({ entry: path[index], beforeRange: index < startIndex })),
		nextCursor: hasMore ? path[at].id : undefined,
		atEdge: !hasMore,
	};
}

export interface ReadOptions {
	/** Character offset into each entry's rendering. */
	offset?: number;
	/** Maximum characters returned per entry. */
	limit?: number;
}

export interface ReadResult {
	id: string;
	text: string;
	/** Total length of the rendering, so a truncated read knows how far there is to go. */
	total: number;
	offset: number;
	/** Present when more follows; pass as `offset` to continue. */
	nextOffset?: number;
}

/** Full renderings for entries on the range's path, including any before the range start. */
export function readEntries(source: BranchSource, range: Range, ids: readonly string[], options: ReadOptions = {}): ReadResult[] {
	const { path } = rangePath(source, range);
	const onPath = new Map(path.map((entry) => [entry.id, entry]));
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? DEFAULT_READ_LIMIT);

	return ids.map((id) => {
		const entry = onPath.get(id);
		if (!entry) throw new Error(`Entry ${id} is not on the summarized path`);
		const full = entryText(entry);
		const text = full.slice(offset, offset + limit);
		const end = offset + text.length;
		return { id, text, total: full.length, offset, nextOffset: end < full.length ? end : undefined };
	});
}

// ---------------------------------------------------------------------------------------------

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}
