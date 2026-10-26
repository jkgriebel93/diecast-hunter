import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  describeExport,
  exportFormatOption,
  exportSaveOptions,
} from "./exportFormat";

describe("EXPORT_FORMATS", () => {
  it("offers HTML, CSV and JSON, HTML first", () => {
    expect(EXPORT_FORMATS.map((f) => f.value)).toEqual(["html", "csv", "json"]);
  });

  it("says that the data formats carry image URLs, not images", () => {
    // The one thing a user picking CSV or JSON over HTML needs to know.
    for (const f of EXPORT_FORMATS.filter((f) => f.value !== "html")) {
      expect(f.description.toLowerCase()).toContain("image url");
    }
  });
});

describe("exportSaveOptions", () => {
  it("names the file for the format and filters the dialog to it", () => {
    expect(exportSaveOptions("Export wishlist", "my-list", "json")).toEqual({
      title: "Export wishlist",
      defaultPath: "my-list.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(exportSaveOptions("Export", "x", "html").defaultPath).toBe("x.html");
    expect(exportSaveOptions("Export", "x", "csv").filters).toEqual([
      { name: "CSV", extensions: ["csv"] },
    ]);
  });

  it("rejects a format the menu doesn't offer", () => {
    expect(() => exportFormatOption("pdf" as unknown as "html")).toThrowError(
      /unknown export format/,
    );
  });
});

describe("describeExport", () => {
  const noun = { one: "entry", many: "entries" };

  it("counts with the caller's noun and ends with a full stop", () => {
    expect(
      describeExport(
        { entries: 1, path: "C:\\out.csv", images_failed: 0 },
        noun,
      ),
    ).toBe("Exported 1 entry to C:\\out.csv.");
    expect(
      describeExport(
        { entries: 1200, path: "/tmp/a.json", images_failed: 0 },
        noun,
      ),
    ).toBe("Exported 1,200 entries to /tmp/a.json.");
  });

  it("mentions failed image downloads only when there were any", () => {
    expect(
      describeExport({ entries: 3, path: "p.html", images_failed: 1 }, noun),
    ).toBe("Exported 3 entries to p.html (1 image could not be downloaded).");
    expect(
      describeExport({ entries: 3, path: "p.html", images_failed: 2 }, noun),
    ).toBe("Exported 3 entries to p.html (2 images could not be downloaded).");
  });
});
