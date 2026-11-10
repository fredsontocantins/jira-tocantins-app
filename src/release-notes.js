import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { config } from "./config.js";
import { parseReleaseNote } from "./confluence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.isAbsolute(config.dbPath)
  ? config.dbPath
  : path.join(__dirname, "..", config.dbPath);

const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(dbPath);

export function initReleaseNotesDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS release_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      confluence_page_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      version TEXT,
      system TEXT,
      space_key TEXT,
      space_name TEXT,
      url TEXT,
      published_at TEXT,
      synced_at TEXT NOT NULL,
      content_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_release_notes_version ON release_notes(version);
    CREATE INDEX IF NOT EXISTS idx_release_notes_system ON release_notes(system);
  `);
}

export function confluenceConfigured() {
  return Boolean(config.confluence && config.confluence.email && config.confluence.token);
}

export function upsertReleaseNote(note) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO release_notes (
      confluence_page_id, title, version, system, space_key, space_name,
      url, published_at, synced_at, content_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(confluence_page_id) DO UPDATE SET
      title = excluded.title,
      version = excluded.version,
      system = excluded.system,
      space_key = excluded.space_key,
      space_name = excluded.space_name,
      url = excluded.url,
      published_at = excluded.published_at,
      synced_at = excluded.synced_at,
      content_summary = excluded.content_summary
  `).run(
    note.confluencePageId,
    note.title,
    note.version || null,
    note.system || null,
    note.spaceKey || null,
    note.spaceName || null,
    note.url || null,
    note.publishedAt || null,
    now,
    note.contentSummary || null
  );
}

export async function syncReleaseNotes({ fetchPages } = { fetchPages: null }) {
  const pages = fetchPages
    ? await fetchPages()
    : await (async () => {
        if (!confluenceConfigured()) {
          throw new Error("Confluence não configurado (CONFLUENCE_EMAIL/CONFLUENCE_TOKEN ausentes).");
        }
        const { fetchReleaseNotes } = await import("./confluence.js");
        return await fetchReleaseNotes();
      })();
  let sincronizados = 0;
  for (const page of pages) {
    const note = parseReleaseNote(page);
    upsertReleaseNote(note);
    sincronizados += 1;
  }
  return { sincronizados, total: pages.length };
}

export function listReleaseNotes({ version, system, limit } = {}) {
  let sql = "SELECT * FROM release_notes WHERE 1=1";
  const params = [];
  if (version) {
    sql += " AND version = ?";
    params.push(version);
  }
  if (system) {
    sql += " AND system = ?";
    params.push(system);
  }
  sql += " ORDER BY version DESC, published_at DESC";
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }
  return db.prepare(sql).all(params);
}

export function getStatus() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM release_notes").get().c;
  const configurado = confluenceConfigured();
  return { configurado, total: count };
}


