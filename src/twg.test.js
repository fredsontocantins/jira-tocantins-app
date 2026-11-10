import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTwgBinary, resolveTwgEnv, readTwgOutput, twgErrorMessage, runTwg } from "./twg.js";

const IS_WINDOWS = process.platform === "win32";
const BIN_ENV = process.env.TWG_BIN;

// ---------------------------------------------------------------- resolveTwgBinary

process.env.TWG_BIN = "C:\\binario\\custom\\twg.exe";
assert.strictEqual(
  resolveTwgBinary(),
  "C:\\binario\\custom\\twg.exe",
  "TWG_BIN deveria ter precedencia sobre qualquer caminho automatico"
);

delete process.env.TWG_BIN;
const binarioAutomatico = resolveTwgBinary();
if (IS_WINDOWS) {
  assert.ok(
    !binarioAutomatico.includes("/opt/twg"),
    `no Windows o binario nao deveria apontar para caminho Linux, obtive "${binarioAutomatico}"`
  );
  assert.ok(
    binarioAutomatico === "twg" || binarioAutomatico.endsWith("twg.exe"),
    `no Windows o binario deveria vir do PATH, obtive "${binarioAutomatico}"`
  );
}

if (BIN_ENV === undefined) delete process.env.TWG_BIN;
else process.env.TWG_BIN = BIN_ENV;

// ---------------------------------------------------------------- resolveTwgEnv

const env = resolveTwgEnv();
if (IS_WINDOWS) {
  assert.ok(
    !(env.HOME || "").startsWith("/home/"),
    `no Windows nao deveria ser injetado um HOME Linux, obtive "${env.HOME}"`
  );
} else {
  assert.ok(env.HOME, "no Linux o HOME deveria estar definido");
}

const caminhoEnv = env.PATH || env.Path || "";
assert.ok(caminhoEnv.length > 0, "o PATH deveria estar definido");
if (IS_WINDOWS) {
  assert.ok(
    !caminhoEnv.split(";").some((p) => p.includes("/opt/twg")),
    `o PATH do Windows nao deveria conter /opt/twg, obtive "${caminhoEnv}"`
  );
} else {
  assert.ok(
    caminhoEnv.split(":").some((p) => p === "/opt/twg/bin"),
    `no Linux o PATH deveria conter /opt/twg/bin, obtive "${caminhoEnv}"`
  );
}

// ---------------------------------------------------------------- readTwgOutput

const jsonDireto = JSON.stringify({ data: [{ id: 1 }] });
assert.strictEqual(
  readTwgOutput(jsonDireto),
  jsonDireto,
  "JSON direto deveria voltar sem alteracao"
);

assert.strictEqual(
  readTwgOutput("   \n  "),
  "   \n  ",
  "saida vazia deveria voltar sem alteracao"
);

assert.strictEqual(
  readTwgOutput("sem match nenhum aqui"),
  "sem match nenhum aqui",
  "saida sem resumo deveria voltar sem alteracao"
);

const dirTemporario = fs.mkdtempSync(path.join(os.tmpdir(), "twg-test-"));
const arquivoJson = path.join(dirTemporario, "resultado.json");
fs.writeFileSync(arquivoJson, jsonDireto, "utf-8");

const resumo = `Executado com sucesso.\nstdout: "${arquivoJson}"\n`;
assert.strictEqual(
  readTwgOutput(resumo),
  jsonDireto,
  "o resumo stdout: \"<arquivo>\" deveria ser lido do disco"
);

const caminhoJsonEscapado = arquivoJson.replace(/\\/g, "\\\\");
const resumoEscapado = `stdout: "${caminhoJsonEscapado}"\n`;
assert.strictEqual(
  readTwgOutput(resumoEscapado),
  jsonDireto,
  "caminho com escape JSON (\\\\) deveria ser desserializado antes de ler"
);

const resumoComJsonCru = JSON.stringify({ stdout: arquivoJson });
assert.strictEqual(
  readTwgOutput(resumoComJsonCru),
  jsonDireto,
  "JSON no formato { stdout: \"<arquivo>\" } deveria ser lido do disco"
);

fs.rmSync(dirTemporario, { recursive: true, force: true });

// ---------------------------------------------------------------- twgErrorMessage

assert.strictEqual(
  twgErrorMessage({ error: null, stderr: "" }),
  "TWG indisponível",
  "sem detalhes o erro deveria manter a mensagem padrao"
);

assert.ok(
  twgErrorMessage({ error: null, stderr: "permission denied\nstack line" }).includes("permission denied"),
  "o stderr deveria aparecer na mensagem de erro"
);

assert.ok(
  twgErrorMessage({ error: new Error("spawn ENOENT"), stderr: "" }).includes("spawn ENOENT"),
  "o erro de spawn deveria aparecer na mensagem de erro"
);

// ---------------------------------------------------------------- runTwg

const resultado = runTwg(["--version"], { timeout: 15000 });
if (resultado.error) {
  console.log("SKIP: twg nao esta instalado neste ambiente");
} else {
  assert.strictEqual(
    resultado.status,
    0,
    `twg --version deveria sair com 0, obtive ${resultado.status}: ${resultado.stderr}`
  );
  assert.ok(
    (resultado.stdout || "").includes("1."),
    `twg --version deveria imprimir a versao, obtive "${resultado.stdout}"`
  );
}

console.log("twg.test.js: OK");
