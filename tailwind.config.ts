import type { Config } from "tailwindcss";

export default {
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SF Mono", "monospace"],
      },
      colors: {
        bg: {
          0: "var(--bg-0)",
          1: "var(--bg-1)",
          2: "var(--bg-2)",
          3: "var(--bg-3)",
          4: "var(--bg-4)",
        },
        ink: {
          1: "var(--ink-1)",
          2: "var(--ink-2)",
          3: "var(--ink-3)",
          4: "var(--ink-4)",
          5: "var(--ink-5)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          dim: "var(--accent-dim)",
        },
        keep: "var(--keep)",
        skip: "var(--skip)",
        pass: "var(--pass)",
        warn: "var(--warn)",
        bad: "var(--bad)",
        b1: "var(--b1)",
        b2: "var(--b2)",
        b3: "var(--b3)",
        b4: "var(--b4)",
        b5: "var(--b5)",
        b6: "var(--b6)",
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
        },
      },
      borderRadius: {
        "1": "var(--r-1)",
        "2": "var(--r-2)",
        "3": "var(--r-3)",
        "4": "var(--r-4)",
      },
    },
  },
  plugins: [],
} satisfies Config;
