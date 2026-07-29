import {
  forwardRef,
  type HTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";

import { cn } from "../lib/cn";

export type TableProps = TableHTMLAttributes<HTMLTableElement> & {
  scrollLabel?: string;
};

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, scrollLabel = "可滚动表格", ...props },
  ref,
) {
  return (
    // The scroll region is intentionally focusable so keyboard users can pan wide tables.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="ink-table-scroll" tabIndex={0} role="region" aria-label={scrollLabel}>
      <table {...props} ref={ref} className={cn("ink-table", className)} />
    </div>
  );
});

export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption {...props} className={cn("ink-table__caption", className)} />;
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={cn("ink-table__header", className)} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} className={cn("ink-table__body", className)} />;
}

export function TableFooter({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tfoot {...props} className={cn("ink-table__footer", className)} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} className={cn("ink-table__row", className)} />;
}

export type TableHeadProps = ThHTMLAttributes<HTMLTableCellElement> & {
  sort?: "ascending" | "descending" | "none";
};

export function TableHead({ className, sort, ...props }: TableHeadProps) {
  return <th {...props} className={cn("ink-table__head", className)} aria-sort={sort} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={cn("ink-table__cell", className)} />;
}
