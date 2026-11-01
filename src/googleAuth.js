// Verificacao de ID token do Google (OIDC) sem dependencias externas.
import crypto from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let jwksCache = { keys: null, expires: 0 };

async function fetchJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.expires) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  // cache por max-age do header ou 1h
  let ttl = 3600_000;
  const cc = res.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  if (m) ttl = parseInt(m[1], 10) * 1000;
  jwksCache = { keys: data.keys, expires: Date.now() + ttl };
  return data.keys;
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export async function verifyGoogleIdToken(idToken, clientId) {
  if (!idToken || !clientId) throw new Error("idToken/clientId ausentes");
  const parts = String(idToken).split(".");
  if (parts.length !== 3) throw new Error("ID token invalido");
  const [hB64, pB64, sB64] = parts;
  const header = JSON.parse(b64urlDecode(hB64).toString("utf8"));
  const payload = JSON.parse(b64urlDecode(pB64).toString("utf8"));
  if (header.alg !== "RS256") throw new Error("alg nao suportado");
  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("chave publica nao encontrada");
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const data = Buffer.from(`${hB64}.${pB64}`);
  const sig = b64urlDecode(sB64);
  const ok = crypto.verify("sha256", data, pub, sig);
  if (!ok) throw new Error("assinatura invalida");

  // validacoes de claims
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) throw new Error("issuer invalido");
  if (payload.aud !== clientId) throw new Error("audience invalida");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("token expirado");
  if (payload.iat && payload.iat > now + 60) throw new Error("iat invalido");
  if (!payload.email) throw new Error("email ausente");
  if (payload.email_verified !== true) throw new Error("email nao verificado");
  return payload;
}
