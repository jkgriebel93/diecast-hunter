/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Tailwind's default z scale stops at 50, which is why the pre-DCH-32
      // nested dialogs reached for the arbitrary `z-[60]`. Naming it makes
      // the documented stacking order (30 scrim / 40 menu / 50 modal /
      // 60 modal-over-modal, see CLAUDE.md) expressible as real classes, so
      // the convention test can grep for it.
      zIndex: {
        60: "60",
      },
      colors: {
        bg: {
          DEFAULT: "rgb(var(--color-bg) / <alpha-value>)",
          panel: "rgb(var(--color-bg-panel) / <alpha-value>)",
          elevated: "rgb(var(--color-bg-elevated) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--color-border) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--color-accent) / <alpha-value>)",
          hover: "rgb(var(--color-accent-hover) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--color-danger) / <alpha-value>)",
          hover: "rgb(var(--color-danger-hover) / <alpha-value>)",
          fg: "rgb(var(--color-danger-fg) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "rgb(var(--color-fg) / <alpha-value>)",
          muted: "rgb(var(--color-fg-muted) / <alpha-value>)",
          subtle: "rgb(var(--color-fg-subtle) / <alpha-value>)",
          faint: "rgb(var(--color-fg-faint) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
