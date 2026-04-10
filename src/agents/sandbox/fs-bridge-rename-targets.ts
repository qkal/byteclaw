export function resolveWritableRenameTargets<T extends { containerPath: string }>(params: {
  from: string;
  to: string;
  cwd?: string;
  action?: string;
  resolveTarget: (params: { filePath: string; cwd?: string }) => T;
  ensureWritable: (target: T, action: string) => void;
}): { from: T; to: T } {
  const action = params.action ?? "rename files";
  const from = params.resolveTarget({ cwd: params.cwd, filePath: params.from });
  const to = params.resolveTarget({ cwd: params.cwd, filePath: params.to });
  params.ensureWritable(from, action);
  params.ensureWritable(to, action);
  return { from, to };
}

export function resolveWritableRenameTargetsForBridge<T extends { containerPath: string }>(
  params: {
    from: string;
    to: string;
    cwd?: string;
    action?: string;
  },
  resolveTarget: (params: { filePath: string; cwd?: string }) => T,
  ensureWritable: (target: T, action: string) => void,
): { from: T; to: T } {
  return resolveWritableRenameTargets({
    ...params,
    ensureWritable,
    resolveTarget,
  });
}

export function createWritableRenameTargetResolver<T extends { containerPath: string }>(
  resolveTarget: (params: { filePath: string; cwd?: string }) => T,
  ensureWritable: (target: T, action: string) => void,
): (params: { from: string; to: string; cwd?: string }) => { from: T; to: T } {
  return (params) => resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable);
}
