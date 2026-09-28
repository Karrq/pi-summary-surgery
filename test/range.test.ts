import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	applyMark,
	entryShape,
	entrySize,
	formatIndexLine,
	indexPage,
	readEntries,
	resolveRange,
	sliceRange,
} from "../extensions/summary/range.ts";

const usage = (output: number) => ({
	input: 0,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function user(sm: SessionManager, text: string): string {
	return sm.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function assistant(sm: SessionManager, content: any[], output = 0): string {
	return sm.appendMessage({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usage(output),
		stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	} as any);
}

function toolResult(sm: SessionManager, toolName: string, text: string): string {
	return sm.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	});
}

/** u1 a1 u2 a2(tool) t2 [label] [compaction] u3 a3 — plus a sibling branch off a1. */
function fixture() {
	const sm = SessionManager.inMemory("/tmp");
	const ids: Record<string, string> = {};
	ids.u1 = user(sm, "first question");
	ids.a1 = assistant(sm, [{ type: "text", text: "first answer" }], 12);
	ids.u2 = user(sm, "run something");
	ids.a2 = assistant(sm, [
		{ type: "thinking", thinking: "should run ls" },
		{ type: "toolCall", id: "call", name: "bash", arguments: { command: "ls -la /secret" } },
	]);
	ids.t2 = toolResult(sm, "bash", "a\nb\nc");
	ids.label = sm.appendLabelChange(ids.u1, "mine");
	ids.compaction = sm.appendCompaction("earlier work summarized", ids.u2, 180_000);
	ids.u3 = user(sm, "after compaction");
	ids.a3 = assistant(sm, [{ type: "text", text: "late answer" }], 30);

	const leaf = sm.getLeafId()!;
	sm.branch(ids.a1);
	ids.sibling = user(sm, "sibling branch");
	sm.branch(leaf);
	return { sm, ids };
}

test("marks: toggle, cap at two, third replaces the closest", () => {
	const path = ["a", "b", "c", "d", "e", "f"];
	assert.deepEqual(applyMark(path, [], "c"), ["c"]);
	assert.deepEqual(applyMark(path, ["c"], "c"), []);
	assert.deepEqual(applyMark(path, ["b", "e"], "f"), ["b", "f"], "extends the end");
	assert.deepEqual(applyMark(path, ["b", "e"], "a"), ["a", "e"], "extends the start");
	assert.deepEqual(applyMark(path, ["b", "e"], "d"), ["b", "d"], "shrinks the end");
	assert.deepEqual(applyMark(path, ["b", "f"], "d"), ["b", "d"], "a tie replaces the later mark");
	assert.deepEqual(applyMark(path, ["e", "b"], "c"), ["c", "e"], "order of marking does not matter");
});

test("resolveRange: earlier mark is start, one mark runs to the end, none is the whole path", () => {
	const path = ["a", "b", "c", "d"];
	assert.deepEqual(resolveRange(path, ["c", "a"]), { startId: "a", endId: "c" });
	assert.deepEqual(resolveRange(path, ["b"]), { startId: "b", endId: "d" });
	assert.deepEqual(resolveRange(path, []), { startId: "a", endId: "d" });
	assert.equal(resolveRange([], []), undefined);
});

test("sliceRange crosses compactions and skips bookkeeping", () => {
	const { sm, ids } = fixture();
	const slice = sliceRange(sm, { startId: ids.u1, endId: ids.a3 });
	assert.deepEqual(
		slice.map((entry) => entry.id),
		[ids.u1, ids.a1, ids.u2, ids.a2, ids.t2, ids.compaction, ids.u3, ids.a3],
	);
});

test("sliceRange rejects a start that is not an ancestor of the end", () => {
	const { sm, ids } = fixture();
	assert.throws(() => sliceRange(sm, { startId: ids.sibling, endId: ids.a3 }), /not an ancestor/);
	assert.throws(() => sliceRange(sm, { startId: ids.u1, endId: "nope" }), /not in this session/);
});

test("previews: real tokens when usage has them, chars otherwise; tool names without args", () => {
	const { sm, ids } = fixture();
	assert.deepEqual(entrySize(sm.getEntry(ids.a1)!), { tokens: 12 });
	assert.deepEqual(entrySize(sm.getEntry(ids.u1)!), { chars: "[User]: first question".length });
	assert.equal(entryShape(sm.getEntry(ids.a2)!), "thinking + toolCall(bash)");
	assert.equal(entryShape(sm.getEntry(ids.t2)!), "bash → 3 lines");
	assert.equal(entryShape(sm.getEntry(ids.compaction)!), "compaction tokensBefore=180.0k");

	const line = formatIndexLine(sm.getEntry(ids.a2)!);
	assert.match(line, new RegExp(`^${ids.a2} \\| assistant \\| \\d+ chars \\| thinking \\+ toolCall\\(bash\\)$`));
	assert.doesNotMatch(line, /secret/);
});

test("indexPage pages forward with an inclusive cursor", () => {
	const { sm, ids } = fixture();
	const range = { startId: ids.u2, endId: ids.a3 };

	const first = indexPage(sm, range, { limit: 2 });
	assert.deepEqual(first.entries.map((e) => e.entry.id), [ids.u2, ids.a2]);
	assert.equal(first.nextCursor, ids.t2);
	assert.equal(first.atEdge, false);

	const second = indexPage(sm, range, { from: first.nextCursor, limit: 2 });
	assert.deepEqual(second.entries.map((e) => e.entry.id), [ids.t2, ids.compaction], "label entry skipped");

	const last = indexPage(sm, range, { from: second.nextCursor, limit: 10 });
	assert.deepEqual(last.entries.map((e) => e.entry.id), [ids.u3, ids.a3]);
	assert.equal(last.nextCursor, undefined);
	assert.equal(last.atEdge, true);
});

test("indexPage backward reaches past the start, flagged, in chronological order", () => {
	const { sm, ids } = fixture();
	const range = { startId: ids.u2, endId: ids.a3 };
	const page = indexPage(sm, range, { direction: "backward" });
	assert.deepEqual(page.entries.map((e) => e.entry.id), [ids.u1, ids.a1]);
	assert.ok(page.entries.every((e) => e.beforeRange));
	assert.equal(page.atEdge, true);

	const inRange = indexPage(sm, range, { limit: 1 });
	assert.equal(inRange.entries[0].beforeRange, false);
});

test("readEntries renders args, pages by chars, and refuses off-path entries", () => {
	const { sm, ids } = fixture();
	const range = { startId: ids.u2, endId: ids.a3 };

	const [call] = readEntries(sm, range, [ids.a2]);
	assert.match(call.text, /\[Assistant tool call bash\]: \{"command":"ls -la \/secret"\}/);
	assert.match(call.text, /\[Assistant thinking\]: should run ls/);

	const [head] = readEntries(sm, range, [ids.a2], { limit: 10 });
	assert.equal(head.text.length, 10);
	assert.equal(head.nextOffset, 10);
	const [tail] = readEntries(sm, range, [ids.a2], { offset: head.nextOffset, limit: 10_000 });
	assert.equal(head.text + tail.text, call.text);
	assert.equal(tail.nextOffset, undefined);

	const [before] = readEntries(sm, range, [ids.u1]);
	assert.equal(before.text, "[User]: first question", "entries before the start are readable");

	assert.throws(() => readEntries(sm, range, [ids.sibling]), /not on the summarized path/);
});
