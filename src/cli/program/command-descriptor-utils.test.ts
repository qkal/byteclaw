import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  addCommandDescriptorsToProgram,
  collectUniqueCommandDescriptors,
  defineCommandDescriptorCatalog,
  getCommandDescriptorNames,
  getCommandsWithSubcommands,
} from "./command-descriptor-utils.js";

describe("command-descriptor-utils", () => {
  const descriptors = [
    { description: "Alpha", hasSubcommands: false, name: "alpha" },
    { description: "Beta", hasSubcommands: true, name: "beta" },
    { description: "Gamma", hasSubcommands: true, name: "gamma" },
  ] as const;

  it("returns descriptor names in order", () => {
    expect(getCommandDescriptorNames(descriptors)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns commands with subcommands", () => {
    expect(getCommandsWithSubcommands(descriptors)).toEqual(["beta", "gamma"]);
  });

  it("collects unique descriptors across groups in order", () => {
    expect(
      collectUniqueCommandDescriptors([
        [
          { description: "Alpha", name: "alpha" },
          { description: "Beta", name: "beta" },
        ],
        [
          { description: "Ignored duplicate", name: "beta" },
          { description: "Gamma", name: "gamma" },
        ],
      ]),
    ).toEqual([
      { description: "Alpha", name: "alpha" },
      { description: "Beta", name: "beta" },
      { description: "Gamma", name: "gamma" },
    ]);
  });

  it("defines a reusable descriptor catalog", () => {
    const catalog = defineCommandDescriptorCatalog(descriptors);

    expect(catalog.descriptors).toBe(descriptors);
    expect(catalog.getDescriptors()).toBe(descriptors);
    expect(catalog.getNames()).toEqual(["alpha", "beta", "gamma"]);
    expect(catalog.getCommandsWithSubcommands()).toEqual(["beta", "gamma"]);
  });

  it("adds descriptors without duplicating existing commands", () => {
    const program = new Command();
    const existingCommands = addCommandDescriptorsToProgram(program, descriptors);

    addCommandDescriptorsToProgram(
      program,
      [
        { description: "Ignored duplicate", name: "beta" },
        { description: "Delta", name: "delta" },
      ],
      existingCommands,
    );

    expect(program.commands.map((command) => command.name())).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});
