import type { Appointment, Client, DateRange } from "./types.js";

/** All Gazelle data access goes through this interface (read-only). */
export interface GazelleClient {
  listAppointments(range: DateRange): Promise<Appointment[]>;
  getAppointment(id: string): Promise<Appointment | undefined>;
  listClients(query?: string): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
}

/** In-memory client for tests and for developing tools before the real API is known. */
export class FixtureClient implements GazelleClient {
  constructor(
    private appointments: Appointment[] = [],
    private clients: Client[] = [],
  ) {}

  async listAppointments({ from, to }: DateRange): Promise<Appointment[]> {
    const lo = new Date(from).getTime();
    const hi = new Date(to).getTime();
    return this.appointments
      .filter((a) => {
        const t = new Date(a.start).getTime();
        return t >= lo && t <= hi;
      })
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  async getAppointment(id: string) {
    return this.appointments.find((a) => a.id === id);
  }

  async listClients(query?: string) {
    const q = query?.toLowerCase();
    return q ? this.clients.filter((c) => c.name.toLowerCase().includes(q)) : this.clients;
  }

  async getClient(id: string) {
    return this.clients.find((c) => c.id === id);
  }
}
