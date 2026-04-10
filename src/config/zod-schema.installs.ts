import { z } from "zod";

export const InstallSourceSchema = z.union([
  z.literal("npm"),
  z.literal("archive"),
  z.literal("path"),
  z.literal("clawhub"),
]);

export const PluginInstallSourceSchema = z.union([InstallSourceSchema, z.literal("marketplace")]);

export const InstallRecordShape = {
  clawhubChannel: z
    .union([z.literal("official"), z.literal("community"), z.literal("private")])
    .optional(),
  clawhubFamily: z.union([z.literal("code-plugin"), z.literal("bundle-plugin")]).optional(),
  clawhubPackage: z.string().optional(),
  clawhubUrl: z.string().optional(),
  installPath: z.string().optional(),
  installedAt: z.string().optional(),
  integrity: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedName: z.string().optional(),
  resolvedSpec: z.string().optional(),
  resolvedVersion: z.string().optional(),
  shasum: z.string().optional(),
  source: InstallSourceSchema,
  sourcePath: z.string().optional(),
  spec: z.string().optional(),
  version: z.string().optional(),
} as const;

export const PluginInstallRecordShape = {
  ...InstallRecordShape,
  marketplaceName: z.string().optional(),
  marketplacePlugin: z.string().optional(),
  marketplaceSource: z.string().optional(),
  source: PluginInstallSourceSchema,
} as const;
