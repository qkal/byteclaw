import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "../../../../test/helpers/channels/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  alias: "teams",
  channelId: "msteams",
  npmSpec: "@openclaw/msteams",
});

const whatsappMeta = {
  blurb: "works with your own number; recommend a separate phone + eSIM.",
  detailLabel: "WhatsApp Web",
  docsPath: "/channels/whatsapp",
  id: "whatsapp",
  label: "WhatsApp",
  selectionLabel: "WhatsApp (QR link)",
};

describeBundledMetadataOnlyChannelCatalogContract({
  defaultChoice: "npm",
  meta: whatsappMeta,
  npmSpec: "@openclaw/whatsapp",
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "whatsapp",
  externalLabel: "WhatsApp Fork",
  externalNpmSpec: "@vendor/whatsapp-fork",
  meta: whatsappMeta,
  npmSpec: "@openclaw/whatsapp",
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
});
