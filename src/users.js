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
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    allowed_projects TEXT NOT NULL DEFAULT '[]',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT
  );
`);

export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "fredson.sousa@azi.com.br").toLowerCase();

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    status: row.status,
    allowedProjects: safeParse(row.allowed_projects),
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  };
}

function safeParse(s) {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

export function getUserByEmail(email) {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  return rowToUser(row);
}

export function getUserById(id) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return rowToUser(row);
}

export function listUsers() {
  const rows = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  return rows.map(rowToUser);
}

export function upsertPendingUser({ email, name, picture }) {
  const e = String(email).toLowerCase();
  const existing = getUserByEmail(e);
  if (existing) return existing;
  const isAdmin = e === ADMIN_EMAIL ? 1 : 0;
  const status = e === ADMIN_EMAIL ? "approved" : "pending";
  const allowed = e === ADMIN_EMAIL ? JSON.stringify(["all"]) : JSON.stringify([]);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (email, name, picture, status, allowed_projects, is_admin, created_at, approved_at, approved_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(e, name || null, picture || null, status, allowed, isAdmin, now,
    status === "approved" ? now : null,
    status === "approved" ? "system" : null);
  return getUserByEmail(e);
}

export function approveUser(id, allowedProjects, approvedBy) {
  const now = new Date().toISOString();
  const projects = Array.isArray(allowedProjects) ? allowedProjects : ["all"];
  db.prepare(
    `UPDATE users SET status='approved', allowed_projects=?, approved_at=?, approved_by=? WHERE id=?`
  ).run(JSON.stringify(projects), now, approvedBy || ADMIN_EMAIL, id);
  return getUserById(id);
}

export function rejectUser(id, approvedBy) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users SET status='rejected', approved_at=?, approved_by=? WHERE id=?`
  ).run(now, approvedBy || ADMIN_EMAIL, id);
  return getUserById(id);
}

export function updateUserScope(id, allowedProjects) {
  db.prepare(`UPDATE users SET allowed_projects=? WHERE id=?`).run(JSON.stringify(allowedProjects), id);
  return getUserById(id);
}

export function isAdminEmail(email) {
  return String(email).toLowerCase() === ADMIN_EMAIL;
}
