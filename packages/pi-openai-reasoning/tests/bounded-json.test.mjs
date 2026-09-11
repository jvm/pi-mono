import assert from "node:assert/strict";
import test from "node:test";
import { boundedStringify } from "../src/bounded-json.ts";

test("bounded JSON preserves native bytes and exact limits", () => {
  const shared = { a: 1, b: "same" };
  const values = [
    null, true, false, 0, -0, 1e100, NaN, Infinity, "",
    "\"\\\b\t\n\f\r\0\u001f café 🌍 \ud800 \udfff \u2028",
    [], {}, [undefined, null, () => {}, Symbol("omitted"), , 2],
    { omitted: undefined, ignored: () => {}, symbol: Symbol("ignored"), "": "", b: 2, "3": 3, "1": 1 },
    { first: shared, second: shared }, [shared, shared],
    Object.assign(Object.create(null), { a: "null prototype" }),
    { toJSON: () => ({ a: 1, b: [2, "three"] }) },
    new Date("2026-09-11T00:00:00Z"),
  ];
  // Cover every UTF-16 code unit, including paired and unpaired surrogates.
  values.push(Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join(""));
  for (const value of values) {
    const expected = JSON.stringify(value);
    const bytes = Buffer.byteLength(expected);
    assert.equal(boundedStringify(value, bytes), expected);
    assert.equal(boundedStringify(value, bytes - 1), undefined);
  }
});

test("bounded JSON stops before later properties and oversized key values", () => {
  let visited = 0;
  const value = {
    text: "x".repeat(1024),
    get later() { visited++; return "must not visit"; },
  };
  assert.equal(boundedStringify(value, 128), undefined);
  assert.equal(visited, 0);
  const largeKey = { ["k".repeat(1024)]: "value" };
  assert.equal(boundedStringify(largeKey, 128), undefined);
  assert.equal(boundedStringify({ text: "\0".repeat(100), get later() { visited++; } }, 128), undefined);
  assert.equal(visited, 0);
});

test("bounded JSON rejects cyclic, boxed, raw and invalid inputs safely", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, 1n, Object("boxed"), undefined, Symbol("unsupported"), () => {}]) {
    assert.equal(boundedStringify(value, 1024), undefined);
  }
  if (JSON.rawJSON) assert.equal(boundedStringify(JSON.rawJSON("123"), 1024), undefined);
  for (const limit of [-1, NaN, Infinity, 1.5]) assert.equal(boundedStringify({}, limit), undefined);
});
