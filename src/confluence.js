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

export async function fetchReleaseNotes() {
  return [];
}
