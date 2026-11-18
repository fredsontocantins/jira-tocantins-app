import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.isAbsolute(config.dbPath)
  ? config.dbPath
  : path.join(__dirname, "..", config.dbPath);

const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(dbPath);

export { db };

export function initActivityControlDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_control (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      descricao TEXT,
      responsavel TEXT,
      pessoa TEXT,
      cliente TEXT,
      tipo TEXT DEFAULT 'atividade',
      data_registro TEXT NOT NULL,
      status TEXT DEFAULT 'registrado',
      whatsapp_enviado INTEGER DEFAULT 0,
      whatsapp_numero TEXT,
      whatsapp_enviado_em TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_control_data ON activity_control(data_registro);
    CREATE INDEX IF NOT EXISTS idx_activity_control_responsavel ON activity_control(responsavel);
    CREATE INDEX IF NOT EXISTS idx_activity_control_status ON activity_control(status);
  `);
}

export function listActivities(limit = 100, offset = 0) {
  return db.prepare("SELECT * FROM activity_control ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
}

export function getActivity(id) {
  return db.prepare("SELECT * FROM activity_control WHERE id = ?").get(id);
}

export function createActivity(data) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO activity_control (titulo, descricao, responsavel, pessoa, cliente, tipo, data_registro, status, whatsapp_numero)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.titulo,
    data.descricao || "",
    data.responsavel || "",
    data.pessoa || "",
    data.cliente || "",
    data.tipo || "atividade",
    data.data_registro || now.split("T")[0],
    data.status || "registrado",
    data.whatsapp_numero || ""
  );
  return { id: result.lastInsertRowid, ...data, created_at: now };
}

export function updateActivity(id, data) {
  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  if (data.titulo !== undefined) { fields.push("titulo = ?"); values.push(data.titulo); }
  if (data.descricao !== undefined) { fields.push("descricao = ?"); values.push(data.descricao); }
  if (data.responsavel !== undefined) { fields.push("responsavel = ?"); values.push(data.responsavel); }
  if (data.pessoa !== undefined) { fields.push("pessoa = ?"); values.push(data.pessoa); }
  if (data.cliente !== undefined) { fields.push("cliente = ?"); values.push(data.cliente); }
  if (data.tipo !== undefined) { fields.push("tipo = ?"); values.push(data.tipo); }
  if (data.data_registro !== undefined) { fields.push("data_registro = ?"); values.push(data.data_registro); }
  if (data.status !== undefined) { fields.push("status = ?"); values.push(data.status); }
  if (data.whatsapp_enviado !== undefined) { fields.push("whatsapp_enviado = ?"); values.push(data.whatsapp_enviado ? 1 : 0); }
  if (data.whatsapp_numero !== undefined) { fields.push("whatsapp_numero = ?"); values.push(data.whatsapp_numero); }
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  db.prepare(`UPDATE activity_control SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getActivity(id);
}

export function deleteActivity(id) {
  db.prepare("DELETE FROM activity_control WHERE id = ?").run(id);
  return { deleted: true, id };
}

export function markWhatsappSent(id, numero, isResend = false) {
  const now = new Date().toISOString();
  if (isResend) {
    db.prepare("UPDATE activity_control SET whatsapp_enviado = 1, whatsapp_numero = ?, whatsapp_enviado_em = ?, status = 'reenviado', updated_at = ? WHERE id = ?").run(numero, now, now, id);
  } else {
    db.prepare("UPDATE activity_control SET whatsapp_enviado = 1, whatsapp_numero = ?, whatsapp_enviado_em = ?, updated_at = ? WHERE id = ?").run(numero, now, now, id);
  }
  return getActivity(id);
}

export function countActivities() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM activity_control").get();
  return row ? row.c : 0;
}

export function getPendingWhatsapp() {
  return db.prepare("SELECT * FROM activity_control WHERE whatsapp_enviado = 0 ORDER BY created_at DESC").all();
}

export function listActivitiesFiltered(dateFrom, dateTo, responsavel) {
  let sql = "SELECT * FROM activity_control WHERE 1=1";
  const params = [];
  if (dateFrom) { sql += " AND data_registro >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND data_registro <= ?"; params.push(dateTo); }
  if (responsavel) { sql += " AND responsavel = ?"; params.push(responsavel); }
  sql += " ORDER BY data_registro DESC, created_at DESC";
  return db.prepare(sql).all(...params);
}