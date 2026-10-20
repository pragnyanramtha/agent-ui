/** A single key hint on a button ("↵", "Esc", "A", "1"). Mouse and trackpad devices only. */
export function KeyCap({ children, onFill = false, className = "" }: { children: React.ReactNode; onFill?: boolean; className?: string }) {
  return (
    <kbd aria-hidden className={`kbd hidden h-4.5 min-w-4.5 shrink-0 px-1 pointer-fine:inline-flex ${onFill ? "bg-white/15 text-current shadow-none" : ""} ${className}`}>
      {children}
    </kbd>
  );
}
