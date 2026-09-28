// Range picker: pi's own /tree selector over a pruned copy of the active path, with tab-marking.
//
// The stock TreeSelectorComponent gets a tree that contains only the root->leaf path, so every
// /tree behavior (rendering, folding, search, filters) works unmodified and start/end can only
// ever be ancestrally ordered. Marks are shown through TreeList.updateNodeLabel on those copied
// nodes, which never reaches the session. Label editing is switched off by clearing onLabelEdit.

import type { ExtensionCommandContext, SessionEntry, SessionTreeNode, Theme } from "@earendil-works/pi-coding-agent";
import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { applyMark, entryKind, entryText, isContentEntry, type Range, resolveRange, sliceRange } from "./range.ts";

export interface PickerOptions {
	/** Opened on `?`; the picker reopens afterwards with marks and cursor preserved. */
	onSettings?: () => Promise<void>;
	/** Extra status line under the range summary, recomputed on each open. */
	describeSettings?: () => string;
}

type PickerOutcome =
	| { kind: "run"; range: Range }
	| { kind: "settings"; marks: string[]; selectedId?: string }
	| { kind: "cancel" };

/** Show the picker until the user runs a range or cancels. */
export async function pickRange(ctx: ExtensionCommandContext, options: PickerOptions = {}): Promise<Range | undefined> {
	const path = ctx.sessionManager.getBranch();
	if (path.length === 0) {
		ctx.ui.notify("Nothing to summarize yet", "info");
		return undefined;
	}

	let marks: string[] = [];
	let selectedId: string | undefined;
	for (;;) {
		const outcome = await ctx.ui.custom<PickerOutcome>((tui, theme, _keybindings, done) => {
			const labels = new Map(path.map((entry) => [entry.id, ctx.sessionManager.getLabel(entry.id)]));
			// Marks and the default start/end only land on content entries; the leaf is often
			// bookkeeping (a label, a model change, an extension's state entry).
			const pathIds = path.filter(isContentEntry).map((entry) => entry.id);
			const leafId = path[path.length - 1].id;
			const selector = new TreeSelectorComponent(
				prunedTree(path, labels),
				leafId,
				tui.terminal.rows,
				() => {
					const range = resolveRange(pathIds, picker.marks);
					if (range) done({ kind: "run", range });
				},
				() => done({ kind: "cancel" }),
				undefined,
				selectedId ?? leafId,
			);
			selector.getTreeList().onLabelEdit = undefined;

			const picker = new RangePicker(selector, tui, theme, ctx, path, labels, marks, options.describeSettings);
			picker.onSettings = options.onSettings
				? () => done({ kind: "settings", marks: picker.marks, selectedId: picker.selectedId() })
				: undefined;
			return picker;
		});

		if (outcome.kind === "run") return outcome.range;
		if (outcome.kind === "cancel") return undefined;
		marks = outcome.marks;
		selectedId = outcome.selectedId;
		await options.onSettings?.();
	}
}

/** Fresh nodes for the path only, each with its one on-path child. */
function prunedTree(path: SessionEntry[], labels: Map<string, string | undefined>): SessionTreeNode[] {
	let child: SessionTreeNode | undefined;
	for (let i = path.length - 1; i >= 0; i--) {
		child = { entry: path[i], children: child ? [child] : [], label: labels.get(path[i].id) };
	}
	return child ? [child] : [];
}

class RangePicker extends Container implements Focusable {
	marks: string[];
	onSettings?: () => void;
	private readonly selector: TreeSelectorComponent;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly ctx: ExtensionCommandContext;
	private readonly path: SessionEntry[];
	/** Content entries only: the ones a mark or a default boundary can land on. */
	private readonly pathIds: string[];
	private readonly labels: Map<string, string | undefined>;
	private readonly describeSettings?: () => string;
	private readonly status = new Text("", 0, 0);
	private _focused = false;

	constructor(
		selector: TreeSelectorComponent,
		tui: TUI,
		theme: Theme,
		ctx: ExtensionCommandContext,
		path: SessionEntry[],
		labels: Map<string, string | undefined>,
		marks: string[],
		describeSettings?: () => string,
	) {
		super();
		this.selector = selector;
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.path = path;
		this.pathIds = path.filter(isContentEntry).map((entry) => entry.id);
		this.labels = labels;
		this.marks = marks;
		this.describeSettings = describeSettings;
		this.addChild(selector);
		this.addChild(this.status);
		this.refresh();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
	}

	selectedId(): string | undefined {
		return this.selector.getTreeList().getSelectedNode()?.entry.id;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			const id = this.selectedId();
			if (id && this.pathIds.includes(id)) {
				this.marks = applyMark(this.pathIds, this.marks, id);
				this.refresh();
				this.tui.requestRender();
			}
			return;
		}
		// Printable, so the stock list would otherwise treat it as a search character.
		if (data === "?" && this.onSettings) {
			this.onSettings();
			return;
		}
		this.selector.handleInput(data);
	}

	private refresh(): void {
		const range = resolveRange(this.pathIds, this.marks);
		const list = this.selector.getTreeList();
		for (const id of this.pathIds) {
			const tag = id === range?.startId && this.marks.length > 0 ? "start" : id === range?.endId && this.marks.length > 1 ? "end" : undefined;
			const own = this.labels.get(id);
			list.updateNodeLabel(id, tag && own ? `${tag} · ${own}` : (tag ?? own));
		}

		const dim = (text: string) => this.theme.fg("dim", text);
		const lines = [`  ${this.theme.fg("accent", "summary")} ${this.describeRange(range)}`];
		const settings = this.describeSettings?.();
		if (settings) lines.push(`  ${dim(settings)}`);
		lines.push(`  ${dim(`tab mark · enter summarize${this.onSettings ? " · ? settings" : ""} · esc cancel`)}`);
		this.status.setText(lines.join("\n"));
	}

	private describeRange(range: Range | undefined): string {
		if (!range) return "nothing to summarize";
		const entries = sliceRange(this.ctx.sessionManager, range);
		const chars = entries.reduce((sum, entry) => sum + entryText(entry).length, 0);
		const size = `${entries.length} entries · ≈${formatTokens(chars / 4)} tokens`;
		if (this.marks.length === 0) return `whole branch · ${size}`;
		const endNote = this.marks.length === 1 ? " (latest)" : "";
		return `${this.describeEntry(range.startId)} → ${this.describeEntry(range.endId)}${endNote} · ${size}`;
	}

	private describeEntry(id: string): string {
		const entry = this.path.find((candidate) => candidate.id === id);
		if (!entry) return id;
		const preview = entryText(entry).replace(/^\[[^\]]*\]:\s*/, "").replace(/\s+/g, " ").slice(0, 32);
		return `${entryKind(entry)} "${preview}"`;
	}
}

function formatTokens(n: number): string {
	return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));
}
