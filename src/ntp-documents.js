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

export function initNtpDocumentsDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ntp_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      confluence_page_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      url TEXT,
      status TEXT DEFAULT 'pending',
      downloaded INTEGER DEFAULT 0,
      content_path TEXT,
      synced_at TEXT,
      page_version INTEGER DEFAULT 0,
      last_modified TEXT,
      content_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ntp_documents_folder ON ntp_documents(folder_path);
    CREATE INDEX IF NOT EXISTS idx_ntp_documents_status ON ntp_documents(status);
  `);
}

export function getDownloadedDocuments() {
  return db.prepare("SELECT * FROM ntp_documents WHERE downloaded = 1").all();
}

export function getPendingDocuments() {
  return db.prepare("SELECT * FROM ntp_documents WHERE downloaded = 0").all();
}

export function markDownloaded(confluencePageId, contentPath = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ntp_documents (
      confluence_page_id, title, folder_path, url, status, downloaded, content_path, synced_at, page_version, last_modified
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?)
    ON CONFLICT(confluence_page_id) DO UPDATE SET
      downloaded = 1,
      content_path = excluded.content_path,
      synced_at = excluded.synced_at,
      last_modified = excluded.last_modified
  `).run(
    confluencePageId,
    null,
    null,
    null,
    null,
    contentPath,
    now
  );
  try {
    db.prepare(`UPDATE ntp_documents SET title = ?, folder_path = ? WHERE confluence_page_id = ?`).run(
      null,
      null,
      confluencePageId
    );
  } catch (e) {
    // Ignore - title may be set on initial insert
  }
}

export function updateDocumentMeta(confluencePageId, title, folderPath, url, status, pageVersion, lastModified) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ntp_documents 
    SET title = ?, folder_path = ?, url = ?, status = ?, page_version = ?, last_modified = ?, synced_at = ?
    WHERE confluence_page_id = ?
  `).run(
    title,
    folderPath,
    url,
    status,
    pageVersion,
    lastModified,
    now,
    confluencePageId
  );
}

export function getDocument(confluencePageId) {
  return db.prepare("SELECT * FROM ntp_documents WHERE confluence_page_id = ?").get(confluencePageId);
}

export function listDocumentsByFolder(folderPath) {
  return db.prepare("SELECT * FROM ntp_documents WHERE folder_path = ? ORDER BY title").all(folderPath);
}

export function listAllDocuments() {
  return db.prepare("SELECT * FROM ntp_documents ORDER BY folder_path, title").all();
}

export function countDownloaded() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM ntp_documents WHERE downloaded = 1").get();
  return row ? row.c : 0;
}

export function countPending() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM ntp_documents WHERE downloaded = 0").get();
  return row ? row.c : 0;
}

export function exportForDownload() {
  return db.prepare(`
    SELECT confluence_page_id, title, folder_path, url, status, page_version, last_modified, content_summary
    FROM ntp_documents
    WHERE downloaded = 1
    ORDER BY folder_path, title
  `).all();
}