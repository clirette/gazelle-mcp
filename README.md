# Gazelle MCP

An [MCP](https://modelcontextprotocol.io) server that connects Claude (Claude Desktop, Claude Code, or any MCP client) to your [Gazelle](https://gazelleapp.io) account, the business platform for piano technicians.

Ask Claude things like:

- "What appointments do I have next week in Springfield?"
- "Build my 2026 mileage log as a CSV for my accountant."
- "How many visits and how much billed work did I do in each state this year?"
- "Add a note to Tuesday's appointment with the Smiths: replaced two bass strings."

It runs locally on your computer, talks to Gazelle using your own API credentials, and keeps its caches and logs in a local `data/` folder.

> **Not tax advice.** Mileage and jurisdiction output is informational. Review it, and check with a tax professional before filing.

## Tools

| Tool | What it does |
| --- | --- |
| `list_appointments` | Appointments in a date range, filterable by client name and status (`scheduled`, `completed`, `cancelled`, `no_show`). |
| `get_appointment` | One appointment by id, including service items and quoted value. |
| `list_clients` | Clients, optionally filtered by name. |
| `build_mileage_log` | A per-trip business mileage log (home → each stop in time order → home, per day) with real driving distances, business purpose, and client, plus an estimated standard-mileage deduction. Optional CSV. |
| `tax_jurisdiction_summary` | Visits, distinct clients, quoted service value, and tips per state (or state + city), to gauge where you may have filing obligations. |
| `set_appointment_override` | **Local only.** Records a correction (actual amount charged, tip received, reason) in `data/overrides.json`. Corrections flow into the summaries. Never sent to Gazelle. |
| `get_audit_log` | Recent changes made by this server. |
| `append_appointment_note` | **Writes to Gazelle. Off by default.** Appends text to an appointment's notes. |
| `set_service_item_price` | **Writes to Gazelle. Off by default.** Changes one service item's price on an appointment (e.g. to $0 for a no-charge visit). |

### About the write tools

The server is **read-only unless you set `GAZELLE_ENABLE_WRITES=1`**. When enabled, every write:

1. Shows a preview and changes nothing unless called again with `confirm=true` (Claude will ask you first).
2. Re-reads the appointment afterwards and reports anything that changed besides what was asked. `set_service_item_price` automatically restores the original items if anything unexpected changed.
3. Is recorded in `data/audit-log.jsonl`.

Gazelle's API can do far more (delete records, change billing, and so on). This server deliberately exposes only these two narrow edits.

## Requirements

- A **Gazelle** account with your business data.
- A free **Gazelle developer account** (separate from your regular Gazelle login). See step 2.
- **Node.js 22.9 or newer** ([nodejs.org](https://nodejs.org)). Check with `node --version`.
- **Git**, or download this repository as a ZIP from GitHub.
- An MCP client such as [Claude Desktop](https://claude.ai/download) or [Claude Code](https://claude.com/claude-code).

## Setup

### 1. Download and build

```sh
git clone https://github.com/clirette/gazelle-mcp.git
cd gazelle-mcp
npm install
npm run build
```

### 2. Create a Gazelle developer account

Gazelle's API uses OAuth: you register an "Integration" (an app) once, then authorize it to read your business account.

1. Go to **https://gazelleapp.io/developer/signup** and create a developer account (website, email, name, password). Gazelle requires your real name and email and deletes anonymous accounts.
2. Log in at **https://gazelleapp.io/developer/login**.

Gazelle's developer documentation is at https://gazelleapp.io/developer. Gazelle doesn't provide support for using the API beyond those docs, so please report problems with this project in its GitHub issues.

### 3. Register an Integration

In the developer portal, create a new Integration:

- **Name:** anything, e.g. `My Gazelle MCP`.
- **Redirect URL:** `https://localhost:8976/callback`

  Gazelle requires an HTTPS redirect URL. Nothing needs to be running at that address: the next step explains how the code is captured. You can edit the URL later.

When you save, Gazelle shows an **application id** (also called the *client id*) and a **secret**. **Copy the secret right away: Gazelle shows it only once and can't recover it.**

### 4. Configure `.env`

Copy the example file and fill it in:

```sh
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

```ini
GAZELLE_CLIENT_ID=your-application-id
GAZELLE_CLIENT_SECRET=your-secret

# Where your workday starts and ends, for the mileage log
GAZELLE_HOME_STREET=123 Main St
GAZELLE_HOME_CITY=Springfield
GAZELLE_HOME_STATE=IL
GAZELLE_HOME_ZIP=62701

GAZELLE_TIMEZONE=America/Chicago

# Optional: enable the two tools that edit Gazelle
# GAZELLE_ENABLE_WRITES=1
```

`.env` holds your secret. It's gitignored, so never commit or share it.

### 5. Authorize (one time)

```sh
npm run auth
```

1. The script prints a link. Open it, log in to **your Gazelle business account**, and approve access.
2. Your browser then tries to open `https://localhost:8976/callback?code=...` and shows an error page. **That is expected.**
3. Copy the **full URL from the address bar** and paste it into the terminal. The code expires after 10 minutes.

The token is saved to `data/token.json` and refreshed automatically. Access tokens last 30 days. If the server isn't used for 90 days, Gazelle revokes the token and you'll need to run `npm run auth` again.

<details>
<summary>Optional: capture the code automatically instead of pasting</summary>

If `data/localhost.pfx` exists, `npm run auth` serves the callback over HTTPS and captures the code itself. You need a certificate your browser trusts for `localhost`:

- With [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, then `mkcert -pkcs12 -p12-file data/localhost.pfx localhost`, and set `GAZELLE_AUTH_PFX_PASSWORD=changeit` (mkcert's default).
- With the .NET SDK: `dotnet dev-certs https --trust`, then `dotnet dev-certs https -ep data/localhost.pfx -p gazelle-local`.

</details>

### 6. Connect it to Claude

Use **absolute paths** to your copy of the repository. On Windows, use forward slashes (`C:/Users/you/gazelle-mcp/...`).

**Claude Code:**

```sh
claude mcp add --scope user gazelle -- node --env-file=/path/to/gazelle-mcp/.env /path/to/gazelle-mcp/dist/index.js
```

**Claude Desktop:** open Settings → Developer → Edit Config (or edit `claude_desktop_config.json` directly: `%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS) and add:

```json
{
  "mcpServers": {
    "gazelle": {
      "command": "node",
      "args": [
        "--env-file=/path/to/gazelle-mcp/.env",
        "/path/to/gazelle-mcp/dist/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop. Then ask: *"List my Gazelle appointments for this week."*

## Configuration

All settings are environment variables, usually set in `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAZELLE_CLIENT_ID`, `GAZELLE_CLIENT_SECRET` | (required) | From your Gazelle Integration. |
| `GAZELLE_HOME_STREET`, `_CITY`, `_STATE`, `_ZIP` | (none) | Start/end point of each day's trips. Can also be passed to `build_mileage_log` directly. |
| `GAZELLE_TIMEZONE` | `America/New_York` | Fallback timezone for dating trips. Gazelle stores a timezone per appointment, which takes precedence. |
| `GAZELLE_ENABLE_WRITES` | off | `1` registers the tools that edit Gazelle. |
| `GAZELLE_OSRM_URL` | public OSRM demo server | Routing server for driving distances. Point it at a self-hosted [OSRM](https://project-osrm.org) for privacy or volume. |
| `GAZELLE_DATA_DIR` | `./data` | Where tokens, caches, overrides, and the audit log live. |
| `GAZELLE_REDIRECT_URI`, `GAZELLE_AUTH_PORT` | `https://localhost:8976/callback`, `8976` | Only if you registered a different redirect URL. |
| `GAZELLE_AUTH_PFX`, `GAZELLE_AUTH_PFX_PASSWORD` | `data/localhost.pfx`, `gazelle-local` | Certificate for automatic code capture (optional). |

## Privacy

Your Gazelle data stays on your computer, except for these lookups needed to compute mileage:

- **Driving distances**: [OSRM](https://project-osrm.org). Only bare latitude/longitude pairs are sent: no names, addresses, or amounts. The default is OSRM's free public demo server; set `GAZELLE_OSRM_URL` to use your own.
- **Geocoding**: the [US Census Bureau geocoder](https://geocoding.geo.census.gov). It is sent your home street address, plus the address of any appointment Gazelle has no coordinates for.

Both results are cached in `data/`, so each lookup happens once. Of course, whatever Claude reads through the tools is sent to Claude as part of your conversation.

Files in `data/` (all gitignored):

| File | Contents |
| --- | --- |
| `token.json` | Your Gazelle OAuth token. Treat it like a password. |
| `overrides.json` | Your local corrections (amounts, tips). |
| `audit-log.jsonl` | Every change made by this server. |
| `route-cache.json`, `geocode-cache.json` | Distance and coordinate caches. |

## How the numbers are computed (and their limits)

- **Mileage:** for each day, trips run from home to each appointment in start-time order and back home, using real driving distances. Cancelled appointments are skipped. **No-shows are included**, because you still drove there. Each trip is dated in the appointment's own timezone.
- **Appointment address:** Gazelle usually leaves the appointment's own location empty, so the client's default address is used. If you did a job somewhere else, that trip will be wrong. Check the log.
- **Deduction estimate:** miles × the IRS standard mileage rate for the trip's date. The built-in rates cover 2024 through 2026, including 2026's mid-year change. Rates for later years must be added in `src/mileage/mileage.ts` (pull requests welcome). Trips without a known rate are listed under `noRateDates`.
- **Value is *quoted*, not collected:** totals come from the service items on each appointment, not from invoices or payments, because not every Gazelle plan includes invoice access through the API. Use `set_appointment_override` to record what you actually charged, and any tips.
- **Quantities:** for service items with quantity ≠ 1, it's unconfirmed whether Gazelle's price is per unit or the line total. Those appointments are flagged `quantityAmbiguous`.
- Gazelle's API is the private API its own apps use. It may change without notice.

## Development

```sh
npm run dev          # run from source (loads .env)
npm test             # unit tests (no Gazelle account needed)
npm run typecheck
npm run introspect   # dump the live Gazelle schema to docs/schema.json (gitignored)
```

`GAZELLE_USE_FIXTURES=1` runs the server against an empty in-memory client. See [`CLAUDE.md`](CLAUDE.md) for architecture and conventions, and [`docs/api-notes.md`](docs/api-notes.md) for what's been verified against the live API.

Contributions are welcome, especially from technicians on Gazelle plans with invoice access. Never include real client data in issues, tests, or pull requests.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Gazelle.
