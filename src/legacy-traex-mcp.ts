export interface ConfiguredMcpServer {
  name?: string;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
  };
}

export function legacyIteamMcpServerNames(servers: ConfiguredMcpServer[]): string[] {
  return (servers || [])
    .filter(server => {
      const name = String(server.name || "");
      const command = String(server.transport?.command || "");
      const args = Array.isArray(server.transport?.args) ? server.transport.args : [];
      return (
        /^iteam-chat-agent_[A-Za-z0-9_-]+$/.test(name) &&
        [command, ...args].some(value =>
          String(value).replaceAll("\\", "/").split("/").pop()?.match(/^chat-bridge\.(?:mjs|js|ts)$/)
        )
      );
    })
    .map(server => String(server.name));
}
