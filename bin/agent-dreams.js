#!/usr/bin/env bun
/**
 * agent-dreams — executável universal do servidor MCP do plugin Dreams.
 *
 * TICKET-HARNESS-45. Fala JSON-RPC sobre stdio:
 *   - NUNCA escreva logs em stdout (quebra o protocolo MCP);
 *   - diagnóstico vai exclusivamente para stderr.
 *
 * Uso:
 *   bunx agent-dreams                (via registro NPM ou local)
 *   ./bin/agent-dreams.js            (checkout local, executável)
 *
 * Configuração de caminho: DREAMS_DB_PATH ou DREAMS_DIR, com default em
 * ~/.config/opencode/dreams/dreams.db.
 */
import { startServer } from "../src/mcp/server.ts";

if (import.meta.main) {
  let server;
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server?.close();
    } catch (error) {
      console.error("[agent-dreams] error during shutdown:", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    ({ server } = await startServer());
    console.error("[agent-dreams] ready on stdio");
  } catch (error) {
    console.error("[agent-dreams] failed to start:", error);
    process.exit(1);
  }
}
