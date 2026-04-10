import { describe, expect, it } from "vitest";
import { buildIrcConnectOptions } from "./connect-options.js";

describe("buildIrcConnectOptions", () => {
  it("copies resolved account connection fields and NickServ config", () => {
    const account = {
      config: {
        nickserv: {
          enabled: true,
          password: "nickserv-pass",
          register: true,
          registerEmail: "bot@example.com",
          service: "NickServ",
        },
      },
      host: "irc.libera.chat",
      nick: "openclaw",
      password: "server-pass",
      port: 6697,
      realname: "OpenClaw Bot",
      tls: true,
      username: "openclaw",
    };

    expect(
      buildIrcConnectOptions(account as never, {
        connectTimeoutMs: 1234,
      }),
    ).toEqual({
      connectTimeoutMs: 1234,
      host: "irc.libera.chat",
      nick: "openclaw",
      nickserv: {
        enabled: true,
        password: "nickserv-pass",
        register: true,
        registerEmail: "bot@example.com",
        service: "NickServ",
      },
      password: "server-pass",
      port: 6697,
      realname: "OpenClaw Bot",
      tls: true,
      username: "openclaw",
    });
  });
});
