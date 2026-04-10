// Manual facade. Keep loader boundary explicit.
type MattermostSenderAllowed = (params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}) => boolean;
interface FacadeModule {
  isMattermostSenderAllowed: MattermostSenderAllowed;
}
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    artifactBasename: "policy-api.js",
    dirName: "mattermost",
  });
}
export const isMattermostSenderAllowed: FacadeModule["isMattermostSenderAllowed"] = ((...args) =>
  loadFacadeModule()["isMattermostSenderAllowed"](
    ...args,
  )) as FacadeModule["isMattermostSenderAllowed"];
