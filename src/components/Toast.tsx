import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

export type ToastKind = "ok" | "err" | "info";
export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

let seq = 0;
const listeners = new Set<(item: ToastItem) => void>();

export function toast(message: string, kind: ToastKind = "info") {
  const item: ToastItem = { id: ++seq, message, kind };
  listeners.forEach((fn) => fn(item));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const add = (item: ToastItem) => {
      setItems((prev) => [...prev.slice(-3), item]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== item.id));
      }, item.kind === "err" ? 6000 : 3600);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
    };
  }, []);

  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "ok" ? "ok" : t.kind === "err" ? "err" : ""}`}>
          {t.kind === "ok" ? <CheckCircle2 size={16} /> : t.kind === "err" ? <AlertTriangle size={16} /> : <Info size={16} />}
          <span>{t.message}</span>
          <button
            className="btn btn-icon btn-ghost"
            style={{ marginLeft: "auto", color: "rgba(255,255,255,.7)" }}
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
