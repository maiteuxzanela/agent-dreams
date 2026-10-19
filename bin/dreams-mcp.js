#!/usr/bin/env bun
/**
 * dreams-mcp — executável universal do servidor MCP do plugin Dreams.
 *
 * TICKET-HARNESS-45 (Frente 1). Fala JSON-RPC sobre stdio, então:
 *   - NUNCA escreva logs em stdout (quebra o protocolo);
 *   - diagnóstico vai para stderr.
 *
 * Uso:
 *   bunx --bun dreams-mcp            (após instalar o pacote)
 *   ./bin/dreams-mcp.js              (checkout local, executável)
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
      console.error("[dreams-mcp] error during shutdown:", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    ({ server } = await startServer());
    console.error("[dreams-mcp] ready on stdio");
  } catch (error) {
    console.error("[dreams-mcp] failed to start:", error);
    process.exit(1);
  }
}
