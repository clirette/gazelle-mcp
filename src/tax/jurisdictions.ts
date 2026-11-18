import type { Appointment } from "../gazelle/types.js";

export interface JurisdictionSummary {
  state: string;
  city?: string;
  visits: number;
  clients: number;
  /** Sum of QUOTED service-item prices (not invoiced/collected revenue). */
  quotedValueCents: number;
  /** Tips recorded for these visits (income; stored locally, not in Gazelle). */
  tipsCents: number;
  /** Appointments with no priced service items (value is understated if > 0). */
  missingAmounts: number;
  /** Appointments with a quantity != 1 item (unit-vs-total price unconfirmed). */
  ambiguousQuantities: number;
  firstVisit: string;
  lastVisit: string;
}

/** Group completed/scheduled work by state (default) or state+city. Cancellations and no-shows are excluded. */
export function summarizeByJurisdiction(
  appointments: Appointment[],
  by: "state" | "city" = "state",
): { summaries: JurisdictionSummary[]; unlocated: string[] } {
  const groups = new Map<string, { s: JurisdictionSummary; clientIds: Set<string> }>();
  const unlocated: string[] = [];

  for (const a of appointments) {
    if (a.status === "cancelled" || a.status === "no_show") continue;
    const state = a.location?.state?.toUpperCase();
    if (!state) {
      unlocated.push(a.id);
      continue;
    }
    const city = by === "city" ? a.location?.city : undefined;
    const key = `${state}|${city ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        s: { state, city, visits: 0, clients: 0, quotedValueCents: 0, tipsCents: 0, missingAmounts: 0, ambiguousQuantities: 0, firstVisit: a.start, lastVisit: a.start },
        clientIds: new Set(),
      };
      groups.set(key, g);
    }
    g.s.visits++;
    if (a.quotedCents == null) g.s.missingAmounts++;
    else g.s.quotedValueCents += a.quotedCents;
    g.s.tipsCents += a.tipCents ?? 0;
    if (a.quantityAmbiguous) g.s.ambiguousQuantities++;
    if (a.clientId) g.clientIds.add(a.clientId);
    if (a.start < g.s.firstVisit) g.s.firstVisit = a.start;
    if (a.start > g.s.lastVisit) g.s.lastVisit = a.start;
  }

  const summaries = [...groups.values()].map(({ s, clientIds }) => ({ ...s, clients: clientIds.size }));
  summaries.sort((a, b) => b.quotedValueCents - a.quotedValueCents);
  return { summaries, unlocated };
}
