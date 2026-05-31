import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "diecast-hunter.fontScale";

/** Base root font size in px that a scale of 1.0 maps to (Tailwind's default). */
const BASE_PX = 16;
const MIN_SCALE = 0.7;
const MAX_SCALE = 1.6;
const STEP = 0.1;

interface FontScaleContextValue {
  /** Multiplier applied to the base root font size (1.0 = 100%). */
  scale: number;
  /** Bump up one step, clamped to MAX_SCALE. */
  increase: () => void;
  /** Bump down one step, clamped to MIN_SCALE. */
  decrease: () => void;
  /** Back to 1.0. */
  reset: () => void;
  setScale: (s: number) => void;
}

const FontScaleContext = createContext<FontScaleContextValue | null>(null);

function clamp(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Round to one decimal so repeated steps don't drift (0.1 isn't exact in FP). */
function quantize(s: number): number {
  return Math.round(s * 10) / 10;
}

function readStoredScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) return clamp(parsed);
    }
  } catch {
    // localStorage can throw in private modes; harmless.
  }
  return 1.0;
}

function applyToDom(scale: number) {
  document.documentElement.style.fontSize = `${BASE_PX * scale}px`;
}

export function FontScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<number>(() => readStoredScale());

  useEffect(() => {
    applyToDom(scale);
    try {
      localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      // ignore
    }
  }, [scale]);

  const setScale = useCallback((s: number) => {
    setScaleState(clamp(quantize(s)));
  }, []);

  const increase = useCallback(() => {
    setScaleState((prev) => clamp(quantize(prev + STEP)));
  }, []);

  const decrease = useCallback(() => {
    setScaleState((prev) => clamp(quantize(prev - STEP)));
  }, []);

  const reset = useCallback(() => setScaleState(1.0), []);

  // Keyboard shortcuts: Ctrl+Shift++ / Ctrl+Shift+- to resize, Ctrl+0 to reset.
  // Match on event.code so it's layout-independent — the "+" key is Shift+Equal,
  // so the produced character ("+"/"_") is unreliable, but the physical key isn't.
  // Reset deliberately does NOT require Shift: Windows reserves Ctrl+Shift+0 for
  // IME / keyboard-layout switching, so that combo never reaches the webview.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        reset();
        return;
      }

      if (!e.shiftKey) return;
      switch (e.code) {
        case "Equal":
        case "NumpadAdd":
          e.preventDefault();
          increase();
          break;
        case "Minus":
        case "NumpadSubtract":
          e.preventDefault();
          decrease();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [increase, decrease, reset]);

  const value = useMemo<FontScaleContextValue>(
    () => ({ scale, increase, decrease, reset, setScale }),
    [scale, increase, decrease, reset, setScale],
  );

  return (
    <FontScaleContext.Provider value={value}>
      {children}
    </FontScaleContext.Provider>
  );
}

export function useFontScale(): FontScaleContextValue {
  const ctx = useContext(FontScaleContext);
  if (!ctx) throw new Error("useFontScale must be used inside FontScaleProvider");
  return ctx;
}
