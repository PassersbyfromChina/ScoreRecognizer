/** 跨平台能力：判断运行环境、保存文件（桌面浏览器 / Android WebView）。 */

export function isNativeMobile(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export function isDesktopApp(): boolean {
  return Boolean(window.desktop?.isDesktop);
}

export function platformLabel(): string {
  if (isDesktopApp()) return `桌面版（${window.desktop?.platform ?? ""}）`;
  if (isNativeMobile()) return "手机版";
  return "浏览器版";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 保存文件：
 * - Android：写入应用的 Documents 目录，并调起系统分享/保存面板
 * - 桌面/浏览器：走普通下载（桌面版会弹保存对话框）
 */
export async function saveFile(blob: Blob, filename: string): Promise<{ ok: boolean; message?: string }> {
  if (isNativeMobile()) {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");
      const data = await blobToBase64(blob);
      const saved = await Filesystem.writeFile({
        path: `ScoreRecognizer/${filename}`,
        data,
        directory: Directory.Documents,
        recursive: true,
      });
      try {
        await Share.share({ title: filename, text: "已保存到 Documents/ScoreRecognizer", url: saved.uri });
      } catch {
        /* 用户取消分享不算失败 */
      }
      return { ok: true, message: `已保存到 Documents/ScoreRecognizer/${filename}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "保存失败" };
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "保存失败" };
  }
}
