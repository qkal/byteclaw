import {
  findPreferredDmConversationByUserId,
  mergeStoredConversationReference,
  normalizeStoredConversationId,
  toConversationStoreEntries,
} from "./conversation-store-helpers.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function createMSTeamsConversationStoreMemory(
  initial: MSTeamsConversationStoreEntry[] = [],
): MSTeamsConversationStore {
  const map = new Map<string, StoredConversationReference>();
  for (const { conversationId, reference } of initial) {
    map.set(normalizeStoredConversationId(conversationId), reference);
  }

  const findPreferredDmByUserId = async (
    id: string,
  ): Promise<MSTeamsConversationStoreEntry | null> => findPreferredDmConversationByUserId(toConversationStoreEntries(map.entries()), id);

  return {
    findByUserId: findPreferredDmByUserId,
    findPreferredDmByUserId,
    get: async (conversationId) => map.get(normalizeStoredConversationId(conversationId)) ?? null,
    list: async () => toConversationStoreEntries(map.entries()),
    remove: async (conversationId) => map.delete(normalizeStoredConversationId(conversationId)),
    upsert: async (conversationId, reference) => {
      const normalizedId = normalizeStoredConversationId(conversationId);
      map.set(
        normalizedId,
        mergeStoredConversationReference(
          map.get(normalizedId),
          reference,
          new Date().toISOString(),
        ),
      );
    },
  };
}
