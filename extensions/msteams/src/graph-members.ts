import type { OpenClawConfig } from "../runtime-api.js";
import { fetchGraphJson, resolveGraphToken } from "./graph.js";

interface GraphUserProfile {
  id?: string;
  displayName?: string;
  mail?: string;
  jobTitle?: string;
  userPrincipalName?: string;
  officeLocation?: string;
}

export interface GetMemberInfoMSTeamsParams {
  cfg: OpenClawConfig;
  userId: string;
}

export interface GetMemberInfoMSTeamsResult {
  user: {
    id: string | undefined;
    displayName: string | undefined;
    mail: string | undefined;
    jobTitle: string | undefined;
    userPrincipalName: string | undefined;
    officeLocation: string | undefined;
  };
}

/**
 * Fetch a user profile from Microsoft Graph by user ID.
 */
export async function getMemberInfoMSTeams(
  params: GetMemberInfoMSTeamsParams,
): Promise<GetMemberInfoMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const path = `/users/${encodeURIComponent(params.userId)}?$select=id,displayName,mail,jobTitle,userPrincipalName,officeLocation`;
  const user = await fetchGraphJson<GraphUserProfile>({ path, token });
  return {
    user: {
      displayName: user.displayName,
      id: user.id,
      jobTitle: user.jobTitle,
      mail: user.mail,
      officeLocation: user.officeLocation,
      userPrincipalName: user.userPrincipalName,
    },
  };
}
