export interface BrowserActionOk { ok: true }

export interface BrowserActionTabResult {
  ok: true;
  targetId: string;
  url?: string;
}

export interface BrowserActionPathResult {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
}

export interface BrowserActionTargetOk { ok: true; targetId: string }
