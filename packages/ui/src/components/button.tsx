import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "ai-primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled = false,
    leadingIcon,
    loading = false,
    loadingLabel = "正在处理",
    size = "md",
    trailingIcon,
    type = "button",
    variant = "primary",
    ...props
  },
  ref,
) {
  const unavailable = disabled || loading;

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn("ink-button", `ink-button--${variant}`, `ink-button--${size}`, className)}
      disabled={unavailable}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
    >
      {loading ? (
        <span className="ink-spinner" aria-hidden="true" />
      ) : (
        leadingIcon && (
          <span className="ink-button__icon" aria-hidden="true">
            {leadingIcon}
          </span>
        )
      )}
      <span className="ink-button__label">{loading ? loadingLabel : children}</span>
      {!loading && trailingIcon && (
        <span className="ink-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, "children" | "leadingIcon" | "trailingIcon"> & {
  label: string;
  icon: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon, label, title, variant = "ghost", ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      className={cn("ink-icon-button", className)}
      aria-label={label}
      title={title ?? label}
    >
      <span className="ink-icon-button__icon" aria-hidden="true">
        {icon}
      </span>
    </Button>
  );
});
