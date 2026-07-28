import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { shouldSendComposerKey } from "../../app/composer";

export interface WorkflowComposerInputHandle {
  getValue: () => string;
  submit: () => void;
}

export const WorkflowComposerInput = forwardRef<WorkflowComposerInputHandle, {
  initialValue: string;
  workflowKey: string;
  ariaLabel: string;
  placeholder: string;
  running: boolean;
  onSubmit: (value: string) => void;
}>(({ initialValue, workflowKey, ariaLabel, placeholder, running, onSubmit }, ref) => {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue, workflowKey]);
  useImperativeHandle(ref, () => ({
    getValue: () => value,
    submit: () => {
      const next = value.trim();
      if (!running && next) {
        setValue("");
        onSubmit(next);
      }
    },
  }), [onSubmit, running, value]);
  return <textarea
    aria-label={ariaLabel}
    value={value}
    onChange={(event) => setValue(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (shouldSendComposerKey({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing })) {
        event.preventDefault();
        const next = value.trim();
        if (!running && next) {
          setValue("");
          onSubmit(next);
        }
      }
    }}
    placeholder={placeholder}
    rows={2}
  />;
});
WorkflowComposerInput.displayName = "WorkflowComposerInput";
