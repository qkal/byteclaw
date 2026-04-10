import { describe, expect, it } from "vitest";
import { MatrixConfigSchema } from "./config-schema.js";

describe("MatrixConfigSchema SecretInput", () => {
  it("accepts SecretRef accessToken at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: { id: "MATRIX_ACCESS_TOKEN", provider: "default", source: "env" },
      homeserver: "https://matrix.example.org",
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef password at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      password: { id: "MATRIX_PASSWORD", provider: "default", source: "env" },
      userId: "@bot:example.org",
    });
    expect(result.success).toBe(true);
  });

  it("accepts dm threadReplies overrides", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: "token",
      dm: {
        policy: "pairing",
        threadReplies: "off",
      },
      homeserver: "https://matrix.example.org",
    });
    expect(result.success).toBe(true);
  });

  it("accepts dm sessionScope overrides", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: "token",
      dm: {
        policy: "pairing",
        sessionScope: "per-room",
      },
      homeserver: "https://matrix.example.org",
    });
    expect(result.success).toBe(true);
  });

  it("accepts room-level account assignments", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: "token",
      groups: {
        "!room:example.org": {
          account: "axis",
          enabled: true,
        },
      },
      homeserver: "https://matrix.example.org",
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected schema parse to succeed");
    }
    expect(result.data.groups?.["!room:example.org"]?.account).toBe("axis");
  });

  it("accepts legacy room-level account assignments", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: "token",
      homeserver: "https://matrix.example.org",
      rooms: {
        "!room:example.org": {
          account: "axis",
          enabled: true,
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected schema parse to succeed");
    }
    expect(result.data.rooms?.["!room:example.org"]?.account).toBe("axis");
  });

  it("accepts quiet Matrix streaming mode", () => {
    const result = MatrixConfigSchema.safeParse({
      accessToken: "token",
      homeserver: "https://matrix.example.org",
      streaming: "quiet",
    });
    expect(result.success).toBe(true);
  });
});
