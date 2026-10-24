/**
 * TICKET-DREAMS-09 — Suíte determinística REAL (sem mocks/stubs) da evolução
 * do schema da tabela `session` do OpenCode e da defesa anti-recursão.
 *
 * Contexto do defeito: o OpenCode 1.18.34 normalizou a tabela `session` e o
 * título deixou de viver em `data` JSON — virou a coluna nativa `title`.
 * O leitor antigo exigia `data` e emitia um `SessionSchemaError` (fatal:
 * false) em TODO ciclo, desativando a exclusão das sessões internas do Dreams
 * (`"Dreams Synthesis"` / `"Dreams Reconciliation"`).
 *
 * Contrato coberto aqui, contra bancos SQLite REAIS em /tmp:
 *  (a) schema NORMALIZADO (`title` nativo): internas excluídas, externas
 *      retornadas, nenhum `SessionSchemaError` emitido;
 *  (b) schema LEGADO (`data` JSON): comportamento histórico preservado;
 *  (c) tabela `session` ausente: fail-soft (`[]`), nenhum throw;
 *  (d) `session` sem nenhuma fonte de título: aí sim é degradação real e é
 *      reportada como advisory;
 *  (e) não regressão do TICKET-DREAMS-60 (leitura sem LIMIT + ordem ASC);
 *  (f) títulos são PARAMETRIZADOS em ambas as variantes (anti-injection).
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import {
  readRecentDialogues,
  detectSessionTitleColumn,
  inspectSessionSchema,
  assertSessionSchema,
  SessionSchemaError,
  SESSION_TITLE_COLUMNS,
} from "../src/core/session_reader";

const BASE_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_09_schema_"));
const NOW = Date.now();
const MIN = 60 * 1000;
const WINDOW = { sinceMs: NOW - 10 * MIN, untilMs: NOW, includeReasoning: false };

afterAll(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---------------------------------------------------------------------------
// Fixtures: DDL ESTÁTICO por variante de schema (nunca DDL concatenado)
// ---------------------------------------------------------------------------

/** `message`/`part` são idênticas em todas as gerações do OpenCode. */
const MESSAGE_DDL = `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    time_created INTEGER,
    data TEXT
  );`;
const PART_DDL = `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    time_created INTEGER,
    data TEXT
  );`;

/** Schema NORMALIZADO (OpenCode >= 1.18.34): título em coluna nativa. */
const SESSION_NORMALIZED_DDL = `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    directory TEXT,
    title TEXT,
    agent TEXT,
    model TEXT,
    time_created INTEGER,
    time_updated INTEGER
  );`;

/** Schema LEGADO: título serializado no JSON de `data`. */
const SESSION_LEGACY_DDL = `CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`;

/** Schema TRANSICIONAL: normalização em curso — `title` nativo E `data` JSON. */
const SESSION_TRANSITIONAL_DDL = `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    title TEXT,
    data TEXT,
    time_created INTEGER
  );`;

/** Schema divergente REAL: existe, mas sem `title` E sem `data`. */
const SESSION_NO_TITLE_DDL = `CREATE TABLE session (id TEXT PRIMARY KEY, payload TEXT);`;

type SchemaKind = "normalized" | "legacy" | "transitional" | "absent" | "no_title_source";

interface FixtureSession {
  id: string;
  /** Título lógico (coluna `title` no schema novo, `data.title` no legado). */
  title?: string;
  /** Payload bruto de `data` (sobrepõe `title`; simula JSON inválido). */
  rawData?: string;
}

interface FixtureMessage {
  id: string;
  session: string;
  t: number;
  role: "user" | "assistant" | "system";
  texts: string[];
  reasonings?: string[];
}

/** Cria um `opencode.db` REAL com a geração de schema pedida. */
function buildDb(opts: {
  name: string;
  schema: SchemaKind;
  sessions?: FixtureSession[];
  messages?: FixtureMessage[];
}): string {
  const dir = path.join(BASE_DIR, opts.name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);

  db.run(MESSAGE_DDL);
  db.run(PART_DDL);

  if (opts.schema === "normalized") {
    db.run(SESSION_NORMALIZED_DDL);
    for (const s of opts.sessions ?? []) {
      db.run(
        "INSERT INTO session (id, project_id, directory, title, agent, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [s.id, "prj_public", "/tmp/project", s.title ?? null, "developer", "model-x", NOW, NOW]
      );
    }
  } else if (opts.schema === "legacy") {
    db.run(SESSION_LEGACY_DDL);
    for (const s of opts.sessions ?? []) {
      const payload = s.rawData !== undefined ? s.rawData : JSON.stringify({ title: s.title });
      db.run("INSERT INTO session (id, data) VALUES (?, ?)", [s.id, payload]);
    }
  } else if (opts.schema === "transitional") {
    db.run(SESSION_TRANSITIONAL_DDL);
    for (const s of opts.sessions ?? []) {
      const payload = s.rawData !== undefined ? s.rawData : JSON.stringify({ title: s.title });
      db.run("INSERT INTO session (id, title, data, time_created) VALUES (?, ?, ?, ?)", [
        s.id,
        s.title ?? null,
        payload,
        NOW,
      ]);
    }
  } else if (opts.schema === "no_title_source") {
    db.run(SESSION_NO_TITLE_DDL);
    for (const s of opts.sessions ?? []) {
      db.run("INSERT INTO session (id, payload) VALUES (?, ?)", [s.id, "{}"]);
    }
  }

  let n = 0;
  for (const m of opts.messages ?? []) {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      m.id,
      m.session,
      m.t,
      JSON.stringify({ role: m.role }),
    ]);
    for (const r of m.reasonings ?? []) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_r${n++}`,
        m.id,
        m.t + n,
        JSON.stringify({ type: "reasoning", text: r }),
      ]);
    }
    for (const t of m.texts) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_t${n++}`,
        m.id,
        m.t + n,
        JSON.stringify({ type: "text", text: t }),
      ]);
    }
  }

  db.close();
  return dbPath;
}

// ===========================================================================
// (a) SCHEMA NORMALIZADO — `title` nativo sustenta a anti-recursão
// ===========================================================================

describe("[DREAMS-09/A] schema normalizado (title nativo)", () => {
  test("detecta a fonte do título como a coluna nativa `title`", () => {
    const dbPath = buildDb({ name: "detect_normalized", schema: "normalized" });
    const db = new Database(dbPath, { readonly: true });
    expect(detectSessionTitleColumn(db)).toBe("title");
    db.close();
  });

  test("schema novo NÃO é divergência: inspect/assert limpos e nenhum SessionSchemaError", () => {
    const dbPath = buildDb({
      name: "no_alarm",
      schema: "normalized",
      sessions: [{ id: "ses_user", title: "Conversa comum" }],
      messages: [{ id: "m1", session: "ses_user", t: NOW - 5000, role: "user", texts: ["olá"] }],
    });

    const db = new Database(dbPath, { readonly: true });
    expect(inspectSessionSchema(db)).toEqual([]);
    expect(assertSessionSchema(db, dbPath)).toEqual([]);
    db.close();

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, onError: (e) => errors.push(e) });
    // O falso alarme do Light Sleep morre aqui: nenhum erro no caminho novo.
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.text)).toEqual(["olá"]);
  });

  test("(a) internas do Dreams excluídas; externas retornam integralmente", () => {
    const dbPath = buildDb({
      name: "normalized_mixed",
      schema: "normalized",
      sessions: [
        { id: "ses_synth", title: "Dreams Synthesis" },
        { id: "ses_recon", title: "Dreams Reconciliation" },
        { id: "ses_lookalike", title: "Dreams Synthesis arquivada" },
        { id: "ses_user_a", title: "Conversa alfa" },
        { id: "ses_user_b", title: "Conversa beta" },
      ],
      messages: [
        // Internas: as MAIS recentes (se vazassem, dominariam o topo da janela).
        { id: "m_synth", session: "ses_synth", t: NOW - 800, role: "user", texts: ["CONTEUDO_SINTESE_NAO_DEVE_VAZAR"] },
        { id: "m_recon", session: "ses_recon", t: NOW - 900, role: "assistant", texts: ["PROMPT_RECONCILIACAO_NAO_DEVE_VAZAR"] },
        // Lookalike (título diferente por sufixo): NÃO pode ser excluída.
        { id: "m_look", session: "ses_lookalike", t: NOW - 1500, role: "user", texts: ["titulo parecido mas legitimo"] },
        // Externas legítimas.
        { id: "m_a", session: "ses_user_a", t: NOW - 4000, role: "user", texts: ["dialogo alfa"] },
        { id: "m_b", session: "ses_user_b", t: NOW - 6000, role: "assistant", texts: ["dialogo beta"] },
      ],
    });

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, ...WINDOW, onError: (e) => errors.push(e) });

    expect(errors).toEqual([]);
    const sessionIds = entries.map((e) => e.session_id);
    expect(sessionIds).not.toContain("ses_synth");
    expect(sessionIds).not.toContain("ses_recon");
    expect(new Set(sessionIds)).toEqual(new Set(["ses_lookalike", "ses_user_a", "ses_user_b"]));

    const texts = entries.map((e) => e.text);
    expect(texts).toContain("dialogo alfa");
    expect(texts).toContain("dialogo beta");
    expect(texts).toContain("titulo parecido mas legitimo");
    expect(texts.some((t) => t.includes("CONTEUDO_SINTESE_NAO_DEVE_VAZAR"))).toBe(false);
    expect(texts.some((t) => t.includes("PROMPT_RECONCILIACAO_NAO_DEVE_VAZAR"))).toBe(false);
  });

  test("(a2) filtro SQL no schema novo incide ANTES do LIMIT (orçamento preservado)", () => {
    const dbPath = buildDb({
      name: "normalized_limit_budget",
      schema: "normalized",
      sessions: [
        { id: "ses_synth", title: "Dreams Synthesis" },
        { id: "ses_user_1", title: "Conversa 1" },
        { id: "ses_user_2", title: "Conversa 2" },
      ],
      messages: [
        { id: "m_user_1", session: "ses_user_1", t: NOW - 5000, role: "user", texts: ["texto 1"] },
        { id: "m_user_2", session: "ses_user_2", t: NOW - 4000, role: "user", texts: ["texto 2"] },
        // Interna mais recente: se o filtro ocorresse só em JS, consumiria a vaga.
        { id: "m_synth", session: "ses_synth", t: NOW - 1000, role: "assistant", texts: ["sintese interna"] },
      ],
    });

    const entries = readRecentDialogues({ dbPath, ...WINDOW, limit: 2 });
    expect(entries.map((e) => e.text)).toEqual(["texto 1", "texto 2"]);
    expect(entries.every((e) => e.session_id !== "ses_synth")).toBe(true);
  });

  test("(f) título hostil é tratado como LITERAL no schema novo (parametrizado)", () => {
    const evil = "Dreams Synthesis'; DROP TABLE message; --";
    const dbPath = buildDb({
      name: "normalized_injection",
      schema: "normalized",
      sessions: [
        { id: "ses_evil", title: evil },
        { id: "ses_ok", title: "Conversa comum" },
      ],
      messages: [
        { id: "m_evil", session: "ses_evil", t: NOW - 1000, role: "user", texts: ["payload malicioso"] },
        { id: "m_ok", session: "ses_ok", t: NOW - 2000, role: "user", texts: ["texto legitimo"] },
      ],
    });

    const entries = readRecentDialogues({ dbPath, ...WINDOW, excludeSessionTitles: [evil] });
    expect(entries.map((e) => e.text)).toEqual(["texto legitimo"]);

    // A tabela `message` sobreviveu: a query seguinte ainda funciona.
    const after = readRecentDialogues({ dbPath, ...WINDOW });
    expect(after.map((e) => e.text)).toContain("payload malicioso");
  });
});

// ===========================================================================
// (b) SCHEMA LEGADO — `data` JSON preservado byte a byte
// ===========================================================================

describe("[DREAMS-09/B] schema legado (data JSON)", () => {
  test("detecta a fonte do título como `data` e mantém a exclusão histórica", () => {
    const dbPath = buildDb({
      name: "legacy_mixed",
      schema: "legacy",
      sessions: [
        { id: "ses_synth", title: "Dreams Synthesis" },
        { id: "ses_recon", title: "Dreams Reconciliation" },
        { id: "ses_normal", title: "Conversa comum" },
        { id: "ses_badjson", rawData: "{isto não é json" },
      ],
      messages: [
        { id: "m_synth", session: "ses_synth", t: NOW - 700, role: "user", texts: ["SINTESE_LEGADA_NAO_DEVE_VAZAR"] },
        { id: "m_recon", session: "ses_recon", t: NOW - 800, role: "assistant", texts: ["RECONCILIACAO_LEGADA_NAO_DEVE_VAZAR"] },
        { id: "m_normal", session: "ses_normal", t: NOW - 3000, role: "user", texts: ["dialogo legado legitimo"] },
        { id: "m_bad", session: "ses_badjson", t: NOW - 4000, role: "user", texts: ["sessao com json invalido"] },
      ],
    });

    const db = new Database(dbPath, { readonly: true });
    expect(detectSessionTitleColumn(db)).toBe("data");
    expect(inspectSessionSchema(db)).toEqual([]);
    db.close();

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, ...WINDOW, onError: (e) => errors.push(e) });

    expect(errors).toEqual([]);
    expect(new Set(entries.map((e) => e.session_id))).toEqual(
      new Set(["ses_normal", "ses_badjson"])
    );
    expect(entries.map((e) => e.text)).not.toContain("SINTESE_LEGADA_NAO_DEVE_VAZAR");
    expect(entries.map((e) => e.text)).not.toContain("RECONCILIACAO_LEGADA_NAO_DEVE_VAZAR");
  });

  test("(f) título hostil é LITERAL no schema legado (json_each parametrizado)", () => {
    const evil = "Dreams Reconciliation'); DELETE FROM session; --";
    const dbPath = buildDb({
      name: "legacy_injection",
      schema: "legacy",
      sessions: [
        { id: "ses_evil", title: evil },
        { id: "ses_ok", title: "Conversa comum" },
      ],
      messages: [
        { id: "m_evil", session: "ses_evil", t: NOW - 1000, role: "user", texts: ["payload legado"] },
        { id: "m_ok", session: "ses_ok", t: NOW - 2000, role: "user", texts: ["texto legitimo"] },
      ],
    });

    const entries = readRecentDialogues({ dbPath, ...WINDOW, excludeSessionTitles: [evil] });
    expect(entries.map((e) => e.text)).toEqual(["texto legitimo"]);
    expect(readRecentDialogues({ dbPath, ...WINDOW }).map((e) => e.text)).toContain("payload legado");
  });
});

// ===========================================================================
// (c) TABELA `session` AUSENTE — fail-soft, `[]`, nenhum throw
// ===========================================================================

describe("[DREAMS-09/C] tabela session ausente (fail-soft)", () => {
  test("sem tabela: detect null, leitura continua e nada é lançado", () => {
    const dbPath = buildDb({
      name: "absent_session",
      schema: "absent",
      messages: [
        { id: "m1", session: "ses_any", t: NOW - 1000, role: "user", texts: ["dialogo sem tabela session"] },
      ],
    });

    const db = new Database(dbPath, { readonly: true });
    expect(detectSessionTitleColumn(db)).toBeNull();
    db.close();

    // Nenhum throw (o fail-soft é da resolução de exclusões; a leitura do
    // diálogo continua normalmente, sem anti-recursão disponível).
    const entries = readRecentDialogues({ dbPath, ...WINDOW });
    expect(entries.map((e) => e.text)).toEqual(["dialogo sem tabela session"]);
  });

  test("sem tabela e sem mensagens na janela ⇒ [] (retorno vazio, sem throw)", () => {
    const dbPath = buildDb({ name: "absent_empty", schema: "absent" });
    expect(() => readRecentDialogues({ dbPath, ...WINDOW })).not.toThrow();
    expect(readRecentDialogues({ dbPath, ...WINDOW })).toEqual([]);
  });
});

// ===========================================================================
// (d) `session` SEM NENHUMA FONTE DE TÍTULO — degradação REAL (advisory)
// ===========================================================================

describe("[DREAMS-09/D] session sem title e sem data", () => {
  test("reporta advisory (fatal:false) e lê o diálogo sem quebrar", () => {
    const dbPath = buildDb({
      name: "no_title_source",
      schema: "no_title_source",
      sessions: [{ id: "ses_any" }],
      messages: [
        { id: "m1", session: "ses_any", t: NOW - 1000, role: "user", texts: ["dialogo normal"] },
      ],
    });

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, ...WINDOW, onError: (e) => errors.push(e) });

    expect(entries.map((e) => e.text)).toEqual(["dialogo normal"]);
    expect(errors.length).toBe(1);
    const error = errors[0] as SessionSchemaError;
    expect(error).toBeInstanceOf(SessionSchemaError);
    expect(error.fatal).toBe(false);
    expect(error.divergences[0].table).toBe("session");
    expect(error.divergences[0].severity).toBe("advisory");
    expect(error.divergences[0].missingColumns).toEqual([...SESSION_TITLE_COLUMNS]);
  });
});

// ===========================================================================
// (g) SCHEMA TRANSICIONAL — `title` nativo E `data` JSON coexistem
// ===========================================================================

describe("[DREAMS-09/G] schema transicional (title + data)", () => {
  test("consulta AS DUAS fontes: linha antiga (só data) e nova (só title) excluídas", () => {
    const dbPath = buildDb({
      name: "transitional_mixed",
      schema: "transitional",
      sessions: [
        // Linha ANTIGA da normalização: `title` nulo, título ainda em `data`.
        { id: "ses_old_synth", rawData: JSON.stringify({ title: "Dreams Synthesis" }) },
        // Linha NOVA: título na coluna nativa.
        { id: "ses_new_recon", title: "Dreams Reconciliation" },
        { id: "ses_user", title: "Conversa comum" },
      ],
      messages: [
        { id: "m_old_synth", session: "ses_old_synth", t: NOW - 700, role: "user", texts: ["SINTESE_ANTIGA_NAO_DEVE_VAZAR"] },
        { id: "m_new_recon", session: "ses_new_recon", t: NOW - 800, role: "assistant", texts: ["RECONCILIACAO_NOVA_NAO_DEVE_VAZAR"] },
        { id: "m_user", session: "ses_user", t: NOW - 3000, role: "user", texts: ["dialogo legitimo"] },
      ],
    });

    const db = new Database(dbPath, { readonly: true });
    expect(detectSessionTitleColumn(db)).toBe("title");
    expect(inspectSessionSchema(db)).toEqual([]);
    db.close();

    const entries = readRecentDialogues({ dbPath, ...WINDOW });
    expect(entries.map((e) => e.text)).toEqual(["dialogo legitimo"]);
  });
});

// ===========================================================================
// (e) NÃO REGRESSÃO do TICKET-DREAMS-60 no schema NORMALIZADO
// ===========================================================================

describe("[DREAMS-09/E] leitura sem LIMIT e ordem ASC preservadas no schema novo", () => {
  test("sem limit ⇒ TODAS as mensagens em ordem cronológica ASC", () => {
    const total = 40;
    const messages: FixtureMessage[] = [];
    for (let i = 0; i < total; i++) {
      messages.push({
        id: `m_${String(i).padStart(3, "0")}`,
        session: "ses_user",
        t: NOW - 60 * MIN + i * 1000,
        role: i % 2 === 0 ? "user" : "assistant",
        texts: [`DIALOGO_${i}`],
      });
    }
    const dbPath = buildDb({
      name: "unbounded_asc",
      schema: "normalized",
      sessions: [{ id: "ses_user", title: "Conversa longa" }],
      messages,
    });

    for (const limit of [undefined, null, 0, Infinity] as const) {
      const entries = readRecentDialogues({
        dbPath,
        sinceMs: NOW - 2 * 60 * MIN,
        untilMs: NOW,
        includeReasoning: false,
        ...(limit === undefined ? {} : { limit }),
      });
      expect(entries.length).toBe(total);
      expect(entries.map((e) => e.text)).toEqual(
        Array.from({ length: total }, (_, i) => `DIALOGO_${i}`)
      );
    }

    // Com teto finito: retém as MAIS RECENTES e devolve em ASC.
    const limited = readRecentDialogues({
      dbPath,
      sinceMs: NOW - 2 * 60 * MIN,
      untilMs: NOW,
      includeReasoning: false,
      limit: 5,
    });
    expect(limited.map((e) => e.text)).toEqual([
      "DIALOGO_35",
      "DIALOGO_36",
      "DIALOGO_37",
      "DIALOGO_38",
      "DIALOGO_39",
    ]);
  });
});
