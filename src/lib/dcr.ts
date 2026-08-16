/**
 * Origin of diecastregistry.com.
 *
 * DCR stores site-relative paths — `detail_url` for a car's page, `image_url`
 * for its thumbnail — so anything we hand to a browser or an `<img>` needs
 * this in front. Collection, Registry, Wishlist and Listings each declared
 * their own copy; one constant means a change of host can't land on some of
 * the four.
 */
export const DCR_BASE = "https://www.diecastregistry.com";

/** Anything of the form `scheme:` — `https:`, but also the `asset:` /
 *  `http://asset.localhost` URLs `convertFileSrc` hands back for a photo the
 *  user attached, which must never be treated as a DCR path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turn a stored DCR reference into an absolute URL.
 *
 * Half a dozen call sites spelled this as `startsWith("http") ? p : DCR_BASE +
 * p`, which gets two cases wrong: a protocol-relative `//host/…` fails the
 * test and comes back as `https://www.diecastregistry.com//host/…`, and a
 * value that lost its leading slash silently concatenates onto the origin.
 * For a link that's a dead end the user can see; for an `<img>` it's a broken
 * picture indistinguishable from a missing one.
 */
export function resolveDcrUrl(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (HAS_SCHEME.test(trimmed)) return trimmed;
  return trimmed.startsWith("/")
    ? `${DCR_BASE}${trimmed}`
    : `${DCR_BASE}/${trimmed}`;
}
