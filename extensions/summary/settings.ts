// Summarizer settings, kept in their own file under the agent dir rather than in pi's shared
// settings.json, which pi rewrites itself.

import fs from "node:fs";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SummarySettings {
	/** `provider/id`; unset means whatever model the session is on. */
	model?: string;
	/** Unset means whatever thinking level the session is on. */
	thinking?: string;
}

const CURRENT = "Use the session's current";

export function settingsPath(): string {
	return path.join(getAgentDir(), "summary-surgery.json");
}

export function loadSettings(file = settingsPath()): SummarySettings {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			model: typeof raw.model === "string" ? raw.model : undefined,
			thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
		};
	} catch {
		return {};
	}
}

export function saveSettings(settings: SummarySettings, file = settingsPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function describeSettings(settings: SummarySettings): string {
	return `model: ${settings.model ?? "current"} · thinking: ${settings.thinking ?? "current"}`;
}

/** The `?` overlay: pick a model, then a thinking level it supports. Esc keeps the old value. */
export async function editSettings(ctx: ExtensionCommandContext, settings: SummarySettings): Promise<SummarySettings> {
	const models = ctx.modelRegistry.getAvailable();
	const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const modelChoice = await ctx.ui.select(`Summarizer model (now: ${settings.model ?? "current"})`, [
		`${CURRENT} (${currentModel})`,
		...models.map((model) => `${model.provider}/${model.id}`),
	]);
	const next: SummarySettings = { ...settings };
	if (modelChoice !== undefined) next.model = modelChoice.startsWith(CURRENT) ? undefined : modelChoice;

	const model = resolveModel(ctx, next.model) ?? ctx.model;
	const levels = model?.reasoning ? getSupportedThinkingLevels(model) : [];
	if (levels.length > 0) {
		const thinkingChoice = await ctx.ui.select(`Summarizer thinking (now: ${next.thinking ?? "current"})`, [
			`${CURRENT} (${ctx.thinkingLevel ?? "default"})`,
			...levels,
		]);
		if (thinkingChoice !== undefined) next.thinking = thinkingChoice.startsWith(CURRENT) ? undefined : thinkingChoice;
	}
	if (next.thinking && model && !(levels as string[]).includes(next.thinking)) next.thinking = undefined;

	saveSettings(next);
	return next;
}

export function resolveModel(ctx: ExtensionCommandContext, spec: string | undefined) {
	if (!spec) return undefined;
	const slash = spec.indexOf("/");
	if (slash < 0) return undefined;
	return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

/**
 * Switch the session to the configured model and thinking level. Deliberately not undone later:
 * the user chose these in the overlay, so switching back is theirs to do.
 */
export async function applySettings(pi: ExtensionAPI, ctx: ExtensionCommandContext, settings: SummarySettings): Promise<string | undefined> {
	if (settings.model) {
		const model = resolveModel(ctx, settings.model);
		if (!model) return `Summarizer model ${settings.model} is not available`;
		if (!(await pi.setModel(model))) return `Could not switch to ${settings.model} (no auth configured?)`;
	}
	if (settings.thinking) pi.setThinkingLevel(settings.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	return undefined;
}
