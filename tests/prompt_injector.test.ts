import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  MAX_MEMORY_LINES,
  MAX_MEMORY_CHARS,
  ANTI_DUMP_NOTICE_MARKER,
  INJECTION_HEADER,
  COLLECTIVE_SECTION_HEADER,
  PERSONA_SECTION_HEADER_PREFIX,
  applyAntiDumpLimit,
  readCollectiveMemory,
  readPersonaMemory,
  resolveSessionAgent,
  buildSystemPromptInjection,
  wrapSystemPromptInjection,
  defaultDreamsDir,
} from "../src/core/prompt_injector";
import { serverPlugin } from "../src/index";

// ============================================================================
// ANTI-MOCK ESTRITO (Quality Gate): nenhum jest.mock / vi.mock / MagicMock /
// stub de módulo. Toda dependência é REAL:
//   - memórias: arquivos .md de verdade em mkdtemp(/tmp) com cleanup total;
//   - SQLite: bancos reais criados via bun:sqlite em /tmp;
//   - SDK: createOpencodeClient real apontado para porta fechada (falha de
//     rede genuína, não simulada) para exercitar o fail-soft do resolutor;
//   - hook: chamado através do serverPlugin real de src/index.ts com
//     input/output reais.
// ============================================================================

const TEST_ROOT = fs.mkdtempSync(path.join("/tmp", "dreams_prompt_injector_"));
const DREAMS_TMP = path.join(TEST_ROOT, "dreams");
const COLLECTIVE_FILE = path.join(DREAMS_TMP, "collective", "COLLECTIVE_MEMORY.md");
const PERSONAS_DIR = path.join(DREAMS_TMP, "personas");

function resetDreamsDir(): void {
  fs.rmSync(DREAMS_TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(DREAMS_TMP, "collective"), { recursive: true });
  fs.mkdirSync(PERSONAS_DIR, { recursive: true });
}

function writeCollective(content: string): void {
  fs.mkdirSync(path.join(DREAMS_TMP, "collective"), { recursive: true });
  fs.writeFileSync(COLLECTIVE_FILE, content, "utf8");
}

function writePersona(agent: string, content: string): void {
  fs.mkdirSync(PERSONAS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PERSONAS_DIR, `${agent}.md`), content, "utf8");
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `Linha ${i + 1} da memoria consolidada`).join("\n");
}

beforeAll(() => {
  resetDreamsDir();
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Leitura da memória coletiva em diretório temporário real
// ---------------------------------------------------------------------------
describe("prompt_injector — memória coletiva (diretório temporário real)", () => {
  beforeEach(() => resetDreamsDir());

  test("readCollectiveMemory lê collective/COLLECTIVE_MEMORY.md do diretório informado", () => {
    writeCollective("# Memória Coletiva de Teste\nFato coletivo: Dante orquestra o harness.");
    const content = readCollectiveMemory(DREAMS_TMP);
    expect(content).toBeString();
    expect(content!).toContain("Fato coletivo: Dante orquestra o harness.");
  });

  test("readCollectiveMemory ignora dreamsDir vazio/não-string sem lançar", () => {
    expect(readCollectiveMemory("")).toBeNull();
    expect(readCollectiveMemory("   ")).toBeNull();
    expect(readCollectiveMemory(undefined as unknown as string)).toBeNull();
  });

  test("buildSystemPromptInjection(agentName=null) monta bloco só com a seção coletiva", () => {
    writeCollective("Fato coletivo para o bloco.");
    const block = buildSystemPromptInjection(DREAMS_TMP, null);
    expect(block).toBeString();
    expect(block!.startsWith(INJECTION_HEADER)).toBe(true);
    expect(block!).toContain(COLLECTIVE_SECTION_HEADER);
    expect(block!).toContain("Fato coletivo para o bloco.");
    expect(block!).not.toContain(PERSONA_SECTION_HEADER_PREFIX);
  });

  test("wrapSystemPromptInjection(dir, undefined, null) devolve o bloco coletivo sem tocar em rede/DB", async () => {
    writeCollective("Fato coletivo via wrap.");
    const block = await wrapSystemPromptInjection(DREAMS_TMP, undefined, null);
    expect(block).toBeString();
    expect(block!.startsWith(INJECTION_HEADER)).toBe(true);
    expect(block!).toContain("Fato coletivo via wrap.");
  });
});

// ---------------------------------------------------------------------------
// 2. Leitura da memória individual de persona
// ---------------------------------------------------------------------------
describe("prompt_injector — memória individual de persona", () => {
  beforeEach(() => resetDreamsDir());

  test("readPersonaMemory lê personas/<agent>.md do diretório temporário", () => {
    writePersona("kael", "Kael prefere inferência na GPU Pascal.");
    const content = readPersonaMemory(DREAMS_TMP, "kael");
    expect(content).toBeString();
    expect(content!).toContain("Kael prefere inferência na GPU Pascal.");
  });

  test("buildSystemPromptInjection inclui a seção da persona quando o arquivo existe", () => {
    writeCollective("Coletivo existe.");
    writePersona("clara", "Clara é a guardiã do Quality Gate.");
    const block = buildSystemPromptInjection(DREAMS_TMP, "clara");
    expect(block).toBeString();
    expect(block!).toContain(COLLECTIVE_SECTION_HEADER);
    expect(block!).toContain(`${PERSONA_SECTION_HEADER_PREFIX}clara)`);
    expect(block!).toContain("Clara é a guardiã do Quality Gate.");
  });

  test("persona sem arquivo: bloco contém só a coletiva (persona pulada graciosamente)", () => {
    writeCollective("Só coletivo.");
    const block = buildSystemPromptInjection(DREAMS_TMP, "persona_inexistente");
    expect(block).toBeString();
    expect(block!).toContain("Só coletivo.");
    expect(block!).not.toContain(PERSONA_SECTION_HEADER_PREFIX);
  });

  test("apenas persona (sem coletiva): bloco monta só a seção da persona", () => {
    writePersona("maya", "Maya faz busca AST cirúrgica.");
    const block = buildSystemPromptInjection(DREAMS_TMP, "maya");
    expect(block).toBeString();
    expect(block!.startsWith(INJECTION_HEADER)).toBe(true);
    expect(block!).toContain(`${PERSONA_SECTION_HEADER_PREFIX}maya)`);
    expect(block!).not.toContain(COLLECTIVE_SECTION_HEADER);
  });

  test("readPersonaMemory bloqueia path traversal e nomes inválidos (retorna null)", () => {
    writeCollective("coletivo");
    expect(readPersonaMemory(DREAMS_TMP, "../x")).toBeNull();
    expect(readPersonaMemory(DREAMS_TMP, "a/b")).toBeNull();
    expect(readPersonaMemory(DREAMS_TMP, "")).toBeNull();
    expect(readPersonaMemory(DREAMS_TMP, ".oculto")).toBeNull();
    expect(readPersonaMemory(DREAMS_TMP, undefined as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback gracioso: arquivos ausentes, diretórios vazios, sessão inválida
// ---------------------------------------------------------------------------
describe("prompt_injector — fallback gracioso (nunca lança)", () => {
  beforeEach(() => resetDreamsDir());

  test("diretório vazio: collective, build e wrap retornam null", async () => {
    expect(readCollectiveMemory(DREAMS_TMP)).toBeNull();
    expect(buildSystemPromptInjection(DREAMS_TMP, null)).toBeNull();
    const block = await wrapSystemPromptInjection(DREAMS_TMP, undefined, null);
    expect(block).toBeNull();
  });

  test("diretório inexistente: retorna null sem lançar", async () => {
    const missing = path.join(TEST_ROOT, "nao_existe_ainda");
    expect(readCollectiveMemory(missing)).toBeNull();
    expect(buildSystemPromptInjection(missing, null)).toBeNull();
    expect(await wrapSystemPromptInjection(missing, undefined, null)).toBeNull();
  });

  test("arquivo vazio ou só com espaços em branco: retorna null", () => {
    writeCollective("");
    expect(readCollectiveMemory(DREAMS_TMP)).toBeNull();
    writeCollective("   \n\t\n   ");
    expect(readCollectiveMemory(DREAMS_TMP)).toBeNull();
    writePersona("kael", "");
    expect(readPersonaMemory(DREAMS_TMP, "kael")).toBeNull();
  });

  test("resolveSessionAgent: sessionID undefined/vazio/whitespace → null", async () => {
    expect(await resolveSessionAgent(undefined, null)).toBeNull();
    expect(await resolveSessionAgent("", null)).toBeNull();
    expect(await resolveSessionAgent("   ", null)).toBeNull();
  });

  test("resolveSessionAgent: sessionID desconhecido + banco inexistente → null sem exceção", async () => {
    const missingDb = path.join(TEST_ROOT, "opencode_falso.db");
    expect(await resolveSessionAgent("ses_inexistente_xyz", null, missingDb)).toBeNull();
  });

  test("resolveSessionAgent: cliente real com porta fechada → fail-soft null (rede falha de verdade)", async () => {
    const deadClient = createOpencodeClient({ baseURL: "http://127.0.0.1:1/" });
    const missingDb = path.join(TEST_ROOT, "opencode_falso_2.db");
    const agent = await resolveSessionAgent("ses_fake_dead_port", deadClient, missingDb);
    expect(agent).toBeNull();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 4. Resolução de agente via SQLite real em /tmp (sem servidor, sem mock)
// ---------------------------------------------------------------------------
describe("prompt_injector — resolução de agente via SQLite real (/tmp)", () => {
  beforeEach(() => resetDreamsDir());

  test("lê agent da tabela session", async () => {
    const dbPath = path.join(TEST_ROOT, "sessions_session.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT)");
    db.query("INSERT INTO session (id, agent) VALUES (?, ?)").run("ses_db_1", "cris");
    db.close();

    expect(await resolveSessionAgent("ses_db_1", null, dbPath)).toBe("cris");
  });

  test("lê agent da tabela session_v2 e normaliza prefixos (opencode/<nome>)", async () => {
    const dbPath = path.join(TEST_ROOT, "sessions_session_v2.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, agent TEXT)");
    db.query("INSERT INTO session_v2 (id, agent) VALUES (?, ?)").run("ses_v2_1", "opencode/maya");
    db.close();

    expect(await resolveSessionAgent("ses_v2_1", null, dbPath)).toBe("maya");
  });

  test("fallback: json_extract do agent na mensagem mais recente (tabela message)", async () => {
    const dbPath = path.join(TEST_ROOT, "sessions_message.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE message (session_id TEXT, data TEXT, time_created INTEGER)");
    db.query("INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)").run(
      "ses_msg_1",
      JSON.stringify({ agent: "agent:dante", text: "mensagem" }),
      1000
    );
    db.query("INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)").run(
      "ses_msg_1",
      JSON.stringify({ agent: "opencode/clara", text: "mais recente" }),
      2000
    );
    db.close();

    expect(await resolveSessionAgent("ses_msg_1", null, dbPath)).toBe("clara");
  });

  test("sessão ausente no banco real → null", async () => {
    const dbPath = path.join(TEST_ROOT, "sessions_vazio.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT)");
    db.close();

    expect(await resolveSessionAgent("ses_nao_esta_la", null, dbPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Truncamento anti-dumping (teto de 150 linhas / 8000 chars)
// ---------------------------------------------------------------------------
describe("prompt_injector — truncamento anti-dumping", () => {
  beforeEach(() => resetDreamsDir());

  test("applyAntiDumpLimit trunca arquivo com 500 linhas e anexa o aviso", () => {
    const result = applyAntiDumpLimit(makeLines(500));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(ANTI_DUMP_NOTICE_MARKER);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(MAX_MEMORY_LINES + 3);
    expect(result.text).not.toContain("Linha 500 da memoria consolidada");
    expect(result.text).toContain("Linha 1 da memoria consolidada");
  });

  test("applyAntiDumpLimit preserva conteúdo curto sem truncar nem avisar", () => {
    const short = "Conteúdo curto dentro do teto.";
    const result = applyAntiDumpLimit(short);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(short);
    expect(result.text).not.toContain(ANTI_DUMP_NOTICE_MARKER);
  });

  test("applyAntiDumpLimit com conteúdo vazio devolve { text: '', truncated: false }", () => {
    expect(applyAntiDumpLimit("")).toEqual({ text: "", truncated: false });
  });

  test("applyAntiDumpLimit respeita o teto de caracteres em linha única gigante", () => {
    const huge = "x".repeat(MAX_MEMORY_CHARS * 3);
    const result = applyAntiDumpLimit(huge);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(ANTI_DUMP_NOTICE_MARKER);
    expect(result.text.length).toBeLessThan(MAX_MEMORY_CHARS + 300);
  });

  test("readCollectiveMemory aplica o teto: >150 linhas truncadas com aviso no arquivo real", () => {
    writeCollective(makeLines(500));
    const content = readCollectiveMemory(DREAMS_TMP);
    expect(content).toBeString();
    expect(content!).toContain(ANTI_DUMP_NOTICE_MARKER);
    expect(content!.split("\n").length).toBeLessThanOrEqual(MAX_MEMORY_LINES + 3);
    expect(content!).not.toContain("Linha 500 da memoria consolidada");
  });

  test("readPersonaMemory também aplica o teto anti-dumping", () => {
    writePersona("kael", makeLines(400));
    const content = readPersonaMemory(DREAMS_TMP, "kael");
    expect(content).toBeString();
    expect(content!).toContain(ANTI_DUMP_NOTICE_MARKER);
    expect(content!.split("\n").length).toBeLessThanOrEqual(MAX_MEMORY_LINES + 3);
  });
});

// ---------------------------------------------------------------------------
// 6. Hook experimental.chat.system.transform via serverPlugin real
// ---------------------------------------------------------------------------
describe("hook experimental.chat.system.transform (serverPlugin real)", () => {
  // Input REAL do SDK: cliente genuíno (porta fechada = falha de rede real),
  // shell Bun real e diretório real do plugin. O plugin só consome `client`,
  // mas o objeto segue a forma completa de PluginInput.
  const pluginDir = path.resolve(import.meta.dir, "..");
  const model = { id: "test-model", name: "test-model", providerID: "test", modelID: "test" } as any;

  let hooks: Awaited<ReturnType<typeof serverPlugin>>;

  beforeAll(async () => {
    hooks = await serverPlugin({
      client: createOpencodeClient({ baseURL: "http://127.0.0.1:1/" }),
      project: { id: "prj_test", worktree: null } as any,
      directory: pluginDir,
      worktree: pluginDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://127.0.0.1:1/"),
      $: (globalThis as any).Bun.$,
    });
  });

  afterAll(async () => {
    await hooks?.dispose?.();
  });

  test("hook está registrado no retorno do plugin e é função", () => {
    const hookFn = hooks["experimental.chat.system.transform"];
    expect(hookFn).toBeFunction();
  });

  test("injeta a memória coletiva real em output.system (sessionID ausente = agente não resolvido)", async () => {
    const hookFn = hooks["experimental.chat.system.transform"]!;
    const output: { system: string[] } = { system: [] };

    await hookFn({ sessionID: undefined, model }, output);

    expect(Array.isArray(output.system)).toBe(true);
    const hasCollective = readCollectiveMemory(defaultDreamsDir()) !== null;
    if (hasCollective) {
      expect(output.system.length).toBe(1);
      expect(output.system[0].startsWith(INJECTION_HEADER)).toBe(true);
      expect(output.system[0]).toContain(COLLECTIVE_SECTION_HEADER);
      // Sem sessão resolvida não pode haver seção de persona.
      expect(output.system[0]).not.toContain(PERSONA_SECTION_HEADER_PREFIX);
    } else {
      // Sem memória coletiva em produção: nada é injetado (contrato null).
      expect(output.system.length).toBe(0);
    }
  });

  test("fail-safe: sessão inexistente com cliente real não lança e injeta no máximo o bloco coletivo", async () => {
    const hookFn = hooks["experimental.chat.system.transform"]!;
    const output: { system: string[] } = { system: [] };

    await hookFn({ sessionID: "ses_clara_fake_nao_existe_000", model }, output);

    expect(output.system.length).toBeLessThanOrEqual(1);
    for (const block of output.system) {
      expect(block.startsWith(INJECTION_HEADER)).toBe(true);
    }
  }, 15000);

  test("fail-safe total: hook nunca rejeita a promise, mesmo com output inicial já populado", async () => {
    const hookFn = hooks["experimental.chat.system.transform"]!;
    const output: { system: string[] } = { system: ["bloco preexistente do sistema"] };

    await expect(hookFn({ sessionID: undefined, model }, output)).resolves.toBeUndefined();
    // Bloco pré-existente é preservado; push é aditivo.
    expect(output.system[0]).toBe("bloco preexistente do sistema");
    expect(output.system.length).toBeLessThanOrEqual(2);
  });
});
