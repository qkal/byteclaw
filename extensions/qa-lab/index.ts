import { definePluginEntry } from "./runtime-api.js";
import { registerQaLabCli } from "./src/cli.js";

export default definePluginEntry({
  description: "Private QA automation harness and debugger UI",
  id: "qa-lab",
  name: "QA Lab",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        registerQaLabCli(program);
      },
      {
        descriptors: [
          {
            description: "Run QA scenarios and launch the private QA debugger UI",
            hasSubcommands: true,
            name: "qa",
          },
        ],
      },
    );
  },
});
