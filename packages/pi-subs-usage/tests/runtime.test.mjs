import test from "node:test";
import { runtimeSmoke } from "./runtime-smoke.mjs";

test("Pi runtime smoke: real resolver and extension event/command contracts", runtimeSmoke);
