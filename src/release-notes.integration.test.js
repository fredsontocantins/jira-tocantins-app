import assert from "node:assert";
import { createSession } from "./auth.js";

// Importar server.js sobe o app na porta 3000; usamos fetch HTTP contra ele.
import("./server.js");

const PORT = process.env.PORT || "3000";
const BASE = `http://localhost:${PORT}`;

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

(async () => {
  const session = createSession({ username: "operacoes", email: "operacoes@azi.com.br", allowedProjects: ["all"], isAdmin: true });
  const token = session.token;

  // 1. Sem token → 401
  let r = await fetch(`${BASE}/api/release-notes`);
  assert.strictEqual(r.status, 401, "GET sem token deve retornar 401, obteve " + r.status);

  // 2. Status com token → 200
  r = await fetch(`${BASE}/api/release-notes/status`, { headers: authHeaders(token) });
  assert.strictEqual(r.status, 200, "GET /status deve retornar 200, obteve " + r.status);
  const status = await r.json();
  assert.ok(status.configurado === false, "Confluence não configurado → configurado:false");

  // 3. Sync com token, Confluence não configurado → 503
  r = await fetch(`${BASE}/api/release-notes/sync`, { method: "POST", headers: authHeaders(token) });
  assert.strictEqual(r.status, 503, "POST /sync sem Confluence deve retornar 503, obteve " + r.status);

  // 4. Lista com token, Confluence não configurado → 503
  r = await fetch(`${BASE}/api/release-notes`, { headers: authHeaders(token) });
  assert.strictEqual(r.status, 503, "GET /release-notes sem Confluence deve retornar 503, obteve " + r.status);

  process.exit(0);
})().catch((err) => {
  console.error("FALHA:", err.message);
  process.exit(1);
});
