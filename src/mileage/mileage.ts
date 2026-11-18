import type { Address, Appointment } from "../gazelle/types.js";

/**
 * IRS standard business mileage rates in cents/mile, effective from the given date (local trip date).
 * 2026 changed mid-year (Announcement 2026-11): 72.5 through Jun 30, 76 from Jul 1.
 * Source: https://www.irs.gov/tax-professionals/standard-mileage-rates — re-verify each year.
 */
export const IRS_RATE_PERIODS: { from: string; cents: number }[] = [
  { from: "2024-01-01", cents: 67 },
  { from: "2025-01-01", cents: 70 },
  { from: "2026-01-01", cents: 72.5 },
  { from: "2026-07-01", cents: 76 },
];

export function rateFor(date: string): number | undefined {
  let rate: number | undefined;
  for (const p of IRS_RATE_PERIODS) if (p.from <= date) rate = p.cents;
  return rate;
}

export interface DistanceProvider {
  /** Driving miles between two addresses. */
  miles(from: Address, to: Address): Promise<number>;
}

/**
 * Great-circle distance from lat/lng, scaled by a road-winding factor.
 * Makes no external calls. Requires coordinates on both addresses.
 * This is an ESTIMATE; real driving distance is usually 1.2-1.4x straight-line.
 */
export class HaversineProvider implements DistanceProvider {
  constructor(private roadFactor = 1.25) {}

  async miles(from: Address, to: Address): Promise<number> {
    if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
      throw new Error("HaversineProvider needs lat/lng on both addresses");
    }
    return haversineMiles(from.lat, from.lng, to.lat, to.lng) * this.roadFactor;
  }
}

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const DEFAULT_TZ = process.env.GAZELLE_TIMEZONE ?? "America/New_York";

/** YYYY-MM-DD of an instant in the given IANA timezone (start times from Gazelle are UTC). */
export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

export interface Trip {
  date: string; // YYYY-MM-DD
  from: string;
  to: string;
  miles: number;
  purpose: string;
  appointmentId?: string;
  clientName?: string;
}

export function formatAddress(a: Address): string {
  return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

/**
 * Build a day-by-day trip log: home -> stop 1 -> ... -> stop N -> home.
 * Appointments without a location are skipped and reported in `skipped`. Cancelled
 * appointments are dropped; no-shows are kept, since the trip was still driven.
 * Trips are dated in each appointment's own timezone (fallback GAZELLE_TIMEZONE).
 */
export async function buildMileageLog(
  appointments: Appointment[],
  home: Address,
  provider: DistanceProvider,
): Promise<{ trips: Trip[]; skipped: { id: string; reason: string }[] }> {
  const trips: Trip[] = [];
  const skipped: { id: string; reason: string }[] = [];

  const byDay = new Map<string, Appointment[]>();
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    if (!a.location) {
      skipped.push({ id: a.id, reason: "no service location" });
      continue;
    }
    const day = localDate(a.start, a.timezone ?? DEFAULT_TZ);
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }

  for (const day of [...byDay.keys()].sort()) {
    const stops = byDay.get(day)!.sort((a, b) => a.start.localeCompare(b.start));
    let prev: Address = home;
    let prevLabel = "Home";
    for (const stop of stops) {
      const loc = stop.location!;
      const label = formatAddress(loc);
      try {
        const miles = await provider.miles(prev, loc);
        trips.push({
          date: day,
          from: prevLabel,
          to: label,
          miles: round1(miles),
          purpose: `Piano service${stop.clientName ? ` - ${stop.clientName}` : ""}`,
          appointmentId: stop.id,
          clientName: stop.clientName,
        });
        prev = loc;
        prevLabel = label;
      } catch (e) {
        skipped.push({ id: stop.id, reason: (e as Error).message });
      }
    }
    if (prev !== home) {
      try {
        const miles = await provider.miles(prev, home);
        trips.push({ date: day, from: prevLabel, to: "Home", miles: round1(miles), purpose: "Return from service calls" });
      } catch (e) {
        skipped.push({ id: `return-${day}`, reason: (e as Error).message });
      }
    }
  }
  return { trips, skipped };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Standard-rate deduction in cents, computed per trip by date. Undefined dates (no rate known) are listed. */
export function estimateDeduction(trips: Trip[]): {
  cents: number;
  byRate: { centsPerMile: number; miles: number; deductionCents: number }[];
  noRateDates: string[];
} {
  const groups = new Map<number, number>();
  const noRate = new Set<string>();
  for (const t of trips) {
    const r = rateFor(t.date);
    if (r == null) noRate.add(t.date);
    else groups.set(r, (groups.get(r) ?? 0) + t.miles);
  }
  const byRate = [...groups].map(([centsPerMile, miles]) => ({
    centsPerMile,
    miles: Math.round(miles * 10) / 10,
    deductionCents: Math.round(miles * centsPerMile),
  }));
  return { cents: byRate.reduce((s, g) => s + g.deductionCents, 0), byRate, noRateDates: [...noRate].sort() };
}

export function tripsToCsv(trips: Trip[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = trips.map((t) =>
    [t.date, t.from, t.to, t.miles, t.purpose, t.appointmentId ?? ""].map((v) => esc(String(v))).join(","),
  );
  return ["date,from,to,miles,purpose,appointment_id", ...rows].join("\n");
}
