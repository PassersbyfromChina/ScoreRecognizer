import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Loader2, RefreshCw, Smartphone, Wifi, WifiOff, X } from "lucide-react";
import type { LanInfo } from "../types/desktop";
import { toast } from "./Toast";

interface Props {
  onClose: () => void;
  /** 手机传回照片后的回调（父组件负责落库） */
  onPhotoCount?: () => void;
}

export function PhoneLinkModal({ onClose, onPhotoCount }: Props) {
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bridge = typeof window !== "undefined" ? window.desktop : undefined;

  const makeQr = useCallback(async (target: string) => {
    try {
      const url = await QRCode.toDataURL(target, {
        width: 260,
        margin: 1,
        color: { dark: "#0f172a", light: "#ffffff" },
        errorCorrectionLevel: "M",
      });
      setQr(url);
    } catch {
      setQr(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const current = await bridge.lan.info();
      setInfo(current);
      if (current.running && current.urls[0]) await makeQr(current.urls[0].url);
      else setQr(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取局域网状态");
    } finally {
      setBusy(false);
    }
  }, [bridge, makeQr]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function start() {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.lan.start();
      if (!result.ok) {
        setError(result.error ?? "启动失败");
        toast(result.error ?? "启动失败", "err");
        return;
      }
      setInfo(result);
      if (result.urls[0]) await makeQr(result.urls[0].url);
      else setError("没有检测到可用的局域网地址，请连接 Wi-Fi 或网线后再试。");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await bridge.lan.stop();
      setInfo(result);
      setQr(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast("链接已复制", "ok");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败，请手动选择链接复制", "err");
    }
  }

  // 订阅手机照片，刷新计数
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.lan.onPhoto(() => onPhotoCount?.());
    return off;
  }, [bridge, onPhotoCount]);

  if (!bridge) {
    return (
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal narrow">
          <div className="modal-head">
            <h3>手机拍摄</h3>
            <span className="spacer" />
            <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div className="notice notice-warn">
              手机协作只在桌面版可用。浏览器版请直接用「批量上传」。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(640px, 100%)" }}>
        <div className="modal-head">
          <Smartphone size={18} color="var(--red)" />
          <h3>手机拍摄 · 电脑处理</h3>
          <span className="spacer" />
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="notice notice-warn" style={{ marginBottom: 14 }}>
              {error}
            </div>
          )}

          {!info || busy ? (
            <div className="center" style={{ padding: 32 }}>
              <span className="spinner" />
            </div>
          ) : !info.running ? (
            <div style={{ padding: "6px 0" }}>
              <div className="notice notice-info" style={{ marginBottom: 16 }}>
                手机和电脑连同一个 Wi-Fi 后，点下面按钮生成二维码。手机扫码打开网页即可拍照，拍完自动传回电脑，识别与核对都在电脑上完成。
              </div>
              <button className="btn btn-primary" onClick={start}>
                <Wifi size={16} />
                开启手机拍摄
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 22, alignItems: "start" }}>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid var(--line)",
                  borderRadius: 14,
                  padding: 12,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {qr ? (
                  <img src={qr} alt="手机扫码连接二维码" style={{ width: 220, height: 220, display: "block" }} />
                ) : (
                  <div className="center" style={{ width: 220, height: 220 }}>
                    <span className="spinner" />
                  </div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                  <span className="badge badge-green">
                    <Wifi size={12} />
                    服务已开启
                  </span>
                  <button className="btn btn-sm btn-secondary" onClick={() => void refresh()}>
                    <RefreshCw size={13} />
                    刷新
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => void stop()}>
                    <WifiOff size={13} />
                    停止
                  </button>
                </div>
                <div className="hint" style={{ marginBottom: 10 }}>
                  用手机扫码（或手动输入下面的地址），页面里点「拍一张答题卡」即可。照片会实时进入左侧列表并自动处理。
                </div>
                {info.urls.length > 1 && (
                  <div className="faint small" style={{ marginBottom: 6 }}>
                    二维码使用第一个地址；若连不上，可换用以下地址：
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {info.urls.map((u) => (
                    <div key={u.ip} className="row" style={{ gap: 8, minWidth: 0 }}>
                      <code
                        className="small"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          background: "#f8fafc",
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          padding: "6px 9px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.url}
                      </code>
                      <button className="btn btn-sm btn-secondary" onClick={() => void copy(u.url)}>
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        复制
                      </button>
                    </div>
                  ))}
                </div>
                {!info.reachable && (
                  <div className="notice notice-warn" style={{ marginTop: 12 }}>
                    没有找到可用的局域网 IP，请确认电脑已连 Wi-Fi 或有线网络。
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="hint" style={{ marginTop: 16, display: "flex", gap: 6, alignItems: "flex-start" }}>
            <Loader2 size={13} className="spin" style={{ marginTop: 2 }} />
            提示：拍照时把答题卡放平、四角拍完整；可以连续拍，电脑会排队处理。
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
