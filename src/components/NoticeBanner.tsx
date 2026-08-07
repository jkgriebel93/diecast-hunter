import { ReactNode } from "react";

/** Messages the app writes about itself (DCH-36).
 *
 *  `ErrorBanner` runs everything through `describeError`, which is built to
 *  classify Rust `AppError` strings. Hand it a sentence *we* wrote and no
 *  prefix matches, so it falls through to "Something went wrong." with the
 *  real text collapsed into a disclosure. Two watch actions hit that: the
 *  eBay side had **succeeded** and the user was told the opposite, with the
 *  truth one click away.
 *
 *  So there are three channels, and the rule for picking one is about where
 *  the words came from, not how bad the news is:
 *
 *  - **A value thrown by the backend** → `ErrorBanner`. It needs
 *    translating, and its raw form belongs behind the disclosure.
 *  - **A sentence we wrote, where the action worked** → `NoticeBanner`
 *    `tone="success"`.
 *  - **A sentence we wrote, where the action worked but something was
 *    skipped** → `NoticeBanner` `tone="warning"`. Not an error: nothing
 *    failed, and colouring it red tells the user to undo something that
 *    actually went through.
 *
 *  Authored text is never re-titled and never collapsed — we already wrote
 *  it for a person, so there is nothing to translate and nothing to hide.
 */
export type NoticeTone = "success" | "warning";

const TONE: Record<NoticeTone, { text: string; card: string }> = {
  success: {
    text: "text-emerald-400",
    card: "border-emerald-500/40 bg-emerald-500/10",
  },
  // Colours resolve `--color-warning-*`, which differ per theme: the amber
  // used elsewhere was picked against the dark page and has no light-mode
  // override, so it washes out on white.
  warning: {
    text: "text-warning-fg",
    card: "border-warning/40 bg-warning/10",
  },
};

export function NoticeBanner({
  message,
  tone = "success",
  variant = "card",
  className = "",
}: {
  /** Already written for a person. Rendered verbatim. */
  message: ReactNode;
  tone?: NoticeTone;
  /** `card` is the page-level banner; `inline` is the compact form, matching
   *  `ErrorBanner`'s two shapes so the three channels sit at the same
   *  weight on a page. */
  variant?: "card" | "inline";
  className?: string;
}) {
  if (message === null || message === undefined || message === "") return null;
  const tones = TONE[tone];

  if (variant === "inline") {
    return (
      <div className={`text-xs ${tones.text} ${className}`} role="status">
        {message}
      </div>
    );
  }

  return (
    <div
      className={`card text-sm ${tones.card} ${className}`}
      // status, not alert: an alert interrupts a screen reader, and none of
      // these need interrupting — the action already completed.
      role="status"
    >
      <div className={tones.text}>{message}</div>
    </div>
  );
}
