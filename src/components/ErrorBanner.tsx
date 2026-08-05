import { describeError } from "@/lib/errors";

/** The one place errors get rendered. Leads with a plain-language line and
 *  the fix; the original backend string stays one click away in a
 *  disclosure rather than being dumped on the page.
 *
 *  `card` is the page-level banner; `inline` is the compact form for
 *  dialogs and side panels. */
export function ErrorBanner({
  error,
  variant = "card",
  className = "",
}: {
  error: unknown;
  variant?: "card" | "inline";
  className?: string;
}) {
  if (error === null || error === undefined || error === "") return null;
  const { title, hint, detail } = describeError(error);

  if (variant === "inline") {
    return (
      <div className={`text-xs ${className}`}>
        <div className="text-red-400">{title}</div>
        {hint && <div className="text-fg-subtle mt-0.5">{hint}</div>}
        {detail && <TechnicalDetails detail={detail} />}
      </div>
    );
  }

  return (
    <div className={`card border-red-500/40 text-sm ${className}`} role="alert">
      <div className="text-red-300">{title}</div>
      {hint && <div className="text-fg-muted mt-1">{hint}</div>}
      {detail && <TechnicalDetails detail={detail} />}
    </div>
  );
}

function TechnicalDetails({ detail }: { detail: string }) {
  return (
    <details className="mt-1.5 group">
      <summary className="text-[11px] text-fg-subtle cursor-pointer select-none hover:text-fg-muted marker:text-fg-subtle">
        Technical details
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-elevated p-2 text-[11px] leading-relaxed text-fg-subtle">
        {detail}
      </pre>
    </details>
  );
}
