export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[Function]";
      }
      if (val instanceof Error) {
        return { message: val.message, name: val.name, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { data: Buffer.from(val).toString("base64"), type: "Uint8Array" };
      }
      return val;
    });
  } catch {
    return null;
  }
}
