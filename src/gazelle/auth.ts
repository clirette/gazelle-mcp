import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../paths.js";

const TOKEN_URL = "https://gazelleapp.io/developer/oauth/token";
export const AUTHORIZE_URL = "https://gazelleapp.io/developer/oauth/authorize";

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds when the access token expires. */
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  created_at: number;
  expires_in: number;
}

export const tokenPath = () => process.env.GAZELLE_TOKEN_FILE ?? dataFile("token.json");

function creds() {
  const id = process.env.GAZELLE_CLIENT_ID;
  const secret = process.env.GAZELLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set GAZELLE_CLIENT_ID and GAZELLE_CLIENT_SECRET in .env (see README).");
  return { id, secret };
}

async function tokenRequest(params: Record<string, string>): Promise<StoredToken> {
  const { id, secret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
  });
  if (!res.ok) throw new Error(`Gazelle token endpoint returned ${res.status}`);
  const t = (await res.json()) as TokenResponse;
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.created_at + t.expires_in,
  };
}

export async function saveToken(t: StoredToken) {
  const p = tokenPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(t, null, 2), { mode: 0o600 });
}

export const exchangeCode = (code: string, redirectUri: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

/** Returns a valid access token, refreshing (and persisting) if within 1 day of expiry. */
export async function getAccessToken(): Promise<string> {
  let stored: StoredToken;
  try {
    stored = JSON.parse(await readFile(tokenPath(), "utf8"));
  } catch {
    throw new Error("Not authorized with Gazelle yet. Run `npm run auth`.");
  }
  if (stored.expires_at - 86_400 > Date.now() / 1000) return stored.access_token;
  stored = await tokenRequest({ grant_type: "refresh_token", refresh_token: stored.refresh_token });
  await saveToken(stored);
  return stored.access_token;
}
