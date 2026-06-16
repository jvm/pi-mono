import test from "node:test";
import assert from "node:assert/strict";
import {
	parseFrontmatter,
	parseSimpleYaml,
	splitTopLevelCommas,
	transformContentForPi,
	unquoteScalar,
	normalizeName,
	sanitizePathName,
	sanitizeDescription,
} from "../scripts/converter.mjs";

// ---------------------------------------------------------------------------
// transformContentForPi
// ---------------------------------------------------------------------------

test("transformContentForPi: rewrites Task(agent) with arguments", () => {
	// The task regex is anchored to the start of a line. Mid-sentence
	// "Task" is left alone; see the "only rewrites Task at line start"
	// test below.
	//
	// The replacement ends with a period and the regex does not consume
	// the trailing period after the `)`, so an input like
	// "Task foo(args)." produces a double period. This matches the
	// upstream `claude-to-pi.ts` behavior, preserved on purpose.
	const input = "Task repo-research-analyst(feature_description). Then continue.";
	const out = transformContentForPi(input);
	assert.equal(
		out,
		'Run subagent with agent="repo-research-analyst" and task="feature_description".. Then continue.',
	);
});

test("transformContentForPi: rewrites Task(agent) without arguments", () => {
	// The task regex is anchored to the start of a line (after optional
	// whitespace and an optional list dash). Mid-sentence "Task" is not
	// rewritten — see the dedicated "only rewrites Task at line start"
	// test below.
	//
	// Note: the empty-arg replacement ends with a period and the
	// original `()` does not consume the trailing `.`, so an input like
	// "Task foo(). Then..." produces a double period. This is the
	// upstream `claude-to-pi.ts` behavior, preserved here on purpose.
	const input = "Task code-reviewer(). Then continue.";
	const out = transformContentForPi(input);
	assert.equal(out, 'Run subagent with agent="code-reviewer".. Then continue.');
});

test("transformContentForPi: strips the compound-engineering: namespace prefix", () => {
	const input = "Task compound-engineering:research:repo-research-analyst(args go here)";
	const out = transformContentForPi(input);
	assert.equal(
		out,
		'Run subagent with agent="repo-research-analyst" and task="args go here".',
	);
});

test("transformContentForPi: rewrites the Claude Code task-tracking primitives", () => {
	const input = "Use TaskCreate to add a task, TaskUpdate to mark progress, and TaskList to review.";
	const out = transformContentForPi(input);
	assert.equal(
		out,
		"Use the platform's task-tracking primitive to add a task, the platform's task-tracking primitive to mark progress, and the platform's task-tracking primitive to review.",
	);
});

test("transformContentForPi: rewrites TaskGet/TaskStop/TaskOutput too", () => {
	const input = "TaskGet then TaskStop then TaskOutput.";
	const out = transformContentForPi(input);
	assert.equal(
		out,
		"the platform's task-tracking primitive then the platform's task-tracking primitive then the platform's task-tracking primitive.",
	);
});

test("transformContentForPi: rewrites TodoWrite and TodoRead", () => {
	const input = "Use TodoWrite to plan, then TodoRead to check.";
	const out = transformContentForPi(input);
	assert.equal(
		out,
		"Use the platform's task-tracking primitive to plan, then the platform's task-tracking primitive to check.",
	);
});

test("transformContentForPi: only rewrites Task at the start of a (possibly-indented) line", () => {
	// Upstream regex anchors on the line start (after optional whitespace and a
	// leading dash for list items). A mid-sentence "Task foo" is left alone.
	const input = "Use the regular Task foo agent to proceed.";
	const out = transformContentForPi(input);
	assert.equal(out, input);
});

test("transformContentForPi: rewrites Task inside a list item (preserves the leading dash)", () => {
	const input = "- Task reviewer(score the work)";
	const out = transformContentForPi(input);
	assert.equal(out, '- Run subagent with agent="reviewer" and task="score the work".');
});

test("transformContentForPi: normalizes /command names", () => {
	const input = "Run /ce-plan to plan, then /ce_code_review to review.";
	const out = transformContentForPi(input);
	assert.equal(out, "Run /ce-plan to plan, then /ce_code_review to review.");
});

test("transformContentForPi: strips the prompts: prefix on slash commands", () => {
	const input = "Run /prompts:ce-plan to start.";
	const out = transformContentForPi(input);
	assert.equal(out, "Run /ce-plan to start.");
});

test("transformContentForPi: keeps the skill: prefix on slash commands (only the part after the colon is normalized)", () => {
	// The upstream `claude-to-pi` rewrite preserves the `skill:` namespace
	// and only normalizes the part after the colon. The character class
	// in the slash-command regex is `[a-z0-9_:-]` (no space), so the
	// capture stops at the first non-matching char. The `skill:` prefix
	// check therefore only fires when the namespace name itself uses
	// the allowed chars; mixed-case or whitespace names are left
	// alone (the `skill:` namespace never gets a chance to apply).
	const out = transformContentForPi("Invoke /skill:ce-plan via the skill loader.");
	assert.equal(out, "Invoke /skill:ce-plan via the skill loader.");
	const out2 = transformContentForPi("Invoke /skill:ce:plan via the skill loader.");
	assert.equal(out2, "Invoke /skill:ce-plan via the skill loader.");
});

test("transformContentForPi: leaves filesystem-looking /dev etc. alone", () => {
	const input = "Look at /etc/hosts, /tmp/foo, /var/log and /usr/local/bin.";
	const out = transformContentForPi(input);
	assert.equal(out, input);
});

test("transformContentForPi: leaves a bare /dev slash command alone (no colon-name space)", () => {
	// "/dev" is a real path. The slash-command regex only matches a name
	// containing alphanumerics/colons/underscores, so this is a no-op.
	assert.equal(transformContentForPi("see /dev/null for details"), "see /dev/null for details");
});

test("transformContentForPi: empty input is empty output", () => {
	assert.equal(transformContentForPi(""), "");
});

test("transformContentForPi: passes through content with no markers unchanged", () => {
	const input = "Just a normal sentence with no CE primitives.";
	assert.equal(transformContentForPi(input), input);
});

// ---------------------------------------------------------------------------
// parseFrontmatter + parseSimpleYaml (the hand-rolled YAML parser)
// ---------------------------------------------------------------------------

test("parseFrontmatter: returns empty data + raw body when no frontmatter is present", () => {
	const out = parseFrontmatter("Hello world\n");
	assert.deepEqual(out.data, {});
	assert.equal(out.body, "Hello world\n");
	assert.equal(out.startIndex, -1);
	assert.equal(out.endIndex, -1);
});

test("parseFrontmatter: parses simple string scalars", () => {
	const raw = "---\nname: ce-plan\ndescription: A planning skill\n---\nBody\n";
	const out = parseFrontmatter(raw);
	assert.deepEqual(out.data, { name: "ce-plan", description: "A planning skill" });
	assert.equal(out.body, "Body\n");
});

test("parseFrontmatter: parses single-quoted and double-quoted strings", () => {
	const raw = '---\na: "double quoted"\nb: \'single quoted\'\nc: unquoted\n---\n';
	const out = parseFrontmatter(raw);
	assert.deepEqual(out.data, {
		a: "double quoted",
		b: "single quoted",
		c: "unquoted",
	});
});

test("parseFrontmatter: parses inline and block arrays", () => {
	const raw = "---\ninline: [a, b, c]\nblock:\n  - one\n  - two\nempty: []\n---\n";
	const out = parseFrontmatter(raw);
	assert.deepEqual(out.data, {
		inline: ["a", "b", "c"],
		block: ["one", "two"],
		empty: [],
	});
});

test("parseFrontmatter: parses booleans, numbers, and null", () => {
	const raw = "---\non: true\noff: false\nn: 42\npi: 3.14\nnil: null\n---\n";
	const out = parseFrontmatter(raw);
	assert.deepEqual(out.data, { on: true, off: false, n: 42, pi: 3.14, nil: null });
});

test("parseFrontmatter: returns empty data when the closing --- is missing", () => {
	const raw = "---\nname: ce-plan\nbody continues without a closer\n";
	const out = parseFrontmatter(raw);
	// Without a closer the parser treats the whole thing as body and returns
	// empty data, so the body is identical to the input.
	assert.deepEqual(out.data, {});
	assert.equal(out.body, raw);
});

test("parseFrontmatter: skips blank lines and comment lines", () => {
	const raw = "---\n# a comment\n\nname: ce-plan\n# another comment\ndescription: x\n---\n";
	const out = parseFrontmatter(raw);
	assert.deepEqual(out.data, { name: "ce-plan", description: "x" });
});

test("parseSimpleYaml: empty input yields empty data", () => {
	assert.deepEqual(parseSimpleYaml(""), {});
});

test("parseSimpleYaml: skips list-continuation lines outside an array", () => {
	const raw = "name: ce-plan\n- not an array\ndescription: x\n";
	// The "- not an array" is treated as a list-continuation line and
	// skipped; it does not poison the surrounding scalar parse.
	const data = parseSimpleYaml(raw);
	assert.equal(data.name, "ce-plan");
	assert.equal(data.description, "x");
});

test("parseSimpleYaml: leaves an empty key value as null", () => {
	const data = parseSimpleYaml("foo:\nbar: baz\n");
	assert.equal(data.foo, null);
	assert.equal(data.bar, "baz");
});

test("splitTopLevelCommas: splits on top-level commas only", () => {
	assert.deepEqual(splitTopLevelCommas("a,b,c"), ["a", "b", "c"]);
	assert.deepEqual(splitTopLevelCommas(""), []);
});

test("splitTopLevelCommas: respects nested brackets and braces", () => {
	assert.deepEqual(splitTopLevelCommas("a,[b,c],{d,e}"), ["a", "[b,c]", "{d,e}"]);
	assert.deepEqual(splitTopLevelCommas("a, [nested, [more, [deep]]], b"), [
		"a",
		" [nested, [more, [deep]]]",
		" b",
	]);
});

test("splitTopLevelCommas: respects quoted commas and escapes", () => {
	// Quoted segments are kept as a single item (the matching quote is
	// toggled, so a comma inside "..." or '...' is not a top-level
	// separator). Backslash-escapes are *not* processed within the value
	// itself — the function only tracks quote state, not escape state.
	// The function also does not strip surrounding whitespace; callers
	// .trim() what they need.
	assert.deepEqual(splitTopLevelCommas('"a,b", \'c,d\', e'), ['"a,b"', " 'c,d'", ' e']);
	// A single unmatched quote (no closing quote) treats the rest of the
	// string as part of the same item.
	assert.deepEqual(splitTopLevelCommas('"has comma, ok", plain'), [
		'"has comma, ok"',
		" plain",
	]);
});

test("splitTopLevelCommas: trims nothing by design (caller is responsible)", () => {
	// The function returns raw segments; callers .trim() what they need.
	assert.deepEqual(splitTopLevelCommas("  a  ,  b  "), ["  a  ", "  b  "]);
});

test("unquoteScalar: handles single, double, none, and escapes", () => {
	assert.equal(unquoteScalar('"hello"'), "hello");
	assert.equal(unquoteScalar("'world'"), "world");
	assert.equal(unquoteScalar("plain"), "plain");
	// Inside double quotes, the function un-escapes \" and \\.
	assert.equal(unquoteScalar('"say \\"hi\\""'), 'say "hi"');
	// Inside single quotes, the function un-escapes \' and \\.
	assert.equal(unquoteScalar("'it\\'s'"), "it's");
});

test("unquoteScalar: parses booleans, numbers, and null", () => {
	assert.equal(unquoteScalar("true"), true);
	assert.equal(unquoteScalar("false"), false);
	assert.equal(unquoteScalar("null"), null);
	assert.equal(unquoteScalar("~"), null);
	assert.equal(unquoteScalar("42"), 42);
	assert.equal(unquoteScalar("-7"), -7);
	assert.equal(unquoteScalar("3.14"), 3.14);
});

// ---------------------------------------------------------------------------
// Name + description helpers (used by convertClaudeToPi and convertAgent)
// ---------------------------------------------------------------------------

test("normalizeName: lowercases, collapses non-alphanumerics, trims dashes", () => {
	assert.equal(normalizeName("CE Plan"), "ce-plan");
	assert.equal(normalizeName("ce:plan"), "ce-plan");
	// Underscores are kept (they're in the allowed character class); the
	// surrounding dashes and whitespace are trimmed.
	assert.equal(normalizeName("  --foo__bar--  "), "foo__bar");
	assert.equal(normalizeName(""), "item");
	assert.equal(normalizeName("..."), "item");
});

test("sanitizePathName: replaces colons only (leaves dashes/underscores alone)", () => {
	assert.equal(sanitizePathName("ce:plan"), "ce-plan");
	assert.equal(sanitizePathName("foo_bar"), "foo_bar");
	assert.equal(sanitizePathName("foo-bar"), "foo-bar");
});

test("sanitizeDescription: collapses whitespace and truncates with ellipsis", () => {
	assert.equal(sanitizeDescription("a  b\nc"), "a b c");
	assert.equal(sanitizeDescription("short"), "short");
	const long = "x".repeat(2000);
	const out = sanitizeDescription(long, 100);
	assert.equal(out.length, 100);
	assert.match(out, /\.\.\.$/);
});
