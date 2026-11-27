import type * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

type SelectItem<Value extends string> = {
  value: Value;
  label: React.ReactNode;
  disabled?: boolean;
};

type SelectProps<Value extends string> = Omit<
  SelectPrimitive.Trigger.Props,
  "value" | "children" | "disabled"
> & {
  items: readonly SelectItem<Value>[];
  value: Value | null;
  onValueChange: (value: Value) => void;
  placeholder?: React.ReactNode;
  disabled?: boolean;
  size?: "sm" | "default";
};

function Select<Value extends string>({
  items,
  value,
  onValueChange,
  placeholder,
  disabled,
  size = "default",
  className,
  ...props
}: SelectProps<Value>) {
  return (
    <SelectPrimitive.Root
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        data-size={size}
        className={cn(
          "flex h-8 w-fit min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-1 pr-2 pl-2.5 text-left text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-placeholder:text-muted-foreground data-popup-open:border-ring data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-[size=sm]:py-0.5 dark:bg-input/30 dark:hover:bg-input/50",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Value
          data-slot="select-value"
          className="min-w-0 flex-1 truncate"
          placeholder={placeholder}
        />
        <SelectPrimitive.Icon
          data-slot="select-icon"
          className="flex shrink-0 text-muted-foreground"
        >
          <ChevronDownIcon className="size-4" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          sideOffset={4}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className="max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-popover ring-1 ring-border duration-(--motion-fast) outline-none motion-safe:data-open:animate-in motion-safe:data-open:fade-in-0 motion-safe:data-open:zoom-in-95 motion-safe:data-closed:animate-out motion-safe:data-closed:fade-out-0 motion-safe:data-closed:zoom-out-95"
          >
            {items.map((item) => (
              <SelectPrimitive.Item
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                data-slot="select-item"
                className="relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm leading-tight outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                <SelectPrimitive.ItemText className="truncate">
                  {item.label}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select, type SelectItem };
