import {
  listMSTeamsDirectoryGroupsLive as listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive as listMSTeamsDirectoryPeersLiveImpl,
} from "./directory-live.js";
import { getMemberInfoMSTeams as getMemberInfoMSTeamsImpl } from "./graph-members.js";
import {
  getMessageMSTeams as getMessageMSTeamsImpl,
  listPinsMSTeams as listPinsMSTeamsImpl,
  listReactionsMSTeams as listReactionsMSTeamsImpl,
  pinMessageMSTeams as pinMessageMSTeamsImpl,
  reactMessageMSTeams as reactMessageMSTeamsImpl,
  searchMessagesMSTeams as searchMessagesMSTeamsImpl,
  unpinMessageMSTeams as unpinMessageMSTeamsImpl,
  unreactMessageMSTeams as unreactMessageMSTeamsImpl,
} from "./graph-messages.js";
import {
  getChannelInfoMSTeams as getChannelInfoMSTeamsImpl,
  listChannelsMSTeams as listChannelsMSTeamsImpl,
} from "./graph-teams.js";
import { msteamsOutbound as msteamsOutboundImpl } from "./outbound.js";
import { probeMSTeams as probeMSTeamsImpl } from "./probe.js";
import {
  deleteMessageMSTeams as deleteMessageMSTeamsImpl,
  editMessageMSTeams as editMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
} from "./send.js";
export const msTeamsChannelRuntime = {
  deleteMessageMSTeams: deleteMessageMSTeamsImpl,
  editMessageMSTeams: editMessageMSTeamsImpl,
  getChannelInfoMSTeams: getChannelInfoMSTeamsImpl,
  getMemberInfoMSTeams: getMemberInfoMSTeamsImpl,
  getMessageMSTeams: getMessageMSTeamsImpl,
  listChannelsMSTeams: listChannelsMSTeamsImpl,
  listMSTeamsDirectoryGroupsLive: listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive: listMSTeamsDirectoryPeersLiveImpl,
  listPinsMSTeams: listPinsMSTeamsImpl,
  listReactionsMSTeams: listReactionsMSTeamsImpl,
  msteamsOutbound: { ...msteamsOutboundImpl },
  pinMessageMSTeams: pinMessageMSTeamsImpl,
  probeMSTeams: probeMSTeamsImpl,
  reactMessageMSTeams: reactMessageMSTeamsImpl,
  searchMessagesMSTeams: searchMessagesMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams: sendMessageMSTeamsImpl,
  unpinMessageMSTeams: unpinMessageMSTeamsImpl,
  unreactMessageMSTeams: unreactMessageMSTeamsImpl,
};
