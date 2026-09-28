// /summary: summarize a marked range of the session on a clean-context branch of the same
// session. See docs/PLAN.md.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { findSummaryHeader, SUMMARY_KIND, SUMMARY_LABEL, type SummaryHeader } from "./header.ts";
import { pickRange } from "./picker.ts";
import { SUMMARIZER_SYSTEM_PROMPT, summaryBrief, summaryCard, summaryRequest } from "./prompt.ts";
import { entryText, lastContentId, type Range, rangePath, sliceRange } from "./range.ts";
import { applySettings, describeSettings, editSettings, loadSettings } from "./settings.ts";
import { registerSectionTools, TOOL_NAMES } from "./tools.ts";

export interface SummaryArgs {
	start?: string;
	end?: string;
	focus?: string;
}

/** `start=<id> end=<id>` select the range without the picker; everything else is focus text. */
export function parseArgs(args: string): SummaryArgs {
	const parsed: SummaryArgs = {};
	const focus: string[] = [];
	for (const word of args.trim().split(/\s+/).filter(Boolean)) {
		const match = /^(start|end)=(\S+)$/.exec(word);
		if (match) parsed[match[1] as "start" | "end"] = match[2];
		else focus.push(word);
	}
	if (focus.length > 0) parsed.focus = focus.join(" ");
	return parsed;
}

export default function summarySurgery(pi: ExtensionAPI): void {
	registerSectionTools(pi);

	// Section tools exist only on summary branches; everywhere else they stay out of the prompt.
	const syncTools = (ctx: ExtensionContext) => {
		const onSummary = findSummaryHeader(ctx.sessionManager) !== undefined;
		const active = pi.getActiveTools();
		const next = onSummary ? TOOL_NAMES : active.filter((name) => !TOOL_NAMES.includes(name));
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
	};
	pi.on("session_start", (_event, ctx) => syncTools(ctx));
	pi.on("session_tree", (_event, ctx) => syncTools(ctx));

	pi.on("before_agent_start", (_event, ctx) => {
		if (findSummaryHeader(ctx.sessionManager)) return { systemPrompt: SUMMARIZER_SYSTEM_PROMPT };
		return undefined;
	});

	pi.registerCommand("summary", {
		description: "Summarize a marked range of this session on a clean-context branch (start=<id> end=<id> to skip the picker)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseArgs(args);
			let settings = loadSettings();

			let range: Range | undefined;
			if (parsed.start) {
				range = { startId: parsed.start, endId: parsed.end ?? lastContentId(ctx.sessionManager.getBranch()) ?? parsed.start };
			} else if (ctx.hasUI) {
				range = await pickRange(ctx, {
					describeSettings: () => describeSettings(settings),
					onSettings: async () => {
						settings = await editSettings(ctx, settings);
					},
				});
				if (!range) return;
			} else {
				ctx.ui.notify("Pass start=<id> [end=<id>] to /summary when there is no picker", "error");
				return;
			}

			try {
				await startSummary(pi, ctx, range, parsed.focus, settings);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}

/**
 * Branch off the current leaf into a summarizer context and send the request.
 *
 * Extensions only get a read-only view of the session manager and there is no public way to
 * append a compaction while idle, so the header goes through the underlying SessionManager. Every
 * provider request is rebuilt from the session projection, so the request that follows sees the
 * reset branch regardless. What the raw append skips is pi's own bookkeeping: no entry_appended
 * event and no refresh of the in-memory transcript. The idle custom message after it goes through
 * pi's normal append path, which refreshes that transcript and gives the branch a visible marker.
 */
export async function startSummary(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	range: Range,
	focus: string | undefined,
	settings: ReturnType<typeof loadSettings>,
): Promise<void> {
	rangePath(ctx.sessionManager, range);
	const entries = sliceRange(ctx.sessionManager, range);
	const chars = entries.reduce((sum, entry) => sum + entryText(entry).length, 0);

	const settingsError = await applySettings(pi, ctx, settings);
	if (settingsError) throw new Error(settingsError);

	const header: SummaryHeader = {
		kind: SUMMARY_KIND,
		startId: range.startId,
		endId: range.endId,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: settings.thinking ?? pi.getThinkingLevel(),
		entryCount: entries.length,
		approxTokens: Math.round(chars / 4),
	};

	pi.setActiveTools(TOOL_NAMES);
	const sessionManager = ctx.sessionManager as unknown as SessionManager;
	const tokensBefore = ctx.getContextUsage()?.tokens ?? 0;
	const headerId = sessionManager.appendCompaction(summaryBrief(header), null, tokensBefore, header, true);
	pi.setLabel(headerId, SUMMARY_LABEL);
	pi.sendMessage({ customType: SUMMARY_KIND, content: summaryCard(header), display: true, details: header });
	pi.sendUserMessage(summaryRequest(focus));
}
