import { describe, expect, it } from "vitest";
import {
  type UpdateChannel,
  type UpdateChannelSource,
  channelToNpmTag,
  formatUpdateChannelLabel,
  isBetaTag,
  isStableTag,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  resolveUpdateChannelDisplay,
} from "./update-channels.js";

describe("update-channels tag detection", () => {
  it.each([
    { beta: true, tag: "v2026.2.24-beta.1" },
    { beta: true, tag: "v2026.2.24.beta.1" },
    { beta: true, tag: "v2026.2.24-BETA-1" },
    { beta: false, tag: "v2026.2.24-1" },
    { beta: false, tag: "v2026.2.24-alphabeta.1" },
    { beta: false, tag: "v2026.2.24" },
  ])("classifies $tag", ({ tag, beta }) => {
    expect(isBetaTag(tag)).toBe(beta);
    expect(isStableTag(tag)).toBe(!beta);
  });
});

describe("normalizeUpdateChannel", () => {
  it.each([
    { expected: "stable", value: "stable" },
    { expected: "beta", value: " BETA " },
    { expected: "dev", value: "Dev" },
    { expected: null, value: "" },
    { expected: null, value: " nightly " },
    { expected: null, value: null },
    { expected: null, value: undefined },
  ] satisfies { value: string | null | undefined; expected: UpdateChannel | null }[])(
    "normalizes %j",
    ({ value, expected }) => {
      expect(normalizeUpdateChannel(value)).toBe(expected);
    },
  );
});

describe("channelToNpmTag", () => {
  it.each([
    { channel: "stable", expected: "latest" },
    { channel: "beta", expected: "beta" },
    { channel: "dev", expected: "dev" },
  ] satisfies { channel: UpdateChannel; expected: string }[])(
    "maps $channel to $expected",
    ({ channel, expected }) => {
      expect(channelToNpmTag(channel)).toBe(expected);
    },
  );
});

describe("resolveEffectiveUpdateChannel", () => {
  it.each([
    {
      expected: { channel: "beta", source: "config" },
      name: "prefers config over git metadata",
      params: {
        configChannel: "beta",
        git: { branch: "feature/test", tag: "v2026.2.24" },
        installKind: "git" as const,
      },
    },
    {
      expected: { channel: "beta", source: "git-tag" },
      name: "uses beta git tag",
      params: {
        git: { tag: "v2026.2.24-beta.1" },
        installKind: "git" as const,
      },
    },
    {
      expected: { channel: "stable", source: "git-tag" },
      name: "treats non-beta git tag as stable",
      params: {
        git: { tag: "v2026.2.24-1" },
        installKind: "git" as const,
      },
    },
    {
      expected: { channel: "dev", source: "git-branch" },
      name: "uses non-HEAD git branch as dev",
      params: {
        git: { branch: "feature/test" },
        installKind: "git" as const,
      },
    },
    {
      expected: { channel: "dev", source: "default" },
      name: "falls back for detached HEAD git installs",
      params: {
        git: { branch: "HEAD" },
        installKind: "git" as const,
      },
    },
    {
      expected: { channel: "stable", source: "default" },
      name: "defaults package installs to stable",
      params: { installKind: "package" as const },
    },
    {
      expected: { channel: "stable", source: "default" },
      name: "defaults unknown installs to stable",
      params: { installKind: "unknown" as const },
    },
  ] satisfies {
    name: string;
    params: Parameters<typeof resolveEffectiveUpdateChannel>[0];
    expected: { channel: UpdateChannel; source: UpdateChannelSource };
  }[])("$name", ({ params, expected }) => {
    expect(resolveEffectiveUpdateChannel(params)).toEqual(expected);
  });
});

describe("formatUpdateChannelLabel", () => {
  it.each([
    {
      expected: "beta (config)",
      name: "formats config labels",
      params: { channel: "beta", source: "config" as const },
    },
    {
      expected: "stable (v2026.2.24)",
      name: "formats git tag labels with tag",
      params: {
        channel: "stable",
        gitTag: "v2026.2.24",
        source: "git-tag" as const,
      },
    },
    {
      expected: "stable (tag)",
      name: "formats git tag labels without tag",
      params: { channel: "stable", source: "git-tag" as const },
    },
    {
      expected: "dev (feature/test)",
      name: "formats git branch labels with branch",
      params: {
        channel: "dev",
        gitBranch: "feature/test",
        source: "git-branch" as const,
      },
    },
    {
      expected: "dev (branch)",
      name: "formats git branch labels without branch",
      params: { channel: "dev", source: "git-branch" as const },
    },
    {
      expected: "stable (default)",
      name: "formats default labels",
      params: { channel: "stable", source: "default" as const },
    },
  ] satisfies {
    name: string;
    params: Parameters<typeof formatUpdateChannelLabel>[0];
    expected: string;
  }[])("$name", ({ params, expected }) => {
    expect(formatUpdateChannelLabel(params)).toBe(expected);
  });
});

describe("resolveUpdateChannelDisplay", () => {
  it("includes the derived label for git branches", () => {
    expect(
      resolveUpdateChannelDisplay({
        gitBranch: "feature/test",
        installKind: "git",
      }),
    ).toEqual({
      channel: "dev",
      label: "dev (feature/test)",
      source: "git-branch",
    });
  });

  it("prefers git tag precedence over branch metadata in the derived label", () => {
    expect(
      resolveUpdateChannelDisplay({
        gitBranch: "feature/test",
        gitTag: "v2026.2.24-beta.1",
        installKind: "git",
      }),
    ).toEqual({
      channel: "beta",
      label: "beta (v2026.2.24-beta.1)",
      source: "git-tag",
    });
  });

  it("does not synthesize git metadata when both tag and branch are missing", () => {
    expect(
      resolveUpdateChannelDisplay({
        installKind: "package",
      }),
    ).toEqual({
      channel: "stable",
      label: "stable (default)",
      source: "default",
    });
  });
});
