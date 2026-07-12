import test from "node:test";
import assert from "node:assert/strict";
import { _resetWarningState, maybeWarnAboutDependencies } from "../src/dependency-check.ts";

function makePi() {
	return {
		getAllTools: () => [
			{ name: "subagent", sourceInfo: { source: "pi-subagents" } },
			{ name: "ask_user", sourceInfo: { source: "pi-ask-user" } },
		],
	};
}

function makeContext(notifications) {
	return {
		cwd: "/tmp/project",
		sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
		},
	};
}

test("missing generated skills warns once with npm 12 recovery steps", () => {
	_resetWarningState();
	const notifications = [];
	const pi = makePi();
	const ctx = makeContext(notifications);

	const missingInstallDir = "/tmp/pi-compound-engineering-missing-skills";
	maybeWarnAboutDependencies(pi, ctx, missingInstallDir);
	maybeWarnAboutDependencies(pi, ctx, missingInstallDir);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "warning");
	assert.match(notifications[0].message, /npm 12\+ blocks unapproved dependency scripts/);
	assert.match(notifications[0].message, /npm install-scripts approve pi-compound-engineering/);
	assert.match(notifications[0].message, /npm rebuild pi-compound-engineering/);
});
