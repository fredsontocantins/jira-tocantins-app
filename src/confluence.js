const VERSION_REGEX = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/;

const SPACE_SYSTEM_MAP = {
  P3: "Patrimônio Mobiliário",
  PI1: "Patrimônio Intangível",
  CDMES: "Catálogo de Materiais e Serviços",
  EDL: "Edital",
  PDC: "Plano de Compras",
  SP: null,
  AZ: "Geração automática",
};

export function parseReleaseNote(page) {
  const title = page.title || "";
  const match = title.match(VERSION_REGEX);
  const version = match ? match[1] : null;
  const system =
    (page.space && page.space.name) ||
    SPACE_SYSTEM_MAP[page.space && page.space.key] ||
    null;

  return {
    confluencePageId: String(page.id),
    title,
    version,
    system,
    spaceKey: page.space && page.space.key ? String(page.space.key) : null,
    spaceName: page.space && page.space.name ? String(page.space.name) : null,
    url: page.url || null,
    publishedAt: page.version && page.version.when ? String(page.version.when) : null,
    contentSummary: null,
  };
}

import { config, confluenceAuthHeader } from "./config.js";

export async function fetchReleaseNotes() {
  const { baseUrl, email, token, cql, limit } = config.confluence;
  if (!baseUrl || !email || !token) {
    throw new Error("Confluence nao configurado (CONFLUENCE_BASE_URL/EMAIL/TOKEN ausentes).");
  }
  const cleanBase = baseUrl.replace(/\/wiki$/, "");
  const url = new URL(`${cleanBase}/wiki/api/v2/pages`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: confluenceAuthHeader(email, token),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Confluence ${res.status}`);
  }
  const data = await res.json();
  return data.results || [];
}
