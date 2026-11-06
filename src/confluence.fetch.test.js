import assert from "node:assert";

// Captura a requisição feita pelo módulo sob teste
let capturedUrl = null;
let capturedHeaders = null;

globalThis.fetch = async (url, opts = {}) => {
  capturedUrl = String(url);
  capturedHeaders = opts.headers || {};
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        {
          id: "3235643414",
          title: "Nota de Release - 2.86.0-BETA",
          url: "https://aztecnologia.atlassian.net/wiki/spaces/P3/pages/3235643414/Notas-de-Release",
          space: { key: "P3", name: "Patrimônio Mobiliário" },
          version: { when: "2026-10-26T00:00:00.000Z" },
          body: { storage: { value: "<p>Resumo da 2.86.0-BETA.</p>" } }
        },
        {
          id: "3235643415",
          title: "Notas de Release 6.33.0",
          url: "https://aztecnologia.atlassian.net/wiki/spaces/EDL/pages/3235643415/Notas-de-Release",
          space: { key: "EDL", name: "Edital" },
          version: { when: "2026-10-20T00:00:00.000Z" },
          body: { storage: { value: "<p>Resumo da 6.33.0.</p>" } }
        }
      ]
    })
  };
};

import { fetchReleaseNotes } from "./confluence.js";
import { config } from "./config.js";

config.confluence.email = "test@azi.com.br";
config.confluence.token = "testtoken123";
config.confluence.baseUrl = "https://aztecnologia.atlassian.net/wiki";

const pages = await fetchReleaseNotes();

assert.strictEqual(pages.length, 2, `esperado 2 paginas, obteve ${pages.length}`);

const p1 = pages[0];
assert.strictEqual(p1.id, "3235643414", "id da primeira pagina errado");
assert.strictEqual(p1.title, "Nota de Release - 2.86.0-BETA", "titulo da primeira pagina errado");
assert.strictEqual(p1.space.key, "P3", "space.key da primeira pagina errado");
assert.strictEqual(p1.space.name, "Patrimônio Mobiliário", "space.name da primeira pagina errado");
assert.strictEqual(p1.version.when, "2026-10-26T00:00:00.000Z", "version.when da primeira pagina errado");
assert.ok(p1.body.storage.value.includes("2.86.0-BETA"), "body da primeira pagina deveria conter o resumo");

const p2 = pages[1];
assert.strictEqual(p2.id, "3235643415", "id da segunda pagina errado");
assert.strictEqual(p2.title, "Notas de Release 6.33.0", "titulo da segunda pagina errado");
assert.strictEqual(p2.space.key, "EDL", "space.key da segunda pagina errado");

// Verifica que a requisicao usou a URL base do Confluence + CQL + limit
assert.ok(
  capturedUrl.includes("/wiki/api/v2/pages"),
  `URL deveria conter /wiki/api/v2/pages, obteve: ${capturedUrl}`
);
assert.ok(
  capturedUrl.includes("cql="),
  `URL deveria conter parametro cql, obteve: ${capturedUrl}`
);
assert.ok(
  capturedUrl.includes("limit="),
  `URL deveria conter parametro limit, obteve: ${capturedUrl}`
);

// Verifica autenticacao Basic
assert.ok(
  capturedHeaders.Authorization,
  "cabecalho Authorization nao enviado"
);
assert.ok(
  String(capturedHeaders.Authorization).startsWith("Basic "),
  `cabecalho Authorization deveria ser Basic, obteve: ${capturedHeaders.Authorization}`
);

console.log("fetchReleaseNotes: requisicao para", capturedUrl);
