/** Manually-added collection entries (DCH-12): form shape, validation, and
 *  duplicate detection. Kept free of Tauri imports so it can be unit-tested
 *  outside the app shell. */

import type { CollectionRow, LocalEntryInput } from "./tauri";

/** The dialog's raw state. Every field is a string because that's what an
 *  `<input>` hands back; conversion to the typed command input happens once,
 *  on submit, in `toInput`. */
export interface ManualEntryForm {
  driverName: string;
  schemeText: string;
  year: string;
  yearRaced: string;
  carNumber: string;
  oem: string;
  brand: string;
  scale: string;
  make: string;
  finish: string;
  diecastType: string;
  productionQty: string;
  price: string;
  condition: string;
  notes: string;
  imageUrl: string;
}

export const EMPTY_MANUAL_ENTRY_FORM: ManualEntryForm = {
  driverName: "",
  schemeText: "",
  year: "",
  yearRaced: "",
  carNumber: "",
  oem: "",
  brand: "",
  scale: "",
  make: "",
  finish: "",
  diecastType: "",
  productionQty: "",
  price: "",
  condition: "",
  notes: "",
  imageUrl: "",
};

/** Prefill the dialog from an existing row, for the edit path. `paid_cents`
 *  becomes a plain decimal string — the field is a text input, not a number
 *  input, so "45" and "45.00" both round-trip unchanged. */
export function formFromRow(row: CollectionRow): ManualEntryForm {
  return {
    driverName: row.driver_name ?? "",
    schemeText: row.scheme_text ?? "",
    year: row.year != null ? String(row.year) : "",
    yearRaced: row.year_raced != null ? String(row.year_raced) : "",
    carNumber: row.car_number ?? "",
    oem: row.oem ?? "",
    brand: row.brand ?? "",
    scale: row.scale ?? "",
    make: row.make ?? "",
    finish: row.finish ?? "",
    diecastType: row.diecast_type ?? "",
    productionQty: row.production_qty != null ? String(row.production_qty) : "",
    price: row.paid_cents != null ? (row.paid_cents / 100).toFixed(2) : "",
    condition: row.condition ?? "",
    notes: row.notes ?? "",
    imageUrl: row.image_url ?? "",
  };
}

/** Dollars to cents. Accepts what people actually type — "$45", "1,299.99",
 *  " 45.5 " — and rejects anything else rather than guessing. `null` means
 *  the field was blank; `undefined` means it was unparseable, which the
 *  caller reports as a validation error.
 *
 *  Rounds rather than truncates: "19.999" is a typo for two decimal places,
 *  and silently dropping the third digit loses a cent. */
export function parsePriceToCents(raw: string): number | null | undefined {
  const trimmed = raw.trim().replace(/[$,]/g, "");
  if (trimmed === "") return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * 100);
}

/** Blank integer field → null, garbage → undefined. Same contract as
 *  `parsePriceToCents`, so callers can treat the two identically. */
export function parseIntField(raw: string): number | null | undefined {
  const trimmed = raw.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Same bounds the backend enforces, duplicated here so a typo is caught
 *  before a round trip rather than coming back as a command error. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/** Everything wrong with the form, so the user fixes it in one pass instead
 *  of being told about one problem at a time. Empty array = valid. */
export function validateManualEntry(form: ManualEntryForm): string[] {
  const errors: string[] = [];
  if (!form.driverName.trim()) errors.push("Driver name is required.");
  if (!form.schemeText.trim())
    errors.push("Scheme/description is required — it titles the entry.");

  for (const [label, raw] of [
    ["Year", form.year],
    ["Year raced", form.yearRaced],
  ] as const) {
    const parsed = parseIntField(raw);
    if (parsed === undefined) errors.push(`${label} must be a whole number.`);
    else if (parsed !== null && (parsed < MIN_YEAR || parsed > MAX_YEAR))
      errors.push(`${label} must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }

  if (parseIntField(form.productionQty) === undefined)
    errors.push("Production quantity must be a whole number.");
  if (parsePriceToCents(form.price) === undefined)
    errors.push("Purchase price must be an amount like 45.00.");

  return errors;
}

/** Convert a validated form to the command input. Throws if the form is
 *  invalid — callers must run `validateManualEntry` first, and the throw is
 *  a programming-error guard, not a user-facing path. */
export function toInput(form: ManualEntryForm): LocalEntryInput {
  const errors = validateManualEntry(form);
  if (errors.length > 0)
    throw new Error(`refusing to submit an invalid entry: ${errors[0]}`);

  const text = (v: string): string | null => v.trim() || null;
  // Safe casts: validation above rejected every `undefined` case.
  return {
    driverName: form.driverName.trim(),
    schemeText: form.schemeText.trim(),
    year: parseIntField(form.year) as number | null,
    yearRaced: parseIntField(form.yearRaced) as number | null,
    carNumber: text(form.carNumber),
    oem: text(form.oem),
    brand: text(form.brand),
    scale: text(form.scale),
    make: text(form.make),
    finish: text(form.finish),
    diecastType: text(form.diecastType),
    productionQty: parseIntField(form.productionQty) as number | null,
    paidCents: parsePriceToCents(form.price) as number | null,
    condition: text(form.condition),
    notes: text(form.notes),
    imageUrl: text(form.imageUrl),
  };
}

/** Loose text key for duplicate comparison: case, punctuation and spacing
 *  vary between what a user types and what DCR publishes ("#24 DuPont" vs
 *  "24 Dupont"), and none of that difference means a different car. */
function loose(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Manually-added rows that now also exist as a synced DCR row.
 *
 * The case this covers: a car DCR didn't list gets added by hand, and later
 * DCR adds it. The next sync brings in a second, near-identical collection
 * row, and nothing connects the two — the user sees a duplicate with no hint
 * about which one to remove.
 *
 * Deliberately advisory rather than automatic. Merging the pair would mean
 * deciding which entry's data survives and silently discarding the other's,
 * on a similarity heuristic; flagging it puts the choice where it belongs.
 * The Remove button is already on the row, so the flag is enough to act on.
 *
 * Matches on driver + scheme + year + scale, all loosely compared. Scale
 * matters because the same paint scheme is commonly issued at 1:24 and 1:64
 * — those are two different cars and both belong in a collection.
 *
 * Returns a map from the local row's `collection_id` to the DCR row it looks
 * like a duplicate of.
 */
export function findLocalDuplicates(
  rows: CollectionRow[],
): Map<number, CollectionRow> {
  const key = (r: CollectionRow) =>
    [
      loose(r.driver_name),
      loose(r.scheme_text),
      r.year ?? "",
      loose(r.scale),
    ].join("|");

  const synced = new Map<string, CollectionRow>();
  for (const r of rows) if (!r.is_local) synced.set(key(r), r);

  const out = new Map<number, CollectionRow>();
  if (synced.size === 0) return out;
  for (const r of rows) {
    if (!r.is_local) continue;
    const match = synced.get(key(r));
    if (match) out.set(r.collection_id, match);
  }
  return out;
}
