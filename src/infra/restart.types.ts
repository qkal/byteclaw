export interface RestartAttempt {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor";
  detail?: string;
  tried?: string[];
}
