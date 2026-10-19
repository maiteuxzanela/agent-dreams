/**
 * TICKET-HARNESS-45 — Frente 1: MCP Server Universal (dual-entrypoint).
 *
 * Suíte determinística SDET (Test Engineer) — SEM mocks.
 *
 * O que é exercitado de verdade:
 *   - O binário `bin/dreams-mcp.js` é iniciado como SUBPROCESSO real
 *     (`process.execPath` = bun) e fala JSON-RPC via stdio.
 *   - O cliente é o `Client` oficial de `@modelcontextprotocol/sdk`, conectado
 *     por `StdioClientTransport` — o mesmo caminho que Claude Desktop/Cursor
 *     usam. Nada de `registerTool` chamado em processo nem stub de transporte.
 *   - O SQLite é REAL (WAL, FTS5, triggers) e isolado em `mkdtemp` sob /tmp via
 *     `DREAMS_DB_PATH`; o stream diário JSONL também é real e isolado.
 *   - A verificação de redação de segredos é feita em três camadas:
 *       1. payload de retorno da tool;
 *       2. linhas da tabela `memories` (leitura por conexão independente);
 *       3. bytes crus de `dreams.db`, `-wal`, `-shm` e do JSONL diário.
 *
 * Contrato coberto:
 *   - `listTools`: nomes, schemas JSON (required/defaults/enum/limites) e
 *     annotations de `dream_learn` / `dream_recall`.
 *   - `dream_learn`: defaults, scope `agent:<nome>`, categoria, rejeição de
 *     scope malformado, fato vazio pós-redação e persistência dual (SQLite+JSONL).
 *   - `dream_recall`: busca exata, neutralização de operadores FTS5
 *     (`OR`, `:`, `*`, parênteses), filtros de scope/category, `limit` e o gate
 *     que impede uma query sem tokens de vazar o banco pelo fallback LIKE.
 *   - `resolveDreamsPaths`: precedência `DREAMS_DB_PATH` > `DREAMS_DIR` >
 *     default do plugin.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveDreamsPaths } from "../src/mcp/server";

// ---------------------------------------------------------------------------
// Isolamento absoluto: FS + SQLite reais em diretório temporário exclusivo.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MCP_BIN = path.join(REPO_ROOT, "bin", "agent-dreams.js");
const LEGACY_MCP_BIN = path.join(REPO_ROOT, "bin", "dreams-mcp.js");
const TEST_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_mcp_sdet_"));
const DB_PATH = path.join(TEST_BASE, "dreams.db");
const DAILY_DIR = path.join(TEST_BASE, "daily");

// ---------------------------------------------------------------------------
// Credenciais sintéticas (nunca reais) — formatos exatos reconhecidos.
// ---------------------------------------------------------------------------
const OPENAI_KEY = "sk-proj-SDET1234567890abcdefghijklmnop";
const PASSWORD_VALUE = "SuperSecret123!";
const GITHUB_TOKEN = "ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWxYz";
const RAW_SECRETS = [OPENAI_KEY, PASSWORD_VALUE, GITHUB_TOKEN] as const;

const REDACTED = "***REDACTED***";

let client: Client;
let transport: StdioClientTransport;

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.DREAMS_DB_PATH = DB_PATH;
  env.DREAMS_DIR = TEST_BASE;
  env.DREAMS_OFFLINE = "1";
  return env;
}

interface ToolCallResult {
  /** Texto completo devolvido pelo servidor (JSON + sufixo de confirmação). */
  raw: string;
  /** `isError` do protocolo MCP. */
  isError: boolean;
  /** Payload JSON parseado da primeira seção do conteúdo textual. */
  payload: Record<string, any>;
}

/**
 * Chama uma tool pelo cliente MCP real. O servidor devolve
 * `${JSON.stringify(payload, null, 2)}\n\n${sufixo}`; separamos o JSON do
 * sufixo humano. Os nossos fatos nunca contêm linha em branco, então a primeira
 * ocorrência de "\n\n" é o separador canônico.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const result: any = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const raw = content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text))
    .join("\n");
  const separator = raw.indexOf("\n\n");
  const jsonText = separator === -1 ? raw : raw.slice(0, separator);
  return {
    raw,
    isError: result.isError === true,
    payload: JSON.parse(jsonText) as Record<string, any>,
  };
}

/** Conexão independente (somente leitura) para inspecionar o SQLite real. */
function readMemoryRows(): Array<{
  id: number;
  scope: string;
  fact: string;
  category: string;
  recall_count: number;
}> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .query(
        "SELECT id, scope, fact, category, recall_count FROM memories ORDER BY id ASC"
      )
      .all() as any;
  } finally {
    db.close();
  }
}

/** Todos os arquivos persistidos que poderiam reter um segredo cru. */
function persistedFiles(): string[] {
  const files: string[] = [];
  for (const candidate of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  if (fs.existsSync(DAILY_DIR)) {
    for (const name of fs.readdirSync(DAILY_DIR).sort()) {
      files.push(path.join(DAILY_DIR, name));
    }
  }
  return files;
}

/** Falha se algum segredo cru sobreviver em QUALQUER byte persistido. */
function expectNoRawSecretOnDisk(label: string): void {
  const files = persistedFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    for (const secret of RAW_SECRETS) {
      if (bytes.includes(Buffer.from(secret))) {
        throw new Error(
          `[${label}] credencial crua '${secret}' vazou no arquivo ${file}`
        );
      }
    }
  }
}

function readDailyRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(DAILY_DIR)) return records;
  for (const name of fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    const raw = fs.readFileSync(path.join(DAILY_DIR, name), "utf-8");
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") records.push(JSON.parse(line));
    }
  }
  return records;
}

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: buildChildEnv(),
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  client = new Client({ name: "dreams-sdet-client", version: "1.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  try {
    await client?.close();
  } finally {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Handshake + descoberta de ferramentas (listTools)
// ---------------------------------------------------------------------------
describe("HARNESS-45/F1 — handshake e descoberta de tools", () => {
  test("expõe exatamente dream_learn e dream_recall", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "dream_learn",
      "dream_recall",
    ]);
  });

  test("dream_learn: schema exige 'fact' e documenta category/scope com defaults", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "dream_learn");
    expect(tool).toBeDefined();

    const schema = tool!.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "category",
      "fact",
      "scope",
    ]);
    expect(schema.required).toEqual(["fact"]);

    expect(schema.properties.fact.type).toBe("string");
    expect(schema.properties.fact.minLength).toBe(1);

    expect(schema.properties.category.type).toBe("string");
    expect(schema.properties.category.enum).toEqual([
      "learning",
      "decision",
      "pitfall",
      "preference",
    ]);
    expect(schema.properties.category.default).toBe("learning");

    expect(schema.properties.scope.type).toBe("string");
    expect(schema.properties.scope.default).toBe("collective");

    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  test("dream_recall: schema exige 'query' e limita limit a 1..100 (default 10)", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "dream_recall");
    expect(tool).toBeDefined();

    const schema = tool!.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "category",
      "limit",
      "query",
      "scope",
    ]);
    expect(schema.required).toEqual(["query"]);

    expect(schema.properties.query.type).toBe("string");
    expect(schema.properties.query.minLength).toBe(1);

    expect(schema.properties.limit.type).toBe("integer");
    expect(schema.properties.limit.minimum).toBe(1);
    expect(schema.properties.limit.maximum).toBe(100);
    expect(schema.properties.limit.default).toBe(10);

    expect(tool!.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. dream_learn — persistência real + redação de segredos
// ---------------------------------------------------------------------------
describe("HARNESS-45/F1 — dream_learn (persistência e redação)", () => {
  test("defaults (collective/learning), DB isolado e segredos redigidos no retorno, SQLite e JSONL", async () => {
    const fact =
      `Chave exposta ${OPENAI_KEY} e password=${PASSWORD_VALUE} ` +
      `com token ${GITHUB_TOKEN} no log de sessão`;

    const result = await callTool("dream_learn", { fact });

    expect(result.isError).toBe(false);
    expect(result.payload.status).toBe("ok");
    // Defaults aplicados pelo schema.
    expect(result.payload.scope).toBe("collective");
    expect(result.payload.category).toBe("learning");
    // O subprocesso honrou DREAMS_DB_PATH (isolamento real, não o DB do usuário).
    expect(result.payload.database).toBe(DB_PATH);
    expect(result.payload.daily_log).toContain(path.join(TEST_BASE, "daily"));
    expect(result.payload.daily_log_error).toBeNull();
    expect(typeof result.payload.id).toBe("number");

    // (1) Retorno da tool: placeholders presentes, credenciais cruas ausentes.
    expect(result.payload.fact).toContain(`sk-${REDACTED}`);
    expect(result.payload.fact).toContain(`password=${REDACTED}`);
    expect(result.payload.fact).toContain(`gh-${REDACTED}`);
    for (const secret of RAW_SECRETS) {
      expect(result.payload.fact).not.toContain(secret);
    }

    // (2) SQLite real: a linha persistida é a versão redigida.
    const row = readMemoryRows().find((entry) => entry.id === result.payload.id);
    expect(row).toBeDefined();
    expect(row!.scope).toBe("collective");
    expect(row!.category).toBe("learning");
    expect(row!.fact).toBe(result.payload.fact);
    for (const secret of RAW_SECRETS) {
      expect(row!.fact).not.toContain(secret);
    }

    // (3) JSONL diário real: mesmo conteúdo redigido.
    const daily = readDailyRecords();
    const record = daily.find((entry) => entry.fact === result.payload.fact);
    expect(record).toBeDefined();
    expect(record!.scope).toBe("collective");
    expect(record!.category).toBe("learning");
    expect(record!.synced_to_db).toBe(true);

    // (4) Nenhum byte cru em DB/WAL/SHM/JSONL.
    expectNoRawSecretOnDisk("learn-defaults");
  });

  test("aceita scope agent:<nome> e category explícita", async () => {
    const result = await callTool("dream_learn", {
      fact: "Pitfall real: parser deve ser reiniciado após mutação de gramática",
      scope: "agent:alice",
      category: "pitfall",
    });

    expect(result.isError).toBe(false);
    expect(result.payload.scope).toBe("agent:alice");
    expect(result.payload.category).toBe("pitfall");

    const row = readMemoryRows().find((entry) => entry.id === result.payload.id);
    expect(row).toMatchObject({
      scope: "agent:alice",
      category: "pitfall",
    });
  });

  test("rejeita scope malformado sem persistir nenhuma linha", async () => {
    const before = readMemoryRows().length;
    const result = await callTool("dream_learn", {
      fact: "tentativa de path traversal",
      scope: "../evil",
    });

    expect(result.isError).toBe(true);
    expect(result.payload.status).toBe("error");
    expect(result.payload.error).toContain("Invalid scope '../evil'");
    expect(readMemoryRows().length).toBe(before);
  });

  test("rejeita fato que fica vazio após trim/redação", async () => {
    const before = readMemoryRows().length;
    const result = await callTool("dream_learn", { fact: "    " });

    expect(result.isError).toBe(true);
    expect(result.payload.error).toContain("empty after secret redaction");
    expect(readMemoryRows().length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. dream_recall — FTS5 real, neutralização de operadores e filtros
// ---------------------------------------------------------------------------
describe("HARNESS-45/F1 — dream_recall (busca real e filtros)", () => {
  const SEEDS = [
    {
      fact: "recallalpha deterministic suite covers the MCP stdio transport",
      scope: "collective",
      category: "learning",
    },
    {
      fact: "recallbeta operator injection must be neutralized by the sanitizer",
      scope: "agent:alice",
      category: "pitfall",
    },
    {
      fact: "recallbeta deploy pipeline relies on real sqlite persistence",
      scope: "agent:bob",
      category: "decision",
    },
    {
      fact: "the agent:alice scope filter target appears only once here",
      scope: "collective",
      category: "learning",
    },
    {
      fact: "limitprobe first record for pagination",
      scope: "collective",
      category: "learning",
    },
    {
      fact: "limitprobe second record for pagination",
      scope: "collective",
      category: "decision",
    },
    {
      fact: "limitprobe third record for pagination",
      scope: "collective",
      category: "preference",
    },
  ] as const;

  beforeAll(async () => {
    for (const seed of SEEDS) {
      const result = await callTool("dream_learn", seed);
      expect(result.isError).toBe(false);
    }
  });

  test("busca exata por termo retorna as memórias reais e incrementa recall_count", async () => {
    const first = await callTool("dream_recall", { query: "recallbeta" });

    expect(first.isError).toBe(false);
    expect(first.payload.status).toBe("ok");
    expect(first.payload.query).toBe("recallbeta");
    expect(first.payload.sanitized_query).toBe('"recallbeta"');
    expect(first.payload.count).toBe(2);
    expect(first.payload.limit).toBe(10); // default do schema

    const facts = first.payload.memories.map((memory: any) => memory.fact);
    expect(facts).toHaveLength(2);
    for (const entry of first.payload.memories) {
      expect(entry.fact).toContain("recallbeta");
      expect(typeof entry.id).toBe("number");
      expect(entry.recall_count).toBeGreaterThanOrEqual(1);
    }

    // Efeito colateral real no SQLite: recall_count foi incrementado.
    const second = await callTool("dream_recall", { query: "recallbeta" });
    const byId = new Map(second.payload.memories.map((m: any) => [m.id, m]));
    for (const entry of first.payload.memories) {
      const refreshed = byId.get(entry.id) as any;
      expect(refreshed).toBeDefined();
      expect(refreshed.recall_count).toBe(entry.recall_count + 1);
    }
  });

  test("operador OR do FTS5 é neutralizado como termo literal (não amplia a busca)", async () => {
    const result = await callTool("dream_recall", {
      query: "recallbeta OR injection",
    });

    expect(result.isError).toBe(false);
    // A sanitização converte TUDO em termos literais entre aspas (AND implícito).
    expect(result.payload.sanitized_query).toBe(
      '"recallbeta" "OR" "injection"'
    );
    // O token literal "OR" não existe em nenhum fato: a query devolve 0,
    // provando que o operador não foi interpretado pelo motor FTS5.
    expect(result.payload.count).toBe(0);
    expect(result.payload.memories).toEqual([]);
  });

  test("dois-pontos (filtro de coluna FTS5) e hífen são tratados como tokens", async () => {
    const colon = await callTool("dream_recall", { query: "agent:alice" });
    expect(colon.isError).toBe(false);
    expect(colon.payload.sanitized_query).toBe('"agent" "alice"');
    expect(colon.payload.count).toBeGreaterThanOrEqual(1);
    expect(
      colon.payload.memories.every((memory: any) =>
        (memory.fact as string).includes("agent:alice")
      )
    ).toBe(true);

    const hyphen = await callTool("dream_recall", { query: "agent:alice" });
    expect(hyphen.payload.sanitized_query).toBe('"agent" "alice"');
  });

  test("filtros exatos de scope e category restringem o resultado", async () => {
    const byScope = await callTool("dream_recall", {
      query: "recallbeta",
      scope: "agent:alice",
    });
    expect(byScope.isError).toBe(false);
    expect(byScope.payload.scope).toBe("agent:alice");
    expect(byScope.payload.count).toBe(1);
    expect(byScope.payload.memories[0].fact).toContain("neutralized");

    const byCategory = await callTool("dream_recall", {
      query: "recallbeta",
      category: "decision",
    });
    expect(byCategory.isError).toBe(false);
    expect(byCategory.payload.category).toBe("decision");
    expect(byCategory.payload.count).toBe(1);
    expect(byCategory.payload.memories[0].fact).toContain("deploy pipeline");

    const combined = await callTool("dream_recall", {
      query: "recallbeta",
      scope: "agent:bob",
      category: "decision",
    });
    expect(combined.payload.count).toBe(1);
    expect(combined.payload.scope).toBe("agent:bob");
    expect(combined.payload.category).toBe("decision");

    const contradiction = await callTool("dream_recall", {
      query: "recallbeta",
      scope: "agent:alice",
      category: "decision",
    });
    expect(contradiction.payload.count).toBe(0);
  });

  test("limit é respeitado (1 e 100) e o default é 10", async () => {
    const limited = await callTool("dream_recall", {
      query: "limitprobe",
      limit: 1,
    });
    expect(limited.isError).toBe(false);
    expect(limited.payload.limit).toBe(1);
    expect(limited.payload.count).toBe(1);
    expect(limited.raw).toContain("1 memory recalled.");

    const all = await callTool("dream_recall", {
      query: "limitprobe",
      limit: 100,
    });
    expect(all.payload.limit).toBe(100);
    expect(all.payload.count).toBe(3);
    expect(all.raw).toContain("3 memories recalled.");

    const defaulted = await callTool("dream_recall", { query: "limitprobe" });
    expect(defaulted.payload.limit).toBe(10);
    expect(defaulted.payload.count).toBe(3);
  });

  test("query sem tokens não vaza o banco pelo fallback LIKE", async () => {
    // Os fatos do cenário 2 contêm os placeholders "***REDACTED***"; se o gate
    // fosse removido, o fallback LIKE '%***%' devolveria essas memórias.
    const result = await callTool("dream_recall", {
      query: "***",
    });

    expect(result.isError).toBe(false);
    expect(result.payload.status).toBe("ok");
    expect(result.payload.sanitized_query).toBe("");
    expect(result.payload.count).toBe(0);
    expect(result.payload.memories).toEqual([]);
    expect(result.raw).toContain("No searchable tokens");
  });

  test("rejeita scope de filtro malformado", async () => {
    const result = await callTool("dream_recall", {
      query: "recallbeta",
      scope: "agent:../evil",
    });
    expect(result.isError).toBe(true);
    expect(result.payload.status).toBe("error");
    expect(result.payload.error).toContain("Invalid scope");
  });
});

// ---------------------------------------------------------------------------
// 4. Contrato puro de resolução de caminhos (precedência de env)
// ---------------------------------------------------------------------------
describe("HARNESS-45/F1 — resolveDreamsPaths", () => {
  test("DREAMS_DB_PATH governa o arquivo e DREAMS_DIR o diretório raiz/diário", () => {
    // Contrato real (server.ts): a precedência 1 resolve o ARQUIVO SQLite; a
    // precedência 2 resolve o DIRETÓRIO RAIZ de onde o JSONL diário deriva.
    // Assim é possível apontar um DB explícito mantendo o stream diário no root
    // configurado — o diário NUNCA é interpolado do nome do arquivo do banco.
    const resolved = resolveDreamsPaths(
      { DREAMS_DB_PATH: "/tmp/sdet/custom.db", DREAMS_DIR: "/tmp/other" },
      "/home/sdet"
    );
    expect(resolved.dbPath).toBe("/tmp/sdet/custom.db");
    expect(resolved.dir).toBe("/tmp/other");
    expect(resolved.dailyDir).toBe("/tmp/other/daily");
  });

  test("DREAMS_DB_PATH sozinho deriva o diretório raiz do próprio arquivo", () => {
    const resolved = resolveDreamsPaths(
      { DREAMS_DB_PATH: "/tmp/sdet-only/nested/custom.db" },
      "/home/sdet"
    );
    expect(resolved.dbPath).toBe("/tmp/sdet-only/nested/custom.db");
    expect(resolved.dir).toBe("/tmp/sdet-only/nested");
    expect(resolved.dailyDir).toBe("/tmp/sdet-only/nested/daily");
  });

  test("DREAMS_DIR sem DB explícito deriva <dir>/dreams.db", () => {
    const resolved = resolveDreamsPaths({ DREAMS_DIR: "/tmp/sdet-dir" }, "/home/sdet");
    expect(resolved.dbPath).toBe("/tmp/sdet-dir/dreams.db");
    expect(resolved.dir).toBe("/tmp/sdet-dir");
    expect(resolved.dailyDir).toBe("/tmp/sdet-dir/daily");
  });

  test("sem env cai no default do plugin (~/.config/opencode/dreams)", () => {
    const resolved = resolveDreamsPaths({}, "/home/sdet");
    expect(resolved.dbPath).toBe("/home/sdet/.config/opencode/dreams/dreams.db");
    expect(resolved.dir).toBe("/home/sdet/.config/opencode/dreams");
    expect(resolved.dailyDir).toBe("/home/sdet/.config/opencode/dreams/daily");
  });

  test("alias legado bin/dreams-mcp.js e novo bin/agent-dreams.js existem e são executáveis", () => {
    expect(fs.existsSync(MCP_BIN)).toBe(true);
    expect(fs.existsSync(LEGACY_MCP_BIN)).toBe(true);
    const mcpStat = fs.statSync(MCP_BIN);
    const legacyStat = fs.statSync(LEGACY_MCP_BIN);
    // Bits de execução presentes
    expect((mcpStat.mode & 0o111) !== 0).toBe(true);
    expect((legacyStat.mode & 0o111) !== 0).toBe(true);
  });
});
