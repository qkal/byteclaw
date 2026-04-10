import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const ircChannelConfigUiHints = {
  "": {
    help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.",
    label: "IRC",
  },
  configWrites: {
    help: "Allow IRC to write config in response to channel events/commands (default: true).",
    label: "IRC Config Writes",
  },
  dmPolicy: {
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.irc.allowFrom=["*"].',
    label: "IRC DM Policy",
  },
  "nickserv.enabled": {
    help: "Enable NickServ identify/register after connect (defaults to enabled when password is configured).",
    label: "IRC NickServ Enabled",
  },
  "nickserv.password": {
    help: "NickServ password used for IDENTIFY/REGISTER (sensitive).",
    label: "IRC NickServ Password",
  },
  "nickserv.passwordFile": {
    help: "Optional file path containing NickServ password.",
    label: "IRC NickServ Password File",
  },
  "nickserv.register": {
    help: "If true, send NickServ REGISTER on every connect. Use once for initial registration, then disable.",
    label: "IRC NickServ Register",
  },
  "nickserv.registerEmail": {
    help: "Email used with NickServ REGISTER (required when register=true).",
    label: "IRC NickServ Register Email",
  },
  "nickserv.service": {
    help: "NickServ service nick (default: NickServ).",
    label: "IRC NickServ Service",
  },
} satisfies Record<string, ChannelConfigUiHint>;
