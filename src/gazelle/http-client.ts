import type { GazelleClient } from "./client.js";
import { gql, gqlAll } from "./graphql.js";
import type { Address, Appointment, AppointmentStatus, Client, DateRange, ServiceItem } from "./types.js";

// NOTE: field/filter shapes come from Gazelle's docs (partly summarized). Verify against the
// live schema with `npm run introspect` and fix here if anything differs.

const LOCATION = `
  street1 street2 municipality region postalCode countryCode latitude longitude`;

const EVENT = `
  id start duration timezone status type title notes
  client { id companyName defaultContact { firstName lastName defaultLocation { ${LOCATION} } } }
  location { ${LOCATION} }
  allServiceItems(first: 50) { nodes { name amount quantity isTaxable isTuning } }`;

interface GLocation {
  street1?: string | null;
  street2?: string | null;
  municipality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: string | null;
  longitude?: string | null;
}
interface GContact {
  firstName?: string | null;
  lastName?: string | null;
  defaultLocation?: GLocation | null;
}
interface GClient {
  id: string;
  companyName?: string | null;
  defaultContact?: GContact | null;
}
interface GEvent {
  id: string;
  start?: string | null;
  duration?: number | null;
  timezone?: string | null;
  status?: string | null;
  title?: string | null;
  notes?: string | null;
  client?: GClient | null;
  location?: GLocation | null;
  allServiceItems?: { nodes: { name?: string | null; amount?: number | null; quantity?: number | null; isTaxable?: boolean | null; isTuning?: boolean | null }[] } | null;
}

const num = (s?: string | null) => (s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);

export function toAddress(l?: GLocation | null): Address | undefined {
  if (!l || !(l.street1 || l.municipality || l.region || l.postalCode)) return undefined;
  return {
    line1: l.street1 ?? undefined,
    line2: l.street2 ?? undefined,
    city: l.municipality ?? undefined,
    state: l.region ?? undefined,
    postalCode: l.postalCode ?? undefined,
    country: l.countryCode ?? undefined,
    lat: num(l.latitude),
    lng: num(l.longitude),
  };
}

const STATUS: Record<string, AppointmentStatus> = {
  ACTIVE: "scheduled",
  COMPLETE: "completed",
  CANCELED: "cancelled",
  NO_SHOW: "no_show",
};

export function clientName(c?: GClient | null): string | undefined {
  if (!c) return undefined;
  const p = c.defaultContact;
  const person = [p?.firstName, p?.lastName].filter(Boolean).join(" ");
  return c.companyName || person || undefined;
}

export function toServiceItems(e: GEvent): ServiceItem[] {
  return (e.allServiceItems?.nodes ?? []).map((i) => ({
    name: i.name ?? "(unnamed)",
    amountCents: i.amount ?? 0,
    quantity: (i.quantity ?? 100) / 100,
    taxable: !!i.isTaxable,
    isTuning: !!i.isTuning,
  }));
}

export function toAppointment(e: GEvent): Appointment {
  const serviceItems = toServiceItems(e);
  const start = e.start ?? "";
  const end =
    start && e.duration != null ? new Date(new Date(start).getTime() + e.duration * 60_000).toISOString() : undefined;
  return {
    id: e.id,
    start,
    end, // duration unit assumed to be minutes — verify with real data
    timezone: e.timezone ?? undefined,
    status: (e.status && STATUS[e.status]) || "unknown",
    title: e.title ?? undefined,
    notes: e.notes ?? undefined,
    serviceItems,
    // Assumes `amount` is a unit price (amount x quantity); unconfirmed when quantity != 1.
    quotedCents: serviceItems.length
      ? Math.round(serviceItems.reduce((s, i) => s + i.amountCents * i.quantity, 0))
      : undefined,
    quantityAmbiguous: serviceItems.some((i) => i.quantity !== 1) || undefined,
    clientId: e.client?.id,
    clientName: clientName(e.client),
    // Prefer the event's own location, else the client's default location.
    location: toAddress(e.location) ?? toAddress(e.client?.defaultContact?.defaultLocation),
  };
}

const day = (iso: string) => iso.slice(0, 10);

export class HttpGazelleClient implements GazelleClient {
  async listAppointments({ from, to }: DateRange): Promise<Appointment[]> {
    const q = `query($filters: PrivateAllEventsFilter, $after: String) {
      allEventsBatched(first: 100, after: $after, filters: $filters, sortBy: [START_ASC]) {
        pageInfo { hasNextPage endCursor }
        nodes { ${EVENT} }
      }
    }`;
    const nodes = await gqlAll<{ allEventsBatched: any }, GEvent>(
      q,
      { filters: { startOn: day(from), endOn: day(to), type: ["APPOINTMENT"] } },
      (d) => d.allEventsBatched,
    );
    return nodes.map(toAppointment);
  }

  async getAppointment(id: string): Promise<Appointment | undefined> {
    const d = await gql<{ event: GEvent | null }>(`query($id: String!) { event(eventId: $id) { ${EVENT} } }`, { id });
    return d.event ? toAppointment(d.event) : undefined;
  }

  async listClients(query?: string): Promise<Client[]> {
    const q = `query($after: String) {
      allClients(first: 100, after: $after, sortBy: [CLIENT_NAME_ASC]) {
        pageInfo { hasNextPage endCursor }
        nodes { id companyName defaultContact { firstName lastName defaultLocation { ${LOCATION} } } }
      }
    }`;
    const nodes = await gqlAll<{ allClients: any }, GClient>(q, {}, (d) => d.allClients);
    const all = nodes.map(toClient);
    const s = query?.toLowerCase();
    return s ? all.filter((c) => c.name.toLowerCase().includes(s)) : all;
  }

  async getClient(id: string): Promise<Client | undefined> {
    const d = await gql<{ client: GClient | null }>(
      `query($id: String!) { client(clientId: $id) { id companyName defaultContact { firstName lastName defaultLocation { ${LOCATION} } } } }`,
      { id },
    );
    return d.client ? toClient(d.client) : undefined;
  }
}

function toClient(c: GClient): Client {
  return {
    id: c.id,
    name: clientName(c) ?? "(unnamed)",
    address: toAddress(c.defaultContact?.defaultLocation),
  };
}
