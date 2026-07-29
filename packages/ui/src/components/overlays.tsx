import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";
import { useControllableState } from "../lib/use-controllable-state";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

interface OverlayPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  dismissible?: boolean;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  kind: "dialog" | "drawer";
  side?: "left" | "right";
}

function OverlayPanel({
  children,
  className,
  closeLabel = "关闭",
  description,
  dismissible = true,
  footer,
  initialFocusRef,
  kind,
  onOpenChange,
  open,
  side = "right",
  title,
}: OverlayPanelProps): ReactNode {
  const titleId = `${kind}-${useId()}-title`;
  const descriptionId = `${kind}-${useId()}-description`;
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const overlay = panelRef.current?.parentElement;
    const backgroundElements = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
    );
    const backgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    backgroundElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    const focusFrame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const content = panel?.querySelector<HTMLElement>(".ink-overlay__content");
      const panelFocusable = panel === null ? [] : focusableElements(panel);
      const firstFocusable =
        content === null || content === undefined
          ? panelFocusable[0]
          : (focusableElements(content)[0] ?? panelFocusable[0]);
      (initialFocusRef?.current ?? firstFocusable ?? panel)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      backgroundState.forEach(({ ariaHidden, element, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", ariaHidden);
        }
      });
      previouslyFocusedRef.current?.focus();
    };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }

      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onOpenChange(false);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissible, onOpenChange, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={cn("ink-overlay", `ink-overlay--${kind}`)}
      data-side={kind === "drawer" ? side : undefined}
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onOpenChange(false);
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        className={cn("ink-overlay__panel", className)}
        tabIndex={-1}
      >
        <header className="ink-overlay__header">
          <div className="ink-overlay__heading">
            <h2 id={titleId} className="ink-overlay__title">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="ink-overlay__description">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              className="ink-overlay__close"
              aria-label={closeLabel}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </header>
        <div className="ink-overlay__content">{children}</div>
        {footer !== undefined && <footer className="ink-overlay__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export type DialogProps = Omit<OverlayPanelProps, "kind" | "side">;

export function Dialog(props: DialogProps): ReactNode {
  return <OverlayPanel {...props} kind="dialog" />;
}

export type DrawerProps = Omit<OverlayPanelProps, "kind"> & {
  side?: "left" | "right";
};

export function Drawer(props: DrawerProps): ReactNode {
  return <OverlayPanel {...props} kind="drawer" />;
}

export interface DropdownMenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
}

export type DropdownMenuProps = HTMLAttributes<HTMLDivElement> & {
  trigger: ReactNode;
  triggerLabel: string;
  items: readonly DropdownMenuItem[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  menuLabel?: string;
  align?: "start" | "end";
};

export const DropdownMenu = forwardRef<HTMLDivElement, DropdownMenuProps>(function DropdownMenu(
  {
    align = "start",
    className,
    defaultOpen = false,
    items,
    menuLabel = "操作菜单",
    onOpenChange,
    open: controlledOpen,
    trigger,
    triggerLabel,
    ...props
  },
  ref,
) {
  const menuId = `ink-menu-${useId()}`;
  const [open, setOpen] = useControllableState({
    value: controlledOpen,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (open) {
      itemRefs.current.find((item) => item !== null && !item.disabled)?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open, setOpen]);

  function focusItem(position: "first" | "last" | "next" | "previous"): void {
    const enabledItems = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    if (enabledItems.length === 0) {
      return;
    }

    const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = 0;

    if (position === "last") {
      nextIndex = enabledItems.length - 1;
    } else if (position === "next") {
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else if (position === "previous") {
      nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    }

    enabledItems[nextIndex]?.focus();
  }

  return (
    <div
      {...props}
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref !== null) {
          ref.current = node;
        }
      }}
      className={cn("ink-dropdown", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ink-dropdown__trigger"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className="ink-dropdown__content"
          data-align={align}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              focusItem("next");
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusItem("previous");
            } else if (event.key === "Home") {
              event.preventDefault();
              focusItem("first");
            } else if (event.key === "End") {
              event.preventDefault();
              focusItem("last");
            }
          }}
        >
          {items.map((item, index) => (
            <div key={item.id}>
              {item.separatorBefore && <div className="ink-dropdown__separator" role="separator" />}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                aria-disabled={item.disabled === true ? true : undefined}
                className="ink-dropdown__item"
                data-danger={item.danger === true ? true : undefined}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                {item.checked !== undefined && (
                  <span className="ink-dropdown__check" aria-hidden="true">
                    {item.checked ? "✓" : ""}
                  </span>
                )}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export interface TooltipTriggerProps {
  "aria-describedby"?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export interface TooltipProps {
  children: (props: TooltipTriggerProps) => ReactNode;
  content: ReactNode;
  delay?: number;
  className?: string;
}

export function Tooltip({ children, className, content, delay = 500 }: TooltipProps): ReactNode {
  const id = `ink-tooltip-${useId()}`;
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function show(): void {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  }

  function hide(): void {
    clearTimeout(timerRef.current);
    setVisible(false);
  }

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
    },
    [],
  );

  const triggerProps: TooltipTriggerProps = {
    ...(visible ? { "aria-describedby": id } : {}),
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  };

  return (
    <span className="ink-tooltip-anchor">
      {/* Event callbacks read the timer ref only after interaction, never during render. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children(triggerProps)}
      {visible && (
        <span id={id} role="tooltip" className={cn("ink-tooltip", className)}>
          {content}
        </span>
      )}
    </span>
  );
}
