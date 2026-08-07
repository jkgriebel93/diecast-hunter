import { useId, useMemo, useState } from "react";
import { api, ALLOWED_SCALES, type CollectionRow } from "@/lib/tauri";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";
import {
  EMPTY_MANUAL_ENTRY_FORM,
  formFromRow,
  toInput,
  validateManualEntry,
  type ManualEntryForm,
} from "@/lib/localEntry";

/**
 * Add or edit a car diecastregistry.com doesn't list (DCH-12).
 *
 * Only the driver and the scheme are required. Everything else is optional
 * on purpose: this feature exists precisely for cars the registry has no
 * data on, so demanding a full spec would defeat it.
 *
 * Purchase price is a cost basis, not an appraisal — it goes to
 * `my_collection.paid_cents` and the entry's retail/wholesale values stay
 * empty. The dialog says so, because a $0 retail on the collection list
 * otherwise reads as a bug.
 */
export function ManualEntryDialog({
  editing,
  driverNames,
  onClose,
  onSaved,
}: {
  /** The row being edited, or null when adding. */
  editing: CollectionRow | null;
  /** Existing driver names, offered as autocomplete so a manual entry lands
   *  in the same driver group as the rest of the collection instead of
   *  creating a near-duplicate driver. */
  driverNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<ManualEntryForm>(() =>
    editing ? formFromRow(editing) : EMPTY_MANUAL_ENTRY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Held unconverted so `ErrorBanner` can classify it — `String(err)` here
  // would flatten a backend `AppError` into a string before anything got to
  // read its prefix.
  const [saveError, setSaveError] = useState<unknown>(null);
  const listId = useId();

  const errors = useMemo(() => validateManualEntry(form), [form]);

  function set<K extends keyof ManualEntryForm>(
    key: K,
    value: ManualEntryForm[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = toInput(form);
      if (editing) {
        await api.updateLocalCollectionEntry(editing.collection_id, input);
        onSaved(`Updated "${input.schemeText}".`);
      } else {
        await api.createLocalCollectionEntry(input);
        onSaved(`Added "${input.schemeText}" to your collection.`);
      }
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  // Errors stay hidden until the first submit: flagging a blank form the
  // instant it opens is noise, not help.
  const showErrors = submitted && errors.length > 0;

  return (
    <Modal
      title={editing ? "Edit entry" : "Add a car manually"}
      description="For cars diecastregistry.com doesn't list. This stays local — nothing is added to your DCR garage."
      onClose={onClose}
      onSubmit={onSubmit}
      busy={saving}
      size="max-w-2xl"
      panelClassName="space-y-4"
      footer={
        <>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving
              ? "Saving…"
              : editing
                ? "Save changes"
                : "Add to collection"}
          </button>
        </>
      }
    >
      <div data-testid="manual-entry-dialog" className="space-y-4">
        {/* Validation messages are ours and already written for a person, so
            they stay a plain list — running them through `describeError`
            would only retitle them "Something went wrong." The save failure
            below is a backend error and does go through `ErrorBanner`. */}
        {showErrors && (
          <ul className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 space-y-0.5">
            {errors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        )}
        <ErrorBanner error={saveError} variant="inline" />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Driver" required className="col-span-2">
            <input
              className="input"
              list={listId}
              value={form.driverName}
              onChange={(e) => set("driverName", e.target.value)}
              placeholder="Jeff Gordon"
              autoFocus
            />
            <datalist id={listId}>
              {driverNames.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Scheme / description"
            required
            className="col-span-2"
            hint="Titles the entry in your collection."
          >
            <input
              className="input"
              value={form.schemeText}
              onChange={(e) => set("schemeText", e.target.value)}
              placeholder="#24 DuPont Monte Carlo"
            />
          </Field>

          <Field label="Year released">
            <input
              className="input"
              value={form.year}
              onChange={(e) => set("year", e.target.value)}
              placeholder="1998"
              inputMode="numeric"
            />
          </Field>
          <Field label="Year raced">
            <input
              className="input"
              value={form.yearRaced}
              onChange={(e) => set("yearRaced", e.target.value)}
              inputMode="numeric"
            />
          </Field>

          <Field label="Car number">
            <input
              className="input"
              value={form.carNumber}
              onChange={(e) => set("carNumber", e.target.value)}
              placeholder="24"
            />
          </Field>
          <Field label="Scale">
            {/* Free text, not a fixed select: the standard sizes cover most
                entries, but a promo or an odd import can be anything, and
                this is the feature for cars that don't fit the catalog. */}
            <input
              className="input"
              list={`${listId}-scale`}
              value={form.scale}
              onChange={(e) => set("scale", e.target.value)}
              placeholder="1:24"
            />
            <datalist id={`${listId}-scale`}>
              {ALLOWED_SCALES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>

          <Field label="OEM">
            <input
              className="input"
              value={form.oem}
              onChange={(e) => set("oem", e.target.value)}
              placeholder="Action"
            />
          </Field>
          <Field label="Brand">
            <input
              className="input"
              value={form.brand}
              onChange={(e) => set("brand", e.target.value)}
              placeholder="RCCA"
            />
          </Field>

          <Field label="Make">
            <input
              className="input"
              value={form.make}
              onChange={(e) => set("make", e.target.value)}
            />
          </Field>
          <Field label="Finish">
            <input
              className="input"
              value={form.finish}
              onChange={(e) => set("finish", e.target.value)}
            />
          </Field>

          <Field label="Type">
            <input
              className="input"
              value={form.diecastType}
              onChange={(e) => set("diecastType", e.target.value)}
              placeholder="Stock Car"
            />
          </Field>
          <Field label="Production quantity">
            <input
              className="input"
              value={form.productionQty}
              onChange={(e) => set("productionQty", e.target.value)}
              inputMode="numeric"
            />
          </Field>

          <Field
            label="Purchase price"
            className="col-span-2"
            hint="What you paid. Recorded as cost — a manual entry has no registry appraisal, so it adds nothing to the retail total."
          >
            <input
              className="input"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              placeholder="45.00"
              inputMode="decimal"
            />
          </Field>

          <Field label="Condition">
            <input
              className="input"
              value={form.condition}
              onChange={(e) => set("condition", e.target.value)}
              placeholder="Mint in box"
            />
          </Field>
          <Field label="Image URL">
            <input
              className="input"
              value={form.imageUrl}
              onChange={(e) => set("imageUrl", e.target.value)}
              placeholder="https://…"
            />
          </Field>

          <Field label="Notes" className="col-span-2">
            <textarea
              className="input min-h-[4rem]"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required = false,
  hint,
  className = "",
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-xs text-fg-subtle">
        {label}
        {required && <span className="text-red-400"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
    </label>
  );
}
