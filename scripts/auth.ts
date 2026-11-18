// One-time OAuth authorization. Usage: npm run auth
// Gazelle requires an HTTPS redirect URL. Two modes:
//  - HTTPS listener (automatic): if data/localhost.pfx exists (see README / below), serve
//    https://localhost:8976/callback with a locally trusted cert and capture the code.
//  - Paste mode (fallback): browser lands on a dead page; paste its full URL here.
//
// Create the cert once:
//   dotnet dev-certs https --trust
//   dotnet dev-certs https -ep data/localhost.pfx -p gazelle-local
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createInterface } from "node:readline/promises";
import { AUTHORIZE_URL, exchangeCode, saveToken, tokenPath } from "../src/gazelle/auth.js";
import { dataFile } from "../src/paths.js";

const PORT = Number(process.env.GAZELLE_AUTH_PORT ?? 8976);
const redirect = process.env.GAZELLE_REDIRECT_URI ?? `https://localhost:${PORT}/callback`;
const pfxPath = process.env.GAZELLE_AUTH_PFX ?? dataFile("localhost.pfx");
const id = process.env.GAZELLE_CLIENT_ID;
if (!id) throw new Error("Set GAZELLE_CLIENT_ID in .env first (see README).");

const url = `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code" })}`;
const done = () => console.log("Token saved to", tokenPath());

if (existsSync(pfxPath)) {
  const server = createServer(
    { pfx: readFileSync(pfxPath), passphrase: process.env.GAZELLE_AUTH_PFX_PASSWORD ?? "gazelle-local" },
    async (req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== new URL(redirect).pathname) return void res.writeHead(404).end();
      const code = u.searchParams.get("code");
      if (!code) return void res.writeHead(400).end("Missing code");
      try {
        await saveToken(await exchangeCode(code, redirect));
        res.end("Authorized. You can close this tab.");
        done();
      } catch (e) {
        res.writeHead(500).end("Token exchange failed");
        console.error((e as Error).message);
      }
      server.close();
    },
  );
  server.listen(PORT, "127.0.0.1");
  console.log(`Open this URL in your browser and approve access:\n\n${url}\n`);
} else {
  console.log(`(No ${pfxPath}; using paste mode.)\n`);
  console.log(`1. Open this URL in your browser and approve access:\n\n${url}\n`);
  console.log(`2. The browser will fail to load ${redirect}?code=... — expected. Copy the full URL`);
  console.log("   from the address bar (the code expires in 10 minutes).\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question("Paste the URL (or just the code): ")).trim();
  rl.close();
  let code = pasted;
  try {
    code = new URL(pasted).searchParams.get("code") ?? "";
  } catch {
    /* not a URL: treat the input as the bare code */
  }
  if (!code) throw new Error("No code found in what you pasted.");
  await saveToken(await exchangeCode(code, redirect));
  done();
}
