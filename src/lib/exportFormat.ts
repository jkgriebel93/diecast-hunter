import { formatCount } from "./format";

/**
 * The three file formats every export offers (Registry results, a wishlist,
 * the Collection). Wire values: the Rust side deserializes these strings
 * into `export::ExportFormat`.
 *
 * HTML is the print-friendly document with images embedded. CSV and JSON
 * are data exports of the same rows; they carry each image's URL instead of
 * its bytes, so they write instantly and never fail on a download.
 */
export type ExportFormat = "html" | "csv" | "json";

export interface ExportFormatOption {
  value: ExportFormat;
  /** Menu label. */
  label: string;
  /** One line under the label saying what the file is good for. */
  description: string;
  /** File extension without the dot; also the save-dialog filter. */
  extension: string;
  /** Save-dialog filter name. */
  filterName: string;
}

/** Menu order: the format the app has always offered first. */
export const EXPORT_FORMATS: readonly ExportFormatOption[] = [
  {
    value: "html",
    label: "HTML (print-friendly)",
    description: "Images embedded; open in a browser to print.",
    extension: "html",
    filterName: "HTML",
  },
  {
    value: "csv",
    label: "CSV spreadsheet",
    description: "One row per item, with image URLs. Opens in Excel or Sheets.",
    extension: "csv",
    filterName: "CSV",
  },
  {
    value: "json",
    label: "JSON",
    description:
      "Structured data with image URLs, for scripts and other tools.",
    extension: "json",
    filterName: "JSON",
  },
];

export function exportFormatOption(format: ExportFormat): ExportFormatOption {
  const option = EXPORT_FORMATS.find((f) => f.value === format);
  if (!option) throw new Error(`unknown export format: ${format}`);
  return option;
}

/**
 * Options for the save dialog: `<baseName>.<ext>` as the suggested name and
 * a single filter for the chosen format, so the dialog can't quietly save
 * a JSON export under `.html`.
 */
export function exportSaveOptions(
  title: string,
  baseName: string,
  format: ExportFormat,
): {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
} {
  const { extension, filterName } = exportFormatOption(format);
  return {
    title,
    defaultPath: `${baseName}.${extension}`,
    filters: [{ name: filterName, extensions: [extension] }],
  };
}

/**
 * The success sentence after an export: what was written and where, plus
 * how many images couldn't be downloaded when that happened. Callers append
 * their own "opening in your browser" sentence when they open the file.
 */
export function describeExport(
  summary: { entries: number; path: string; images_failed: number },
  noun: { one: string; many: string },
): string {
  const count =
    summary.entries === 1
      ? `1 ${noun.one}`
      : `${formatCount(summary.entries)} ${noun.many}`;
  const failed =
    summary.images_failed > 0
      ? ` (${summary.images_failed === 1 ? "1 image" : `${formatCount(summary.images_failed)} images`} could not be downloaded).`
      : ".";
  return `Exported ${count} to ${summary.path}${failed}`;
}
