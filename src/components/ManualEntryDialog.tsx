import { useEffect, useId, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api, ALLOWED_SCALES, type CollectionRow } from "@/lib/tauri";
import {
  loadAttributeOptions,
  EMPTY_ATTRIBUTE_OPTIONS,
  type AttributeOptions,
} from "@/lib/attributeOptions";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";
import {
  EMPTY_MANUAL_ENTRY_FORM,
  formFromRow,
  toInput,
  validateManualEntry,
  type ManualEntryForm,
} from "@/lib/localEntry";

/** What should happen to the entry's photo when the dialog is saved.
 *
 *  Three states rather than a nullable path because "leave it alone" and
 *  "take it away" are different intentions, and a single `string | null`
 *  would collapse them — opening the dialog on a row that already has a
 *  photo and pressing Save would silently delete it. */
type PhotoAction =
  | { kind: "unchanged" }
  | { kind: "replace"; sourcePath: string }
  | { kind: "remove" };

/** Extensions the backend accepts (`collection_photo::ALLOWED_EXTENSIONS`).
 *  Duplicated here so the OS picker greys out files that would be refused,
 *  rather than letting the user choose one and reporting an error after. */
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

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
  /** `partial` is true when the entry saved but its photo didn't — the save
   *  went through, so the caller must not report it as a failure. */
  onSaved: (message: string, partial?: boolean) => void;
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
  const [photo, setPhoto] = useState<PhotoAction>({ kind: "unchanged" });
  // Seeded from the row being edited; replaced when a new file is picked and
  // cleared when the photo is removed. Held separately from `photo` because
  // the stored photo and a freshly-picked one become displayable by different
  // routes — one is already inside the app's asset scope, the other needs the
  // per-file grant in `pickPhoto`.
  const [previewSrc, setPreviewSrc] = useState<string | null>(() =>
    editing?.local_image_path ? convertFileSrc(editing.local_image_path) : null,
  );
  const [options, setOptions] = useState<AttributeOptions>(
    EMPTY_ATTRIBUTE_OPTIONS,
  );
  const listId = useId();

  // Loaded on open rather than on first focus: five of the fields below want
  // suggestions, so there is no keystroke early enough to hide the fetch
  // behind, and the cache makes every open after the first free.
  useEffect(() => {
    let live = true;
    void loadAttributeOptions().then((o) => {
      if (live) setOptions(o);
    });
    return () => {
      live = false;
    };
  }, []);

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
      let collectionId: number;
      let message: string;
      if (editing) {
        await api.updateLocalCollectionEntry(editing.collection_id, input);
        collectionId = editing.collection_id;
        message = `Updated "${input.schemeText}".`;
      } else {
        const summary = await api.createLocalCollectionEntry(input);
        collectionId = summary.collection_id;
        message = `Added "${input.schemeText}" to your collection.`;
      }

      // The photo is a second round trip because it needs the entry's id,
      // which on the add path doesn't exist until the row does. Its failure
      // is reported as a shortfall rather than an error: everything the user
      // typed is already saved, and an error banner here would tell them to
      // retry a save that succeeded.
      try {
        if (photo.kind === "replace") {
          await api.setCollectionPhoto(collectionId, photo.sourcePath);
        } else if (photo.kind === "remove") {
          await api.clearCollectionPhoto(collectionId);
        }
      } catch (photoErr) {
        onSaved(
          `${message} The photo couldn't be ${
            photo.kind === "remove" ? "removed" : "attached"
          } — ${String(photoErr)}`,
          true,
        );
        return;
      }
      onSaved(message);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  async function pickPhoto() {
    const picked = await openFileDialog({
      title: "Choose a photo",
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: PHOTO_EXTENSIONS }],
    });
    // The picker resolves to null when dismissed; `multiple: false` narrows
    // the union to a single path, but guard anyway rather than index into it.
    if (typeof picked !== "string") return;
    setPhoto({ kind: "replace", sourcePath: picked });
    // Nothing is copied until Save, so the preview has to read the file where
    // it sits — outside the app's asset scope. A refusal here costs only the
    // preview, so it stays silent and the pick still stands.
    try {
      await api.allowPhotoPreview(picked);
      setPreviewSrc(convertFileSrc(picked));
    } catch {
      setPreviewSrc(null);
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

          {/* Suggestions, not a closed set — same as Driver and Scale above.
              The registry's vocabulary is the right default, but this dialog
              exists for cars DCR doesn't list, and a promo or an import can
              carry a brand the registry has never catalogued. */}
          {(
            [
              ["oem", "OEM", "Action", options.oems],
              ["brand", "Brand", "RCCA", options.brands],
              ["make", "Make", "CWC", options.makes],
              ["finish", "Finish", "Elite", options.finishes],
              ["diecastType", "Type", "Stock Car", options.types],
            ] as const
          ).map(([key, label, placeholder, opts]) => (
            <Field key={key} label={label}>
              <input
                className="input"
                list={`${listId}-${key}`}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
                placeholder={placeholder}
              />
              <datalist id={`${listId}-${key}`}>
                {opts.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </Field>
          ))}

          <Field label="Production quantity">
            <input
              className="input"
              value={form.productionQty}
              onChange={(e) => set("productionQty", e.target.value)}
              inputMode="numeric"
              placeholder="2508"
            />
          </Field>
          <Field
            label="DIN"
            className="col-span-2"
            hint="Which copy of the run this one is — the number on the chassis or the card. Leave blank if it isn't numbered."
          >
            <input
              className="input"
              value={form.din}
              onChange={(e) => set("din", e.target.value)}
              inputMode="numeric"
              placeholder={
                form.productionQty.trim()
                  ? `1 of ${form.productionQty.trim()}`
                  : "1832"
              }
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
          <Field
            label="Image URL"
            hint={
              previewSrc
                ? "Not shown — your own photo takes precedence."
                : undefined
            }
          >
            <input
              className="input"
              value={form.imageUrl}
              onChange={(e) => set("imageUrl", e.target.value)}
              placeholder="https://…"
            />
          </Field>

          {/* A plain div, not a Field: the control is a button and an image,
              so wrapping it in the <label> Field renders would make clicking
              the preview trigger the button. */}
          <div className="col-span-2 space-y-1">
            <span className="text-xs text-fg-subtle">Photo</span>
            <div className="flex items-start gap-3">
              {previewSrc ? (
                <img
                  src={previewSrc}
                  alt="Attached photo"
                  className="h-24 w-24 rounded border border-border object-cover"
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded border border-dashed border-border text-xs text-fg-subtle">
                  No photo
                </div>
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void pickPhoto()}
                    disabled={saving}
                  >
                    {previewSrc ? "Choose a different photo…" : "Choose photo…"}
                  </button>
                  {previewSrc && (
                    <button
                      type="button"
                      className="link-danger text-sm"
                      onClick={() => {
                        setPhoto({ kind: "remove" });
                        setPreviewSrc(null);
                      }}
                      disabled={saving}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-fg-subtle">
                  Copied into the app, so moving or deleting the original
                  won&rsquo;t break it.
                </p>
              </div>
            </div>
          </div>

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
