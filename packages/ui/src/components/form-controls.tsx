import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "../lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  leadingAdornment?: ReactNode;
  trailingAdornment?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    "aria-invalid": ariaInvalid,
    className,
    disabled,
    invalid = false,
    leadingAdornment,
    readOnly,
    trailingAdornment,
    ...props
  },
  ref,
) {
  const resolvedInvalid = invalid ? true : ariaInvalid;

  return (
    <span
      className={cn("ink-field-control", className)}
      data-disabled={disabled === true ? true : undefined}
      data-invalid={resolvedInvalid}
      data-readonly={readOnly === true ? true : undefined}
    >
      {leadingAdornment && (
        <span className="ink-field-control__adornment" aria-hidden="true">
          {leadingAdornment}
        </span>
      )}
      <input
        {...props}
        ref={ref}
        className="ink-input"
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={resolvedInvalid}
      />
      {trailingAdornment && (
        <span className="ink-field-control__adornment" aria-hidden="true">
          {trailingAdornment}
        </span>
      )}
    </span>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  currentLength?: number;
  maxLengthLabel?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    "aria-invalid": ariaInvalid,
    className,
    currentLength,
    disabled,
    invalid = false,
    maxLength,
    maxLengthLabel = "字符",
    readOnly,
    ...props
  },
  ref,
) {
  const showCounter = currentLength !== undefined || maxLength !== undefined;
  const resolvedInvalid = invalid ? true : ariaInvalid;

  return (
    <span className={cn("ink-textarea-wrap", className)}>
      <textarea
        {...props}
        ref={ref}
        className="ink-textarea"
        disabled={disabled}
        readOnly={readOnly}
        maxLength={maxLength}
        aria-invalid={resolvedInvalid}
        data-invalid={resolvedInvalid}
      />
      {showCounter && (
        <span className="ink-textarea__counter" aria-live="off">
          {currentLength ?? 0}
          {maxLength === undefined ? "" : ` / ${String(maxLength)}`} {maxLengthLabel}
        </span>
      )}
    </span>
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  options: readonly SelectOption[];
  placeholder?: string;
  loading?: boolean;
  invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    "aria-invalid": ariaInvalid,
    className,
    disabled,
    invalid = false,
    loading = false,
    options,
    placeholder,
    defaultValue,
    value,
    ...props
  },
  ref,
) {
  const resolvedInvalid = invalid ? true : ariaInvalid;
  const selectionProps =
    value !== undefined
      ? { value }
      : defaultValue !== undefined
        ? { defaultValue }
        : placeholder !== undefined
          ? { defaultValue: "" }
          : {};

  return (
    <select
      {...props}
      {...selectionProps}
      ref={ref}
      className={cn("ink-select", className)}
      disabled={loading ? true : disabled}
      aria-busy={loading ? true : undefined}
      aria-invalid={resolvedInvalid}
      data-invalid={resolvedInvalid}
    >
      {loading ? (
        <option value="">正在加载…</option>
      ) : (
        <>
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </>
      )}
    </select>
  );
});

export interface FormFieldRenderProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FormFieldProps {
  children: (props: FormFieldRenderProps) => ReactNode;
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optionalLabel?: string;
  className?: string;
}

export function FormField({
  children,
  className,
  error,
  hint,
  id: providedId,
  label,
  optionalLabel = "可选",
  required = false,
}: FormFieldProps) {
  const generatedId = useId();
  const id = providedId ?? `ink-field-${generatedId}`;
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const controlProps: FormFieldRenderProps = {
    id,
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
    ...(error === undefined ? {} : { "aria-invalid": true }),
    ...(required ? { "aria-required": true } : {}),
  };

  return (
    <div
      className={cn("ink-form-field", className)}
      data-invalid={error !== undefined || undefined}
    >
      <label className="ink-form-field__label" htmlFor={id}>
        {label}
        {!required && <span className="ink-form-field__optional">{optionalLabel}</span>}
      </label>
      {children(controlProps)}
      {hint !== undefined && (
        <div id={hintId} className="ink-form-field__hint">
          {hint}
        </div>
      )}
      {error !== undefined && (
        <div id={errorId} className="ink-form-field__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
