// The Collection entry title (DCH-65):
//   <Driver> #<Car No.> <Year> <Sponsor/Scheme> <Car Model> <Special Attrs>
// e.g. "Jeff Gordon #24 2002 Pepsi Daytona Chevy Monte Carlo Elite Color Chrome".
//
// DCR gives us no discrete sponsor, paint-scheme or car-model fields — all
// three are fused into `scheme_text` ("#24 Pepsi Daytona 2002 Chevy Monte
// Carlo"), and the `make` column is a code ("CWC"), not display text. So the
// builder splits `scheme_text` on the tokens we can anchor: the leading "#N"
// (car number) and the year. What's left of the year is the sponsor plus the
// paint-scheme name, what's right of it is the model. Sponsor and scheme name
// can't be told apart, so they render as one segment — the ticket's
// "<Sponsor> <Model> <Scheme>" ordering becomes "<Sponsor/Scheme> <Model>".
//
// Every part is optional: a pre-enrichment stub has no `car_number` column
// (the scheme prefix stands in), a manual entry's scheme is free text with
// no "#N" or year to anchor on (it passes through whole), and a row with
// nothing at all yields "" for the caller to substitute a placeholder.

/** The fields the title reads. Structural subset of `CollectionRow`, so
 *  tests don't have to build full rows. */
export interface TitleView {
  driver_name: string | null;
  car_number: string | null;
  year: number | null;
  scheme_text: string | null;
  brand: string | null;
  finish: string | null;
}

const YEAR_RE = /\b(?:19|20)\d{2}\b/;

/** "(Standard)" / "Standard" is DCR's none-value for finish, not an
 *  attribute worth a slot in the title. */
function isStandardFinish(finish: string): boolean {
  return (
    finish
      .replace(/^\(|\)$/g, "")
      .trim()
      .toLowerCase() === "standard"
  );
}

export function collectionTitle(item: TitleView): string {
  let rest = item.scheme_text?.trim() ?? "";

  // Leading "#24 " — the car number as the garage scheme line carries it.
  let schemeNumber: string | null = null;
  const numMatch = /^#(\S+)\s*/.exec(rest);
  if (numMatch) {
    schemeNumber = numMatch[1];
    rest = rest.slice(numMatch[0].length);
  }

  // Split the remainder at the year: left is sponsor + paint scheme, right
  // is the car model. The column year anchors when it appears in the text;
  // otherwise any year-shaped token does (a manual entry's column year
  // needn't be the one typed into the scheme).
  let sponsorScheme = rest;
  let model = "";
  let schemeYear: string | null = null;
  const columnYear = item.year != null ? String(item.year) : null;
  const yearMatch =
    columnYear !== null && new RegExp(`\\b${columnYear}\\b`).test(rest)
      ? new RegExp(`\\b${columnYear}\\b`).exec(rest)
      : YEAR_RE.exec(rest);
  if (yearMatch) {
    schemeYear = yearMatch[0];
    sponsorScheme = rest.slice(0, yearMatch.index).trim();
    model = rest.slice(yearMatch.index + schemeYear.length).trim();
  }

  // Brand ("Elite", "ARC") and a real finish ("Color Chrome") are the
  // special attributes; skip one that already reads out of the scheme text.
  const restLower = `${sponsorScheme} ${model}`.toLowerCase();
  const specials: string[] = [];
  for (const s of [
    item.brand,
    item.finish != null && !isStandardFinish(item.finish) ? item.finish : null,
  ]) {
    const trimmed = s?.trim();
    if (
      trimmed &&
      !restLower.includes(trimmed.toLowerCase()) &&
      !specials.some((seen) => seen.toLowerCase() === trimmed.toLowerCase())
    ) {
      specials.push(trimmed);
    }
  }

  const number = item.car_number ?? schemeNumber;
  const year = columnYear ?? schemeYear;

  return [
    item.driver_name,
    number && `#${number}`,
    year,
    sponsorScheme,
    model,
    ...specials,
  ]
    .filter((p): p is string => !!p && p !== "")
    .join(" ");
}
