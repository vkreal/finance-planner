/* Shared fold / collapse toggle chip for every fold control in
   the app (option B, picked 2026-10-25): a small circle
   outline containing a "+" sign when the section is closed and
   a "−" sign when it is open — the classic accordion look. Both
   signs are drawn as crisp inline SVG vector strokes, never
   font glyphs (raw glyphs were the original complaint). A sign
   swap does not rotate: the horizontal stroke is always present
   and the vertical stroke fades in / out for the + / − swap.
   The chip keeps the previous chevron chip's footprint (28px)
   and its subtle border / slightly-raised surface treatment, so
   no layout shifts. This component is purely visual
   (aria-hidden): the owning button keeps its accessible name,
   aria-expanded / aria-controls, and persisted fold state
   exactly as before. Two usages share it: inside a full-width
   header button (Roth / Playground sections), and inside the
   small standalone toggle buttons in the Spending section
   headers and the Playground "Start from a known point"
   header, whose 36px button box is the comfortable tap target
   around this 28px chip. Swapping back to the chevron (option
   A) is a one-file edit here — every call site is unchanged. */
export function FoldChevron({
  open,
  className = "",
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--dim)] ${className}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3.5 8H12.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M8 3.5V12.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="transition-opacity duration-200 ease-out motion-reduce:transition-none"
          style={{ opacity: open ? 0 : 1 }}
        />
      </svg>
    </span>
  );
}
