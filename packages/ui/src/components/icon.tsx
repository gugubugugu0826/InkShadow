import {
  Archive,
  ArrowLeft,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Ellipsis,
  FileText,
  Globe,
  History,
  House,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, type SVGProps } from "react";

import { cn } from "../lib/cn";

export const inkIconNames = [
  "alert-circle",
  "alert-triangle",
  "archive",
  "arrow-left",
  "bell",
  "check",
  "chevron-down",
  "chevron-right",
  "clock",
  "close",
  "file-text",
  "globe",
  "history",
  "home",
  "library",
  "more",
  "pen",
  "plus",
  "refresh",
  "search",
  "settings",
  "shield",
  "sparkles",
  "trash",
  "upload",
  "user",
] as const;

export type InkIconName = (typeof inkIconNames)[number];

const ICONS: Readonly<Record<InkIconName, LucideIcon>> = {
  "alert-circle": CircleAlert,
  "alert-triangle": TriangleAlert,
  archive: Archive,
  "arrow-left": ArrowLeft,
  bell: Bell,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  clock: Clock3,
  close: X,
  "file-text": FileText,
  globe: Globe,
  history: History,
  home: House,
  library: BookOpen,
  more: Ellipsis,
  pen: PenLine,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  trash: Trash2,
  upload: Upload,
  user: UserRound,
};

interface MeaningfulIcon {
  /** Accessible name announced by assistive technology. */
  label: string;
  decorative?: false;
}

interface DecorativeIcon {
  /** Decorative icons must be explicitly hidden from assistive technology. */
  decorative: true;
  label?: never;
}

export type InkIconProps = Omit<
  SVGProps<SVGSVGElement>,
  "aria-hidden" | "aria-label" | "children" | "color" | "focusable" | "role" | "strokeWidth"
> & {
  name: InkIconName;
  size?: number | string;
} & (MeaningfulIcon | DecorativeIcon);

/**
 * Themeable DESIGN icon primitive.
 *
 * Meaningful icons require `label`; decorative icons require `decorative`.
 * Colour always follows `currentColor`, and the v0.3.1b 1.75 stroke cannot be
 * overridden through props.
 */
export const InkIcon = forwardRef<SVGSVGElement, InkIconProps>(function InkIcon(
  { className, decorative = false, label, name, size = 24, ...props },
  ref,
) {
  const IconComponent = ICONS[name];
  const accessibleLabel = typeof label === "string" ? label.trim() : "";

  if (!decorative && accessibleLabel.length === 0) {
    throw new Error("InkIcon requires a non-empty accessible label unless decorative is true.");
  }

  return (
    <IconComponent
      {...props}
      ref={ref}
      className={cn("ink-icon", className)}
      color="currentColor"
      data-icon={name}
      focusable="false"
      size={size}
      strokeWidth={1.75}
      {...(decorative
        ? { "aria-hidden": true }
        : { "aria-label": accessibleLabel, role: "img" as const })}
    />
  );
});
