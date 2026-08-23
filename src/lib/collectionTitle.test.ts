// The pure half of DCH-65: composing the entry title out of what DCR
// actually gives us. What matters here is the anchoring — the "#N" prefix
// and the year are the only tokens that let scheme_text fall apart into
// sponsor/scheme and model — and that every field is genuinely optional,
// because stubs, manual entries and half-enriched rows all render through
// the same builder.
import { describe, expect, it } from "vitest";
import { collectionTitle, type TitleView } from "./collectionTitle";

function view(overrides: Partial<TitleView>): TitleView {
  return {
    driver_name: null,
    car_number: null,
    year: null,
    scheme_text: null,
    brand: null,
    finish: null,
    ...overrides,
  };
}

describe("collectionTitle", () => {
  it("composes the full format from an enriched garage row", () => {
    expect(
      collectionTitle(
        view({
          driver_name: "Jeff Gordon",
          car_number: "24",
          year: 2002,
          scheme_text: "#24 Pepsi Daytona 2002 Chevy Monte Carlo",
          brand: "Elite",
          finish: "Color Chrome",
        }),
      ),
    ).toBe(
      "Jeff Gordon #24 2002 Pepsi Daytona Chevy Monte Carlo Elite Color Chrome",
    );
  });

  it("takes the car number off the scheme prefix before enrichment", () => {
    // car_number is a detail-page fact, so a stub row hasn't got the column.
    expect(
      collectionTitle(
        view({
          driver_name: "Terry Labonte",
          year: 1998,
          scheme_text: "#5 Kellogg's Corn Flakes 1998 Chevy Monte Carlo",
        }),
      ),
    ).toBe("Terry Labonte #5 1998 Kellogg's Corn Flakes Chevy Monte Carlo");
  });

  it("prefers the car_number column over the scheme prefix", () => {
    expect(
      collectionTitle(
        view({
          car_number: "24",
          scheme_text: "#00 DuPont 2001 Chevy",
          year: 2001,
        }),
      ),
    ).toBe("#24 2001 DuPont Chevy");
  });

  it("passes a manual entry's free-text scheme through whole", () => {
    // No "#N", no year token — nothing to anchor on, nothing invented.
    expect(
      collectionTitle(
        view({
          driver_name: "Dale Earnhardt",
          scheme_text: "Goodwrench tribute car",
        }),
      ),
    ).toBe("Dale Earnhardt Goodwrench tribute car");
  });

  it("splits on a year-shaped token when the column year is absent", () => {
    expect(
      collectionTitle(
        view({ scheme_text: "#3 Wrangler 1984 Chevy Monte Carlo" }),
      ),
    ).toBe("#3 1984 Wrangler Chevy Monte Carlo");
  });

  it("still shows the column year when the scheme has no year to split on", () => {
    expect(
      collectionTitle(
        view({ driver_name: "Bill Elliott", year: 1985, scheme_text: "Coors" }),
      ),
    ).toBe("Bill Elliott 1985 Coors");
  });

  it("drops the (Standard) finish and keeps a real one", () => {
    const base = {
      driver_name: "Jeff Gordon",
      year: 2002,
      scheme_text: "#24 Pepsi Daytona 2002 Chevy Monte Carlo",
    };
    expect(collectionTitle(view({ ...base, finish: "(Standard)" }))).toBe(
      "Jeff Gordon #24 2002 Pepsi Daytona Chevy Monte Carlo",
    );
    expect(collectionTitle(view({ ...base, finish: "Color Chrome" }))).toBe(
      "Jeff Gordon #24 2002 Pepsi Daytona Chevy Monte Carlo Color Chrome",
    );
  });

  it("doesn't repeat a special the scheme text already carries", () => {
    expect(
      collectionTitle(
        view({
          year: 2001,
          scheme_text: "#24 DuPont Elite 2001 Chevy Monte Carlo",
          brand: "Elite",
        }),
      ),
    ).toBe("#24 2001 DuPont Elite Chevy Monte Carlo");
  });

  it("doesn't repeat a finish identical to the brand", () => {
    // DCR's Elite line shows up as both the brand and the finish on some
    // entries; one "Elite" in the title is plenty.
    expect(
      collectionTitle(
        view({
          year: 2016,
          scheme_text: "#6 Valvoline 2016 Chevy SS",
          brand: "Elite",
          finish: "Elite",
        }),
      ),
    ).toBe("#6 2016 Valvoline Chevy SS Elite");
  });

  it("renders what exists when the scheme is missing entirely", () => {
    expect(
      collectionTitle(
        view({ driver_name: "Jeff Gordon", car_number: "24", year: 2002 }),
      ),
    ).toBe("Jeff Gordon #24 2002");
  });

  it("returns the empty string for an empty row", () => {
    expect(collectionTitle(view({}))).toBe("");
  });
});
