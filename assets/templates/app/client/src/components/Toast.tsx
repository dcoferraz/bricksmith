import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Kind = 'info' | 'success' | 'warning' | 'error';
interface Toast {
  id: number;
  text: string;
  kind: Kind;
}

const ToastContext = createContext<{ show: (text: string, kind?: Kind) => void }>({ show: () => undefined });

const STYLE: Record<Kind, string> = {
  info: 'bg-slate-800 text-white',
  success: 'bg-emerald-600 text-white',
  warning: 'bg-amber-500 text-slate-900',
  error: 'bg-red-600 text-white',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: Kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded px-4 py-2 text-sm shadow ${STYLE[t.kind]}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
