import { cn } from "@/lib/utils"

/** A thin ring that turns; slows to a still ring under reduced motion. */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label="Loading…"
      className={cn("inline-block size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-70 motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Spinner }
