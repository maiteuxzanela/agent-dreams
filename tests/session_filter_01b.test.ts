/**
 * TICKET-DREAMS-01B — Suíte determinística REAL (sem mocks) da defesa
 * anti-recursão do `session_reader.ts`.
 *
 * Objetivo: comprovar que sessões internas de síntese do Dreams
 * (título padrão `"Dreams Synthesis"`) NUNCA são reprocessadas como diálogo de
 * usuário — em DUAS camadas independentes:
 *   1. filtro SQL (`json_extract(session.data, '$.title') IN (...)`) aplicado
 *      ANTES do LIMIT (o orçamento de mensagens não é consumido pelas sessões
 *      excluídas);
 *   2. revalidação em JS no momento da emissão (Set de IDs excluídos).
 *
 * Toda a infraestrutura é REAL: bancos SQLite reais em /tmp, schema DDL real e
 * o módulo de produção real. Zero `unittest.mock`/`jest.mock`/stubs.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import {
  readRecentDialogues,
  DEFAULT_EXCLUDED_SESSION_TITLES,
} from "../src/core/session_reader";

const BASE_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_01b_filter_"));
const NOW = Date.now();
const MIN = 60 * 1000;

afterAll(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface FixtureSession {
  id: string;
  /** Objeto que é serializado com JSON.stringify. Ignorado quando rawData é dado. */
  data?: unknown;
  /** Payload bruto gravado verbatim (para simular JSON inválido). */
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

/**
 * Cria um banco OpenCode real em /tmp com as tabelas `message`, `part` e
 * (opcionalmente) `session`. Fecha o handle antes de devolver o caminho.
 */
function buildDb(opts: {
  name: string;
  sessions?: FixtureSession[];
  messages?: FixtureMessage[];
  withSessionTable?: boolean;
  detectForeignKeys?: boolean;
}): string {
  const dir = path.join(BASE_DIR, opts.name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);

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

  const withSessionTable = opts.withSessionTable ?? true;
  if (withSessionTable) {
    db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`);
    for (const s of opts.sessions ?? []) {
      const payload = s.rawData !== undefined ? s.rawData : JSON.stringify(s.data);
      db.run("INSERT INTO session (id, data) VALUES (?, ?)", [s.id, payload]);
    }
  }

  for (const m of opts.messages ?? []) {
    db.run(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      [m.id, m.session, m.t, JSON.stringify({ role: m.role })]
    );
    let n = 0;
    for (const r of m.reasonings ?? []) {
      db.run(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        [`${m.id}_r${n++}`, m.id, m.t + n, JSON.stringify({ type: "reasoning", text: r })]
      );
    }
    for (const t of m.texts) {
      db.run(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        [`${m.id}_t${n++}`, m.id, m.t + n, JSON.stringify({ type: "text", text: t })]
      );
    }
  }

  db.close();
  return dbPath;
}

const SESSIONS_MIXED: FixtureSession[] = [
  { id: "ses_synth", data: { title: "Dreams Synthesis" } },
  { id: "ses_other", data: { title: "Outro Título" } },
  { id: "ses_normal", data: { title: "Conversa comum da usuária" } },
  { id: "ses_badjson", rawData: "{isto não é json" },
];

const MESSAGES_MIXED: FixtureMessage[] = [
  // sessão de síntese: a MAIS recente — deve sumir por completo
  { id: "m_synth", session: "ses_synth", t: NOW - 1000, role: "user", texts: ["CONTEUDO_SINTESE_INTERNA_NAO_DEVE_VAZAR"] },
  // sessões comuns, mais antigas
  { id: "m_normal", session: "ses_normal", t: NOW - 9000, role: "user", texts: ["dialogo normal alfa"] },
  { id: "m_other", session: "ses_other", t: NOW - 8000, role: "user", texts: ["conteudo do titulo outro"] },
  { id: "m_bad", session: "ses_badjson", t: NOW - 7000, role: "user", texts: ["conteudo de sessao com json invalido"] },
];

const WINDOW = { sinceMs: NOW - 10 * MIN, untilMs: NOW, includeReasoning: false };

describe("TICKET-DREAMS-01B — filtro anti-recursão de sessões internas", () => {
  test("constante canônica expõe exatamente os títulos internos do Dreams", () => {
    expect(Array.isArray(DEFAULT_EXCLUDED_SESSION_TITLES)).toBe(true);
    // TICKET-DREAMS-06-FIX (BLOQUEANTE 1): além da síntese diária, o
    // julgamento neural de reconciliação do Sono REM também é uma sessão
    // interna do Dreams e jamais pode virar matéria-prima do dia seguinte.
    expect(DEFAULT_EXCLUDED_SESSION_TITLES).toEqual([
      "Dreams Synthesis",
      "Dreams Reconciliation",
    ]);
  });

  test("default: sessão 'Dreams Reconciliation' é 100% filtrada do diálogo (anti-recursão)", () => {
    const dbPath = buildDb({
      name: "reconciliation_filter",
      sessions: [
        { id: "ses_recon", data: { title: "Dreams Reconciliation" } },
        { id: "ses_synth", data: { title: "Dreams Synthesis" } },
        { id: "ses_normal", data: { title: "Conversa comum da usuária" } },
      ],
      messages: [
        { id: "m_recon", session: "ses_recon", t: NOW - 500, role: "user", texts: ["PROMPT_DE_JULGAMENTO_NEURAL_NAO_DEVE_VAZAR"] },
        { id: "m_synth", session: "ses_synth", t: NOW - 1000, role: "user", texts: ["CONTEUDO_SINTESE_INTERNA_NAO_DEVE_VAZAR"] },
        { id: "m_normal", session: "ses_normal", t: NOW - 9000, role: "user", texts: ["dialogo normal legitimo"] },
      ],
    });
    const entries = readRecentDialogues({ dbPath, ...WINDOW });

    // Nenhum vestígio das DUAS sessões internas.
    expect(entries.some((e) => e.session_id === "ses_recon")).toBe(false);
    expect(entries.some((e) => e.text.includes("PROMPT_DE_JULGAMENTO_NEURAL"))).toBe(false);
    expect(entries.some((e) => e.session_id === "ses_synth")).toBe(false);
    // A sessão legítima continua sendo lida normalmente.
    expect(entries.map((e) => e.session_id)).toEqual(["ses_normal"]);
  });

  test("default: sessão 'Dreams Synthesis' é 100% filtrada e não retorna no diálogo", () => {
    const dbPath = buildDb({ name: "default", sessions: SESSIONS_MIXED, messages: MESSAGES_MIXED });
    const entries = readRecentDialogues({ dbPath, ...WINDOW });

    // Nenhum vestígio da sessão de síntese.
    expect(entries.some((e) => e.session_id === "ses_synth")).toBe(false);
    expect(entries.some((e) => e.text.includes("CONTEUDO_SINTESE_INTERNA"))).toBe(false);

    // As sessões legítimas continuam sendo lidas normalmente.
    const sessionIds = new Set(entries.map((e) => e.session_id));
    expect(sessionIds.has("ses_normal")).toBe(true);
    expect(sessionIds.has("ses_other")).toBe(true);
    expect(sessionIds.has("ses_badjson")).toBe(true);
    expect(entries.length).toBe(3);
  });

  test("excludeSessionTitles: [] desliga o filtro e a sessão de síntese reaparece", () => {
    const dbPath = buildDb({ name: "disable", sessions: SESSIONS_MIXED, messages: MESSAGES_MIXED });
    const entries = readRecentDialogues({ dbPath, excludeSessionTitles: [], ...WINDOW });

    expect(entries.length).toBe(4);
    expect(entries.some((e) => e.session_id === "ses_synth")).toBe(true);
    expect(entries.some((e) => e.text.includes("CONTEUDO_SINTESE_INTERNA"))).toBe(true);
  });

  test("excludeSessionTitles customizado substitui (não soma) a lista padrão", () => {
    const dbPath = buildDb({ name: "custom", sessions: SESSIONS_MIXED, messages: MESSAGES_MIXED });
    const entries = readRecentDialogues({
      dbPath,
      excludeSessionTitles: ["Outro Título"],
      ...WINDOW,
    });

    // 'Outro Título' passa a ser filtrado...
    expect(entries.some((e) => e.session_id === "ses_other")).toBe(false);
    // ...e 'Dreams Synthesis' deixa de ser filtrado (a lista foi substituída).
    expect(entries.some((e) => e.session_id === "ses_synth")).toBe(true);
    expect(entries.some((e) => e.session_id === "ses_normal")).toBe(true);
  });

  test("fail-soft: banco sem tabela session continua lendo normalmente (sem exclusão)", () => {
    const dbPath = buildDb({
      name: "no_session_table",
      withSessionTable: false,
      messages: MESSAGES_MIXED,
    });
    // Não deve lançar; sem tabela `session`, o filtro degrada para vazio.
    const entries = readRecentDialogues({ dbPath, ...WINDOW });
    expect(entries.length).toBe(4);
    expect(entries.some((e) => e.session_id === "ses_synth")).toBe(true);
  });

  test("session.data com JSON inválido não derruba a leitura (json_valid blinda)", () => {
    const dbPath = buildDb({
      name: "bad_json",
      sessions: [
        { id: "ses_bad", rawData: "{{{" },
        { id: "ses_synth", data: { title: "Dreams Synthesis" } },
        { id: "ses_ok", data: { title: "normal" } },
      ],
      messages: [
        { id: "m_bad", session: "ses_bad", t: NOW - 3000, role: "user", texts: ["linha de sessao invalida"] },
        { id: "m_synth", session: "ses_synth", t: NOW - 2000, role: "user", texts: ["SINTESE VAZOU"] },
        { id: "m_ok", session: "ses_ok", t: NOW - 1000, role: "user", texts: ["linha normal ok"] },
      ],
    });

    let threw = false;
    let entries: ReturnType<typeof readRecentDialogues> = [];
    try {
      entries = readRecentDialogues({ dbPath, ...WINDOW });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const sessionIds = new Set(entries.map((e) => e.session_id));
    // A sessão com JSON inválido NÃO é excluída (json_valid=false) e é lida.
    expect(sessionIds.has("ses_bad")).toBe(true);
    // A sessão de síntese (JSON válido) segue excluída.
    expect(sessionIds.has("ses_synth")).toBe(false);
    expect(sessionIds.has("ses_ok")).toBe(true);
  });

  test("exclusão ocorre ANTES do LIMIT: sessões filtradas não consomem o orçamento", () => {
    // 4 mensagens da sessão de síntese (as MAIS recentes) + 2 da sessão normal.
    // Com limit=2, a leitura correta devolve as 2 normais (o filtro SQL precisa
    // ter incidido antes do LIMIT). Se o filtro fosse pós-LIMIT, o limite seria
    // gasto nas sínteses e nada sobraria.
    const synthMsgs: FixtureMessage[] = Array.from({ length: 4 }, (_, i) => ({
      id: `m_synth_${i}`,
      session: "ses_synth",
      t: NOW - 4000 + i * 100,
      role: "user" as const,
      texts: [`sintese interna ${i}`],
    }));
    const normMsgs: FixtureMessage[] = [
      { id: "m_norm_0", session: "ses_norm", t: NOW - 8000, role: "user", texts: ["normal zero"] },
      { id: "m_norm_1", session: "ses_norm", t: NOW - 7000, role: "user", texts: ["normal um"] },
    ];
    const dbPath = buildDb({
      name: "limit_budget",
      sessions: [
        { id: "ses_synth", data: { title: "Dreams Synthesis" } },
        { id: "ses_norm", data: { title: "normal" } },
      ],
      messages: [...synthMsgs, ...normMsgs],
    });

    const entries = readRecentDialogues({ dbPath, limit: 2, ...WINDOW });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.session_id === "ses_norm")).toBe(true);
    expect(entries.map((e) => e.text)).toEqual(["normal zero", "normal um"]);
  });

  test("janela hours/sinceMs/untilMs é respeitada junto ao filtro", () => {
    // Excluída dentro da janela; normal dentro; normal fora (antiga demais).
    const dbPath = buildDb({
      name: "window",
      sessions: [
        { id: "ses_synth", data: { title: "Dreams Synthesis" } },
        { id: "ses_norm", data: { title: "normal" } },
      ],
      messages: [
        { id: "m_synth_in", session: "ses_synth", t: NOW - 1000, role: "user", texts: ["SINTESE DENTRO"] },
        { id: "m_norm_in", session: "ses_norm", t: NOW - 2000, role: "user", texts: ["normal dentro da janela"] },
        { id: "m_norm_out", session: "ses_norm", t: NOW - 3 * 60 * MIN, role: "user", texts: ["normal fora da janela"] },
      ],
    });

    // Executa a janela via `hours` (sem sinceMs): apenas as últimas 1h.
    const entries = readRecentDialogues({
      dbPath,
      hours: 1,
      untilMs: NOW,
      includeReasoning: false,
    });

    const texts = entries.map((e) => e.text);
    expect(texts).toContain("normal dentro da janela");
    expect(texts).not.toContain("normal fora da janela");
    expect(texts).not.toContain("SINTESE DENTRO");
    expect(entries.length).toBe(1);
  });

  test("title com espaços/caixa diferente NÃO é excluído (comparação exata)", () => {
    const dbPath = buildDb({
      name: "exact_match",
      sessions: [
        { id: "ses_case", data: { title: "dreams synthesis" } },
        { id: "ses_space", data: { title: "Dreams Synthesis " } },
        { id: "ses_exact", data: { title: "Dreams Synthesis" } },
      ],
      messages: [
        { id: "m_case", session: "ses_case", t: NOW - 3000, role: "user", texts: ["caixa diferente"] },
        { id: "m_space", session: "ses_space", t: NOW - 2000, role: "user", texts: ["espaco extra"] },
        { id: "m_exact", session: "ses_exact", t: NOW - 1000, role: "user", texts: ["match exato"] },
      ],
    });
    const entries = readRecentDialogues({ dbPath, ...WINDOW });
    const sessionIds = new Set(entries.map((e) => e.session_id));
    expect(sessionIds.has("ses_exact")).toBe(false);
    expect(sessionIds.has("ses_case")).toBe(true);
    expect(sessionIds.has("ses_space")).toBe(true);
  });
});
