import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted p-0.5 transition-colors duration-(--motion-fast) outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary data-checked:bg-primary dark:bg-input/40 dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 translate-x-0 rounded-full bg-background shadow-xs transition-transform duration-(--motion-fast) data-checked:translate-x-4 data-checked:bg-primary-foreground dark:bg-foreground dark:data-checked:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
