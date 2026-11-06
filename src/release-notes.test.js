import assert from "node:assert";
import { initReleaseNotesDB, syncReleaseNotes } from "./release-notes.js";

await initReleaseNotesDB();
const resultado = await syncReleaseNotes({ fetchPages: async () => [] });
assert.ok(resultado, "sync não retornou resultado");
assert.strictEqual(resultado.sincronizados, 0, "deveria sincronizar 0");
