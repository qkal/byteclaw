import {
  getChatInfo as getChatInfoImpl,
  getChatMembers as getChatMembersImpl,
  getFeishuMemberInfo as getFeishuMemberInfoImpl,
} from "./chat.js";
import {
  listFeishuDirectoryGroupsLive as listFeishuDirectoryGroupsLiveImpl,
  listFeishuDirectoryPeersLive as listFeishuDirectoryPeersLiveImpl,
} from "./directory.js";
import { feishuOutbound as feishuOutboundImpl } from "./outbound.js";
import {
  createPinFeishu as createPinFeishuImpl,
  listPinsFeishu as listPinsFeishuImpl,
  removePinFeishu as removePinFeishuImpl,
} from "./pins.js";
import { probeFeishu as probeFeishuImpl } from "./probe.js";
import {
  addReactionFeishu as addReactionFeishuImpl,
  listReactionsFeishu as listReactionsFeishuImpl,
  removeReactionFeishu as removeReactionFeishuImpl,
} from "./reactions.js";
import {
  editMessageFeishu as editMessageFeishuImpl,
  getMessageFeishu as getMessageFeishuImpl,
  sendCardFeishu as sendCardFeishuImpl,
  sendMessageFeishu as sendMessageFeishuImpl,
} from "./send.js";

export const feishuChannelRuntime = {
  addReactionFeishu: addReactionFeishuImpl,
  createPinFeishu: createPinFeishuImpl,
  editMessageFeishu: editMessageFeishuImpl,
  feishuOutbound: { ...feishuOutboundImpl },
  getChatInfo: getChatInfoImpl,
  getChatMembers: getChatMembersImpl,
  getFeishuMemberInfo: getFeishuMemberInfoImpl,
  getMessageFeishu: getMessageFeishuImpl,
  listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveImpl,
  listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveImpl,
  listPinsFeishu: listPinsFeishuImpl,
  listReactionsFeishu: listReactionsFeishuImpl,
  probeFeishu: probeFeishuImpl,
  removePinFeishu: removePinFeishuImpl,
  removeReactionFeishu: removeReactionFeishuImpl,
  sendCardFeishu: sendCardFeishuImpl,
  sendMessageFeishu: sendMessageFeishuImpl,
};
