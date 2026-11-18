import { readFile } from "node:fs/promises";
import { dataFile } from "../paths.js";
import type { GazelleClient } from "./client.js";
import type { Appointment, DateRange } from "./types.js";

/**
 * Owner corrections that Gazelle itself can't express, keyed by appointment id, in
 * data/overrides.json (local, gitignored):
 *   { "evt_abc": { "quotedCents": 0, "reason": "free promotion, not charged" } }
 */
export interface Override {
  quotedCents?: number;
  tipCents?: number;
  reason?: string;
}

export async function loadOverrides(): Promise<Record<string, Override>> {
  try {
    return JSON.parse(await readFile(process.env.GAZELLE_OVERRIDES_FILE ?? dataFile("overrides.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read overrides.json: ${(e as Error).message}`);
  }
}

export function applyOverride(a: Appointment, o?: Override): Appointment {
  if (!o) return a;
  return {
    ...a,
    ...(o.tipCents != null ? { tipCents: o.tipCents } : {}),
    ...(o.quotedCents != null ? { quotedCents: o.quotedCents, quantityAmbiguous: undefined } : {}),
    overrideReason: o.reason ?? "owner override",
  };
}

/** Decorates a client so every appointment it returns has owner overrides applied. */
export function withOverrides(inner: GazelleClient): GazelleClient {
  return {
    async listAppointments(range: DateRange) {
      const [appts, ov] = await Promise.all([inner.listAppointments(range), loadOverrides()]);
      return appts.map((a) => applyOverride(a, ov[a.id]));
    },
    async getAppointment(id: string) {
      const [a, ov] = await Promise.all([inner.getAppointment(id), loadOverrides()]);
      return a && applyOverride(a, ov[id]);
    },
    listClients: (q) => inner.listClients(q),
    getClient: (id) => inner.getClient(id),
  };
}
