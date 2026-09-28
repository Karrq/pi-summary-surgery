// section_index / section_read: the summarizer's only tools. Both resolve the range from the
// summary header on the current path, so the model never names a session or a range.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findSummaryHeader } from "./header.ts";
import { DEFAULT_INDEX_LIMIT, DEFAULT_READ_LIMIT, formatIndexLine, indexPage, type Range, readEntries } from "./range.ts";

export const INDEX_TOOL = "section_index";
export const READ_TOOL = "section_read";
export const TOOL_NAMES = [INDEX_TOOL, READ_TOOL];

const MAX_INDEX_LIMIT = 500;
const MAX_READ_IDS = 50;

function currentRange(ctx: ExtensionContext): Range {
	const header = findSummaryHeader(ctx.sessionManager);
	if (!header) throw new Error("Not on a summary branch; there is no marked range to read");
	return { startId: header.details!.startId, endId: header.details!.endId };
}

export function registerSectionTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: INDEX_TOOL,
		label: "Section index",
		description: [
			"List entries of the marked session range, one line each: `id | kind | size | shape`.",
			"Size is output tokens when known, otherwise characters. Shape names tools but omits their arguments.",
			"Pages are chronological. `from` is an inclusive cursor; pass the returned `next` to continue in the same direction.",
			"Omit `from` to page forward from the range start, or backward from just before it.",
			"Backward walks past the range start toward the session root, for context the range depends on; those lines are marked `before range`.",
		].join(" "),
		promptSnippet: "List the entries of the session range being summarized",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Entry id to start at (inclusive)" })),
			direction: Type.Optional(StringEnum(["forward", "backward"] as const, { description: "Default forward" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INDEX_LIMIT, description: `Default ${DEFAULT_INDEX_LIMIT}` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const range = currentRange(ctx);
			const page = indexPage(ctx.sessionManager, range, params);
			const lines = page.entries.map(({ entry, beforeRange }) => `${formatIndexLine(entry)}${beforeRange ? " | before range" : ""}`);
			const edge = params.direction === "backward" ? "reached the session root" : "reached the range end";
			const footer = page.nextCursor ? `next: ${page.nextCursor}` : edge;
			return {
				content: [{ type: "text", text: `${lines.join("\n") || "(no entries)"}\n\n${footer}` }],
				details: { range, count: page.entries.length, nextCursor: page.nextCursor },
			};
		},
	});

	pi.registerTool({
		name: READ_TOOL,
		label: "Section read",
		description: [
			"Read the full content of session entries by id, tool call arguments and results included.",
			"Any entry on the path to the range end can be read, including ones before the range start.",
			`Each entry returns at most \`limit\` characters (default ${DEFAULT_READ_LIMIT}) from \`offset\`; a truncated entry says which offset continues it.`,
		].join(" "),
		promptSnippet: "Read full entries of the session range being summarized",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_READ_IDS, description: "Entry ids from section_index" }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into each entry" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: `Characters per entry, default ${DEFAULT_READ_LIMIT}` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const range = currentRange(ctx);
			const results = readEntries(ctx.sessionManager, range, params.ids, params);
			const text = results
				.map((result) => {
					const span = result.offset > 0 || result.nextOffset !== undefined ? ` (chars ${result.offset}-${result.offset + result.text.length} of ${result.total})` : "";
					const more = result.nextOffset !== undefined ? `\n[truncated; continue with offset=${result.nextOffset}]` : "";
					return `=== ${result.id}${span} ===\n${result.text}${more}`;
				})
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { range, ids: params.ids },
			};
		},
	});
}
