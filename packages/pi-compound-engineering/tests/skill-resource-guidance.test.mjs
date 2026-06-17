import test from "node:test";
import assert from "node:assert/strict";
import {
	appendCeSkillResourceGuidance,
	CE_SKILL_RESOURCE_GUIDANCE_MARKER,
	renderCeSkillResourceGuidance,
	shouldAppendCeSkillResourceGuidance,
} from "../src/skill-resource-guidance.ts";

test("renderCeSkillResourceGuidance: describes package-relative CE skill resources", () => {
	const guidance = renderCeSkillResourceGuidance();

	assert.match(guidance, /Compound Engineering \(CE\) skill/);
	assert.match(guidance, /skills\/<skill-name>\/scripts\/<file>/);
	assert.match(guidance, /skills\/<skill-name>\/references\/<file>/);
	assert.match(guidance, /skills\/<skill-name>\/assets\/<file>/);
	assert.match(guidance, /skills\/ce-<skill>\/scripts\/<file>/);
	assert.match(guidance, /skills\/ce-<skill>\/references\/<file>/);
	assert.match(guidance, /skills\/ce-setup\/scripts\/check-health/);
});

test("renderCeSkillResourceGuidance: omits machine-specific absolute paths by default", () => {
	const guidance = renderCeSkillResourceGuidance();

	assert.doesNotMatch(guidance, /\/Users\//);
	assert.doesNotMatch(guidance, /~\//);
	assert.doesNotMatch(guidance, /\/tmp\//);
	assert.doesNotMatch(guidance, /\/var\//);
});

test("renderCeSkillResourceGuidance: includes absolute shell examples when package root is provided", () => {
	const guidance = renderCeSkillResourceGuidance("/opt/pi/packages/pi-compound-engineering");

	assert.match(guidance, /Package install directory for this session/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/skills\/<skill-name>\/\.\.\./);
	assert.match(guidance, /scripts\/<file>/);
	assert.match(guidance, /references\/<file>/);
	assert.match(guidance, /assets\/<file>/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/package\.json/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/skills\/ce-setup\/scripts\/check-health/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/skills\/ce-setup\/references\/config-template\.yaml/);
	assert.match(guidance, /Do not look for/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/plugin\.json/);
	assert.match(guidance, /\/opt\/pi\/packages\/pi-compound-engineering\/scripts\/<file>/);
});

test("renderCeSkillResourceGuidance: stays concise enough for per-turn prompt injection", () => {
	const guidance = renderCeSkillResourceGuidance("/opt/pi/packages/pi-compound-engineering");

	assert.ok(guidance.length < 1600, `guidance should stay short, got ${guidance.length} chars`);
});

test("appendCeSkillResourceGuidance: appends guidance to an existing prompt", () => {
	const out = appendCeSkillResourceGuidance("Base prompt", "/opt/pi/packages/pi-compound-engineering");

	assert.match(out, /^Base prompt\n\n/);
	assert.match(out, new RegExp(CE_SKILL_RESOURCE_GUIDANCE_MARKER));
	assert.match(out, /\/opt\/pi\/packages\/pi-compound-engineering\/skills\/ce-setup\/scripts\/check-health/);
});

test("appendCeSkillResourceGuidance: returns unchanged prompt when marker is already present", () => {
	const prompt = `Base prompt\n\n${CE_SKILL_RESOURCE_GUIDANCE_MARKER}\nExisting guidance`;

	assert.equal(appendCeSkillResourceGuidance(prompt), prompt);
});

test("appendCeSkillResourceGuidance: handles an empty system prompt", () => {
	const out = appendCeSkillResourceGuidance("");

	assert.ok(out.startsWith(CE_SKILL_RESOURCE_GUIDANCE_MARKER));
});

test("shouldAppendCeSkillResourceGuidance: matches direct CE slash commands", () => {
	assert.equal(shouldAppendCeSkillResourceGuidance("/ce-setup"), true);
	assert.equal(shouldAppendCeSkillResourceGuidance("please run /ce-work docs/plans/example.md"), true);
	assert.equal(shouldAppendCeSkillResourceGuidance("/skill:ce-plan something"), true);
});

test("shouldAppendCeSkillResourceGuidance: matches expanded CE package skill content", () => {
	const prompt = '<skill name="ce-setup" location="/example/pi-compound-engineering/skills/ce-setup/SKILL.md">';

	assert.equal(shouldAppendCeSkillResourceGuidance(prompt), true);
});

test("shouldAppendCeSkillResourceGuidance: matches loaded CE skills for natural-language prompts", () => {
	assert.equal(
		shouldAppendCeSkillResourceGuidance("set up Compound Engineering here", [
			{ name: "ce-plan", filePath: "/example/pi-compound-engineering/skills/ce-plan/SKILL.md" },
		]),
		true,
	);
});

test("shouldAppendCeSkillResourceGuidance: matches package-owned skills by path", () => {
	assert.equal(
		shouldAppendCeSkillResourceGuidance("please help", [
			{ name: "setup", baseDir: "/example/pi-compound-engineering/skills/ce-setup" },
		]),
		true,
	);
});

test("shouldAppendCeSkillResourceGuidance: skips unrelated prompts and skill lists", () => {
	assert.equal(shouldAppendCeSkillResourceGuidance("please refactor this helper"), false);
	assert.equal(shouldAppendCeSkillResourceGuidance("/help"), false);
	assert.equal(shouldAppendCeSkillResourceGuidance("concept: ce-work is useful"), false);
	assert.equal(
		shouldAppendCeSkillResourceGuidance("please help", [{ name: "ast-grep", filePath: "/example/skills/ast-grep/SKILL.md" }]),
		false,
	);
});
