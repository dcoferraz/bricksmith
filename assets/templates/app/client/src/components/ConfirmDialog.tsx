import { Modal } from './Modal';

export function ConfirmDialog({
  title,
  message,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} busy={busy} onClose={onCancel}>
      <p className="mb-6 text-sm text-slate-700">{message}</p>
      <fieldset disabled={busy} className="flex justify-end gap-2">
        <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="rounded bg-red-600 px-3 py-1.5 text-sm text-white" onClick={onConfirm}>
          Delete
        </button>
      </fieldset>
    </Modal>
  );
}
