import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../paths.js";
import { gql } from "./graphql.js";
import { loadOverrides, type Override } from "./overrides.js";

/**
 * All Gazelle writes live here. The only mutation used is `updateEvent`, for exactly two narrow
 * edits: appending to `notes` and changing one service item's price. Each is previewed first,
 * verified afterwards against a before/after snapshot, and audited to data/audit-log.jsonl.
 * The MCP tools that call these are only registered when GAZELLE_ENABLE_WRITES=1.
 */

const SNAPSHOT = `
  id start duration timezone status type title notes tags buffer
  client { id } user { id }
  location { street1 }
  allEventPianos(first: 50) { nodes { isTuning piano { id eventLastService calculatedLastService calculatedNextService } } }
  allServiceItems(first: 50) { nodes { id name amount quantity duration isTaxable isTuning type piano { id } masterServiceItem { id } currency { code } } }`;

export type Snapshot = Record<string, any> & { id: string; notes?: string | null };

export async function snapshot(id: string): Promise<Snapshot> {
  const d = await gql<{ event: Snapshot | null }>(`query($id: String!) { event(eventId: $id) { ${SNAPSHOT} } }`, { id });
  if (!d.event) throw new Error(`No appointment with id ${id}`);
  return d.event;
}

const auditPath = () => process.env.GAZELLE_AUDIT_FILE ?? dataFile("audit-log.jsonl");

export async function audit(entry: Record<string, unknown>) {
  await mkdir(dirname(auditPath()), { recursive: true });
  await appendFile(auditPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function appendedNotes(current: string | null | undefined, addition: string): string {
  const text = addition.trim();
  if (!text) throw new Error("Note text is empty");
  return current?.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
}

/** Everything except notes (and server-side timestamps) must be identical before and after. */
export function unexpectedChanges(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === "notes") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

export interface NotePreview {
  id: string;
  title?: string | null;
  start?: string;
  currentNotes: string | null;
  newNotes: string;
}

export async function previewAppendNote(id: string, text: string): Promise<NotePreview> {
  const s = await snapshot(id);
  return { id, title: s.title, start: s.start, currentNotes: s.notes ?? null, newNotes: appendedNotes(s.notes, text) };
}

export async function appendNote(id: string, text: string) {
  const before = await snapshot(id);
  const notes = appendedNotes(before.notes, text);
  const d = await gql<{ updateEvent: { event?: { id: string } | null; mutationErrors: { fieldName?: string; key?: string; messages?: string[]; type?: string }[] } }>(
    `mutation($id: String!, $input: PrivateEventInput!) {
       updateEvent(id: $id, input: $input) { event { id } mutationErrors { fieldName key messages type } }
     }`,
    { id, input: { notes } },
  );
  const errors = d.updateEvent.mutationErrors;
  const after = await snapshot(id);
  const changed = unexpectedChanges(before, after);
  await audit({ action: "appendNote", eventId: id, errors, notesBefore: before.notes ?? null, notesAfter: after.notes ?? null, unexpectedChanges: changed });
  if (errors.length) throw new Error(`Gazelle rejected the update: ${JSON.stringify(errors)}`);
  if (after.notes !== notes) throw new Error("Update returned no errors but notes did not change as expected; see audit log.");
  return { ok: true, notes: after.notes, unexpectedChanges: changed, before: { notes: before.notes ?? null } };
}

/** Local-only correction stored in data/overrides.json (never sent to Gazelle). */
export async function setOverride(id: string, patch: Override) {
  const all = await loadOverrides();
  const previous = all[id] ?? null;
  all[id] = { ...previous, ...patch };
  const p = process.env.GAZELLE_OVERRIDES_FILE ?? dataFile("overrides.json");
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(all, null, 2) + "\n");
  await audit({ action: "setOverride", eventId: id, previous, current: all[id] });
  return { previous, current: all[id] };
}

export async function readAuditLog(limit = 20) {
  try {
    const lines = (await readFile(auditPath(), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Service-item price edit. updateEvent probably REPLACES the serviceItems list, so
// we resend every item unchanged except the target amount, verify, and auto-restore
// the original items if anything else changed.
// ---------------------------------------------------------------------------

interface SvcNode {
  id: string;
  name: string;
  amount: number | null;
  quantity: number;
  duration: number;
  isTaxable: boolean | null;
  isTuning: boolean | null;
  type: string;
  piano?: { id: string } | null;
  masterServiceItem?: { id: string } | null;
  currency?: { code: string } | null;
}

const toInput = (i: SvcNode, amount: number | null = i.amount) => ({
  pianoId: i.piano?.id ?? null,
  masterServiceItemId: i.masterServiceItem?.id ?? null,
  name: i.name,
  amount,
  duration: i.duration,
  quantity: i.quantity,
  type: i.type,
  currencyCode: i.currency?.code ?? null,
  isTuning: i.isTuning,
  isTaxable: i.isTaxable,
});

const itemsOf = (s: Snapshot): SvcNode[] => s.allServiceItems?.nodes ?? [];

function pickTarget(s: Snapshot, itemId?: string): SvcNode {
  const items = itemsOf(s);
  if (itemId) {
    const t = items.find((i) => i.id === itemId);
    if (!t) throw new Error(`No service item ${itemId}. Items: ${items.map((i) => `${i.id} (${i.name})`).join(", ")}`);
    return t;
  }
  if (items.length !== 1) {
    throw new Error(`Appointment has ${items.length} service items; pass itemId. Items: ${items.map((i) => `${i.id} (${i.name}, ${i.amount})`).join("; ")}`);
  }
  return items[0];
}

export async function previewSetItemPrice(id: string, amountCents: number, itemId?: string) {
  const s = await snapshot(id);
  const t = pickTarget(s, itemId);
  return {
    id,
    title: s.title,
    start: s.start,
    item: { id: t.id, name: t.name, quantity: t.quantity / 100 },
    priceCentsBefore: t.amount,
    priceCentsAfter: amountCents,
    otherItemsResent: itemsOf(s).filter((i) => i.id !== t.id).map((i) => ({ name: i.name, amount: i.amount })),
    warning: "Gazelle replaces the whole service-item list on update, so item ids may change. Everything else is verified afterwards and auto-restored on mismatch.",
  };
}

/** Item contents with ids stripped, for comparing before/after. */
const norm = (i: SvcNode) => JSON.stringify({ ...toInput(i) });

export async function setItemPrice(id: string, amountCents: number, itemId?: string) {
  const before = await snapshot(id);
  const target = pickTarget(before, itemId);
  const items = itemsOf(before);
  const send = (list: unknown[]) =>
    gql<{ updateEvent: { mutationErrors: { fieldName?: string; key?: string; messages?: string[]; type?: string }[] } }>(
      `mutation($id: String!, $input: PrivateEventInput!) {
         updateEvent(id: $id, input: $input) { mutationErrors { fieldName key messages type } }
       }`,
      { id, input: { serviceItems: list } },
    );

  const d = await send(items.map((i) => toInput(i, i.id === target.id ? amountCents : i.amount)));
  const errors = d.updateEvent.mutationErrors;
  const after = await snapshot(id);

  // What should differ: only the target item's amount (matched by position/content, ids ignored).
  const expected = items.map((i) => norm({ ...i, amount: i.id === target.id ? amountCents : i.amount }));
  const actual = itemsOf(after).map(norm);
  const sameItems = JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
  const others = unexpectedChanges(
    { ...before, allServiceItems: undefined },
    { ...after, allServiceItems: undefined },
  );

  let restored = false;
  if (errors.length || !sameItems || others.length) {
    // Put the original items back, then re-check.
    await send(items.map((i) => toInput(i)));
    const again = await snapshot(id);
    restored = JSON.stringify(itemsOf(again).map(norm).sort()) === JSON.stringify(items.map(norm).sort());
  }
  await audit({
    action: "setItemPrice", eventId: id, itemId: target.id, amountBefore: target.amount, amountRequested: amountCents,
    errors, sameItems, unexpectedChanges: others, restored,
    itemsBefore: items, itemsAfter: itemsOf(after),
  });
  if (errors.length) throw new Error(`Gazelle rejected the update: ${JSON.stringify(errors)}${restored ? " (original items verified restored)" : ""}`);
  if (!sameItems || others.length) {
    throw new Error(
      `Verification failed (items match: ${sameItems}; other fields changed: ${others.join(", ") || "none"}). ` +
        (restored ? "Original items were restored and verified." : "RESTORE ALSO FAILED — check the appointment in Gazelle; see audit log."),
    );
  }
  return {
    ok: true,
    priceCentsBefore: target.amount,
    priceCentsAfter: amountCents,
    itemIdsChanged: JSON.stringify(items.map((i) => i.id).sort()) !== JSON.stringify(itemsOf(after).map((i) => i.id).sort()),
    unexpectedChanges: others,
  };
}
