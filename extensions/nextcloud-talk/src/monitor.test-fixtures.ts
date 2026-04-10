import { generateNextcloudTalkSignature } from "./signature.js";

export function createSignedCreateMessageRequest(params?: { backend?: string }) {
  const payload = {
    actor: { id: "alice", name: "Alice", type: "Person" },
    object: {
      content: "hello",
      id: "msg-1",
      mediaType: "text/plain",
      name: "hello",
      type: "Note",
    },
    target: { id: "room-1", name: "Room 1", type: "Collection" },
    type: "Create",
  };
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // Pragma: allowlist secret
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
    },
  };
}
