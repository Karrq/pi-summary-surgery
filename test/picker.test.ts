// Drives the picker headlessly: the real TreeSelectorComponent, fed raw key sequences through a
// fake ctx.ui.custom, rendered to plain text.

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { pickRange } from "../extensions/summary/picker.ts";

const UP = "\x1b[A";
const TAB = "\t";
const ENTER = "\r";

initTheme();

function session() {
	const sm = SessionManager.inMemory("/tmp");
	const ids: string[] = [];
	for (const text of ["alpha", "bravo", "charlie", "delta"]) {
		ids.push(sm.appendMessage({ role: "user", content: text, timestamp: Date.now() }));
	}
	// A sibling branch the picker must not show.
	const leaf = sm.getLeafId()!;
	sm.branch(ids[1]);
	sm.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
	sm.branch(leaf);
	sm.appendLabelChange(ids[0], "mine");
	return { sm, ids };
}

/** A ctx whose ui.custom runs the component through `script`, one open at a time. */
function fakeCtx(sm: SessionManager, scripts: ((component: any, render: () => string) => void)[]) {
	const notes: string[] = [];
	const ctx: any = {
		sessionManager: sm,
		ui: {
			notify: (message: string) => notes.push(message),
			custom: async (factory: any) => {
				const script = scripts.shift();
				if (!script) throw new Error("picker opened more times than scripted");
				let result: unknown;
				let finished = false;
				const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
				const component = await factory(tui, themeProxy, {}, (value: unknown) => {
					result = value;
					finished = true;
				});
				const render = () => stripAnsi(component.render(100).join("\n"));
				script(component, render);
				if (!finished) throw new Error("script did not finish the picker");
				return result;
			},
		},
	};
	return { ctx, notes };
}

// The picker only needs fg(); plain passthrough keeps rendered output greppable.
const themeProxy = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function press(component: any, ...keys: string[]) {
	for (const key of keys) component.handleInput(key);
}

test("shows only the active path and tags marks without touching labels", async () => {
	const { sm, ids } = session();
	let rendered = "";
	const { ctx } = fakeCtx(sm, [
		(picker, render) => {
			rendered = render();
			assert.doesNotMatch(rendered, /sibling/, "other branches are pruned");
			assert.match(rendered, /whole branch · 4 entries/);

			press(picker, UP, UP, TAB); // bravo
			rendered = render();
			assert.match(rendered, /\[start\] user: bravo/);
			assert.match(rendered, /user "bravo" → user "delta" \(latest\) · 3 entries/);

			press(picker, UP, TAB); // alpha, second mark
			rendered = render();
			assert.match(rendered, /\[start · mine\] user: alpha/, "an existing label is kept alongside the tag");
			assert.match(rendered, /\[end\] user: bravo/);
			press(picker, ENTER);
		},
	]);

	const range = await pickRange(ctx);
	assert.deepEqual(range, { startId: ids[0], endId: ids[1] });
	assert.equal(sm.getLabel(ids[0]), "mine", "session labels are untouched");
	assert.equal(sm.getLabel(ids[1]), undefined);
});

test("a third mark replaces the closest one, and tab on a mark clears it", async () => {
	const { sm, ids } = session();
	const { ctx } = fakeCtx(sm, [
		(picker, render) => {
			press(picker, UP, UP, UP, TAB); // alpha
			press(picker, TAB); // clear it again
			assert.doesNotMatch(render(), /\[start/);

			press(picker, TAB); // alpha
			press(picker, "\x1b[B", "\x1b[B", "\x1b[B", TAB); // delta
			press(picker, UP, TAB); // charlie: closer to delta, so it replaces the end
			assert.match(render(), /\[end\] user: charlie/);
			press(picker, ENTER);
		},
	]);
	assert.deepEqual(await pickRange(ctx), { startId: ids[0], endId: ids[2] });
});

test("? round-trips through settings with marks and cursor preserved; esc cancels", async () => {
	const { sm, ids } = session();
	let settingsOpened = 0;
	const { ctx } = fakeCtx(sm, [
		(picker) => press(picker, UP, UP, TAB, "?"),
		(picker, render) => {
			assert.match(render(), /\[start\] user: bravo/, "marks survive the settings round trip");
			assert.match(render(), /model: from settings/);
			press(picker, "\x1b");
		},
	]);
	const range = await pickRange(ctx, {
		describeSettings: () => "model: from settings",
		onSettings: async () => {
			settingsOpened++;
		},
	});
	assert.equal(range, undefined);
	assert.equal(settingsOpened, 1);
	void ids;
});
