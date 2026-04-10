import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 2;

function formatManagedWorkspaceBind(params: {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}): string {
  return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}

export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  args.push(
    "-v",
    formatManagedWorkspaceBind({
      containerPath: workdir,
      hostPath: workspaceDir,
      readOnly: workspaceAccess !== "rw",
    }),
  );
  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      formatManagedWorkspaceBind({
        containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
        hostPath: agentWorkspaceDir,
        readOnly: workspaceAccess === "ro",
      }),
    );
  }
}
