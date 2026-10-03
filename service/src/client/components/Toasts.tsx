import { useEffect } from 'react';
import { Icon } from './Icon';

export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'neutral';
  title: string;
  body?: string;
  href?: string;
  hrefLabel?: string;
}

const TTL_MS = 7000;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TTL_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);
  return (
    <li className={`toast toast-${toast.tone}`}>
      <span className="toast-dot" aria-hidden="true" />
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        {toast.body ? <p className="toast-text">{toast.body}</p> : null}
        {toast.href ? (
          <a className="toast-link" href={toast.href} target="_blank" rel="noopener">
            {toast.hrefLabel ?? 'Open'}
            <Icon name="external" size={13} />
          </a>
        ) : null}
      </div>
      <button type="button" className="btn btn-icon btn-ghost toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" size={14} />
      </button>
    </li>
  );
}

/** Always-mounted live region so screen readers announce new toasts. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite" aria-relevant="additions">
      <ul>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </ul>
    </div>
  );
}
