/**
 * TICKET-HARNESS-60 — Suíte determinística REAL (sem mocks) da leitura
 * IRRESTRITA de diálogos no `session_reader.ts`.
 *
 * Contrato novo:
 *  - `readRecentDialogues` SEM `options.limit` (ou com `null`, `0`, `Infinity`,
 *    `NaN` ou valor negativo) NÃO aplica cláusula `LIMIT`: devolve TODAS as
 *    mensagens da janela `[since, until]`, em ordem cronológica ASC.
 *  - `options.limit` positivo e finito preserva o comportamento histórico:
 *    retém as N mensagens MAIS RECENTES e devolve em ordem cronológica ASC.
 *  - Os dois pontos de chamada do `sleep_cycle.ts` (Light Sleep e REM direto)
 *    não passam `limit` e, portanto, aproveitam a leitura integral.
 *
 * Infraestrutura 100% real: bancos SQLite em /tmp com o DDL do OpenCode,
 * o módulo de produção real e o `SleepCycle` real. Zero mocks/stubs de
 * comportamento; o único seam de observação é um recorder de `console.log`
 * (usado pelo REM), que repassa cada linha ao logger original.
 */
import { test, expect, describe, afterAll, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import {
  readRecentDialogues,
  buildDialogueSummary,
} from "../src/core/session_reader";
import { DreamsDB } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";

// A fixture real tem 600 mensagens; o timeout default de 5s é apertado.
setDefaultTimeout(30_000);

const BASE_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_10_unbounded_"));
const NOW = Date.now();
const MIN = 60 * 1000;
const TOTAL = 600;
const SESSION = "ses_harness60";

afterAll(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Fixture {
  dbPath: string;
  /** Textos na ordem cronológica (mais antigo → mais recente). */
  texts: string[];
}

/**
 * Cria um banco OpenCode real com `message`/`part`/`session`.
 * A mensagem `i` recebe timestamp crescente e um texto único `DIALOGO_<i>`,
 * permitindo provar ausência de truncamento por contagem/set exatos.
 */
function buildFixture(opts: {
  name: string;
  count?: number;
  session?: string;
  title?: string;
  /** Quantas mensagens extras da sessão de síntese inserir (excluídas). */
  synthesisCount?: number;
  /** Mensagens adicionais fora da janela (mais antigas que `sinceMs`). */
  oldCount?: number;
}): Fixture {
  const dir = path.join(BASE_DIR, opts.name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);
  const session = opts.session ?? SESSION;

  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    time_created INTEGER,
    data TEXT
  );`);
  db.run(`CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    time_created INTEGER,
    data TEXT
  );`);
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`);

  db.run("INSERT INTO session (id, data) VALUES (?, ?)", [
    session,
    JSON.stringify({ title: opts.title ?? "Conversa comum da usuária" }),
  ]);

  const count = opts.count ?? TOTAL;
  const texts: string[] = [];
  const insertMessage = (id: string, sessionId: string, t: number, role: string, text: string) => {
    db.run(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      [id, sessionId, t, JSON.stringify({ role })]
    );
    db.run(
      "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
      [`${id}_t0`, id, t + 1, JSON.stringify({ type: "text", text })]
    );
  };

  // Um único commit: 600 INSERTs individuais com autocommit levariam segundos.
  const writeFixture = db.transaction(() => {
  // Janela quente: mensagens com timestamps estritamente crescentes.
  const start = NOW - count * 1000;
  for (let i = 0; i < count; i++) {
    const text = `DIALOGO_${String(i).padStart(4, "0")} linha cronologica ${i}`;
    texts.push(text);
    insertMessage(
      `msg_${String(i).padStart(4, "0")}`,
      session,
      start + i * 1000,
      i % 2 === 0 ? "user" : "assistant",
      text
    );
  }

  // Sessão interna do Dreams: NUNCA pode ser lida como diálogo.
  if (opts.synthesisCount) {
    db.run("INSERT INTO session (id, data) VALUES (?, ?)", [
      "ses_dreams_synthesis",
      JSON.stringify({ title: "Dreams Synthesis" }),
    ]);
    for (let i = 0; i < opts.synthesisCount; i++) {
      insertMessage(
        `msg_synth_${i}`,
        "ses_dreams_synthesis",
        NOW - 500 + i,
        "assistant",
        `SINTESE_INTERNA_${i}`
      );
    }
  }

  // Mensagens antigas, fora da janela de 24h (nunca devem retornar).
  if (opts.oldCount) {
    for (let i = 0; i < opts.oldCount; i++) {
      insertMessage(
        `msg_old_${i}`,
        session,
        NOW - 48 * 60 * MIN - i * 1000,
        "user",
        `DIALOGO_ANTIGO_${i}`
      );
    }
  }

  });
  writeFixture();
  db.close();
  return { dbPath, texts };
}

const WINDOW = { sinceMs: NOW - 60 * MIN, untilMs: NOW, includeReasoning: false };

function expectAllMessages(entries: ReturnType<typeof readRecentDialogues>, fixture: Fixture) {
  expect(entries.length).toBe(fixture.texts.length);
  expect(entries.map((e) => e.text)).toEqual(fixture.texts);
  // Ordem estritamente cronológica ascendente.
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i].timestamp).toBeGreaterThan(entries[i - 1].timestamp);
  }
  expect(new Set(entries.map((e) => e.message_id)).size).toBe(fixture.texts.length);
}

describe("TICKET-HARNESS-60 — readRecentDialogues sem teto forçado", () => {
  test("sem options.limit devolve TODAS as 600 mensagens (sem truncamento)", () => {
    const fixture = buildFixture({ name: "no_limit" });
    expect(fixture.texts.length).toBe(600);

    const entries = readRecentDialogues({ dbPath: fixture.dbPath, ...WINDOW });

    expectAllMessages(entries, fixture);
    expect(entries[0].text).toContain("DIALOGO_0000");
    expect(entries[599].text).toContain("DIALOGO_0599");
    expect(entries.some((e) => e.text.includes("DIALOGO_0500"))).toBe(true);
  });

  test("limit null/0/undefined explícito/Infinity/NaN/negativo = leitura irrestrita", () => {
    const fixture = buildFixture({ name: "unbounded_variants" });
    const variants: Array<number | null | undefined> = [
      null,
      0,
      undefined,
      Infinity,
      Number.NaN,
      -1,
      -500,
    ];

    for (const limit of variants) {
      const entries = readRecentDialogues({
        dbPath: fixture.dbPath,
        limit,
        ...WINDOW,
      });
      expect({
        limit: String(limit),
        count: entries.length,
      }).toEqual({ limit: String(limit), count: 600 });
      expect(entries.map((e) => e.text)).toEqual(fixture.texts);
    }
  });

  test("limit positivo (10) retém as 10 MAIS RECENTES em ordem cronológica", () => {
    const fixture = buildFixture({ name: "limit_10" });
    const entries = readRecentDialogues({
      dbPath: fixture.dbPath,
      limit: 10,
      ...WINDOW,
    });

    expect(entries.length).toBe(10);
    expect(entries.map((e) => e.text)).toEqual(fixture.texts.slice(-10));
    expect(entries[0].text).toContain("DIALOGO_0590");
    expect(entries[9].text).toContain("DIALOGO_0599");
  });

  test("limit 1 devolve exatamente a mensagem mais recente", () => {
    const fixture = buildFixture({ name: "limit_1" });
    const entries = readRecentDialogues({
      dbPath: fixture.dbPath,
      limit: 1,
      ...WINDOW,
    });
    expect(entries.length).toBe(1);
    expect(entries[0].text).toContain("DIALOGO_0599");
  });

  test("limit igual ao total (600) devolve todas, sem off-by-one", () => {
    const fixture = buildFixture({ name: "limit_exact_total" });
    const entries = readRecentDialogues({
      dbPath: fixture.dbPath,
      limit: 600,
      ...WINDOW,
    });
    expectAllMessages(entries, fixture);
  });

  test("limit fracionário positivo aplica floor (10.9 → 10 mais recentes)", () => {
    const fixture = buildFixture({ name: "limit_fraction" });
    const entries = readRecentDialogues({
      dbPath: fixture.dbPath,
      limit: 10.9,
      ...WINDOW,
    });
    expect(entries.length).toBe(10);
    expect(entries.map((e) => e.text)).toEqual(fixture.texts.slice(-10));
  });

  test("leitura irrestrita ainda respeita janela e exclusão de sessão interna", () => {
    const fixture = buildFixture({
      name: "window_and_exclusion",
      count: 600,
      synthesisCount: 25,
      oldCount: 40,
    });

    const entries = readRecentDialogues({ dbPath: fixture.dbPath, ...WINDOW });

    expectAllMessages(entries, fixture);
    expect(entries.some((e) => e.session_id === "ses_dreams_synthesis")).toBe(false);
    expect(entries.some((e) => e.text.startsWith("SINTESE_INTERNA_"))).toBe(false);
    expect(entries.some((e) => e.text.startsWith("DIALOGO_ANTIGO_"))).toBe(false);
  });
});

describe("TICKET-HARNESS-60 — integração real com SleepCycle (ambos os call sites)", () => {
  test("Light Sleep captura as 600 mensagens no handoff dialogue_pending.txt", async () => {
    const fixture = buildFixture({ name: "light_sleep" });
    const baseDir = path.join(BASE_DIR, "light_sleep_dreams");
    const dreamsDb = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      const cycle = new SleepCycle(dreamsDb, {
        baseDir,
        sessionDbPath: fixture.dbPath,
      });

      await cycle.lightSleep();

      const pendingPath = path.join(baseDir, "dialogue_pending.txt");
      expect(fs.existsSync(pendingPath)).toBe(true);
      const pending = fs.readFileSync(pendingPath, "utf8");

      const occurrences = pending.match(/DIALOGO_\d{4}/g) ?? [];
      expect(occurrences.length).toBe(600);
      expect(pending).toContain("DIALOGO_0000");
      expect(pending).toContain("DIALOGO_0599");

      // O handoff é byte-a-byte o resumo COMPLETO da leitura irrestrita.
      const direct = readRecentDialogues({
        dbPath: fixture.dbPath,
        hours: 24,
        untilMs: Date.now(),
        includeReasoning: false,
      });
      expect(direct.length).toBe(600);
      expect(pending).toBe(buildDialogueSummary(direct));
    } finally {
      dreamsDb.close();
    }
  });

  test("REM Sleep (leitura direta, sem handoff) lê as 600 mensagens, não 500", async () => {
    const fixture = buildFixture({ name: "rem_sleep" });
    const baseDir = path.join(BASE_DIR, "rem_sleep_dreams");
    const dreamsDb = new DreamsDB(path.join(baseDir, "dreams.db"));
    const logged: string[] = [];
    const originalLog = console.log;
    // Transport recorder: observa e repassa — nunca altera o comportamento.
    console.log = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const cycle = new SleepCycle(dreamsDb, {
        baseDir,
        sessionDbPath: fixture.dbPath,
        // captureDialogue=true (default) habilita o caminho de leitura direta
        // do REM; como o Light Sleep NUNCA rodou, não existe handoff pendente.
        captureDialogue: true,
      });

      // DREAMS_OFFLINE=1 (script `npm test`): a síntese é adiada, mas a leitura
      // e o particionamento do diálogo acontecem ANTES e são observáveis.
      await cycle.remSleep();

      const partitionLine = logged.find((line) =>
        line.includes("Diálogo particionado em")
      );
      expect(partitionLine).toBeDefined();

      // 600 mensagens curtas cabem em 1 chunk; o total de bytes prova que o
      // conteúdo lido foi o diálogo COMPLETO (não o teto antigo de 500).
      expect(partitionLine).toContain("1 chunk(s)");

      const direct = readRecentDialogues({
        dbPath: fixture.dbPath,
        hours: 24,
        untilMs: Date.now(),
        includeReasoning: false,
      });
      expect(direct.length).toBe(600);
      const fullBytes = Buffer.byteLength(buildDialogueSummary(direct), "utf8");

      // Controle de discriminação: o resumo de apenas 500 mensagens é menor.
      const capped = readRecentDialogues({
        dbPath: fixture.dbPath,
        hours: 24,
        untilMs: Date.now(),
        includeReasoning: false,
        limit: 500,
      });
      expect(capped.length).toBe(500);
      const cappedBytes = Buffer.byteLength(buildDialogueSummary(capped), "utf8");
      expect(fullBytes).toBeGreaterThan(cappedBytes);

      const bytesMatch = partitionLine?.match(/\((\d+) bytes no total\)/);
      expect(bytesMatch).not.toBeNull();
      expect(Number(bytesMatch![1])).toBe(fullBytes);
      expect(Number(bytesMatch![1])).toBeGreaterThan(cappedBytes);

      // O pendente NÃO é criado/consumido nesse caminho: o handoff permanece
      // inexistente e a síntese adiada é reportada no DREAMS.md.
      expect(fs.existsSync(path.join(baseDir, "dialogue_pending.txt"))).toBe(false);
      const dreamsMd = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf8");
      expect(dreamsMd).toContain("adiada");
    } finally {
      console.log = originalLog;
      dreamsDb.close();
    }
  });
});
