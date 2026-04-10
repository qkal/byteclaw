import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { SLACK_MAX_BLOCKS, parseSlackBlocksInput } from "./blocks-input.js";
import { type SlackBlock, buildSlackInteractiveBlocks } from "./blocks-render.js";

export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  const slackData = payload.channelData?.slack;
  const interactiveBlocks = buildSlackInteractiveBlocks(payload.interactive);
  let channelBlocks: SlackBlock[] = [];
  if (slackData && typeof slackData === "object" && !Array.isArray(slackData)) {
    channelBlocks =
      (parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as SlackBlock[]) ?? [];
  }
  const blocks = [...channelBlocks, ...interactiveBlocks];
  if (blocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  return blocks.length > 0 ? blocks : undefined;
}
