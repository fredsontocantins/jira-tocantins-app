import assert from "node:assert";
import { confluenceAuthHeader } from "./config.js";

const header = confluenceAuthHeader("user@azi.com.br", "token123");
const expected =
  "Basic " + Buffer.from("user@azi.com.br:token123").toString("base64");
assert.strictEqual(header, expected, "header incorreto");
