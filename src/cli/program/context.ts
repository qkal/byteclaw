import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

export interface ProgramContext {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
}

export function createProgramContext(): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = (): string[] => {
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  return {
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
    get channelOptions() {
      return getChannelOptions();
    },
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    programVersion: VERSION,
  };
}
