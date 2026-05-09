import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import * as path from "path";

const server = new McpServer({ name: "clean", version: "0.0.1" });

server.tool({
  name: "echo",
  description: "Echo back the supplied message",
  inputSchema: {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  },
  handler: async ({ msg }: { msg: string }) => ({
    content: [{ type: "text", text: msg }],
  }),
});

server.tool({
  name: "fixed_path_lookup",
  description: "Look up a value from a fixed local config",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
  handler: async ({ key }: { key: string }) => {
    const fixedConfigPath = path.join(__dirname, "config.json");
    return {
      content: [{ type: "text", text: `${key} from ${fixedConfigPath}` }],
    };
  },
});

export default server;
