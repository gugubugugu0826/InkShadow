import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";

import { cn } from "../lib/cn";
import { useControllableState } from "../lib/use-controllable-state";

type TabsOrientation = "horizontal" | "vertical";

interface TabsContextValue {
  baseId: string;
  orientation: TabsOrientation;
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);

  if (context === null) {
    throw new Error(`${component} must be used inside Tabs.`);
  }

  return context;
}

function valueId(baseId: string, part: "tab" | "panel", value: string): string {
  return `${baseId}-${part}-${encodeURIComponent(value)}`;
}

export type TabsProps = HTMLAttributes<HTMLDivElement> & {
  value?: string;
  defaultValue: string;
  onValueChange?: (value: string) => void;
  orientation?: TabsOrientation;
};

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { className, defaultValue, onValueChange, orientation = "horizontal", value, ...props },
  ref,
) {
  const baseId = `ink-tabs-${useId()}`;
  const [selectedValue, setSelectedValue] = useControllableState({
    value,
    defaultValue,
    onChange: onValueChange,
  });

  return (
    <TabsContext.Provider
      value={{
        baseId,
        orientation,
        value: selectedValue,
        setValue: setSelectedValue,
      }}
    >
      <div
        {...props}
        ref={ref}
        className={cn("ink-tabs", className)}
        data-orientation={orientation}
      />
    </TabsContext.Provider>
  );
});

export type TabsListProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
};

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, label, ...props },
  ref,
) {
  const { orientation } = useTabsContext("TabsList");

  return (
    <div
      {...props}
      ref={ref}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={cn("ink-tabs__list", className)}
    />
  );
});

export type TabsTriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
  value: string;
};

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { className, disabled, onClick, onKeyDown, value, ...props },
  ref,
) {
  const context = useTabsContext("TabsTrigger");
  const selected = context.value === value;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }

    const list = event.currentTarget.closest('[role="tablist"]');
    const enabledTabs = Array.from(
      list?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [],
    );
    const currentIndex = enabledTabs.indexOf(event.currentTarget);
    const previousKey = context.orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const nextKey = context.orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    let nextIndex: number | undefined;

    if (event.key === previousKey) {
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
    } else if (event.key === nextKey) {
      nextIndex = (currentIndex + 1) % enabledTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabledTabs.length - 1;
    }

    if (nextIndex === undefined || enabledTabs.length === 0) {
      return;
    }

    event.preventDefault();
    enabledTabs[nextIndex]?.focus();
    enabledTabs[nextIndex]?.click();
  }

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      id={valueId(context.baseId, "tab", value)}
      role="tab"
      className={cn("ink-tabs__trigger", className)}
      aria-controls={valueId(context.baseId, "panel", value)}
      aria-selected={selected}
      data-state={selected ? "active" : "inactive"}
      disabled={disabled}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          context.setValue(value);
        }
      }}
      onKeyDown={handleKeyDown}
    />
  );
});

export type TabsContentProps = HTMLAttributes<HTMLDivElement> & {
  value: string;
};

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(function TabsContent(
  { className, value, ...props },
  ref,
) {
  const context = useTabsContext("TabsContent");
  const selected = context.value === value;

  return (
    <div
      {...props}
      ref={ref}
      id={valueId(context.baseId, "panel", value)}
      role="tabpanel"
      className={cn("ink-tabs__content", className)}
      aria-labelledby={valueId(context.baseId, "tab", value)}
      data-state={selected ? "active" : "inactive"}
      hidden={!selected}
      tabIndex={0}
    />
  );
});
