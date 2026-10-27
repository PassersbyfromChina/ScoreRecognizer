import type { ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  children,
  footer,
  onClose,
  narrow,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  narrow?: boolean;
}) {
  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${narrow ? "narrow" : ""}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="spacer" />
          {onClose && (
            <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmText = "确定",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      narrow
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className="muted" style={{ lineHeight: 1.7 }}>
        {message}
      </div>
    </Modal>
  );
}
