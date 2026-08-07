import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  surface?: "dark" | "light" | "inherit";
  selected?: boolean;
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, selected = false, surface = "inherit", ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn("ink-card", className)}
      data-selected={selected || undefined}
      data-surface={surface === "inherit" ? undefined : surface}
    />
  );
});

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ink-card__header", className)} />;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type CardTitleProps = HTMLAttributes<HTMLHeadingElement> & {
  headingLevel?: HeadingLevel;
};

export function CardTitle({ children, className, headingLevel = 3, ...props }: CardTitleProps) {
  return createElement(
    `h${String(headingLevel)}`,
    { ...props, className: cn("ink-card__title", className) },
    children,
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={cn("ink-card__description", className)} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ink-card__content", className)} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("ink-card__footer", className)} />;
}

export type BadgeTone = "neutral" | "accent" | "ai" | "success" | "warning" | "danger" | "info";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  selected?: boolean;
  leadingIcon?: ReactNode;
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { children, className, leadingIcon, selected = false, tone = "neutral", ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      className={cn("ink-badge", `ink-badge--${tone}`, className)}
      data-selected={selected || undefined}
    >
      {leadingIcon && (
        <span className="ink-badge__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      )}
      {children}
    </span>
  );
});
