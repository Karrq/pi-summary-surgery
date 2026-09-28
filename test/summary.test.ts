// End to end against a real AgentSession and pi-ai's faux provider: the requests the summarizer
// actually sends are captured and checked for what reached the model.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import summarySurgery, { parseArgs } from "../extensions/summary/index.ts";
import { findSummaryHeader, SUMMARY_LABEL } from "../extensions/summary/header.ts";
import { SUMMARIZER_SYSTEM_PROMPT } from "../extensions/summary/prompt.ts";
import { TOOL_NAMES } from "../extensions/summary/tools.ts";

type Captured = { system: string; tools: string[]; text: string };

function flatten(context: any): Captured {
	const system = context.messages
		.filter((m: any) => m.role === "system")
		.map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("")))
		.join("\n");
	const tools = new Set<string>();
	for (const m of context.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) tools.add(t.name);
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
	}
	// Tool results are excluded: reading the range back through section_read is the point.
	const text = JSON.stringify(context.messages.filter((m: any) => m.role !== "system" && m.role !== "toolResult"));
	return { system, tools: [...tools].sort(), text };
}

async function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-surgery-"));
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);

	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: [summarySurgery] });
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});

	const errors: string[] = [];
	await session.bindExtensions({
		mode: "print",
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async (targetId, options) => ({ cancelled: (await session.navigateTree(targetId, options)).cancelled }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
		onError: (err) => errors.push(`${err.event}: ${err.error}`),
	});

	const requests: Captured[] = [];
	const reply = (build: () => any) => (context: any) => {
		requests.push(flatten(context));
		return build();
	};
	return { session, faux, requests, reply, errors };
}

async function settle(session: any, faux: { getPendingResponseCount(): number }) {
	for (let i = 0; i < 200 && (faux.getPendingResponseCount() > 0 || session.isStreaming); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await session.waitForIdle();
}

test("parseArgs splits range ids from focus text", () => {
	assert.deepEqual(parseArgs("start=a1 end=b2 the auth bits"), { start: "a1", end: "b2", focus: "the auth bits" });
	assert.deepEqual(parseArgs(""), {});
	assert.deepEqual(parseArgs("just focus"), { focus: "just focus" });
});

test("/summary runs on a clean branch with only the section tools, then leaves the main branch intact", async () => {
	const { session, faux, requests, reply, errors } = await setup();
	try {
		faux.setResponses([
			reply(() => fauxAssistantMessage("MAIN-ANSWER-ONE")),
			reply(() => fauxAssistantMessage("MAIN-ANSWER-TWO")),
		]);
		await session.prompt("MAIN-QUESTION-ONE");
		await session.prompt("MAIN-QUESTION-TWO");

		const sm = session.sessionManager;
		const mainLeaf = sm.getLeafId()!;
		const mainTools = [...session.getActiveToolNames()].sort();
		assert.ok(!mainTools.some((name) => TOOL_NAMES.includes(name)), "section tools stay out of the main branch");
		assert.ok(!requests[0].tools.some((name) => TOOL_NAMES.includes(name)));

		const branch = sm.getBranch();
		const secondQuestion = branch.find((e: any) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("TWO"))!;

		let indexResult = "";
		let readResult = "";
		faux.setResponses([
			reply(() => fauxAssistantMessage([fauxToolCall("section_index", {})], { stopReason: "toolUse" })),
			reply(() => fauxAssistantMessage([fauxToolCall("section_read", { ids: [secondQuestion.id] })], { stopReason: "toolUse" })),
			reply(() => fauxAssistantMessage([fauxText("SUMMARY-TEXT")])),
		]);
		session.subscribe((event: any) => {
			if (event.type !== "tool_execution_end") return;
			const text = event.result?.content?.[0]?.text ?? "";
			if (event.toolName === "section_index") indexResult = text;
			if (event.toolName === "section_read") readResult = text;
		});

		await session.prompt(`/summary start=${secondQuestion.id} end=${mainLeaf} focus on two`);
		// The command returns once it has sent the request; the turn it triggers runs after.
		await settle(session, faux);
		assert.deepEqual(errors, []);

		const summarizer = requests.slice(2);
		assert.equal(summarizer.length, 3, "three summarizer requests");
		for (const request of summarizer) {
			assert.equal(request.system, SUMMARIZER_SYSTEM_PROMPT, "forced summarizer system prompt");
			assert.deepEqual(request.tools, [...TOOL_NAMES].sort(), "only the section tools");
			assert.doesNotMatch(request.text, /MAIN-QUESTION|MAIN-ANSWER/, "no main-branch content in context");
		}
		assert.match(summarizer[0].text, /Summarize the marked range\. Focus: focus on two/);
		assert.match(summarizer[0].text, /reset to summarize a marked range/);

		assert.match(indexResult, new RegExp(`${secondQuestion.id} \\| user`));
		assert.match(indexResult, /reached the range end/);
		assert.match(readResult, /MAIN-QUESTION-TWO/, "the range is reachable through the tools");

		const header = findSummaryHeader(sm)!;
		assert.ok(header, "summary header on the branch");
		assert.equal(header.parentId, mainLeaf, "branches off the leaf the command ran at");
		assert.equal(header.firstKeptEntryId, header.id, "retain-none");
		assert.equal(header.details!.startId, secondQuestion.id);
		assert.equal(sm.getLabel(header.id), SUMMARY_LABEL);

		await session.navigateTree(mainLeaf, { summarize: false });
		const restored = [...session.getActiveToolNames()].sort();
		assert.deepEqual(restored, mainTools, "main loadout comes back on navigation");

		faux.setResponses([reply(() => fauxAssistantMessage("MAIN-ANSWER-THREE"))]);
		await session.prompt("MAIN-QUESTION-THREE");
		await settle(session, faux);
		const back = requests[requests.length - 1];
		assert.notEqual(back.system, SUMMARIZER_SYSTEM_PROMPT);
		assert.match(back.text, /MAIN-QUESTION-ONE/, "main context is whole again");
		assert.doesNotMatch(back.text, /SUMMARY-TEXT|Summarize the marked range/, "summary branch stays off the main path");
	} finally {
		session.dispose();
	}
});
