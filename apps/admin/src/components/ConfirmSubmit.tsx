import { useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Asks "Save these changes?" before any form inside it is submitted, so
 * every Settings section saves on its own with a confirm, without each card
 * having to build one. Submits are caught on the way down (capture), held,
 * and sent again once confirmed.
 */
export function ConfirmSubmit({ what, children }: { what: string; children: ReactNode }) {
  const [pending, setPending] = useState<HTMLFormElement | null>(null);
  const confirmed = useRef(false);
  return (
    <div
      onSubmitCapture={(e) => {
        if (confirmed.current) {
          confirmed.current = false;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setPending(e.target as HTMLFormElement);
      }}
    >
      {children}
      {pending ? (
        <ConfirmDialog
          title={`Save ${what}?`}
          confirmLabel="Save changes"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const form = pending;
            setPending(null);
            confirmed.current = true;
            form.requestSubmit();
          }}
        >
          <p>The change applies straight away and is written to the audit log with your name.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
