/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0d10",
          panel: "#13171c",
          elevated: "#1a1f25",
        },
        border: {
          DEFAULT: "#262c34",
        },
        accent: {
          DEFAULT: "#3b82f6",
          hover: "#2563eb",
        },
      },
    },
  },
  plugins: [],
};
