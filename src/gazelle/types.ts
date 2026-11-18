/** Normalized domain model. Adapters in client.ts map Gazelle's wire format to these. */

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  county?: string;
  /** Two-letter state/province code, e.g. "NY". */
  state?: string;
  postalCode?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface Client {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: Address;
}

/** `no_show` is kept separate from `cancelled`: no revenue, but the trip was still driven. */
export type AppointmentStatus = "scheduled" | "completed" | "cancelled" | "no_show" | "unknown";

export interface Appointment {
  id: string;
  /** ISO 8601 start. */
  start: string;
  /** ISO 8601 end, if known. */
  end?: string;
  /** IANA timezone of the appointment (start is UTC). */
  timezone?: string;
  status: AppointmentStatus;
  title?: string;
  notes?: string;
  clientId?: string;
  clientName?: string;
  /** Where the service happens. */
  location?: Address;
  /** Priced service line items attached to the appointment in Gazelle. */
  serviceItems?: ServiceItem[];
  /**
   * Sum of service-item prices in integer cents (the QUOTED/scheduled value, not invoiced or
   * collected revenue; invoices are not read, since not every Gazelle plan includes them). Undefined if no items.
   */
  quotedCents?: number;
  /** True if any item has quantity != 1 (price-per-unit vs line-total is unconfirmed). */
  quantityAmbiguous?: boolean;
  /** Tip received in integer cents (Gazelle can't store tips without invoice access; comes from overrides.json). */
  tipCents?: number;
  /** Set when the owner's data/overrides.json corrected this appointment. */
  overrideReason?: string;
}

export interface ServiceItem {
  name: string;
  /** Unit price in cents as reported by Gazelle. */
  amountCents: number;
  /** Quantity (Gazelle reports hundredths; normalized here, 1 = one unit). */
  quantity: number;
  taxable: boolean;
  isTuning: boolean;
}

export interface DateRange {
  /** Inclusive, ISO date or datetime. */
  from: string;
  /** Inclusive, ISO date or datetime. */
  to: string;
}
