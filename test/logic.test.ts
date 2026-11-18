import { describe, expect, it } from "vitest";
import { HaversineProvider, buildMileageLog, estimateDeduction, rateFor, tripsToCsv } from "../src/mileage/mileage.js";
import { summarizeByJurisdiction } from "../src/tax/jurisdictions.js";
import type { Appointment } from "../src/gazelle/types.js";

const home = { city: "Albany", state: "NY", lat: 42.6526, lng: -73.7562 };
const appt = (id: string, start: string, state: string, lat: number, lng: number, cents?: number): Appointment => ({
  id,
  start,
  status: "completed",
  clientId: "c" + id,
  clientName: "Client " + id,
  quotedCents: cents,
  location: { city: "X", state, lat, lng },
});

describe("mileage", () => {
  it("builds home->stops->home per day and skips unlocated", async () => {
    const appts = [
      appt("1", "2026-03-02T09:00:00", "NY", 42.8, -73.9),
      appt("2", "2026-03-02T13:00:00", "NY", 42.9, -74.0),
      { id: "3", start: "2026-03-03T09:00:00", status: "completed" as const },
    ];
    const { trips, skipped } = await buildMileageLog(appts, home, new HaversineProvider());
    expect(trips.map((t) => t.to)).toHaveLength(3);
    expect(trips.at(-1)!.to).toBe("Home");
    expect(skipped).toEqual([{ id: "3", reason: "no service location" }]);
  });
  it("logs the drive for a no-show but not for a cancellation", async () => {
    const appts = [
      { ...appt("1", "2026-03-02T09:00:00", "NY", 42.8, -73.9), status: "no_show" as const },
      { ...appt("2", "2026-03-03T09:00:00", "NY", 42.9, -74.0), status: "cancelled" as const },
    ];
    const { trips } = await buildMileageLog(appts, home, new HaversineProvider());
    expect(trips.map((t) => t.appointmentId ?? "return")).toEqual(["1", "return"]);
  });
  it("estimates deduction and escapes CSV", () => {
    const t = (date: string, miles: number) => ({ date, from: "a", to: "b", miles, purpose: "p" });
    expect(estimateDeduction([t("2025-06-01", 100)]).cents).toBe(7000);
    expect(estimateDeduction([t("1999-01-01", 10)]).noRateDates).toEqual(["1999-01-01"]);
    // 2026 rate changes on Jul 1: 72.5c before, 76c from that date
    expect(rateFor("2026-06-30")).toBe(72.5);
    expect(rateFor("2026-07-01")).toBe(76);
    expect(estimateDeduction([t("2026-06-30", 100), t("2026-07-01", 100)]).cents).toBe(7250 + 7600);
    expect(tripsToCsv([{ date: "d", from: 'a,"b"', to: "c", miles: 1, purpose: "p" }])).toContain('"a,""b"""');
  });
});

describe("jurisdictions", () => {
  it("groups by state, sums revenue, flags missing amounts", () => {
    const { summaries, unlocated } = summarizeByJurisdiction([
      appt("1", "2026-01-01", "NY", 0, 0, 10000),
      appt("2", "2026-02-01", "ny", 0, 0),
      appt("3", "2026-03-01", "VT", 0, 0, 5000),
      { id: "4", start: "2026-03-01", status: "completed" },
      { ...appt("5", "2026-03-02", "NY", 0, 0, 9000), status: "no_show" },
    ]);
    const ny = summaries.find((s) => s.state === "NY")!;
    expect(ny).toMatchObject({ visits: 2, quotedValueCents: 10000, missingAmounts: 1, clients: 2 });
    expect(unlocated).toEqual(["4"]);
  });
});

import { localDate } from "../src/mileage/mileage.js";
describe("timezone", () => {
  it("dates a late-evening local appointment on its local day, not the UTC day", () => {
    expect(localDate("2026-03-03T02:30:00Z", "America/New_York")).toBe("2026-03-02");
    expect(localDate("2026-03-03T02:30:00Z", "UTC")).toBe("2026-03-03");
  });
});

import { applyOverride } from "../src/gazelle/overrides.js";
describe("overrides", () => {
  it("replaces quoted value, clears the ambiguity flag, records the reason", () => {
    const a = { id: "e", start: "2026-05-03T17:15:00Z", status: "completed" as const, quotedCents: 30000, quantityAmbiguous: true };
    expect(applyOverride(a, { quotedCents: 0, reason: "promo" })).toMatchObject({ quotedCents: 0, quantityAmbiguous: undefined, overrideReason: "promo" });
    expect(applyOverride(a)).toBe(a);
  });
});

import { appendedNotes, unexpectedChanges } from "../src/gazelle/writer.js";
describe("writer", () => {
  it("appends to existing notes, keeps them, and handles empty", () => {
    expect(appendedNotes("old\n", "new")).toBe("old\n\nnew");
    expect(appendedNotes(null, " new ")).toBe("new");
    expect(() => appendedNotes("x", "  ")).toThrow();
  });
  it("flags any change other than notes", () => {
    const b = { id: "e", notes: "a", start: "s", allServiceItems: { nodes: [{ amount: 1 }] } };
    expect(unexpectedChanges(b, { ...b, notes: "b" })).toEqual([]);
    expect(unexpectedChanges(b, { ...b, notes: "b", allServiceItems: { nodes: [] } })).toEqual(["allServiceItems"]);
  });
});
