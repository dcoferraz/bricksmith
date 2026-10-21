import { useEffect, type ReactNode } from 'react';

/** Blocks Escape/backdrop close while busy. */
export function Modal({ title, busy, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/60">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-slate-700" aria-label="Saving" />
          </div>
        )}
      </div>
    </div>
  );
}
