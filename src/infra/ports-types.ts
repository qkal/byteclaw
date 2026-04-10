export interface PortListener {
  pid?: number;
  ppid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
}

export type PortUsageStatus = "free" | "busy" | "unknown";

export interface PortUsage {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
}

export type PortListenerKind = "gateway" | "ssh" | "unknown";
