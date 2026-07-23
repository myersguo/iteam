import React, { useMemo, useRef, type ReactNode } from "react";
import {
  Button as ArcoButton,
  Checkbox as ArcoCheckbox,
  Empty as ArcoEmpty,
  Input as ArcoInput,
  Modal as ArcoModal,
  Select as ArcoSelect,
  Tag as ArcoTag
} from "@arco-design/web-react";

export type NativeButtonType = "button" | "submit" | "reset";

export interface UiButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick"> {
  type?: NativeButtonType;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export function UiButton({ className, type = "button", onClick, children, ...rest }: UiButtonProps) {
  const classText = String(className || "");
  const visualType =
    classText.includes("btn-primary")
      ? "primary"
      : classText.includes("btn-ghost") ||
          classText.includes("ghost-btn") ||
          classText.includes("icon-btn") ||
          classText.includes("row-icon-btn") ||
          classText.includes("side-add") ||
          classText.includes("modal-close")
        ? "text"
        : "secondary";
  const status = classText.includes("danger") || classText.includes("modal-delete") ? "danger" : undefined;
  const iconOnly =
    !children ||
    classText.includes("icon-btn") ||
    classText.includes("side-add") ||
    classText.includes("row-icon-btn") ||
    classText.includes("modal-close");

  return (
    <ArcoButton
      {...(rest as any)}
      className={className}
      htmlType={type}
      type={visualType as any}
      status={status as any}
      iconOnly={iconOnly}
      onClick={event => onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>)}
    >
      {children}
    </ArcoButton>
  );
}

export interface UiInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "onChange"> {
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

export const UiInput = React.forwardRef<HTMLInputElement, UiInputProps>(function UiInput(
  { className, onChange, type, checked, defaultChecked, value, ...rest },
  ref
) {
  const inputRef = useRef<any>(null);
  React.useImperativeHandle(ref, () => inputRef.current?.dom as HTMLInputElement);

  if (type === "checkbox") {
    return (
      <ArcoCheckbox
        {...(rest as any)}
        className={className}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={(nextChecked, event) => {
          onChange?.({
            ...event,
            target: { checked: nextChecked, value: value ?? rest.name ?? "" },
            currentTarget: { checked: nextChecked, value: value ?? rest.name ?? "" }
          } as unknown as React.ChangeEvent<HTMLInputElement>);
        }}
      />
    );
  }

  const Component = type === "password" ? ArcoInput.Password : ArcoInput;
  return (
    <Component
      {...(rest as any)}
      ref={inputRef as any}
      className={className}
      type={type}
      value={value as any}
      onChange={(_nextValue, event) => onChange?.(event as React.ChangeEvent<HTMLInputElement>)}
    />
  );
});

export interface UiTextAreaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
}

export const UiTextArea = React.forwardRef<HTMLTextAreaElement, UiTextAreaProps>(function UiTextArea(
  { className, onChange, ...rest },
  ref
) {
  const textAreaRef = useRef<any>(null);
  React.useImperativeHandle(ref, () => textAreaRef.current?.dom as HTMLTextAreaElement);
  return (
    <ArcoInput.TextArea
      {...(rest as any)}
      ref={textAreaRef}
      className={className}
      onChange={(_nextValue, event) => onChange?.(event as React.ChangeEvent<HTMLTextAreaElement>)}
    />
  );
});

export interface UiSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size" | "onChange"> {
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  placeholder?: string;
}

function nativeOptionToArcoOption(child: React.ReactNode) {
  if (!React.isValidElement(child)) return null;
  const props = child.props as React.OptionHTMLAttributes<HTMLOptionElement>;
  const value = props.value === undefined ? String(props.children ?? "") : String(props.value);
  return {
    value,
    label: props.children as ReactNode,
    disabled: props.disabled
  };
}

export function UiSelect({
  className,
  children,
  onChange,
  value,
  defaultValue,
  disabled,
  placeholder,
  ...rest
}: UiSelectProps) {
  const options = useMemo(
    () =>
      React.Children.toArray(children)
        .map(nativeOptionToArcoOption)
        .filter(Boolean) as { value: string; label: ReactNode; disabled?: boolean }[],
    [children]
  );

  return (
    <ArcoSelect
      {...(rest as any)}
      className={className}
      value={value === undefined ? undefined : String(value)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      disabled={disabled}
      placeholder={placeholder}
      options={options}
      getPopupContainer={node => node.parentElement || document.body}
      onChange={nextValue => {
        const stringValue = nextValue === undefined || nextValue === null ? "" : String(nextValue);
        onChange?.({
          target: { value: stringValue },
          currentTarget: { value: stringValue }
        } as unknown as React.ChangeEvent<HTMLSelectElement>);
      }}
    />
  );
}

export function UiModalHost({
  children,
  onClose
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <ArcoModal
      visible
      footer={null}
      closable={false}
      maskClosable
      autoFocus={false}
      onCancel={onClose}
      className="iteam-modal-host"
      wrapClassName="iteam-modal-wrap"
    >
      {children}
    </ArcoModal>
  );
}

export function StatusTag({
  tone,
  children,
  className
}: {
  tone: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ArcoTag className={`status-pill ${tone} ${className || ""}`} size="small" bordered={false}>
      {children}
    </ArcoTag>
  );
}

export function InlineEmpty({
  className = "empty",
  title,
  description,
  icon
}: {
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={className}>
      {icon}
      <ArcoEmpty description={description || title || "No data"} />
    </div>
  );
}
