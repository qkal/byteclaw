import { Type } from "@sinclair/typebox";

export function createTelegramPollExtraToolSchemas() {
  return {
    pollAnonymous: Type.Optional(Type.Boolean()),
    pollDurationSeconds: Type.Optional(Type.Number()),
    pollPublic: Type.Optional(Type.Boolean()),
  };
}
