/**
 * dreams-mcp — servidor MCP (Model Context Protocol) do plugin Dreams.
 *
 * TICKET-HARNESS-45 (Frente 1) — Dual-entrypoint:
 *   - entrada nativa OpenCode: `src/index.ts` (plugin);
 *   - entrada universal MCP: este servidor, falado por stdio (JSON-RPC), para
 *     IDEs/clientes externos (Antigravity, OpenCode CLI, Claude Desktop etc.).
 *
 * Regras de transporte:
 *   - O stdout é EXCLUSIVO do protocolo JSON-RPC. Qualquer diagnóstico/log é
 *     escrito em `stderr` (`console.error`), jamais em `console.log`.
 *   - As ferramentas são síncronas sobre SQLite (bun:sqlite); por isso a
 *     assinatura do handler é `async` apenas por contrato do SDK, sem I/O
 *     bloqueante de rede no caminho crítico.
 *
 * Segurança:
 *   - `dream_learn` aplica `redactSecrets` antes de qualquer persistência
 *     (e `DreamsDB.insertMemory` reaplica como defesa em profundidade).
 *   - `dream_recall` aplica `sanitizeFts5Query` como gate: uma query sem
 *     nenhum token alfanumérico é rejeitada com resultado vazio (evita o
 *     fallback LIKE `%%` retornar o banco inteiro).
 *   - `scope` é validado contra o formato canônico `collective|agent:<nome>`,
 *     bloqueando escopos malformados/traversal.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DreamsDB,
  sanitizeFts5Query,
  DREAMS_DIR_MODE,
  DREAMS_FILE_MODE,
  type MemoryCategory,
  type MemoryRecord,
} from "../core/db";
import { redactSecrets } from "../core/security";

export const MCP_SERVER_NAME = "dreams-mcp";
export const MCP_SERVER_VERSION = "1.0.3";

/** Categorias canônicas aceitas por `dream_learn` (espelha `MemoryCategory`). */
export const MEMORY_CATEGORIES = [
  "learning",
  "decision",
  "pitfall",
  "preference",
] as const satisfies readonly MemoryCategory[];

/**
 * Escopo válido: `collective` ou `agent:<nome>` com caracteres seguros.
 * Mantido em sincronia com `src/tools.ts` (mesmo contrato, mesma defesa).
 */
const SCOPE_PATTERN = /^(collective|agent:[a-zA-Z0-9_-]+)$/;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export interface DreamsPaths {
  /** Diretório raiz do Dreams (contém `dreams.db` e `daily/`). */
  dir: string;
  /** Caminho absoluto do SQLite. */
  dbPath: string;
  /** Diretório do stream diário JSONL (`log_<YYYY-MM-DD>.jsonl`). */
  dailyDir: string;
}

type Environment = Record<string, string | undefined>;

/**
 * Resolve os caminhos do Dreams respeitando, em ordem de precedência:
 *   1. `DREAMS_DB_PATH` (arquivo SQLite explícito);
 *   2. `DREAMS_DIR` (diretório raiz; DB = `<dir>/dreams.db`);
 *   3. default `~/.config/opencode/dreams` (mesmo default do plugin).
 *
 * O diretório do log diário acompanha o diretório raiz resolvido — nunca é
 * interpolado a partir de entrada do usuário.
 */
export function resolveDreamsPaths(
  env: Environment = process.env,
  home: string = os.homedir()
): DreamsPaths {
  const dirOverride = env.DREAMS_DIR?.trim();
  const dbOverride = env.DREAMS_DB_PATH?.trim();

  const dir = dirOverride
    ? path.resolve(dirOverride)
    : dbOverride
      ? path.dirname(path.resolve(dbOverride))
      : path.join(home, ".config/opencode/dreams");

  const dbPath = dbOverride ? path.resolve(dbOverride) : path.join(dir, "dreams.db");

  return { dir, dbPath, dailyDir: path.join(dir, "daily") };
}

/**
 * Abre o DreamsDB com mensagem de erro descritiva (fail-fast no boot do
 * servidor, em vez de um processo MCP vivo porém inoperante).
 */
export function openDreamsDatabase(paths: DreamsPaths = resolveDreamsPaths()): DreamsDB {
  try {
    return new DreamsDB(paths.dbPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[${MCP_SERVER_NAME}] unable to open DreamsDB at '${paths.dbPath}': ${detail}`
    );
  }
}

/**
 * Espelho da persistência durável do `dream_learn` nativo: append no JSONL
 * diário (`<dir>/daily/log_<YYYY-MM-DD>.jsonl`), marcado com
 * `synced_to_db: true` porque o insert síncrono no SQLite já ocorreu.
 *
 * Retorna o caminho do arquivo. Propaga erro de I/O para o chamador decidir
 * (o handler degrada de forma graciosa: o fato já está no SQLite).
 */
export function appendDailyLog(
  paths: DreamsPaths,
  scope: string,
  fact: string,
  category: MemoryCategory,
  now: Date = new Date()
): string {
  // TICKET-DREAMS-07 (defesa em profundidade POSIX): o MCP escreve o MESMO
  // JSONL diário que a tool `dream_learn` do plugin. Se este processo for o
  // primeiro a criar o arquivo, ele precisa nascer `0o600` — do contrário a
  // janela de leitura por outros usuários da máquina fica aberta.
  fs.mkdirSync(paths.dailyDir, { recursive: true, mode: DREAMS_DIR_MODE });
  try {
    fs.chmodSync(paths.dailyDir, DREAMS_DIR_MODE);
  } catch (error) {
    // best-effort: filesystem read-only ou owner divergente.
    void error;
  }
  const dateStr = now.toISOString().split("T")[0];
  const file = path.join(paths.dailyDir, `log_${dateStr}.jsonl`);
  const record = {
    scope,
    fact,
    category,
    timestamp: now.toISOString(),
    synced_to_db: true,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", {
    encoding: "utf8",
    mode: DREAMS_FILE_MODE,
  });
  try {
    fs.chmodSync(file, DREAMS_FILE_MODE);
  } catch (error) {
    // best-effort: artefato herdado em filesystem hostil.
    void error;
  }
  return file;
}

export interface DreamMcpContext {
  db: DreamsDB;
  paths: DreamsPaths;
}

export interface CreateServerOptions {
  db?: DreamsDB;
  paths?: DreamsPaths;
}

/** Serializa apenas os campos públicos/estáveis de uma memória. */
export function serializeMemory(record: MemoryRecord) {
  return {
    id: record.id ?? null,
    scope: record.scope,
    category: record.category,
    fact: record.fact,
    score: record.score,
    decay_weight: record.decay_weight,
    confirmations: record.confirmations,
    recall_count: record.recall_count,
    last_reinforced: record.last_reinforced,
    created_at: record.created_at,
  };
}

function textResult(payload: unknown, suffix = ""): {
  content: Array<{ type: "text"; text: string }>;
} {
  const body = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text: suffix ? `${body}\n\n${suffix}` : body }],
  };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cria o `McpServer` já com as ferramentas `dream_learn` e `dream_recall`
 * registradas. Exportado para testes determinísticos (injeção de DB temporário
 * e transporte em memória), sem precisar tocar o banco real do usuário.
 */
export function createDreamsMcpServer(options: CreateServerOptions = {}): McpServer {
  const paths = options.paths ?? resolveDreamsPaths();
  const db = options.db ?? openDreamsDatabase(paths);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Dreams persistent memory. Use dream_learn to store a durable fact " +
        "(secret-redacted) and dream_recall to retrieve memories via full-text search.",
    }
  );

  server.registerTool(
    "dream_learn",
    {
      title: "Dream Learn",
      description:
        "Persist a durable memory in the Dreams store. Secrets are redacted " +
        "before writing to SQLite and to the daily JSONL stream. " +
        "scope defaults to 'collective'; category defaults to 'learning'.",
      inputSchema: {
        fact: z
          .string()
          .min(1)
          .describe("Fact/learning to persist. Credentials are redacted automatically."),
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .default("learning")
          .describe("Memory category (learning | decision | pitfall | preference)."),
        scope: z
          .string()
          .optional()
          .default("collective")
          .describe("Target scope: 'collective' (default) or 'agent:<name>'."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ fact, category, scope }) => {
      if (!SCOPE_PATTERN.test(scope)) {
        return errorResult(
          `Invalid scope '${scope}'. Expected 'collective' or 'agent:<name>' ` +
            "(allowed chars: [a-zA-Z0-9_-])."
        );
      }

      // Redação determinística ANTES de qualquer persistência (JSONL/SQLite).
      const sanitizedFact = redactSecrets(fact).trim();
      if (!sanitizedFact) {
        return errorResult("The fact is empty after secret redaction.");
      }

      try {
        const id = db.insertMemory(scope, sanitizedFact, category as MemoryCategory);

        // O JSONL diário é complementar: falha de I/O não invalida o insert
        // canônico no SQLite. O desvio é reportado no payload.
        let dailyLog: string | null = null;
        let dailyLogError: string | null = null;
        try {
          dailyLog = appendDailyLog(paths, scope, sanitizedFact, category as MemoryCategory);
        } catch (error) {
          dailyLogError = errorMessage(error);
        }

        const payload = {
          status: "ok",
          id,
          scope,
          category,
          fact: sanitizedFact,
          database: paths.dbPath,
          daily_log: dailyLog,
          daily_log_error: dailyLogError,
          stored_at: new Date().toISOString(),
        };

        const confirmation = dailyLog
          ? `Memory logged to daily stream for scope '${scope}'. Will be consolidated tonight.`
          : `Memory stored in SQLite for scope '${scope}'. Daily stream append failed: ${dailyLogError}`;

        return textResult(payload, confirmation);
      } catch (error) {
        return errorResult(`dream_learn failed: ${errorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "dream_recall",
    {
      title: "Dream Recall",
      description:
        "Retrieve durable memories from the Dreams SQLite store using full-text " +
        "search (FTS5) with a LIKE fallback. Sanitized query; limit default 10.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text search query."),
        scope: z
          .string()
          .optional()
          .describe("Restrict to an exact scope ('collective' or 'agent:<name>')."),
        category: z
          .string()
          .min(1)
          .optional()
          .describe("Restrict to a category (learning | decision | pitfall | preference)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .default(DEFAULT_LIMIT)
          .describe(`Maximum number of memories (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, scope, category, limit }) => {
      if (scope !== undefined && !SCOPE_PATTERN.test(scope)) {
        return errorResult(
          `Invalid scope '${scope}'. Expected 'collective' or 'agent:<name>' ` +
            "(allowed chars: [a-zA-Z0-9_-])."
        );
      }

      // Gate de segurança: sem tokens alfanuméricos não há MATCH FTS5 válido e
      // o fallback LIKE com a string crua poderia varrer o banco inteiro.
      const sanitizedQuery = sanitizeFts5Query(query);
      if (!sanitizedQuery) {
        return textResult(
          {
            status: "ok",
            query,
            sanitized_query: "",
            count: 0,
            memories: [],
          },
          "No searchable tokens in query; nothing was recalled."
        );
      }

      try {
        // `db.recall` reaplica a sanitização para o MATCH FTS5, mas preserva a
        // query ORIGINAL para o fallback LIKE — por isso passamos `query`.
        const records = db.recall(query, scope, category, limit);
        const payload = {
          status: "ok",
          query,
          sanitized_query: sanitizedQuery,
          scope: scope ?? null,
          category: category ?? null,
          limit,
          count: records.length,
          memories: records.map(serializeMemory),
        };
        const suffix =
          records.length === 0
            ? "No relevant memories found."
            : `${records.length} memor${records.length === 1 ? "y" : "ies"} recalled.`;
        return textResult(payload, suffix);
      } catch (error) {
        return errorResult(`dream_recall failed: ${errorMessage(error)}`);
      }
    }
  );

  return server;
}

export interface StartServerOptions extends CreateServerOptions {
  /** Transporte injetável (default: `StdioServerTransport`). */
  transport?: Transport;
}

/**
 * Conecta o servidor ao transporte stdio (entrada universal MCP).
 *
 * Retorna as referências vivas para que o chamador (CLI/bin ou teste) possa
 * encerrar de forma limpa. Em `bin/agent-dreams.js`, sinais SIGINT/SIGTERM
 * fecham o servidor antes de sair.
 */
export async function startServer(options: StartServerOptions = {}): Promise<{
  server: McpServer;
  transport: Transport;
}> {
  const server = createDreamsMcpServer(options);
  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
