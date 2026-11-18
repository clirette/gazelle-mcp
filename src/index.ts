#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FixtureClient, type GazelleClient } from "./gazelle/client.js";
import { HttpGazelleClient } from "./gazelle/http-client.js";
import { loadOverrides, withOverrides } from "./gazelle/overrides.js";
import { appendNote, previewAppendNote, previewSetItemPrice, readAuditLog, setItemPrice, setOverride } from "./gazelle/writer.js";
import { OsrmProvider, geocode } from "./mileage/routing.js";
import { buildMileageLog, estimateDeduction, tripsToCsv } from "./mileage/mileage.js";
import { summarizeByJurisdiction } from "./tax/jurisdictions.js";

const client: GazelleClient =
  process.env.GAZELLE_USE_FIXTURES === "1" ? new FixtureClient() : withOverrides(new HttpGazelleClient());

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
const server = new McpServer({ name: "gazelle-mcp", version });

/** Tools that change data in Gazelle are only registered when the user opts in. */
const WRITES_ENABLED = process.env.GAZELLE_ENABLE_WRITES === "1";
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: (e as Error).message }],
});

const dateRange = {
  from: z.string().describe("Start date/time, ISO 8601 (inclusive)"),
  to: z.string().describe("End date/time, ISO 8601 (inclusive)"),
};

server.registerTool(
  "list_appointments",
  {
    description: "List appointments in a date range, optionally filtered by client name substring or status.",
    inputSchema: {
      ...dateRange,
      client: z.string().optional().describe("Case-insensitive client name filter"),
      status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ from, to, client: name, status }) => {
    try {
      let appts = await client.listAppointments({ from, to });
      if (name) appts = appts.filter((a) => a.clientName?.toLowerCase().includes(name.toLowerCase()));
      if (status) appts = appts.filter((a) => a.status === status);
      return text(appts);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_appointment",
  { description: "Get one appointment by id.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
  async ({ id }) => {
    try {
      return text((await client.getAppointment(id)) ?? "Not found");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_clients",
  {
    description: "List clients, optionally filtered by name substring.",
    inputSchema: { query: z.string().optional() },
    annotations: READ_ONLY,
  },
  async ({ query }) => {
    try {
      return text(await client.listClients(query));
    } catch (e) {
      return fail(e);
    }
  },
);

const addressSchema = z.object({
  line1: z.string().describe("Street address"),
  city: z.string(),
  state: z.string().describe("Two-letter state code"),
  postalCode: z.string().optional(),
});

function homeFromEnv() {
  const { GAZELLE_HOME_STREET: line1, GAZELLE_HOME_CITY: city, GAZELLE_HOME_STATE: state, GAZELLE_HOME_ZIP: postalCode } =
    process.env;
  return line1 && city && state ? { line1, city, state, postalCode } : undefined;
}

server.registerTool(
  "build_mileage_log",
  {
    description:
      "Build a business mileage log from appointments in a range: home -> each stop in time order -> home, per local day. " +
      "Distances are real driving distances from OSRM routing (cached); trip dates use the appointment's local timezone. " +
      "Appointments lacking coordinates are geocoded with the US Census geocoder; any that fail are listed in `skipped`. " +
      "Returns trips, totals, skipped appointments, and optionally CSV. Informational only, not tax advice.",
    inputSchema: {
      ...dateRange,
      home: addressSchema.optional().describe("Trip origin/return address. Defaults to GAZELLE_HOME_* env vars."),
      csv: z.boolean().optional().describe("Include CSV text"),
    },
    annotations: READ_ONLY,
  },
  async ({ from, to, home: homeIn, csv }) => {
    try {
      const homeAddr = homeIn ?? homeFromEnv();
      if (!homeAddr) throw new Error("Provide `home` or set GAZELLE_HOME_STREET/CITY/STATE/ZIP.");
      const home = await geocode(homeAddr);
      const appts = await client.listAppointments({ from, to });
      const geocodeFailures: { id: string; reason: string }[] = [];
      for (const a of appts) {
        if (a.location && (a.location.lat == null || a.location.lng == null)) {
          try {
            a.location = await geocode(a.location);
          } catch (e) {
            geocodeFailures.push({ id: a.id, reason: (e as Error).message });
          }
        }
      }
      const { trips, skipped } = await buildMileageLog(appts, home, new OsrmProvider());
      const totalMiles = Math.round(trips.reduce((s, t) => s + t.miles, 0) * 10) / 10;
      return text({
        totalMiles,
        estimatedDeduction: estimateDeduction(trips),
        trips,
        skipped: skipped.filter((s) => !geocodeFailures.some((g) => g.id === s.id)).concat(geocodeFailures),
        ...(csv ? { csv: tripsToCsv(trips) } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "tax_jurisdiction_summary",
  {
    description:
      "Summarize visits, distinct clients, and QUOTED service value (sum of Gazelle service-item prices; NOT invoiced or collected revenue) by state (or state+city) from appointment service locations, " +
      "to gauge multi-jurisdiction filing exposure. Informational only, not tax advice.",
    inputSchema: { ...dateRange, by: z.enum(["state", "city"]).optional() },
    annotations: READ_ONLY,
  },
  async ({ from, to, by }) => {
    try {
      const appts = await client.listAppointments({ from, to });
      return text(summarizeByJurisdiction(appts, by ?? "state"));
    } catch (e) {
      return fail(e);
    }
  },
);

if (WRITES_ENABLED) {
  server.registerTool(
    "append_appointment_note",
    {
      description:
        "WRITES TO GAZELLE. Appends text to an appointment's notes (existing notes are kept). This is the only field changed. " +
        "Without confirm=true it only returns a preview of the before/after notes and changes nothing. " +
        "After a confirmed write it re-reads the appointment and reports if anything other than notes changed. Every write is audit-logged locally.",
      inputSchema: {
        id: z.string().describe("Appointment (event) id"),
        text: z.string().describe("Text to append"),
        confirm: z.boolean().optional().describe("Must be true to actually write; omit/false to preview"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, text: note, confirm }) => {
      try {
        if (!confirm) return text({ preview: await previewAppendNote(id, note), note: "Nothing written. Call again with confirm=true to apply." });
        return text(await appendNote(id, note));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_service_item_price",
    {
      description:
        "WRITES TO GAZELLE. Sets the price of one service item on an appointment (e.g. to 0 for a no-charge visit). " +
        "Gazelle replaces the whole item list on update, so this resends every item unchanged except the target, verifies the result, " +
        "and automatically restores the original items if anything else changed. Without confirm=true it only previews. Audit-logged. " +
        "Does not touch invoices, tips, or payments.",
      inputSchema: {
        id: z.string().describe("Appointment (event) id"),
        amountCents: z.number().int().min(0).describe("New price in cents (0 = no charge)"),
        itemId: z.string().optional().describe("Service item id; required if the appointment has more than one item"),
        confirm: z.boolean().optional().describe("Must be true to actually write; omit/false to preview"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, amountCents, itemId, confirm }) => {
      try {
        if (!confirm) return text({ preview: await previewSetItemPrice(id, amountCents, itemId), note: "Nothing written. Call again with confirm=true to apply." });
        return text(await setItemPrice(id, amountCents, itemId));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

server.registerTool(
  "set_appointment_override",
  {
    description:
      "LOCAL ONLY (does not touch Gazelle). Records the owner's correction for an appointment in data/overrides.json: " +
      "the real quoted value and/or a tip received, with a reason. These flow into the tax summary. " +
      "Without confirm=true it only previews. Audit-logged.",
    inputSchema: {
      id: z.string().describe("Appointment (event) id"),
      quotedCents: z.number().int().min(0).optional().describe("Actual amount charged for the visit, in cents"),
      tipCents: z.number().int().min(0).optional().describe("Tip received, in cents"),
      reason: z.string().min(1).describe("Why, in the owner's words"),
      confirm: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, confirm, ...patch }) => {
    try {
      if (!confirm) {
        const previous = (await loadOverrides())[id] ?? null;
        return text({ preview: { id, previous, proposed: { ...previous, ...patch } }, note: "Nothing written. Call again with confirm=true to apply." });
      }
      return text(await setOverride(id, patch));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_audit_log",
  {
    description: "Show the most recent changes this server has made (Gazelle edits and local overrides).",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ limit }) => text(await readAuditLog(limit ?? 20)),
);

await server.connect(new StdioServerTransport());
