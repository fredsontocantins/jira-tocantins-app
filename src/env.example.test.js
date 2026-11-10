import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.example");
const content = fs.readFileSync(envPath, "utf8");
for (const v of ["CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_TOKEN", "CONFLUENCE_CQL", "CONFLUENCE_LIMIT"]) {
  assert.ok(content.includes(v), `variavel ${v} nao encontrada no .env.example`);
}
