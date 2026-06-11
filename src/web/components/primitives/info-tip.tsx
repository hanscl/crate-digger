import { useId, useState } from "react";
import { clsx } from "clsx";

/**
 * InfoTip — a small (i) affordance that reveals a layman's explanation of an
 * adjacent control on hover OR keyboard focus. Built to slot next to the
 * `Knob` / `Fader` labels, so it stays visually quiet (tertiary ink, accent on
 * interaction) and respects the Cyan Tape tokens.
 *
 * Accessibility:
 *   - The trigger is a real `<button>` so it is keyboard-focusable and the tip
 *     opens on focus, not only pointer hover.
 *   - The tip text carries a stable id wired to `aria-describedby` on the
 *     trigger, so assistive tech announces the explanation when the (i) is
 *     reached.
 *   - The tip itself is `role="tooltip"` and `aria-hidden` while collapsed.
 */

export type InfoTipProps = {
  /** Plain-language explanation of the adjacent control. */
  text: string;
  /** Accessible name for the trigger; defaults to a generic "more info". */
  label?: string;
};

export function InfoTip({ text, label = "more info" }: InfoTipProps) {
  const id = useId();
  const tipId = `${id}-tip`;
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={clsx(
          "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full",
          "border border-line text-ink-3 leading-none",
          "text-[9px] font-mono select-none cursor-help",
          "transition-colors hover:text-accent hover:border-accent/40",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        )}
      >
        i
      </button>
      <span
        id={tipId}
        role="tooltip"
        aria-hidden={!open}
        className={clsx(
          "absolute left-1/2 bottom-full z-20 mb-2 -translate-x-1/2",
          // Invisible bridge across the mb-2 gap so sliding the cursor from the
          // trigger onto the tip never crosses a dead-zone that would fire the
          // wrapper's onMouseLeave and close the tip mid-transit.
          "before:absolute before:inset-x-0 before:top-full before:h-2 before:content-['']",
          "w-52 rounded-2 border border-line-strong bg-bg-3 px-3 py-2",
          "text-left text-xs leading-snug text-ink-2 normal-case tracking-normal font-sans",
          "shadow-[var(--shadow-2)] transition-opacity duration-100",
          // While collapsed the tip is invisible and inert (matches aria-hidden);
          // while open it captures pointer events so the cursor can rest on it.
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {text}
      </span>
    </span>
  );
}
