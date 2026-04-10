import {
  BOUNDARY_PATH_ALIAS_POLICIES,
  type BoundaryPathAliasPolicy,
  resolveBoundaryPath,
} from "./boundary-path.js";
import { assertNoHardlinkedFinalPath } from "./hardlink-guards.js";

export type PathAliasPolicy = BoundaryPathAliasPolicy;

export const PATH_ALIAS_POLICIES = BOUNDARY_PATH_ALIAS_POLICIES;

export async function assertNoPathAliasEscape(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  policy?: PathAliasPolicy;
}): Promise<void> {
  const resolved = await resolveBoundaryPath({
    absolutePath: params.absolutePath,
    boundaryLabel: params.boundaryLabel,
    policy: params.policy,
    rootPath: params.rootPath,
  });
  const allowFinalSymlink = params.policy?.allowFinalSymlinkForUnlink === true;
  if (allowFinalSymlink && resolved.kind === "symlink") {
    return;
  }
  await assertNoHardlinkedFinalPath({
    allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink,
    boundaryLabel: params.boundaryLabel,
    filePath: resolved.absolutePath,
    root: resolved.rootPath,
  });
}
