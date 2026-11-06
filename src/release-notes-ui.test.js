import assert from "node:assert";
import fs from "fs";

const html = fs.readFileSync("public/index.html", "utf8");

const temBotao = html.includes("Notas de Release");
const temDrawer = html.includes("id=\"releaseNotesBackdrop\"") || html.includes("release-notes");

assert.ok(temBotao, "botão 'Notas de Release' deve existir no HTML");
assert.ok(temDrawer, "drawer 'release-notes' deve existir no HTML");
