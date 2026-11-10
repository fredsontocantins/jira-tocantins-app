import assert from "node:assert";
import { parseReleaseNote } from "./confluence.js";

const page = {
  id: "3235643414",
  title: "Nota de Release - 2.86.0-BETA",
  url: "https://aztecnologia.atlassian.net/wiki/spaces/P3/pages/3235643414/Notas-de-Release",
  space: { key: "P3", name: "Patrimônio Mobiliário" },
  version: { when: "2026-10-26T00:00:00.000Z" },
  body: { storage: { value: "<p>Resumo da versão 2.86.0-BETA.</p>" } }
};

const r = parseReleaseNote(page);
assert.strictEqual(r.version, "2.86.0-BETA", "versão errada: " + r.version);
assert.strictEqual(r.system, "Patrimônio Mobiliário", "sistema errado: " + r.system);
assert.strictEqual(r.confluencePageId, "3235643414", "id errado");
