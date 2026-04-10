import { describePackageManifestContract } from "../../../test/helpers/plugins/package-manifest-contract.js";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  { minHostVersionBaseline: "2026.3.22", pluginId: "bluebubbles" },
  {
    minHostVersionBaseline: "2026.3.22",
    mirroredRootRuntimeDeps: [
      "@buape/carbon",
      "@discordjs/opus",
      "https-proxy-agent",
      "opusscript",
    ],
    pluginId: "discord",
  },
  {
    minHostVersionBaseline: "2026.3.22",
    mirroredRootRuntimeDeps: ["@larksuiteoapi/node-sdk"],
    pluginId: "feishu",
  },
  {
    minHostVersionBaseline: "2026.3.22",
    mirroredRootRuntimeDeps: ["google-auth-library"],
    pluginId: "googlechat",
  },
  { minHostVersionBaseline: "2026.3.22", pluginId: "irc" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "line" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "matrix" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "mattermost" },
  {
    minHostVersionBaseline: "2026.3.22",
    mirroredRootRuntimeDeps: ["@lancedb/lancedb", "openai"],
    pluginId: "memory-lancedb",
  },
  { minHostVersionBaseline: "2026.3.22", pluginId: "msteams" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "nextcloud-talk" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "nostr" },
  {
    mirroredRootRuntimeDeps: ["@slack/bolt", "@slack/web-api", "https-proxy-agent"],
    pluginId: "slack",
  },
  { minHostVersionBaseline: "2026.3.22", pluginId: "synology-chat" },
  {
    mirroredRootRuntimeDeps: ["@grammyjs/runner", "@grammyjs/transformer-throttler", "grammy"],
    pluginId: "telegram",
  },
  { minHostVersionBaseline: "2026.3.22", pluginId: "tlon" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "twitch" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "voice-call" },
  {
    minHostVersionBaseline: "2026.3.22",
    mirroredRootRuntimeDeps: ["jimp"],
    pluginId: "whatsapp",
    pluginLocalRuntimeDeps: ["@whiskeysockets/baileys"],
  },
  { minHostVersionBaseline: "2026.3.22", pluginId: "zalo" },
  { minHostVersionBaseline: "2026.3.22", pluginId: "zalouser" },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}
