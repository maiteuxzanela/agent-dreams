/**
 * TICKET-DREAMS-06 — Sanitização ativa de segredos (`redactSecrets`) nos seams
 * de persistência do OpenCode Dreams.
 *
 * Suíte determinística SDET (Hugo) — SEM mocks, SQLite real + FS real isolado
 * em /tmp/dreams_test_sec_* (nunca o ~/.config/opencode/dreams de produção):
 *
 *   Cenário A — `dream_learn`: JSONL diário (`daily/log_YYYY-MM-DD.jsonl`)
 *               recebe o fato JÁ censurado; zero credenciais em texto puro.
 *   Cenário B — Dual-write síncrono: tabela `memories` + `dream_recall`
 *               (FTS5) expõem apenas o fato censurado.
 *   Cenário C — Defesa em profundidade: `DreamsDB.insertMemory` reaplica
 *               `redactSecrets` idempotente mesmo com chamada direta.
 *   Cenário D — Projeções markdown (`COLLECTIVE_MEMORY.md` / `personas/*.md`)
 *               geradas pelo ciclo de sono não contêm credenciais puras.
 *
 * Nota de calibração: `containsSecret` é assertivo para os padrões com prefixo
 * (sk-/AIza/Bearer/JWT — placeholder quebra o regex), mas a regra genérica de
 * atribuição (`chave=valor`) ainda casa com o próprio placeholder
 * (`password="***REDACTED***"`). Por isso a asserção canônica de "ausência de
 * vazamento" é a ABSENÇÃO DA CREDENCIAL CRUA no texto persistido — nunca
 * `containsSecret(texto_já_redigido) === false` para atribuições.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { DreamsDB } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";
import { dream_learn, dream_recall } from "../src/tools";
import { redactSecrets, REDACTED_PLACEHOLDER, REDACTED_JWT_PLACEHOLDER } from "../src/core/security";

// ---------------------------------------------------------------------------
// Segredos sintéticos conhecidos (nunca reais) — forma exata dos padrões.
// ---------------------------------------------------------------------------
const OPENAI_KEY = "sk-proj-abc12345678901234567890"; // sk- + 26 chars [A-Za-z0-9_-]
const GOOGLE_KEY = "AIzaSyD98765432101234567890123456789012"; // AIza + 35 chars
const BEARER_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // token após "Bearer "
const STANDALONE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const PASSWORD_VALUE = "SuperSecret123!";

/** Credenciais crua-únicas: ausência obrigatória em TODO persistido. */
const RAW_SECRETS = [OPENAI_KEY, GOOGLE_KEY, BEARER_JWT, STANDALONE_JWT, PASSWORD_VALUE] as const;

/** Assert de defesa: nenhum segredo cru pode aparecer no texto persistido. */
function expectNoRawSecrets(text: string, label: string): void {
  for (const raw of RAW_SECRETS) {
    if (text.includes(raw)) {
      throw new Error(`[${label}] Vazamento de credencial crua: ${raw}`);
    }
  }
}

// Isolamento absoluto: FS + SQLite reais sob /tmp (prefixo canônico do ticket).
const TEST_BASE_DIR = path.join("/tmp", `dreams_test_sec_${Date.now()}`);
const DB_PATH = path.join(TEST_BASE_DIR, "dreams_06.db");
const DAILY_DIR = path.join(TEST_BASE_DIR, "daily");
const COLLECTIVE_DIR = path.join(TEST_BASE_DIR, "collective");
const PERSONAS_DIR = path.join(TEST_BASE_DIR, "personas");

/** Lê e parseia todas as linhas do JSONL diário gravado por `dream_learn`. */
function readDailyJsonlRecords(): Array<Record<string, string>> {
  const files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith(".jsonl"));
  const records: Array<Record<string, string>> = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(DAILY_DIR, file), "utf-8");
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") records.push(JSON.parse(line));
    }
  }
  return records;
}

/** Todos os `.jsonl` do diretório diário, em ordem estável de nome. */
function dailyJsonlPaths(): string[] {
  return fs
    .readdirSync(DAILY_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(DAILY_DIR, f));
}

describe("TICKET-DREAMS-06 — Cenário A: dream_learn redige o JSONL diário", () => {
  let db: DreamsDB;

  beforeAll(() => {
    fs.mkdirSync(TEST_BASE_DIR, { recursive: true });
    db = new DreamsDB(DB_PATH);
  });

  afterAll(() => {
    db.close();
  });

  test("A1: fato com chave OpenAI sk- é gravado censurado no log_YYYY-MM-DD.jsonl", () => {
    const fact = `Aprendi que a chave ${OPENAI_KEY} estava exposta no log de sessão`;
    dream_learn({ scope: "collective", fact, category: "learning" }, { dailyDir: DAILY_DIR });

    const logs = dailyJsonlPaths();
    expect(logs.length).toBe(1); // nome canônico log_<data>.jsonl

    const content = fs.readFileSync(logs[0], "utf-8");
    expectNoRawSecrets(content, "A1/jsonl");
    expect(content).toContain(`sk-${REDACTED_PLACEHOLDER}`);

    // Schema do record íntegro (scope/fact/category/timestamp) — a censura não
    // pode quebrar o contrato ingerido pelo Light Sleep.
    const record = JSON.parse(content.trim().split("\n")[0]!);
    expect(record.scope).toBe("collective");
    expect(record.category).toBe("learning");
    expect(record.fact).toContain(`sk-${REDACTED_PLACEHOLDER}`);
    expect(record.fact).not.toContain(OPENAI_KEY);
    expect(typeof record.timestamp).toBe("string");
  });

  test("A2: lote com AIza / Bearer / JWT / password= — todas as linhas censuradas, zero credencial crua", () => {
    const facts = [
      { scope: "collective", fact: `Usamos ${GOOGLE_KEY} no build de teste`, category: "decision" as const },
      {
        scope: "agent:morgan",
        fact: `Authorization: Bearer ${BEARER_JWT} validado em produção`,
        category: "learning" as const,
      },
      { scope: "agent:morgan", fact: `JWT observado ${STANDALONE_JWT} no callback`, category: "pitfall" as const },
      {
        scope: "collective",
        fact: `Config final password="${PASSWORD_VALUE}" no deploy`,
        category: "preference" as const,
      },
    ];
    for (const f of facts) dream_learn(f, { dailyDir: DAILY_DIR });

    for (const file of dailyJsonlPaths()) {
      const content = fs.readFileSync(file, "utf-8");
      expectNoRawSecrets(content, `A2/${path.basename(file)}`);
    }
    const records = readDailyJsonlRecords();
    expect(records.length).toBe(5); // A1 + 4 do lote
    const joined = records.map((r) => r.fact).join("\n");
    expect(joined).toContain(`AIza${REDACTED_PLACEHOLDER}`);
    expect(joined).toContain(`Bearer ${REDACTED_PLACEHOLDER}`);
    expect(joined).toContain(REDACTED_JWT_PLACEHOLDER);
    expect(joined).toContain(`password="${REDACTED_PLACEHOLDER}"`);
  });

  test("A3: fato limpo persiste byte-idêntico (sem falso positivo da máscara)", () => {
    const clean = "Decisão arquitetural: dreams consolida memórias no SQLite com FTS5.";
    dream_learn({ scope: "collective", fact: clean, category: "decision" }, { dailyDir: DAILY_DIR });
    const records = readDailyJsonlRecords();
    expect(records.some((r) => r.fact === clean)).toBe(true);
  });

  test("A4: idempotência + dedup — mesmo fato secreto duas vezes: JSONL ambas censuradas, UMA row reforçada no SQLite", () => {
    const fact = `Segredo repetido ${OPENAI_KEY} colado no chat`;
    const dbBefore = new DreamsDB(path.join(TEST_BASE_DIR, "dreams_06.db")); // reopen do MESMO arquivo
    try {
      dream_learn({ scope: "agent:hugo", fact, category: "pitfall" }, { dailyDir: DAILY_DIR, db: dbBefore });
      dream_learn({ scope: "agent:hugo", fact, category: "pitfall" }, { dailyDir: DAILY_DIR, db: dbBefore });

      // JSONL: duas linhas (fonte de verdade append-only), AMBAS censuradas.
      const all = readDailyJsonlRecords();
      const hugoLines = all.filter((r) => r.scope === "agent:hugo");
      expect(hugoLines.length).toBe(2);
      for (const r of hugoLines) {
        expect(r.fact).toContain(`sk-${REDACTED_PLACEHOLDER}`);
        expect(r.fact).not.toContain(OPENAI_KEY);
      }

      // SQLite: dedup EXATO sobre o fato SANITIZADO — uma única row, reforçada.
      const rows = dbBefore
        .getAllMemories()
        .filter((m) => m.scope === "agent:hugo" && m.fact.includes(`sk-${REDACTED_PLACEHOLDER}`));
      expect(rows.length).toBe(1);
      expect(rows[0]!.confirmations).toBeGreaterThanOrEqual(2);
      expect(rows[0]!.fact).not.toContain(OPENAI_KEY);
    } finally {
      dbBefore.close();
    }
  });
});

describe("TICKET-DREAMS-06 — Cenário B: dual-write SQLite + dream_recall censurados", () => {
  let db: DreamsDB;

  beforeAll(() => {
    // Reabre o MESMO banco isolado (estado do Cenário A compartilhado de propósito:
    // o dual-write do dream_learn persiste no arquivo real).
    db = new DreamsDB(DB_PATH);
  });

  afterAll(() => {
    db.close();
  });

  test("B1: dual-write grava em `memories` apenas o fato sanitizado", () => {
    const fact = `Chave de produção ${OPENAI_KEY} rotacionada hoje`;
    dream_learn({ scope: "collective", fact, category: "decision" }, { dailyDir: DAILY_DIR, db });

    const rows = db.getAllMemories().filter((m) => m.fact.includes(`sk-${REDACTED_PLACEHOLDER}`));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.fact).not.toContain(OPENAI_KEY);
    }
    // Invariante global do banco: nenhuma row de memória carrega credencial crua.
    for (const row of db.getAllMemories()) {
      expectNoRawSecrets(row.fact, "B1/memories");
    }
  });

  test("B2: dream_recall por token não-secreto devolve o fato censurado", () => {
    const out = dream_recall({ query: "chave produção rotacionada", scope: "collective" }, db);
    expect(out).toContain(`sk-${REDACTED_PLACEHOLDER}`);
    expect(out).not.toContain(OPENAI_KEY);
    expectNoRawSecrets(out, "B2/recall");
  });

  test("B3: busca FTS pelo próprio segredo não devolve o segredo (token bruto não indexado)", () => {
    const results = db.recall("abc12345678901234567890", "collective");
    for (const r of results) {
      expect(r.fact).not.toContain(OPENAI_KEY);
      expect(r.fact).not.toContain("abc12345678901234567890");
    }
    // O token cru do segredo nunca foi persistido ⇒ não pode casar no FTS5.
    expect(results.length).toBe(0);
  });
});

describe("TICKET-DREAMS-06 — Cenário C: defesa em profundidade em DreamsDB.insertMemory", () => {
  let db: DreamsDB;

  beforeAll(() => {
    db = new DreamsDB(path.join(TEST_BASE_DIR, "dreams_06_c.db")); // banco próprio do cenário
  });

  afterAll(() => {
    db.close();
  });

  test("C1: insertMemory DIRETO redige secret='...' antes do INSERT (chamador malicioso/não-sanitizado)", () => {
    const id = db.insertMemory("agent:dante", "chave privada secret='12345678'", "preference");
    const row = db.getAllMemories().find((m) => m.id === id);
    expect(row).toBeDefined();
    expect(row!.fact).toBe("chave privada secret='***REDACTED***'");
    expect(row!.fact).not.toContain("12345678");
  });

  test("C2: insertMemory de fato JÁ redigido não re-redige (idempotência no seam)", () => {
    const already = "chave privada secret='***REDACTED***' do servidor antigo (registro)";
    const id = db.insertMemory("agent:dante", already, "learning");
    const row = db.getAllMemories().find((m) => m.id === id);
    expect(row!.fact).toBe(already); // byte-idêntico: sem placeholder duplicado
    expect(row!.fact).not.toContain("***REDACTED******REDACTED***");
  });

  test("C3: dedup por fato sanitizado — duas entradas cruas distintas que colapsam no mesmo sanitized fundem em 1 row", () => {
    const before = db.getAllMemories().filter((m) => m.scope === "agent:kael").length;
    db.insertMemory("agent:kael", `primeira nota secret='${PASSWORD_VALUE}'`, "pitfall");
    db.insertMemory("agent:kael", `primeira nota secret='${PASSWORD_VALUE}'`, "pitfall"); // repetida
    const rows = db.getAllMemories().filter((m) => m.scope === "agent:kael");
    expect(rows.length).toBe(before + 1); // exatamente UMA row nova
    expect(rows[0]!.fact).not.toContain(PASSWORD_VALUE);
    expect(rows[0]!.fact).toContain(REDACTED_PLACEHOLDER);
    expect(rows[0]!.confirmations).toBeGreaterThanOrEqual(2); // reforço, não clone
  });

  test("C4: TODAS as famílias (sk-/AIza/Bearer/JWT/password=) via insertMemory direto ficam censuradas", () => {
    const seeds: Array<[string, string]> = [
      ["agent:cris", `api openai ${OPENAI_KEY} no CI`],
      ["agent:cris", `google ${GOOGLE_KEY} no CI`],
      ["agent:tales", `header Bearer ${BEARER_JWT} interceptado`],
      ["agent:tales", `jwt ${STANDALONE_JWT} capturado`],
      ["collective", `deploy com password=${PASSWORD_VALUE} na env`],
    ];
    for (const [scope, fact] of seeds) db.insertMemory(scope, fact, "learning");

    for (const row of db.getAllMemories()) {
      expectNoRawSecrets(row.fact, `C4/row#${row.id}`);
    }
    const all = db.getAllMemories().map((m) => m.fact).join("\n");
    expect(all).toContain(`sk-${REDACTED_PLACEHOLDER}`);
    expect(all).toContain(`AIza${REDACTED_PLACEHOLDER}`);
    expect(all).toContain(`Bearer ${REDACTED_PLACEHOLDER}`);
    expect(all).toContain(REDACTED_JWT_PLACEHOLDER);
    expect(all).toContain(`password=${REDACTED_PLACEHOLDER}`);
  });
});

describe("TICKET-DREAMS-06 — Cenário D: projeções markdown sem credenciais puras", () => {
  let db: DreamsDB;
  let cycle: SleepCycle;

  beforeAll(async () => {
    db = new DreamsDB(path.join(TEST_BASE_DIR, "dreams_06_d.db"));
    cycle = new SleepCycle(db, {
      baseDir: TEST_BASE_DIR,
      sessionDbPath: path.join(TEST_BASE_DIR, "non_existent.db"), // fail-soft, isolado de produção
    });
  });

  afterAll(() => {
    db.close();
  });

  test("D1: ciclo completo (light+deep) projeta COLLECTIVE_MEMORY.md e personas/*.md censurados", async () => {
    dream_learn(
      { scope: "collective", fact: `Lembretes: chave ${OPENAI_KEY} expirada e senha password="${PASSWORD_VALUE}"`, category: "preference" },
      { dailyDir: DAILY_DIR, db }
    );
    dream_learn(
      { scope: "agent:dante", fact: `Orquestrador usou ${GOOGLE_KEY} no deploy`, category: "learning" },
      { dailyDir: DAILY_DIR, db }
    );

    await cycle.lightSleep(); // ingere JSONL (já censurado) → SQLite (re-redigido, idempotente)
    await cycle.deepSleep(); // aplica decaimento + updateProjections (pós-poda)

    const collective = fs.readFileSync(path.join(COLLECTIVE_DIR, "COLLECTIVE_MEMORY.md"), "utf-8");
    const persona = fs.readFileSync(path.join(PERSONAS_DIR, "dante.md"), "utf-8");

    expectNoRawSecrets(collective, "D1/COLLECTIVE_MEMORY.md");
    expectNoRawSecrets(persona, "D1/personas/dante.md");

    // Prova de pipeline (não basta arquivo vazio): o fato censurado PROJETOU-SE.
    expect(collective).toContain(`sk-${REDACTED_PLACEHOLDER}`);
    expect(persona).toContain(`AIza${REDACTED_PLACEHOLDER}`);
  });

  test("D2: varredura recursiva de TODO o diretório isolado — zero credencial crua em nenhum arquivo (jsonl, md, db)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const bytes = fs.readFileSync(full);
        for (const raw of RAW_SECRETS) {
          // Credenciais longas/únicas: ausência exigida até nos bytes do SQLite/WAL.
          if (bytes.includes(Buffer.from(raw, "utf-8"))) {
            offenders.push(`${path.relative(TEST_BASE_DIR, full)} → ${raw}`);
          }
        }
      }
    };
    walk(TEST_BASE_DIR);
    expect(offenders).toEqual([]);
  });
});
