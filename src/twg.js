import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const IS_WINDOWS = process.platform === "win32";

// Caminho do TWG no container Linux (imagem do Coolify).
const BINARIO_LINUX = "/opt/twg/bin/twg";
const DIR_BINARIO_LINUX = "/opt/twg/bin";

/**
 * Descobre o executavel do TWG.
 * Ordem: TWG_BIN (override explicito) > caminho do container Linux > PATH do sistema.
 */
export function resolveTwgBinary() {
  const override = (process.env.TWG_BIN || "").trim();
  if (override) return override;
  if (!IS_WINDOWS && fs.existsSync(BINARIO_LINUX)) return BINARIO_LINUX;
  return "twg";
}

/**
 * Monta o ambiente do processo filho.
 * No Windows nao injeta nenhum caminho Linux; no Linux mantém o HOME do container.
 */
export function resolveTwgEnv() {
  const env = { ...process.env };
  const dirs = [];

  const binario = resolveTwgBinary();
  const dir = path.dirname(binario);
  if (dir && dir !== "." && binario.includes(path.sep)) dirs.push(dir);
  if (!IS_WINDOWS) dirs.push(DIR_BINARIO_LINUX);

  const unicos = [...new Set(dirs)];
  const chavePath = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const atual = env[chavePath] || "";
  const prefixo = unicos.join(path.delimiter);
  env[chavePath] = atual ? `${prefixo}${path.delimiter}${atual}` : prefixo;

  if (!IS_WINDOWS && !env.HOME) env.HOME = "/home/app";
  return env;
}

/**
 * O TWG pode devolver o JSON direto ou um resumo com o caminho do arquivo
 * (stdout: "<arquivo>"). Normaliza os dois formatos para o conteudo do JSON.
 */
export function readTwgOutput(stdout) {
  const raw = stdout || "";
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const arquivo = typeof parsed?.stdout === "string" ? parsed.stdout : null;
      const conteudo = arquivo ? lerArquivoSeExistir(arquivo) : null;
      return conteudo ?? raw;
    } catch {
      return raw;
    }
  }

  const m = trimmed.match(/stdout:\s*"([^"]+)"/);
  if (!m) return raw;
  return lerArquivoSeExistir(m[1]) ?? raw;
}

function lerArquivoSeExistir(caminho) {
  if (!caminho) return null;
  // O caminho pode vir escapado como JSON (C:\\Users\\...) ou cru (C:\Users\...).
  const candidatos = [caminho, caminho.replace(/\\\\/g, "\\")];
  for (const candidato of candidatos) {
    try {
      if (fs.existsSync(candidato)) return fs.readFileSync(candidato, "utf-8");
    } catch {}
  }
  return null;
}

/** Mensagem de erro com a causa real (stderr ou erro de spawn). */
export function twgErrorMessage(result) {
  const base = "TWG indisponível";
  if (!result) return base;
  if (result.error) return `${base}: ${result.error.message}`;
  const stderr = (result.stderr || "").trim();
  if (!stderr) return base;
  const primeiraLinha = stderr.split(/\r?\n/).find((l) => l.trim().length > 0) || stderr;
  return `${base}: ${primeiraLinha.trim()}`;
}

/** Executa o TWG de forma portavel (Windows ou Linux). */
export function runTwg(args, options = {}) {
  const timeout = options.timeout ?? 15000;
  const binario = resolveTwgBinary();
  const env = resolveTwgEnv();
  let result = spawnSync(binario, args, { encoding: "utf-8", timeout, env });
  if (result.error && result.error.code === "ENOENT" && IS_WINDOWS && !path.extname(binario)) {
    result = spawnSync(`${binario}.exe`, args, { encoding: "utf-8", timeout, env });
  }
  return result;
}
