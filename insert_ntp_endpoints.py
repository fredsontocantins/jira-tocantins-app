#!/usr/bin/env python3
import re

with open('src/server.js', 'r') as f:
    content = f.read()

old_block = """  } catch (err) {
    console.error("pdf atividade error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ===== Notas de Release (Confluence) =====""

new_block = """  } catch (err) {
    console.error("pdf atividade error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
}

// ===== Documentos NTP =====

app.get("/api/ntp/documents", requireAuth, async (req, res) => {
  try {
    const { folder, status } = req.query;
    const documents = listNtpDocuments({ folder, status });
    res.json({ success: true, total: documents.length, documents });
  } catch (err) {
    console.error("ntp documents error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/ntp/documents/folder-stats", requireAuth, async (req, res) => {
  try {
    const stats = listNtpDocumentsByFolder();
    res.json({ success: true, stats });
  } catch (err) {
    console.error("ntp folder stats error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.post("/api/ntp/sync", requireAuth, async (req, res) => {
  try {
    const { force } = req.body;
    const result = await syncNtpDocuments({ force });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("ntp sync error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/ntp/status", requireAuth, async (req, res) => {
  try {
    const stats = getSyncStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error("ntp status error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ===== Notas de Release (Confluence) =====""

if old_block in content:
    content = content.replace(old_block, new_block)
    with open('src/server.js', 'w') as f:
        f.write(content)
    print('SUCESS: NTP endpoints inserted')
else:
    print('ERROR: old_block not found')
    lines = content.split('\n')
    for i in range(1995, 2010):
        print(f'{i}: {lines[i-1]}')