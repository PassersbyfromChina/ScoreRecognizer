export interface LanUrl {
  name: string;
  ip: string;
  url: string;
}

export interface LanInfo {
  running: boolean;
  port: number | null;
  token: string;
  urls: LanUrl[];
  reachable: boolean;
}

export interface LanStartResult extends LanInfo {
  ok: boolean;
  error?: string;
}

export interface LanPhotoPayload {
  id: string;
  filename: string;
  data: Uint8Array | ArrayBuffer;
}

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  getAppVersion: () => Promise<string>;
  lan: {
    info: () => Promise<LanInfo>;
    start: () => Promise<LanStartResult>;
    stop: () => Promise<LanInfo & { ok: boolean }>;
    onPhoto: (callback: (payload: LanPhotoPayload) => void) => () => void;
  };
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
