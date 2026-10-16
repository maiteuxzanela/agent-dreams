import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { DreamsDB, CATEGORY_WEIGHTS, sanitizeFts5Query } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";
import { dream_learn, dream_recall } from "../src/tools";
import {
  readRecentDialogues,
  summarizeDialogues,
  readRecentDialogueSummary,
} from "../src/core/session_reader";
import {
  parseMimoMemories,
  validateMemory,
  stripAnsi,
  synthesizeMemories,
  buildSynthesisPrompt,
  MimoSynthesizer,
  DEFAULT_MIMO_MODEL,
  DEFAULT_FALLBACK_MODEL,
} from "../src/core/mimo_synthesizer";
import fs from "fs";
import path from "path";

// DEF-01: diretório base 100% isolado em /tmp — os testes NUNCA tocam em
// ~/.config/opencode/dreams (memória/DB de produção).
const TEST_BASE_DIR = path.join("/tmp", `opencode_dreams_test_${Date.now()}`);
const DB_PATH = path.join(TEST_BASE_DIR, "test_dreams.db");
const DAILY_DIR = path.join(TEST_BASE_DIR, "daily");
const COLLECTIVE_DIR = path.join(TEST_BASE_DIR, "collective");
const PERSONAS_DIR = path.join(TEST_BASE_DIR, "personas");

describe("OpenCode Dreams Plugin — Banco e Ciclo Local", () => {
  let db: DreamsDB;
  let cycle: SleepCycle;

  beforeAll(() => {
    fs.mkdirSync(TEST_BASE_DIR, { recursive: true });
    db = new DreamsDB(DB_PATH);
    cycle = new SleepCycle(db, {
      baseDir: TEST_BASE_DIR,
      sessionDbPath: path.join(TEST_BASE_DIR, "non_existent.db"), // isolado de ~/.local/share
    });
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  });

  test("Should insert memories and use SQLite FTS5 for search", () => {
    db.insertMemory("collective", "Maiteux gosta de usar o Laya RLCD para inferência local estruturada", "learning");
    db.insertMemory("agent:cris", "Cris deve focar em telas web responsivas", "preference");
    
    // Lexical search
    const results = db.recall("Laya RLCD");
    expect(results.length).toBe(1);
    expect(results[0].fact).toContain("Maiteux gosta de usar o Laya RLCD");
    
    const resultsCris = db.recall("telas", "agent:cris");
    expect(resultsCris.length).toBe(1);
    expect(resultsCris[0].fact).toContain("telas web");
  });

  test("DEF-02: Temporal decay should reduce score and archive old memories", async () => {
    // Insert an old memory explicitly
    db.insertMemory("collective", "Fato antigo que será esquecido", "learning");
    const all = db.getAllMemories();
    const oldMemory = all.find(m => m.fact === "Fato antigo que será esquecido");
    
    // Force last_reinforced (e created_at) para 30 dias atrás: deepSleep mede o
    // delta_t a partir de last_reinforced com fallback em created_at.
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    (db as any).db.run(
      "UPDATE memories SET created_at = ?, last_reinforced = ? WHERE id = ?",
      [oldDate.toISOString(), oldDate.toISOString(), oldMemory?.id]
    );
    
    await cycle.deepSleep(); // Apply decay
    
    const remaining = db.getAllMemories();
    const stillExists = remaining.some(m => m.fact === "Fato antigo que será esquecido");
    expect(stillExists).toBe(false); // Below threshold and deleted

    // Garantia matemática: memória reforçada hoje (delta_t ~ 0) NÃO é arquivada
    // apenas por ser "antiga" em created_at.
    db.insertMemory("collective", "Fato reforçado hoje não pode ser arquivado", "learning");
    const fresh = db.getAllMemories().find(m => m.fact === "Fato reforçado hoje não pode ser arquivado");
    (db as any).db.run(
      "UPDATE memories SET created_at = ?, last_reinforced = ? WHERE id = ?",
      [oldDate.toISOString(), new Date().toISOString(), fresh?.id]
    );
    await cycle.deepSleep();
    const survived = db.getAllMemories().some(m => m.fact === "Fato reforçado hoje não pode ser arquivado");
    expect(survived).toBe(true);
  });

  test("Memory isolation for personas", async () => {
    db.insertMemory("agent:kael", "Kael prefere não usar Ollama localmente se puder evitar", "preference");
    cycle.updateProjections();

    const collectiveContent = fs.readFileSync(path.join(COLLECTIVE_DIR, "COLLECTIVE_MEMORY.md"), "utf-8");
    const kaelContent = fs.readFileSync(path.join(PERSONAS_DIR, "kael.md"), "utf-8");
    
    expect(collectiveContent).not.toContain("Kael prefere não usar Ollama");
    expect(kaelContent).toContain("Kael prefere não usar Ollama");
  });

  test("Token count for injections should be small (<= 500 chars limit as rough proxy for now)", async () => {
    const collectiveContent = fs.readFileSync(path.join(COLLECTIVE_DIR, "COLLECTIVE_MEMORY.md"), "utf-8");
    expect(collectiveContent.length).toBeLessThan(1000);
  });

  test("DEF-06: Light Sleep aplica fallback category='learning' para session.idle sem categoria", async () => {
    const logPath = path.join(DAILY_DIR, "log_def06.jsonl");
    const fact = "Fato de teste sem categoria explícita vindo de session.idle";
    fs.writeFileSync(logPath, JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n");

    await cycle.lightSleep();

    const mem = db.getAllMemories().find(m => m.fact === fact);
    expect(mem).toBeDefined();
    expect(mem!.category).toBe("learning");
    expect(mem!.scope).toBe("collective");
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(logPath + ".processed")).toBe(true);
  });

  test("DEF-10: Light Sleep não reforça score de eventos triviais repetidos (session.idle)", async () => {
    const fact = "Sessão finalizada no diretório /tmp/def10_repeticao";
    fs.writeFileSync(
      path.join(DAILY_DIR, "log_def10_first.jsonl"),
      JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n"
    );
    await cycle.lightSleep();

    const first = db.getAllMemories().find(m => m.fact === fact);
    expect(first).toBeDefined();
    expect(first!.confirmations).toBe(1);
    expect(first!.score).toBe(1.0);

    fs.writeFileSync(
      path.join(DAILY_DIR, "log_def10_repeat.jsonl"),
      JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n"
    );
    await cycle.lightSleep();

    const repeated = db.getAllMemories().find(m => m.fact === fact);
    expect(repeated!.confirmations).toBe(1);
    expect(repeated!.score).toBe(1.0);
  });

  test("DEF-10: reforço de fatos repetidos é limitado por teto (sem inflação infinita)", () => {
    const fact = "Sessão finalizada no diretório /tmp/def10_teto";
    for (let i = 0; i < 20; i++) {
      db.insertMemory("collective", fact, "learning");
    }
    const mem = db.getAllMemories().find(m => m.fact === fact);
    expect(mem).toBeDefined();
    expect(mem!.confirmations).toBe(DreamsDB.MAX_CONFIRMATIONS);
    expect(mem!.confirmations).toBeLessThanOrEqual(10);
    expect(mem!.score).toBeLessThanOrEqual(DreamsDB.MAX_SCORE);
    expect(mem!.score).toBe(5);
  });

  test("Light Sleep should expunge old daily files (.processed/.jsonl) older than 3 days", async () => {
    const oldFilePath = path.join(DAILY_DIR, "log_2023-01-01.jsonl.processed");
    fs.writeFileSync(oldFilePath, JSON.stringify({fake: "data"}));
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    fs.utimesSync(oldFilePath, tenDaysAgo, tenDaysAgo);
    
    const recentJsonlPath = path.join(DAILY_DIR, "log_recent.jsonl");
    fs.writeFileSync(recentJsonlPath, JSON.stringify({recent: true, fact: "test"}));
    
    await cycle.lightSleep();
    
    const oldExists = fs.existsSync(oldFilePath);
    expect(oldExists).toBe(false);
    
    const recentProcessed = recentJsonlPath + ".processed";
    const recentProcessedExists = fs.existsSync(recentProcessed);
    expect(recentProcessedExists).toBe(true);
  });

  test("DEF-03: dream_learn valida o scope e rejeita Directory Traversal", () => {
    expect(() => dream_learn({ scope: "../../etc/passwd", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "agent:../escape", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "agent:", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "outro:scope", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();

    const message = dream_learn({ scope: "collective", fact: "Fato válido para validação de scope", category: "learning" }, { dailyDir: DAILY_DIR });
    expect(message).toContain("collective");

    const written = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith(".jsonl"));
    expect(written.length).toBeGreaterThan(0);
    const content = written.map(f => fs.readFileSync(path.join(DAILY_DIR, f), "utf-8")).join("\n");
    expect(content).toContain("Fato válido para validação de scope");
    expect(fs.existsSync(path.join(TEST_BASE_DIR, "log_def03_escape.jsonl"))).toBe(false);
  });

  test("DEF-03: updateProjections bloqueia Directory Traversal no nome do agente", () => {
    db.insertMemory("agent:../../escape", "Fato hostil de traversal", "learning");
    db.insertMemory("agent:..", "Fato hostil de traversal dois", "learning");

    cycle.updateProjections();

    expect(fs.existsSync(path.join(TEST_BASE_DIR, "escape.md"))).toBe(false);
    expect(fs.existsSync(path.join("/tmp", "escape.md"))).toBe(false);
    const personas = fs.readdirSync(PERSONAS_DIR);
    expect(personas.length).toBeGreaterThan(0);
    expect(personas.every(f => /^[a-zA-Z0-9_-]+\.md$/.test(f))).toBe(true);
  });
});

describe("src/index.ts E2E (HOME isolado em /tmp)", () => {
  test("DEF-05/DEF-09/4C: log diário na escrita e reabertura transparente do DB após dispose", () => {
    const tmpHome = path.join("/tmp", `opencode_dreams_index_${Date.now()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    try {
      const proc = Bun.spawnSync(
        [process.execPath, path.join(import.meta.dir, "fixtures", "index_e2e.ts")],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: { ...process.env, HOME: tmpHome },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stdout = new TextDecoder().decode(proc.stdout);
      const line = stdout.split("\n").find(l => l.startsWith("E2E_RESULT:"));
      expect(line).toBeDefined();
      expect(proc.exitCode).toBe(0);

      const result = JSON.parse(line!.slice("E2E_RESULT:".length));
      const today = new Date().toISOString().split("T")[0];

      expect(String(result.dailyDir).startsWith(tmpHome)).toBe(true);
      expect(result.todayLogExists).toBe(true);
      expect(result.todayLogName).toBe(`log_${today}.jsonl`);
      expect(String(result.todayLogContent)).toContain("Fato E2E DEF-05 gravado no log do dia corrente");
      expect(result.eventHookRemoved).toBe(true);
      expect(result.disposeSuccess).toBe(true);
      // TICKET-DREAMS-04 (Frente 4C) SUPERSEDE o antigo "recall falha após
      // dispose": o singleton é zerado e o acesso seguinte reabre transparente.
      expect(result.dbReopenedAfterDispose).toBe(true);
      expect(result.recallAfterDisposeHasFact).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("session_reader — Leitura read-only, Placeholders Exatos e Truncamento Invertido", () => {
  const tmpDir = path.join("/tmp", `opencode_session_reader_test_${Date.now()}`);
  const dbPath = path.join(tmpDir, "opencode.db");
  let sqliteDb: Database;

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    sqliteDb = new Database(dbPath);
    sqliteDb.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        time_created INTEGER,
        data TEXT
      );
    `);

    const now = Date.now();
    // 5 mensagens em ordem cronológica
    for (let i = 1; i <= 5; i++) {
      const msgId = `msg_batch_${i}`;
      const timeMsg = now - (6000 - i * 1000);
      const role = i % 2 === 1 ? "user" : "assistant";
      sqliteDb.run(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        [msgId, "ses_batch", timeMsg, JSON.stringify({ role })]
      );

      // Part 1: reasoning (apenas assistant)
      if (role === "assistant") {
        sqliteDb.run(
          "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
          [`part_r_${i}`, msgId, timeMsg + 10, JSON.stringify({ type: "reasoning", text: `Raciocínio interno da mensagem ${i}` })]
        );
      }

      // Part 2: text útil
      sqliteDb.run(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        [`part_t_${i}`, msgId, timeMsg + 20, JSON.stringify({ type: "text", text: `Texto principal da mensagem ${i} sobre arquitetura tri-camada.` })]
      );

      // Part 3: tool noise (deve ser descartado)
      sqliteDb.run(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        [`part_tool_${i}`, msgId, timeMsg + 30, JSON.stringify({ type: "tool", name: "bash", text: "stdout ruidoso" })]
      );
    }

    // Mensagem 6: mensagem sem partes de texto (apenas ruído)
    sqliteDb.run(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      ["msg_noise_only", "ses_batch", now - 500, JSON.stringify({ role: "assistant" })]
    );
    sqliteDb.run(
      "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
      ["part_only_tool", "msg_noise_only", now - 450, JSON.stringify({ type: "tool", name: "bash", text: "apenas ferramenta" })]
    );
  });

  afterAll(() => {
    sqliteDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("readRecentDialogues extrai texto e descarta ferramentas/ruídos", () => {
    const entriesWithReasoning = readRecentDialogues({ dbPath, includeReasoning: true });
    // 5 mensagens úteis: 3 user (1 part cada) + 2 assistant (2 parts cada = reasoning + text) = 7 entries
    expect(entriesWithReasoning.length).toBe(7);

    const entriesTextOnly = readRecentDialogues({ dbPath, includeReasoning: false });
    // 5 mensagens úteis text-only
    expect(entriesTextOnly.length).toBe(5);
    expect(entriesTextOnly.every(e => e.kind === "text")).toBe(true);
    expect(entriesTextOnly[0].text).toContain("mensagem 1");
    expect(entriesTextOnly[4].text).toContain("mensagem 5");
  });

  test("readRecentDialogues constrói query de parts com placeholders exatos e respeita limit", () => {
    // Limit = 2: busca as 2 mensagens mais recentes (msg_noise_only e msg_batch_5)
    // msg_noise_only não tem partes textuais, então apenas msg_batch_5 devolve entry
    const entries = readRecentDialogues({ dbPath, limit: 2, includeReasoning: false });
    expect(entries.length).toBe(1);
    expect(entries[0].message_id).toBe("msg_batch_5");
    expect(entries[0].text).toContain("mensagem 5");
  });

  test("summarizeDialogues inverte truncamento preservando o final da timeline com prefixo", () => {
    const entries = readRecentDialogues({ dbPath, includeReasoning: false });
    // Resumo completo sem exceder limite: sem prefixo de omissão
    const summaryNoLimit = summarizeDialogues(entries, { maxChars: 5000 });
    expect(summaryNoLimit.startsWith("[… início do dia omitido]")).toBe(false);
    expect(summaryNoLimit).toContain("mensagem 1");
    expect(summaryNoLimit).toContain("mensagem 5");

    // Resumo com limite curto: deve cortar o início e reter o final
    const shortSummary = summarizeDialogues(entries, { maxChars: 120 });
    expect(shortSummary.startsWith("[… início do dia omitido]\n\n")).toBe(true);
    expect(shortSummary).toContain("mensagem 5");
    expect(shortSummary).not.toContain("mensagem 1");
    expect(shortSummary.length).toBeLessThanOrEqual(120);
  });

  test("summarizeDialogues respeita o teto padrão de 120.000 caracteres", () => {
    // Cria entries gigantes somando > 130.000 caracteres
    const bigEntries = Array.from({ length: 150 }, (_, i) => ({
      session_id: "ses_big",
      message_id: `msg_big_${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as any,
      kind: "text" as const,
      text: `Linha de diálogo ${i}: ` + "A".repeat(1000),
      timestamp: Date.now() - (150 - i) * 1000,
      time_iso: new Date(Date.now() - (150 - i) * 1000).toISOString(),
      truncated: false,
    }));

    const defaultSummary = summarizeDialogues(bigEntries); // default maxChars = 120_000
    expect(defaultSummary.length).toBeLessThanOrEqual(120_000);
    expect(defaultSummary.startsWith("[… início do dia omitido]\n\n")).toBe(true);
    expect(defaultSummary).toContain("Linha de diálogo 149:");
  });

  test("readRecentDialogueSummary é fail-soft com banco ausente ou vazio", () => {
    const missing = readRecentDialogueSummary({ dbPath: "/tmp/banco_inexistente_12345.db" });
    expect(missing).toBe("");
  });
});

describe("mimo_synthesizer — Parsing Robusto, Normalização de Idioma e Sanitização", () => {
  test("stripAnsi remove sequências de escape ANSI", () => {
    const raw = "\u001b[31mErro formatado\u001b[0m e texto limpo";
    expect(stripAnsi(raw)).toBe("Erro formatado e texto limpo");
  });

  test("validateMemory valida itens e sanitiza escopos contra traversal", () => {
    const valid = validateMemory({
      scope: "collective",
      category: "preference",
      fact: "Maiteux prefere utilizar a arquitetura tri-camada com Cactus Needle 3",
    });
    expect(valid).not.toBeNull();
    expect(valid?.scope).toBe("collective");
    expect(valid?.category).toBe("preference");

    const traversal = validateMemory({
      scope: "agent:../../escape",
      category: "learning",
      fact: "Aprendizado específico que tentou escapar do diretório de personas",
    });
    expect(traversal).not.toBeNull();
    expect(traversal?.scope).toBe("agent:escape");

    const pureDots = validateMemory({
      scope: "agent:../..",
      category: "learning",
      fact: "Aprendizado específico com pontos puros de traversal",
    });
    expect(pureDots).not.toBeNull();
    expect(pureDots?.scope).toBe("collective");

    const invalidCat = validateMemory({
      scope: "collective",
      category: "categoria_desconhecida",
      fact: "Fato com categoria inválida",
    });
    expect(invalidCat).toBeNull();

    const shortFact = validateMemory({
      scope: "collective",
      category: "learning",
      fact: "curto",
    });
    expect(shortFact).toBeNull();
  });

  test("Normaliza alias em português para categorias canônicas", () => {
    expect(validateMemory({ scope: "collective", category: "aprendizado", fact: "Lição aprendida em português" })?.category).toBe("learning");
    expect(validateMemory({ scope: "collective", category: "preferência", fact: "Preferência da usuária registrada" })?.category).toBe("preference");
    expect(validateMemory({ scope: "collective", category: "decisão", fact: "Decisão arquitetural firmada" })?.category).toBe("decision");
    expect(validateMemory({ scope: "collective", category: "armadilha", fact: "Armadilha de concorrência superada" })?.category).toBe("pitfall");
    expect(validateMemory({ scope: "collective", category: "bug", fact: "Bug de concorrência detectado e corrigido" })?.category).toBe("pitfall");
  });

  test("parseMimoMemories extrai JSON cercado por markdown ou prosa", () => {
    const raw = `
Aqui está a destilação cognitiva solicitada:
\`\`\`json
[
  {
    "scope": "collective",
    "category": "decision",
    "fact": "Fica estabelecido o uso de bun:sqlite em modo readonly para leitura de sessões"
  },
  {
    "scope": "agent:tulio",
    "category": "learning",
    "fact": "Túlio mantém a paridade estrita entre schemas e contratos do servidor MCP"
  }
]
\`\`\`
Essas foram as memórias extraídas.
`;
    const { memories, dropped, parsed } = parseMimoMemories(raw);
    expect(parsed).toBe(true);
    expect(memories.length).toBe(2);
    expect(dropped).toBe(0);
    expect(memories[0].category).toBe("decision");
    expect(memories[1].scope).toBe("agent:tulio");
  });

  test("parseMimoMemories tolera JSON com wrapper object { memories: [...] }", () => {
    const raw = JSON.stringify({
      memories: [
        { scope: "collective", category: "learning", fact: "Fato dentro de objeto wrapper" },
      ],
    });
    const { memories, parsed } = parseMimoMemories(raw);
    expect(parsed).toBe(true);
    expect(memories.length).toBe(1);
    expect(memories[0].fact).toBe("Fato dentro de objeto wrapper");
  });

  test("parseMimoMemories varre colchetes de forma robusta sem teto arbitrário de 24", () => {
    const noise = Array.from({ length: 40 }, (_, i) => `[tag_${i}]`).join(" ");
    const raw = `${noise} Texto com array final: [{"scope":"collective","category":"learning","fact":"Varredura robusta sem limite de 24 colchetes"}]`;
    const { memories, parsed } = parseMimoMemories(raw);
    expect(parsed).toBe(true);
    expect(memories.length).toBe(1);
    expect(memories[0].fact).toContain("Varredura robusta");
  });

  test("parseMimoMemories descarta duplicatas e contabiliza itens inválidos em dropped", () => {
    const raw = JSON.stringify([
      { scope: "collective", category: "learning", fact: "Fato idêntico duplicado no mesmo scope" },
      { scope: "collective", category: "learning", fact: "Fato idêntico duplicado no mesmo scope" },
      { scope: "collective", category: "invalido", fact: "Fato com categoria invalida" },
      { scope: "collective", category: "learning", fact: "123" }, // curto demais
    ]);
    const { memories, dropped } = parseMimoMemories(raw);
    expect(memories.length).toBe(1);
    expect(dropped).toBe(2); // 2 itens inválidos descartados
  });

  test("buildSynthesisPrompt encapsula diálogo e aplica regras de formato", () => {
    const prompt = buildSynthesisPrompt("user: teste\nassistant: ok");
    expect(prompt).toContain("<dialogo>");
    expect(prompt).toContain("user: teste");
    expect(prompt).toContain("REGRAS ABSOLUTAS:");
    expect(prompt).toContain("EXCLUSIVAMENTE com um array JSON válido");
  });
});

describe("mimo_synthesizer — Cascata de Modelos, Teto de Diálogo e Resiliência Fail-Fast", () => {
  test("Constantes de modelo padrão respeitam a governança do ecossistema", () => {
    expect(DEFAULT_MIMO_MODEL).toBe("opencode/mimo-v2.6-flash-free");
    expect(DEFAULT_FALLBACK_MODEL).toBe("google/antigravity-gemini-3.8-flash");
  });

  test("synthesizeMemories em modo DREAMS_OFFLINE=1 lança erro explícito sem inventar dados fakes", async () => {
    const prevOffline = process.env.DREAMS_OFFLINE;
    process.env.DREAMS_OFFLINE = "1";
    try {
      const dialogue = "[2026-10-09T10:00:00Z] user: Sempre utilize modelos na cota gratuita para especialistas";
      await expect(synthesizeMemories(dialogue)).rejects.toThrow(
        "Nenhum modelo de IA disponível para síntese cognitiva"
      );
    } finally {
      if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
      else process.env.DREAMS_OFFLINE = prevOffline;
    }
  });

  test("MimoSynthesizer tenta cascata de modelos e agrega erros ao falhar com binário inexistente", async () => {
    const synth = new MimoSynthesizer({
      binary: "/etc/hostname",
      models: ["opencode/mimo-v2.6-flash-free", "google/antigravity-gemini-3.7-flash"],
    });

    await expect(synth.synthesize("diálogo de teste")).rejects.toThrow(
      "Nenhum modelo de IA disponível para síntese cognitiva"
    );
  });

  test("MimoSynthesizer aplica teto de 120.000 caracteres no diálogo com truncamento invertido", async () => {
    const hugeDialogue = "B".repeat(150_000);
    const synth = new MimoSynthesizer({
      binary: "/etc/hostname",
      maxDialogueChars: 120_000,
    });

    // Deve truncar e falhar no spawn do binário não-executável (EACCES), comprovando o teto
    await expect(synth.synthesize(hugeDialogue)).rejects.toThrow(
      "Nenhum modelo de IA disponível para síntese cognitiva"
    );
  });

  test("Transport recorder real: --pure em argv e prompt por STDIN, nunca em argv (sem mocks, sem rede)", async () => {
    // Seam legítimo de I/O: um binário REAL em /tmp grava o próprio argv em disco
    // e devolve um JSON de memórias válido. Nenhum mock/stub de módulo é usado.
    const recorderDir = fs.mkdtempSync(path.join("/tmp", "dreams_argv_recorder_"));
    const argsFile = path.join(recorderDir, "argv.log");
    const stdinFile = path.join(recorderDir, "stdin.log");
    const recorderBin = path.join(recorderDir, "opencode_recorder.sh");
    fs.writeFileSync(
      recorderBin,
      [
        "#!/usr/bin/env bash",
        // NUL como delimitador: o prompt é multi-linha e não pode ser quebrado por \\n.
        `printf '%s\\0' "$@" > "${argsFile}"`,
        // TICKET-DREAMS-01A: o prompt trafega por STDIN, não por argv.
        `cat > "${stdinFile}"`,
        `printf '%s\\n' '[{"scope":"collective","fact":"Transport recorder real capturou o argv do comando run","category":"learning"}]'`,
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    // O recorder é 100% local: desliga o fail-fast offline só durante o spawn
    // (rede nunca é tocada — o binário apontado é o script gravado acima).
    const prevOffline = process.env.DREAMS_OFFLINE;
    delete process.env.DREAMS_OFFLINE;
    try {
      const synth = new MimoSynthesizer({
        binary: recorderBin,
        models: ["opencode/mimo-v2.6-flash-free"],
        timeoutMs: 10_000,
      });
      const result = await synth.synthesize(
        "user: use sempre a cota gratuita\nassistant: combinado"
      );

      // Contrato de saída: JSON real parseado e persistível.
      expect(result.error).toBeNull();
      expect(result.modelUsed).toBe("opencode/mimo-v2.6-flash-free");
      expect(result.source).toBe("mimo");
      expect(result.memories.length).toBe(1);
      expect(result.memories[0].scope).toBe("collective");
      expect(result.memories[0].category).toBe("learning");
      expect(result.memories[0].fact).toContain("Transport recorder real");

      // Contrato de entrada: argv SEM o prompt + --pure compulsória (TICKET-DREAMS-01A).
      const argv = fs
        .readFileSync(argsFile, "utf8")
        .split("\0")
        .filter(Boolean);
      expect(argv).toEqual([
        "run",
        "--pure",
        "--title",
        "Dreams Synthesis",
        "--dir",
        "/tmp",
        "--model",
        "opencode/mimo-v2.6-flash-free",
      ]);
      // NENHUM item de argv carrega o prompt (anti-E2BIG / anti-exposição em /proc).
      expect(argv.some((a) => a.includes("<dialogo>"))).toBe(false);

      // O prompt real chegou por STDIN íntegro.
      const stdin = fs.readFileSync(stdinFile, "utf8");
      expect(stdin).toContain("<dialogo>");
      expect(stdin).toContain("REGRAS ABSOLUTAS:");
      expect(stdin).toContain("user: use sempre a cota gratuita");
    } finally {
      if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
      else process.env.DREAMS_OFFLINE = prevOffline;
      fs.rmSync(recorderDir, { recursive: true, force: true });
    }
  });
});

describe("SleepCycle — Integração End-to-End Isolada em /tmp", () => {
  const e2eDir = path.join("/tmp", `opencode_dreams_e2e_${Date.now()}`);
  const opencodeDbPath = path.join(e2eDir, "opencode.db");
  const dreamsDbPath = path.join(e2eDir, "dreams.db");
  let opencodeSqlite: Database;
  let dreamsDb: DreamsDB;
  let cycle: SleepCycle;

  beforeAll(() => {
    fs.mkdirSync(e2eDir, { recursive: true });
    opencodeSqlite = new Database(opencodeDbPath);
    opencodeSqlite.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        time_created INTEGER,
        data TEXT
      );
    `);

    const now = Date.now();
    opencodeSqlite.run(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      ["msg_e2e_1", "ses_e2e", now - 2000, JSON.stringify({ role: "user" })]
    );
    opencodeSqlite.run(
      "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
      ["part_e2e_1", "msg_e2e_1", now - 2000, JSON.stringify({ type: "text", text: "Maiteux determinou que o Quality Gate de código pertence à Clara" })]
    );

    dreamsDb = new DreamsDB(dreamsDbPath);
    cycle = new SleepCycle(dreamsDb, {
      baseDir: e2eDir,
      sessionDbPath: opencodeDbPath,
      captureDialogue: true,
      dialogueHours: 24,
    });
  });

  afterAll(() => {
    opencodeSqlite.close();
    dreamsDb.close();
    fs.rmSync(e2eDir, { recursive: true, force: true });
  });

  test("Ciclo completo Light Sleep -> REM Sleep (offline / adiamento) -> Deep Sleep", async () => {
    const prevOffline = process.env.DREAMS_OFFLINE;
    process.env.DREAMS_OFFLINE = "1";
    try {
      // 1. Light Sleep lê opencode.db e grava dialogue_pending.txt
      await cycle.lightSleep();
      const dialoguePendingFile = path.join(e2eDir, "dialogue_pending.txt");
      expect(fs.existsSync(dialoguePendingFile)).toBe(true);
      const pendingContent = fs.readFileSync(dialoguePendingFile, "utf-8");
      expect(pendingContent).toContain("Quality Gate de código pertence à Clara");

      // 2. REM Sleep em modo offline: a síntese é adiada por indisponibilidade de modelo,
      // PRESERVANDO dialogue_pending.txt intacto e NÃO gravando dados falsos no DreamsDB.
      await cycle.remSleep();
      expect(fs.existsSync(dialoguePendingFile)).toBe(true); // arquivo preservado!

      const dreamsMd = path.join(e2eDir, "DREAMS.md");
      expect(fs.existsSync(dreamsMd)).toBe(true);
      const dreamsContent = fs.readFileSync(dreamsMd, "utf-8");
      expect(dreamsContent).toContain("# Daily Dreams Synthesis");
      expect(dreamsContent).toContain("status da síntese: **adiada**");

      // Nenhuma memória falsa/inventada foi inserida
      const savedMemories = dreamsDb.recall("Quality Gate");
      expect(savedMemories.length).toBe(0);

      // 3. Deep Sleep aplica decaimento temporal sem erros
      await cycle.deepSleep();
    } finally {
      if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
      else process.env.DREAMS_OFFLINE = prevOffline;
    }
  });

  test("Ciclo completo com múltiplas personas atualiza tanto coletivo quanto personas individuais", async () => {
    dreamsDb.insertMemory("collective", "Diretriz global de isolamento e anti-mock", "decision");
    dreamsDb.insertMemory("agent:kael", "Kael cuida da alocação de VRAM da GPU Pascal", "learning");
    dreamsDb.insertMemory("agent:tulio", "Túlio valida schemas Pydantic e contratos MCP", "preference");

    cycle.updateProjections();

    const collectiveMd = path.join(e2eDir, "collective", "COLLECTIVE_MEMORY.md");
    const kaelMd = path.join(e2eDir, "personas", "kael.md");
    const tulioMd = path.join(e2eDir, "personas", "tulio.md");

    expect(fs.existsSync(collectiveMd)).toBe(true);
    expect(fs.existsSync(kaelMd)).toBe(true);
    expect(fs.existsSync(tulioMd)).toBe(true);

    const kaelContent = fs.readFileSync(kaelMd, "utf-8");
    expect(kaelContent).toContain("Kael cuida da alocação de VRAM");

    const tulioContent = fs.readFileSync(tulioMd, "utf-8");
    expect(tulioContent).toContain("Túlio valida schemas Pydantic");
  });
});

describe("DreamsDB — Resiliência de busca FTS5, triggers e contadores", () => {
  const ftsDir = path.join("/tmp", `opencode_dreams_fts_${Date.now()}`);
  const ftsDbPath = path.join(ftsDir, "fts_test.db");
  let ftsDb: DreamsDB;

  beforeAll(() => {
    fs.mkdirSync(ftsDir, { recursive: true });
    ftsDb = new DreamsDB(ftsDbPath);
  });

  afterAll(() => {
    ftsDb.close();
    fs.rmSync(ftsDir, { recursive: true, force: true });
  });

  test("FTS5 trigger de delete remove da tabela virtual", () => {
    const id = ftsDb.insertMemory("collective", "Memoria efemera para teste de delecao FTS", "learning");
    let found = ftsDb.recall("efemera");
    expect(found.length).toBe(1);

    ftsDb.deleteMemory(id);
    found = ftsDb.recall("efemera");
    expect(found.length).toBe(0);
  });

  test("Recall com caracteres especiais cai no fallback LIKE sem quebrar", () => {
    ftsDb.insertMemory("collective", "Memoria com simbolos: (c/d) * & [teste]", "decision");
    const results = ftsDb.recall("(c/d) * &");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fact).toContain("(c/d)");
  });

  test("Recall incrementa recall_count e atualiza last_reinforced", () => {
    ftsDb.insertMemory("agent:clara", "Clara executa suite deterministica sem mocks", "learning");
    const before = ftsDb.getMemoriesByScope("agent:clara")[0];
    expect(before.recall_count).toBe(0);

    const recalled = ftsDb.recall("deterministica", "agent:clara");
    expect(recalled.length).toBe(1);
    expect(recalled[0].recall_count).toBe(1);

    const after = ftsDb.getMemoriesByScope("agent:clara")[0];
    expect(after.recall_count).toBe(1);
  });
});

describe("Síntese Real de Ponta a Ponta via IA (Fallback Gemini 3.8 Flash Antigravity)", () => {
  test("Gera memórias válidas com modelo real google/antigravity-gemini-3.8-flash e persiste no DreamsDB", async () => {
    if (process.env.DREAMS_OFFLINE === "1") {
      console.log("[E2E Real] Pulando chamada de rede com DREAMS_OFFLINE=1");
      return;
    }

    const testDir = path.join("/tmp", `opencode_dreams_real_ai_${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const realDb = new DreamsDB(path.join(testDir, "real_dreams.db"));

    try {
      const dialogue = [
        "[2026-10-09T16:00:00Z] user: Clara, garanta que todos os testes rodem contra SQLite isolado em /tmp.",
        "[2026-10-09T16:00:15Z] assistant: Entendido, todos os testes de integração do Dreams usam diretórios temporários únicos em /tmp.",
      ].join("\n");

      const result = await synthesizeMemories(dialogue, {
        models: ["google/antigravity-gemini-3.8-flash"],
        timeoutMs: 45000,
      });

      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.source).toBe("gemini");
      expect(result.modelUsed).toBe("google/antigravity-gemini-3.8-flash");
      expect(result.error).toBeNull();

      for (const mem of result.memories) {
        expect(["collective", "agent:clara"].some(s => mem.scope === s || mem.scope.startsWith("agent:"))).toBe(true);
        expect(["learning", "decision", "pitfall", "preference"]).toContain(mem.category);
        expect(mem.fact.length).toBeGreaterThanOrEqual(10);
        realDb.insertMemory(mem.scope, mem.fact, mem.category);
      }

      const all = realDb.getAllMemories();
      expect(all.length).toBeGreaterThan(0);

      const recalled = realDb.recall("SQLite");
      expect(recalled.length).toBeGreaterThan(0);
    } finally {
      realDb.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ===========================================================================
// TICKET-DREAMS-03 (Frentes A + B) — Suíte determinística do SDET (Hugo).
//
// Sem mocks: exercita SQLite REAL (bun:sqlite) em arquivos isolados sob /tmp,
// o tokenizer FTS5 real, o sanitizador real e o SleepCycle real. A suíte é
// sensível a mutação: cada assert fica vermelho se a produção for revertida
// (ver comentários "MUTATION").
// ===========================================================================

describe("TICKET-DREAMS-03A — Robustez FTS5, folding de acentos e dual-write", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "opencode_dreams_03a_"));
  const dbPath = path.join(dir, "fts.db");
  let db: DreamsDB;
  let raw: Database;

  beforeAll(() => {
    db = new DreamsDB(dbPath);
    raw = new Database(dbPath);
    raw.exec("PRAGMA busy_timeout = 5000;");
  });

  afterAll(() => {
    try { db.close(); } catch { /* noop */ }
    try { raw.close(); } catch { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("DDL de memories_fts usa unicode61 remove_diacritics 2", () => {
    const row = raw.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
    ).get();
    expect(row).not.toBeNull();
    // MUTATION: reverter o tokenizer para o default (sem remove_diacritics) quebra aqui.
    expect(row!.sql).toContain("unicode61");
    expect(row!.sql).toContain("remove_diacritics 2");
  });

  test("folding de acentos: 'inferencia' e 'inferência' casam o MESMO registro", () => {
    const id = db.insertMemory(
      "collective",
      "A inferência local do Laya usa RLCD sem acento no indice",
      "learning"
    );

    const semAcento = db.recall("inferencia");
    const comAcento = db.recall("inferência");

    expect(semAcento.length).toBe(1);
    expect(comAcento.length).toBe(1);
    expect(semAcento[0].id).toBe(id);
    expect(comAcento[0].id).toBe(id);
    expect(semAcento[0].fact).toBe(comAcento[0].fact);
  });

  test("sanitizeFts5Query neutraliza ':' '-' '*' '(' '/' '&' e aspas", () => {
    expect(sanitizeFts5Query("agent:dante")).toBe('"agent" "dante"');
    expect(sanitizeFts5Query("ensemble-room")).toBe('"ensemble" "room"');
    expect(sanitizeFts5Query("(c/d) * &")).toBe('"c" "d"');
    expect(sanitizeFts5Query('Laya "RLCD"')).toBe('"Laya" "RLCD"');
    expect(sanitizeFts5Query("***")).toBe("");
    expect(sanitizeFts5Query("")).toBe("");
    expect(sanitizeFts5Query("!!! ... ---")).toBe("");
  });

  test("recall com ':' (agent:dante) e '-' (ensemble-room) NÃO lança e acha o fato", () => {
    db.insertMemory("agent:dante", "Escopo agent:dante orquestra o ensemble room", "decision");

    let viaColon: any[] = [];
    expect(() => { viaColon = db.recall("agent:dante"); }).not.toThrow();
    expect(viaColon.length).toBe(1);
    expect(viaColon[0].fact).toContain("agent:dante");

    let viaHifen: any[] = [];
    expect(() => { viaHifen = db.recall("ensemble-room"); }).not.toThrow();
    expect(viaHifen.length).toBe(1);
    expect(viaHifen[0].fact).toContain("ensemble room");
  });

  test("MATCH CRU com 'agent:dante' lança fts5 syntax error — prova que o sanitizador é necessário", () => {
    // Sem o sanitizador, ':' é interpretado como filtro de coluna inexistente.
    // Este canário garante que o teste acima exercita um caminho real de risco.
    expect(() =>
      raw.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all("agent:dante")
    ).toThrow();
  });

  test("touchRecall incrementa recall_count e atualiza last_reinforced", () => {
    const id = db.insertMemory("agent:clara", "Clara roda a suite deterministica real", "learning");
    const before = db.getMemoriesByScope("agent:clara", 10).find((m) => m.id === id)!;
    expect(before.recall_count).toBe(0);

    const recalled = db.recall("deterministica", "agent:clara");
    expect(recalled.length).toBe(1);

    const after = db.getMemoriesByScope("agent:clara", 10).find((m) => m.id === id)!;
    expect(after.recall_count).toBe(1);
    expect(new Date(after.last_reinforced).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_reinforced).getTime()
    );
  });

  test("migração idempotente de DB legado: reescreve DDL, preserva linhas e habilita folding", () => {
    const migDir = path.join(dir, "mig");
    fs.mkdirSync(migDir, { recursive: true });
    const migPath = path.join(migDir, "legacy.db");

    // DB legado: memories_fts SEM remove_diacritics, já populado.
    const legacy = new Database(migPath);
    legacy.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL, fact TEXT NOT NULL, category TEXT NOT NULL,
        score REAL DEFAULT 1.0, decay_weight REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0, confirmations INTEGER DEFAULT 1,
        last_reinforced TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        fact, category, content='memories', content_rowid='id'
      );
      INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
        VALUES ('collective', 'Memória legada sobre inferência antiga', 'learning', 1.0, 1.0, 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO memories_fts(rowid, fact, category)
        VALUES (1, 'Memória legada sobre inferência antiga', 'learning');
    `);
    legacy.close();

    const readSql = () => {
      const probe = new Database(migPath);
      const sql = probe.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
      ).get()!.sql;
      probe.close();
      return sql;
    };

    // 1ª abertura: deve detectar o tokenizer legado, recriar e 'rebuild'.
    const migrated = new DreamsDB(migPath);
    const sqlAfterMigration = readSql();
    expect(sqlAfterMigration).toContain("remove_diacritics 2");
    expect(migrated.getAllMemories().length).toBe(1);            // nenhuma linha perdida
    expect(migrated.recall("inferencia").length).toBe(1);        // índice reconstruído + folding
    migrated.close();

    // 2ª abertura: idempotente — DDL inalterado e dados preservados.
    const second = new DreamsDB(migPath);
    const sqlAfterSecond = readSql();
    expect(sqlAfterSecond).toBe(sqlAfterMigration);
    expect(second.getAllMemories().length).toBe(1);
    expect(second.recall("inferência").length).toBe(1);
    second.close();
  });
});

describe("TICKET-DREAMS-03A — Dual-write dream_learn -> dream_recall no MESMO turno", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "opencode_dreams_dw_"));
  let db: DreamsDB;

  beforeAll(() => { db = new DreamsDB(path.join(dir, "dw.db")); });
  afterAll(() => {
    try { db.close(); } catch { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("dream_learn grava JSONL E torna o fato consultável no mesmo turno (db injetado)", () => {
    const dailyDir = path.join(dir, "daily");
    const ret = dream_learn(
      { scope: "collective", fact: "Maiteux prefere determinismo nos testes", category: "preference" },
      { dailyDir, db }
    );
    expect(typeof ret).toBe("string");

    // Camada 1: JSONL diário (fonte de verdade) — exatamente 1 linha com o fato.
    const logFile = fs.readdirSync(dailyDir).find((f) => f.startsWith("log_"))!;
    const lines = fs.readFileSync(path.join(dailyDir, logFile), "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.fact).toBe("Maiteux prefere determinismo nos testes");
    expect(parsed.scope).toBe("collective");

    // Camada 2: dual-write síncrono no SQLite — recall imediato, sem ciclo de sono.
    const recalled = db.recall("determinismo");
    expect(recalled.length).toBe(1);
    expect(recalled[0].fact).toContain("determinismo");

    // dream_recall (tool) também devolve o registro na mesma sessão.
    const toolOut = dream_recall({ query: "determinismo" }, db);
    expect(toolOut).toContain("determinismo");
  });

  test("dream_learn sem db é retrocompatível: grava apenas o JSONL", () => {
    const dailyDir = path.join(dir, "daily_retro");
    expect(() =>
      dream_learn(
        { scope: "agent:tales", fact: "Aprendizado apenas JSONL sem banco", category: "learning" },
        { dailyDir }
      )
    ).not.toThrow();
    const logFile = fs.readdirSync(dailyDir).find((f) => f.startsWith("log_"))!;
    const parsed = JSON.parse(fs.readFileSync(path.join(dailyDir, logFile), "utf-8").trim());
    expect(parsed.fact).toBe("Aprendizado apenas JSONL sem banco");
  });

  test("scope inválido continua lançando (anti Directory Traversal)", () => {
    const dailyDir = path.join(dir, "daily_bad");
    expect(() =>
      dream_learn({ scope: "../escape", fact: "x", category: "learning" }, { dailyDir, db })
    ).toThrow();
  });

  test("falha REAL do espelho SQLite (db fechado) não quebra a tool: JSONL é preservado", () => {
    const failDir = path.join(dir, "daily_fail");
    const closed = new DreamsDB(path.join(dir, "closed.db"));
    closed.close(); // componente real em estado de erro: insertMemory lançará

    // MUTATION: sem o try/catch do dual-write, esta chamada lançaria.
    expect(() =>
      dream_learn(
        { scope: "collective", fact: "Fato resiliente com banco indisponivel", category: "pitfall" },
        { dailyDir: failDir, db: closed }
      )
    ).not.toThrow();

    const logFile = fs.readdirSync(failDir).find((f) => f.startsWith("log_"))!;
    const parsed = JSON.parse(fs.readFileSync(path.join(failDir, logFile), "utf-8").trim());
    expect(parsed.fact).toBe("Fato resiliente com banco indisponivel");
  });
});

describe("TICKET-DREAMS-03B — Pesos categóricos, ranking semântico e amortecimento log", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "opencode_dreams_03b_"));
  const dbPath = path.join(dir, "rank.db");
  let db: DreamsDB;
  let cycle: SleepCycle;
  let raw: Database;

  beforeAll(() => {
    db = new DreamsDB(dbPath);
    raw = new Database(dbPath);
    raw.exec("PRAGMA busy_timeout = 5000;");
    cycle = new SleepCycle(db, { baseDir: dir, sessionDbPath: path.join(dir, "none.db") });
  });

  afterAll(() => {
    try { db.close(); } catch { /* noop */ }
    try { raw.close(); } catch { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("CATEGORY_WEIGHTS expõe os pesos canônicos e insertMemory usa defaults por categoria", () => {
    expect(CATEGORY_WEIGHTS.preference).toEqual({ base_weight: 2.5, decay_weight: 0.1 });
    expect(CATEGORY_WEIGHTS.decision).toEqual({ base_weight: 2.0, decay_weight: 0.3 });
    expect(CATEGORY_WEIGHTS.pitfall).toEqual({ base_weight: 1.8, decay_weight: 0.5 });
    expect(CATEGORY_WEIGHTS.learning).toEqual({ base_weight: 1.0, decay_weight: 1.0 });

    db.insertMemory("agent:pesos", "Preferência sem score explícito", "preference");
    db.insertMemory("agent:pesos", "Aprendizado sem score explícito", "learning");
    const rows = db.getMemoriesByScope("agent:pesos", 10);
    const pref = rows.find((m) => m.fact.includes("Preferência sem score"))!;
    const learn = rows.find((m) => m.fact.includes("Aprendizado sem score"))!;
    // MUTATION: defaults revertidos (1.0) quebram estes asserts.
    expect(pref.score).toBe(2.5);
    expect(pref.decay_weight).toBe(0.1);
    expect(learn.score).toBe(1.0);
    expect(learn.decay_weight).toBe(1.0);
  });

  test("Ranking: preference ANTIGA supera learning RECENTE no Top 20 após deepSleep", async () => {
    const oldPref = db.insertMemory(
      "collective",
      "Preferência antiga: sempre usar suites deterministicas",
      "preference"
    );
    const newLearn = db.insertMemory(
      "collective",
      "Aprendizado recente: descobri o comando bun test",
      "learning"
    );

    const oldIso = new Date(Date.now() - 90 * 86400000).toISOString();
    const nowIso = new Date().toISOString();
    raw.run("UPDATE memories SET last_reinforced = ?, created_at = ? WHERE id = ?", [oldIso, oldIso, oldPref]);
    raw.run("UPDATE memories SET last_reinforced = ?, created_at = ? WHERE id = ?", [nowIso, nowIso, newLearn]);

    await cycle.deepSleep();

    const top = db.getMemoriesByScope("collective", 20);
    const prefIdx = top.findIndex((m) => m.id === oldPref);
    const learnIdx = top.findIndex((m) => m.id === newLearn);
    expect(prefIdx).toBeGreaterThanOrEqual(0);
    expect(learnIdx).toBeGreaterThanOrEqual(0);
    // MUTATION: sem o viés de categoria (base 2.5 / decay 0.1), a learning recente venceria.
    expect(prefIdx).toBeLessThan(learnIdx);
    expect(top[prefIdx].score).toBeGreaterThan(top[learnIdx].score);

    // A projeção do Top 20 reflete a mesma ordem.
    cycle.updateProjections();
    const md = fs.readFileSync(path.join(dir, "collective", "COLLECTIVE_MEMORY.md"), "utf-8");
    const posPref = md.indexOf("Preferência antiga");
    const posLearn = md.indexOf("Aprendizado recente");
    expect(posPref).toBeGreaterThan(-1);
    expect(posLearn).toBeGreaterThan(-1);
    expect(posPref).toBeLessThan(posLearn);
  });

  test("Amortecimento de recall: 100 lembranças crescem log(101), não linearmente", async () => {
    const hot = db.insertMemory("agent:damping", "Fato canário repetido", "learning");
    const cold = db.insertMemory("agent:damping", "Fato controle estavel", "learning");

    const iso = new Date().toISOString();
    for (const id of [hot, cold]) {
      raw.run("UPDATE memories SET last_reinforced = ?, created_at = ?, recall_count = 0 WHERE id = ?", [iso, iso, id]);
    }

    const N = 100;
    for (let i = 0; i < N; i++) {
      const r = db.recall("canário", "agent:damping");
      expect(r.length).toBe(1);
    }

    const hotMid = db.getMemoriesByScope("agent:damping", 10).find((m) => m.id === hot)!;
    const coldMid = db.getMemoriesByScope("agent:damping", 10).find((m) => m.id === cold)!;
    expect(hotMid.recall_count).toBe(N);
    expect(coldMid.recall_count).toBe(0);

    await cycle.deepSleep();

    const hotAfter = db.getAllMemories().find((m) => m.id === hot)!;
    const coldAfter = db.getAllMemories().find((m) => m.id === cold)!;
    const delta = hotAfter.score - coldAfter.score;

    // log(1 + 100) = 4.605...  MUTATION: count linear daria delta = 100;
    // ausência de amortecimento/log daria delta = 0. A banda [4.0, 5.0] prova
    // o teto sublinear logarítmico.
    expect(delta).toBeGreaterThan(4.0);
    expect(delta).toBeLessThan(5.0);
    expect(delta).toBeLessThan(N); // nunca linear
  });
});
