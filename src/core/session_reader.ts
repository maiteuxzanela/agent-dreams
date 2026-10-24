/**
 * session_reader.ts — Leitura read-only das conversas recentes do OpenCode.
 *
 * Abre `~/.local/share/opencode/opencode.db` em modo SOMENTE LEITURA
 * (`new Database(dbPath, { readonly: true })`) e extrai o diálogo textual
 * das últimas N horas unindo as tabelas `message` e `part`.
 *
 * Regras de extração:
 *  - Papel vindo de `message.data` → JSON `$.role` (`user` = instruções/pedidos/
 *    feedbacks da usuária; `assistant` = respostas/ações do agente).
 *  - Texto vindo de `part.data` → JSON `$.type === "text"` ou
 *    `$.type === "reasoning"`, campo `$.text`.
 *  - Ruído descartado: `type: "tool"` (payloads binários / saídas de bash
 *    gigantescas), `step-start`, `step-finish`, `patch`, `file`, `compaction`.
 *
 * Defesa anti-recursão: sessões internas do Dreams (títulos canônicos
 * `"Dreams Synthesis"` — a síntese diária — e `"Dreams Reconciliation"` — o
 * julgamento neural de reconciliação do Sono REM) são excluídas em duas
 * camadas — filtro SQL e revalidação em JS no momento da emissão — de modo
 * que a síntese (ou a reconciliação) de um dia nunca seja reprocessada como
 * diálogo de usuário no dia seguinte. A lista é configurável por
 * `excludeSessionTitles`.
 *
 * TICKET-DREAMS-09 — EVOLUÇÃO LEGÍTIMA DO SCHEMA DE `session`: o OpenCode
 * 1.18.34 normalizou a tabela e passou a expor `title` como COLUNA nativa
 * (antes o título vivia em `data` JSON). A exclusão anti-recursão detecta a
 * fonte REAL do título via `PRAGMA table_info` — `title` no schema novo,
 * `data` no legado — e monta o filtro correspondente, sempre com parâmetros
 * vinculados (nunca interpolando título em SQL). Divergência de schema só é
 * REPORTADA quando NENHUMA das duas fontes existe (aí, sim, a anti-recursão
 * fica inativa); a evolução `data` → `title` não é mais alarme.
 *
 * TICKET-DREAMS-06-FIX (BLOQUEANTE 1): o título `"Dreams Reconciliation"`
 * entrou na lista canônica porque o julgamento neural de reconciliação roda
 * como um processo `opencode run --title "Dreams Reconciliation"` — sem esta
 * exclusão, o PRÓPRIO julgamento da noite seria ingerido como diálogo de
 * usuário no ciclo seguinte (auto-alimentação recursiva do acervo).
 *
 * NUNCA lança exceção não tratada: banco inexistente, vazio, corrompido ou
 * indisponível retornam `[]` (fail-soft; o erro é apenas repassado ao
 * callback opcional `onError`, nunca propagado).
 *
 * TICKET-DREAMS-04 — CHECAGEM PREVENTIVA DE SCHEMA: antes da query quente,
 * o schema do OpenCode é inspecionado via `PRAGMA table_info` (tabelas
 * `message`, `part` e `session`). Uma divergência crítica (tabela essencial
 * ausente ou coluna crítica faltando) vira um erro SEMÂNTICO
 * (`SessionSchemaError`) que orienta a usuária a atualizar o OpenCode —
 * no lugar do crash genérico do SQLite. Divergências advisory (a tabela
 * opcional `session`) são reportadas, mas não abortam a leitura.
 *
 * TICKET-DREAMS-08 (Frente 8A) — INGESTÃO INTEGRAL EM CHUNKS: além do resumo
 * de disparo único (`summarizeDialogues`, mantido por compatibilidade), este
 * módulo expõe `chunkDialogues` / `chunkDialogueText` / `buildDialogueSummary`.
 * Eles particionam TODO o diálogo do dia em fatias sequenciais seguras
 * (orçamento de caracteres E de bytes UTF-8), SEM o truncamento invertido que
 * omitia o início do dia (`[… início do dia omitido]`). O REM Sleep consome
 * cada fatia individualmente, de modo que dias com >120.000 caracteres são
 * processados integralmente (manhã, tarde e noite).
 */
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";

/** Papel do autor da mensagem dentro da sessão. */
export type DialogRole = "user" | "assistant" | "system" | "other";

/** Natureza textual do trecho extraído. */
export type DialogKind = "text" | "reasoning";

/**
 * Títulos de sessão internos do Dreams que NUNCA devem ser lidos como diálogo
 * de usuário (defesa anti-recursão: a síntese de um dia não pode virar
 * matéria-prima do dia seguinte). Comparação exata contra
 * `json_extract(session.data, '$.title')`.
 *
 * - `"Dreams Synthesis"` — a síntese diária (REM Sleep).
 * - `"Dreams Reconciliation"` — o julgamento neural de reconciliação
 *   (REM Sleep, TICKET-DREAMS-06): também é um processo interno do Dreams e
 *   jamais pode reentrar no acervo como diálogo de usuário.
 */
export const DEFAULT_EXCLUDED_SESSION_TITLES: readonly string[] = [
  "Dreams Synthesis",
  "Dreams Reconciliation",
];

/** Um trecho do diálogo, já normalizado e agrupado por mensagem. */
export interface DialogEntry {
  /** ID da sessão OpenCode (`ses_...`). */
  session_id: string;
  /** ID da mensagem de origem (`msg_...`). */
  message_id: string;
  /** Autor: `user` (usuária) vs `assistant` (agente). */
  role: DialogRole;
  /** `text` = fala explícita; `reasoning` = raciocínio intermediário do agente. */
  kind: DialogKind;
  /** Conteúdo textual (possivelmente truncado em `maxTextLength`). */
  text: string;
  /** Timestamp da mensagem em epoch milliseconds. */
  timestamp: number;
  /** Timestamp da mensagem em ISO 8601 (UTC). */
  time_iso: string;
  /** `true` quando o texto foi cortado por `maxTextLength`. */
  truncated: boolean;
}

/** Opções de leitura do diálogo recente. */
export interface SessionReaderOptions {
  /** Caminho do SQLite. Padrão: `~/.local/share/opencode/opencode.db`. */
  dbPath?: string;
  /** Janela de horas retroativas. Padrão: 24. */
  hours?: number;
  /** Corte absoluto em epoch ms (sobrepõe `hours`). */
  sinceMs?: number;
  /** Limite superior absoluto em epoch ms (padrão: agora). */
  untilMs?: number;
  /**
   * Máximo de mensagens retornadas.
   *
   * OPCIONAL: quando omitido (ou `null`, `0` ou `Infinity`), a consulta SQL
   * NÃO aplica cláusula `LIMIT` — leitura irrestrita de TODAS as mensagens da
   * janela `[since, until]`, em ordem cronológica ascendente. Apenas um número
   * positivo e finito ativa o teto compatível (ordenação decrescente + LIMIT,
   * depois revertida para cronológica), retendo as mensagens mais recentes.
   */
  limit?: number | null;
  /** Incluir partes `reasoning` além das `text`. Padrão: true. */
  includeReasoning?: boolean;
  /** Filtrar por papel específico (padrão: todos). */
  role?: DialogRole;
  /** Corte de caracteres por trecho; `0` ou `Infinity` desliga. Padrão: 4000. */
  maxTextLength?: number;
  /**
   * Títulos de sessão a excluir da leitura (comparação EXATA contra a fonte
   * de título do schema real: a coluna `title` no schema normalizado do
   * OpenCode, ou `data` JSON no legado). Padrão:
   * `["Dreams Synthesis", "Dreams Reconciliation"]`.
   * Passe `[]` para desligar a exclusão. Quando a tabela `session` não existe
   * (schema divergente), a exclusão degrada para vazio — e a divergência é
   * REPORTADA via `onError` (sem abortar a leitura), porque a defesa
   * anti-recursão fica inativa.
   */
  excludeSessionTitles?: readonly string[];
  /**
   * Observabilidade opcional: recebe qualquer erro engolido pelo fail-soft.
   * A função NUNCA lança — quem decide se o erro vira log é o chamador.
   */
  onError?: (error: unknown) => void;
}

/** Uma linha crua da tabela `message` lida do banco de sessões. */
interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  role_raw: unknown;
}

/**
 * TICKET-DREAMS-04 — SQLs ESTÁTICOS da leitura (nada é concatenado neles).
 *
 * A lista de sessões internas a excluir e a lista de IDs de mensagem entram
 * como PARÂMETRO JSON, expandido por `json_each` — em vez de placeholders
 * montados por concatenação. `NOT IN (SELECT ...)` sobre um conjunto vazio é
 * TRUE, então a ausência de exclusões não altera o resultado.
 */

/** Variante COM teto: as N mensagens MAIS RECENTES (invertidas em JS). */
const SQL_MESSAGES_LIMITED = `
      SELECT m.id, m.session_id, m.time_created,
             json_extract(m.data, '$.role') AS role_raw
        FROM message m
       WHERE m.time_created >= ? AND m.time_created <= ?
         AND m.session_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY m.time_created DESC, m.id DESC
       LIMIT ?`;

/** Variante SEM teto: TODAS as mensagens da janela, em ordem cronológica. */
const SQL_MESSAGES_UNLIMITED = `
      SELECT m.id, m.session_id, m.time_created,
             json_extract(m.data, '$.role') AS role_raw
        FROM message m
       WHERE m.time_created >= ? AND m.time_created <= ?
         AND m.session_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY m.time_created ASC, m.id ASC`;

/** Partes textuais (`text`/`reasoning`) das mensagens informadas. */
const SQL_PARTS = `
      SELECT p.message_id,
             json_extract(p.data, '$.type')  AS ptype,
             json_extract(p.data, '$.text')  AS ptext,
             p.time_created AS ptime,
             p.id           AS pid
        FROM part p
       WHERE p.message_id IN (SELECT value FROM json_each(?))
         AND json_valid(p.data)
         AND (
               json_extract(p.data, '$.type') = 'text'
               OR (? = 1 AND json_extract(p.data, '$.type') = 'reasoning')
             )
         AND json_extract(p.data, '$.text') IS NOT NULL
         AND TRIM(json_extract(p.data, '$.text')) <> ''
       ORDER BY p.message_id, p.time_created ASC, p.id ASC`;

/** Caminho padrão do banco de sessões do OpenCode. */
export function defaultSessionDbPath(): string {
  return path.join(os.homedir(), ".local/share/opencode/opencode.db");
}

/**
 * TICKET-DREAMS-09 — exclusão anti-recursão por TÍTULO, em DUAS variantes
 * ESTÁTICAS (o schema real decide qual executar; nada é concatenado):
 *
 *  - `SQL_EXCLUDED_BY_TITLE` — schema NORMALIZADO do OpenCode (>= 1.18.34),
 *    onde `title` é coluna nativa da tabela `session`;
 *  - `SQL_EXCLUDED_BY_DATA_TITLE` — schema LEGADO, onde o título vive no JSON
 *    de `data` (`json_valid` blinda contra JSON malformado isolado).
 *
 * Em AMBAS a lista de títulos entra como PARÂMETRO JSON expandido por
 * `json_each`: nenhum título (nem qualquer valor externo) é interpolado na
 * string SQL. Comparação EXATA, como exige a defesa anti-recursão.
 */
const SQL_EXCLUDED_BY_TITLE = `
      SELECT s.id AS id
        FROM session s
       WHERE s.title IN (SELECT value FROM json_each(?))`;

const SQL_EXCLUDED_BY_DATA_TITLE = `
      SELECT s.id AS id
        FROM session s
       WHERE json_valid(s.data)
         AND json_extract(s.data, '$.title') IN (SELECT value FROM json_each(?))`;

/**
 * Schema TRANSICIONAL (as duas colunas coexistem durante a normalização):
 * o título é procurado nas DUAS fontes, porque linhas antigas podem ter
 * `title` nulo com o título ainda em `data`. Dois parâmetros idênticos.
 */
const SQL_EXCLUDED_BY_TITLE_OR_DATA = `
      SELECT s.id AS id
        FROM session s
       WHERE s.title IN (SELECT value FROM json_each(?))
          OR (json_valid(s.data)
              AND json_extract(s.data, '$.title') IN (SELECT value FROM json_each(?)))`;

// ---------------------------------------------------------------------------
// TICKET-DREAMS-04 — Checagem preventiva de schema do OpenCode
// ---------------------------------------------------------------------------

/**
 * Tabelas do banco de sessões inspecionadas na checagem preventiva.
 *
 * `message` e `part` são o CORPO da leitura (sem elas a query quente nem
 * compila). `session` é usada apenas pela exclusão anti-recursão — sua
 * ausência é uma degradação suportada (ver `collectExcludedSessionIds`), mas
 * continua sendo inspecionada para que a divergência seja REPORTADA.
 */
export const SESSION_SCHEMA_TABLES = ["message", "part", "session"] as const;

/** Versão em `Set` da lista acima (guard de interpolação do PRAGMA). */
const SESSION_SCHEMA_TABLE_SET: ReadonlySet<string> = new Set(SESSION_SCHEMA_TABLES);

/** Colunas críticas por tabela (as consumidas pelas queries de leitura). */
export const SESSION_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "time_created", "data"],
  // TICKET-DREAMS-09: a tabela `session` só exige a IDENTIDADE. A fonte do
  // título é polimórfica (`title` no schema normalizado, `data` no legado) e
  // qualquer uma das duas satisfaz a anti-recursão — ver SESSION_TITLE_COLUMNS.
  session: ["id"],
};

/**
 * Colunas ACEITAS como fonte do título de sessão, em ordem de preferência.
 *
 *  - `title` — schema NORMALIZADO do OpenCode (>= 1.18.34): coluna nativa,
 *    comparada diretamente com `IN (SELECT value FROM json_each(?))`.
 *  - `data` — schema LEGADO: o título vive em `data` JSON, lido por
 *    `json_extract(data, '$.title')` com `json_valid` como guarda.
 *
 * A presença de QUALQUER uma delas torna o schema legítimo; a ausência das
 * duas é a única divergência real que desliga a anti-recursão.
 */
export const SESSION_TITLE_COLUMNS = ["title", "data"] as const;

/** Fonte real do título de uma tabela `session`. */
export type SessionTitleColumn = (typeof SESSION_TITLE_COLUMNS)[number];

/**
 * Tabelas cuja AUSÊNCIA invalida a leitura. `session` NÃO entra: ela é
 * opcional por contrato (a exclusão anti-recursão degrada para lista vazia).
 */
const REQUIRED_SESSION_TABLES: readonly string[] = ["message", "part"];

/**
 * Severidade de uma divergência de schema.
 *
 *  - `critical`: a leitura é IMPOSSÍVEL (falta tabela/coluna essencial).
 *    O erro semântico aborta a leitura no lugar do crash genérico do SQLite.
 *  - `advisory`: a leitura continua, mas uma capacidade foi degradada
 *    (ex.: a exclusão anti-recursão fica inativa). O erro semântico é
 *    reportado, mas NÃO aborta a leitura.
 */
export type SessionSchemaSeverity = "critical" | "advisory";

/** Uma divergência detectada entre o schema esperado e o schema real. */
export interface SessionSchemaDivergence {
  /** Tabela inspecionada (`message`, `part` ou `session`). */
  table: string;
  /** `critical` aborta a leitura; `advisory` apenas reporta. */
  severity: SessionSchemaSeverity;
  /** `true` quando a tabela inteira não existe no banco. */
  missingTable: boolean;
  /** Colunas críticas ausentes (vazio quando a tabela inteira falta). */
  missingColumns: string[];
}

/**
 * Erro SEMÂNTICO de divergência de schema — orienta a usuária/ o usuário em
 * vez de propagar um `SQLiteError: no such column: ...` genérico.
 */
export class SessionSchemaError extends Error {
  /** Divergências detectadas (críticas e/ou advisory). */
  readonly divergences: SessionSchemaDivergence[];
  /** Caminho do banco inspecionado. */
  readonly dbPath: string;
  /** `true` quando a divergência IMPEDE a leitura (severidade crítica). */
  readonly fatal: boolean;

  constructor(dbPath: string, divergences: SessionSchemaDivergence[]) {
    super(buildSessionSchemaMessage(dbPath, divergences));
    this.name = "SessionSchemaError";
    this.divergences = divergences;
    this.dbPath = dbPath;
    this.fatal = divergences.some((divergence) => divergence.severity === "critical");
  }
}

/** Monta a mensagem orientativa do erro semântico de schema. */
function buildSessionSchemaMessage(
  dbPath: string,
  divergences: SessionSchemaDivergence[]
): string {
  const details = divergences
    .map((divergence) => {
      if (divergence.missingTable) return `tabela '${divergence.table}' ausente`;
      return `tabela '${divergence.table}' sem a(s) coluna(s) ${divergence.missingColumns.join(", ")}`;
    })
    .join("; ");

  const fatal = divergences.some((divergence) => divergence.severity === "critical");

  if (!fatal) {
    return (
      `Schema do banco de sessões do OpenCode divergente (${dbPath}): ${details}. ` +
      `A leitura do diálogo continua, mas a exclusão anti-recursão das sessões ` +
      `internas do Dreams fica inativa (schema divergente do esperado).`
    );
  }

  return (
    `Schema do banco de sessões do OpenCode incompatível (${dbPath}): ${details}. ` +
    `O Dreams espera as tabelas 'message' (id, session_id, time_created, data), ` +
    `'part' (id, message_id, time_created, data) e 'session' (id e title OU data). ` +
    `Atualize o OpenCode para a versão que o Dreams suporta ou aponte o caminho ` +
    `correto do banco de sessões.`
  );
}

/** Colunas existentes de uma tabela (`PRAGMA table_info`). */
function tableColumns(db: Database, table: string): Set<string> {
  // O identificador vem SEMPRE da lista fechada `SESSION_SCHEMA_TABLES`
  // (nunca de entrada do usuário) — o guard abaixo blinda a interpolação
  // do PRAGMA contra qualquer nome de tabela forasteiro.
  if (!SESSION_SCHEMA_TABLE_SET.has(table)) return new Set();
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Inspeciona o schema do banco de sessões via `PRAGMA table_info` e devolve
 * as divergências encontradas (tabela ausente ou coluna crítica ausente).
 *
 * Leve e somente-leitura: 3 PRAGMAs — nenhuma query sobre as tabelas.
 *
 * TICKET-DREAMS-09: a tabela `session` aceita DUAS gerações legítimas —
 * `title` nativo (OpenCode normalizado) ou `data` JSON (legado). A evolução
 * `data` → `title` NÃO é divergência; só é reportada (advisory) quando a
 * tabela some ou quando nenhuma das fontes de título existe.
 */
export function inspectSessionSchema(db: Database): SessionSchemaDivergence[] {
  const divergences: SessionSchemaDivergence[] = [];

  for (const table of SESSION_SCHEMA_TABLES) {
    const columns = tableColumns(db, table);
    const required = REQUIRED_SESSION_TABLES.includes(table);
    const severity: SessionSchemaSeverity = required ? "critical" : "advisory";

    if (columns.size === 0) {
      // `PRAGMA table_info` de uma tabela inexistente devolve zero linhas.
      divergences.push({
        table,
        severity,
        missingTable: true,
        missingColumns: [],
      });
      continue;
    }

    const missingColumns = SESSION_SCHEMA_COLUMNS[table].filter(
      (column) => !columns.has(column)
    );

    // TICKET-DREAMS-09: sem NENHUMA fonte de título a anti-recursão fica
    // inativa — aí a degradação é real e precisa ser reportada.
    if (table === "session" && !SESSION_TITLE_COLUMNS.some((column) => columns.has(column))) {
      missingColumns.push(...SESSION_TITLE_COLUMNS);
    }

    if (missingColumns.length > 0) {
      divergences.push({
        table,
        severity,
        missingTable: false,
        missingColumns,
      });
    }
  }

  return divergences;
}

/**
 * Validação PREVENTIVA do schema do OpenCode.
 *
 * Divergências `critical` abortam a leitura com um erro semântico (o
 * usuário é orientado a atualizar o OpenCode); divergências `advisory` são
 * apenas reportadas — a leitura continua, com a capacidade degradada.
 *
 * @throws {SessionSchemaError} quando há divergência crítica.
 */
export function assertSessionSchema(db: Database, dbPath: string): SessionSchemaDivergence[] {
  const divergences = inspectSessionSchema(db);
  const critical = divergences.filter((divergence) => divergence.severity === "critical");
  if (critical.length > 0) {
    throw new SessionSchemaError(dbPath, critical);
  }
  return divergences;
}

/** Normaliza o papel vindo do JSON de `message.data`. */
function normalizeRole(raw: unknown): DialogRole {
  if (raw === "user" || raw === "assistant" || raw === "system") return raw;
  return "other";
}

/**
 * Detecta a FONTE REAL do título da tabela `session` inspecionando as colunas
 * existentes (`PRAGMA table_info`).
 *
 * TICKET-DREAMS-09: o schema do OpenCode evoluiu de `data` JSON para a coluna
 * nativa `title`. Quando as duas coexistem (schema transicional), devolve
 * `title` — a coleta de exclusões consulta as DUAS fontes nesse caso, para não
 * perder linhas antigas cujo título ainda está só em `data`.
 *
 * Fail-soft por contrato: tabela ausente, banco ilegível ou nenhuma coluna
 * aceita devolvem `null` (o chamador degrada para "sem exclusões", sem throw).
 */
export function detectSessionTitleColumn(db: Database): SessionTitleColumn | null {
  try {
    const columns = tableColumns(db, "session");
    for (const column of SESSION_TITLE_COLUMNS) {
      if (columns.has(column)) return column;
    }
    return null;
  } catch {
    // Banco fechado/corrompido ou PRAGMA indisponível → degradação silenciosa.
    return null;
  }
}

/**
 * Coleta os IDs de sessões cujo título bate com `titles`.
 *
 * Defesa em profundidade (camada 1 — SQL): resolve as sessões internas do
 * Dreams uma única vez, fora da query quente, consultando a tabela `session`.
 * A consulta executada depende do formato REAL do schema (TICKET-DREAMS-09):
 * `title` nativo no schema normalizado, `data` JSON no legado e, no schema
 * TRANSICIONAL (ambos presentes), a união das duas fontes. Os títulos entram
 * sempre como parâmetro JSON (`json_each`), nunca interpolados.
 *
 * É deliberadamente fail-soft: se a tabela não existir (schemas antigos,
 * fixtures de teste), não expuser nenhuma fonte de título, ou `session.data`
 * não for JSON válido, retorna `[]` em vez de derrubar a leitura.
 */
function collectExcludedSessionIds(db: Database, titles: readonly string[]): string[] {
  if (titles.length === 0) return [];
  try {
    const columns = tableColumns(db, "session");
    const byTitle = columns.has("title");
    const byData = columns.has("data");
    if (!byTitle && !byData) return [];

    const titlesJson = JSON.stringify(titles);
    const rows =
      byTitle && byData
        ? db
            .query<{ id: string | null }, [string, string]>(SQL_EXCLUDED_BY_TITLE_OR_DATA)
            .all(titlesJson, titlesJson)
        : byTitle
          ? db.query<{ id: string | null }, [string]>(SQL_EXCLUDED_BY_TITLE).all(titlesJson)
          : db
              .query<{ id: string | null }, [string]>(SQL_EXCLUDED_BY_DATA_TITLE)
              .all(titlesJson);

    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (error) {
    // Tabela ausente, schema divergente ou JSON malformado → sem exclusões.
    void error;
    return [];
  }
}

/** Trunca o texto em `max` caracteres, sinalizando o corte. */
function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, max).trimEnd() + " …", truncated: true };
}

/**
 * Lê o diálogo textual das últimas horas no SQLite do OpenCode.
 *
 * @returns Lista cronológica de trechos; `[]` se o banco não existir, estiver
 *          vazio, corrompido ou a leitura falhar por qualquer motivo.
 */
export function readRecentDialogues(options: SessionReaderOptions = {}): DialogEntry[] {
  const dbPath = options.dbPath || defaultSessionDbPath();
  const hours = options.hours ?? 24;
  const until = options.untilMs ?? Date.now();
  const since = options.sinceMs ?? until - hours * 60 * 60 * 1000;
  // TICKET-HARNESS-60: sem teto forçado. Só há LIMIT quando o chamador pede um
  // número positivo e finito; omitido/null/0/Infinity significa leitura
  // irrestrita de todas as mensagens da janela.
  const requestedLimit = options.limit;
  const hasFiniteLimit =
    typeof requestedLimit === "number" &&
    Number.isFinite(requestedLimit) &&
    requestedLimit > 0;
  const limit = hasFiniteLimit ? Math.floor(requestedLimit as number) : null;
  const includeReasoning = options.includeReasoning ?? true;
  const maxTextLength = options.maxTextLength ?? 4000;
  const excludeSessionTitles = options.excludeSessionTitles ?? DEFAULT_EXCLUDED_SESSION_TITLES;

  // Fail-soft: arquivo ausente ou vazio → lista vazia, sem exceção.
  try {
    if (!fs.existsSync(dbPath)) return [];
    if (fs.statSync(dbPath).size === 0) return [];
  } catch (error) {
    options.onError?.(error);
    return [];
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // TICKET-DREAMS-04: CHECAGEM PREVENTIVA de schema, ANTES da query quente.
    // Divergência crítica → erro semântico que orienta o usuário (o crash
    // genérico do SQLite — "no such column: ..." — nunca chega a acontecer).
    // Divergência advisory → apenas reportada; a leitura continua, com a
    // capacidade degradada (ex.: exclusão anti-recursão inativa).
    const divergences = assertSessionSchema(db, dbPath);
    const advisories = divergences.filter(
      (divergence) => divergence.severity === "advisory"
    );
    if (advisories.length > 0) {
      options.onError?.(new SessionSchemaError(dbPath, advisories));
    }

    // 0) Defesa anti-recursão (camada 1 — SQL): resolve os IDs das sessões
    //    internas do Dreams ("Dreams Synthesis" e "Dreams Reconciliation")
    //    ANTES da query quente, para que o LIMIT já incida sobre o conjunto
    //    filtrado. Fail-soft: tabela ausente → lista vazia, sem afetar a
    //    leitura normal.
    const excludedSessionIds = collectExcludedSessionIds(db, excludeSessionTitles);
    const excludedSessionIdSet = new Set(excludedSessionIds);

    // 1) Mensagens da janela.
    //    - Sem limite (omitido/null/0/Infinity): leitura IRRESTRITA, ordenada
    //      cronologicamente de forma ascendente, sem cláusula LIMIT.
    //    - Com limite positivo finito (compatibilidade): busca em ordem
    //      DECRESCENTE + LIMIT para reter as mais RECENTES quando a janela
    //      excede o teto, depois inverte para a ordem cronológica de leitura.
    //
    //    As DUAS variantes de SQL são ESTÁTICAS (nada é concatenado na
    //    string): a lista de sessões excluídas entra como parâmetro JSON e é
    //    expandida por `json_each` — `NOT IN (subquery vazia)` é TRUE, ou
    //    seja, a ausência de exclusões não altera o resultado.
    const excludedIdsJson = JSON.stringify(excludedSessionIds);
    const messages = hasFiniteLimit
      ? db
          .query<MessageRow, (string | number)[]>(SQL_MESSAGES_LIMITED)
          .all(since, until, excludedIdsJson, limit as number)
      : db
          .query<MessageRow, (string | number)[]>(SQL_MESSAGES_UNLIMITED)
          .all(since, until, excludedIdsJson);
    if (hasFiniteLimit) messages.reverse();

    if (messages.length === 0) return [];

    // 2) Partes textuais dessas mensagens (índice `part_message_id_id_idx`).
    //    `json_valid` blinda contra JSON malformado isolado: a linha inválida é
    //    descartada em vez de derrubar a consulta inteira. O filtro de kind vai
    //    por parâmetro posicionado (?) — nada de interpolação de string no SQL.
    //    Filtra exatamente pelos IDs das mensagens retornados no primeiro select
    //    (parâmetro JSON expandido por `json_each`).
    const msgIdsJson = JSON.stringify(messages.map((m) => m.id));
    const rows = db
      .query<
        {
          message_id: string;
          ptype: string;
          ptext: string;
          ptime: number;
          pid: string;
        },
        (string | number)[]
      >(SQL_PARTS)
      .all(msgIdsJson, includeReasoning ? 1 : 0);

    // 3) Agrupa as partes por mensagem E por kind, preservando a ordem
    //    cronológica interna (o raciocínio vem antes da fala do agente).
    const partsByMessage = new Map<string, { text: string[]; reasoning: string[] }>();
    for (const row of rows) {
      let bucket = partsByMessage.get(row.message_id);
      if (!bucket) {
        bucket = { text: [], reasoning: [] };
        partsByMessage.set(row.message_id, bucket);
      }
      if (row.ptype === "reasoning") bucket.reasoning.push(row.ptext);
      else bucket.text.push(row.ptext);
    }

    // 4) Emite no máximo 2 trechos por mensagem (um por kind), na ordem
    //    raciocínio → fala, descartando mensagens sem texto textual útil
    //    (ex.: mensagens compostas apenas por ferramentas/parts de ruído).
    const entries: DialogEntry[] = [];
    for (const msg of messages) {
      // Defesa em profundidade (camada 2 — JS): revalida o Set de sessões
      // internas no momento da emissão. Mesmo que a cláusula SQL seja
      // futuramente alterada/omitida, nada interno escapa para o resumo.
      if (excludedSessionIdSet.has(msg.session_id)) continue;

      const bucket = partsByMessage.get(msg.id);
      if (!bucket) continue;

      const role = normalizeRole(msg.role_raw);
      if (options.role && role !== options.role) continue;

      const timeline: { kind: DialogKind; pieces: string[] }[] = [
        { kind: "reasoning", pieces: bucket.reasoning },
        { kind: "text", pieces: bucket.text },
      ];

      for (const segment of timeline) {
        if (segment.pieces.length === 0) continue;
        const joined = segment.pieces.join("\n").trim();
        if (!joined) continue;

        const { text, truncated } = truncateText(joined, maxTextLength);
        entries.push({
          session_id: msg.session_id,
          message_id: msg.id,
          role,
          kind: segment.kind,
          text,
          timestamp: msg.time_created,
          time_iso: new Date(msg.time_created).toISOString(),
          truncated,
        });
      }
    }

    return entries;
  } catch (error) {
    // Banco vazio, corrompido, bloqueado ou schema inesperado → fail-soft.
    options.onError?.(error);
    return [];
  } finally {
    try {
      db?.close();
    } catch (error) {
      // Banco já fechado / nunca aberto — fechamento idempotente.
      void error;
    }
  }
}

/**
 * Orçamento padrão de caracteres por chunk de diálogo (~100k, conforme o
 * desenho do TICKET-DREAMS-08).
 */
export const DEFAULT_MAX_CHARS_PER_CHUNK = 100_000;

/**
 * Orçamento padrão em BYTES UTF-8 por chunk de diálogo.
 *
 * Mantido com folga abaixo de `MAX_PROMPT_BYTES` (128.000, em
 * `mimo_synthesizer.ts`) para que `buildCappedPrompt` NUNCA precise truncar um
 * chunk — inclusive em texto densamente acentuado (até ~2 bytes por caractere
 * em pt-BR). É o que garante o critério "sem emissão de `[… início do dia
 * omitido]`": o teto do prompt é respeitado POR CHUNK, e não por descarte.
 */
export const DEFAULT_MAX_BYTES_PER_CHUNK = 110_000;

/** Opções de particionamento de diálogo em chunks sequenciais. */
export interface ChunkDialogueOptions {
  /** Máximo de caracteres por chunk. Padrão: `DEFAULT_MAX_CHARS_PER_CHUNK`. */
  maxCharsPerChunk?: number;
  /** Máximo de bytes UTF-8 por chunk. Padrão: `DEFAULT_MAX_BYTES_PER_CHUNK`. */
  maxBytesPerChunk?: number;
}

/** Comprimento real de `text` em bytes UTF-8 (≠ `String.length`, que é UTF-16). */
function dialogueUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Normaliza um orçamento para um inteiro positivo (fallback em valor inválido). */
function normalizeChunkBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const budget = Math.floor(value);
  return budget > 0 ? budget : fallback;
}

/**
 * Renderiza os trechos agrupados por sessão num texto único e COMPLETO — sem
 * qualquer truncamento. É a matéria-prima tanto do resumo de disparo único
 * quanto do particionamento em chunks.
 */
function renderDialogueBlocks(entries: DialogEntry[]): string {
  const bySession = new Map<string, DialogEntry[]>();
  for (const entry of entries) {
    const bucket = bySession.get(entry.session_id);
    if (bucket) bucket.push(entry);
    else bySession.set(entry.session_id, [entry]);
  }

  const blocks: string[] = [];
  for (const [sessionId, items] of bySession) {
    const first = items[0];
    const last = items[items.length - 1];
    const lines: string[] = [
      `# sessão ${sessionId} (${items.length} trecho(s), ${first.time_iso} → ${last.time_iso})`,
    ];
    for (const item of items) {
      const marker = item.kind === "reasoning" ? "raciocínio" : item.role;
      lines.push(`[${item.time_iso}] ${marker}: ${item.text.replace(/\s+/g, " ").trim()}`);
    }
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

/**
 * Devolve o resumo textual COMPLETO da janela lida — sem truncamento e sem
 * omissão do início do dia. Usado pelo handoff do Light Sleep para que TODO o
 * diálogo capturado chegue ao REM Sleep, que então o particiona em chunks.
 */
export function buildDialogueSummary(entries: DialogEntry[]): string {
  return renderDialogueBlocks(entries);
}

/**
 * Agrupa os trechos por sessão e produz um resumo textual conciso, pronto para
 * ser injetado num prompt de síntese (outra camada do Dreams).
 *
 * COMPATIBILIDADE (TICKET-DREAMS-08): mantido com o comportamento histórico de
 * truncamento invertido (cauda preservada + prefixo `[… início do dia
 * omitido]`) para os fluxos de disparo único. Para ingestão integral em fatias
 * sequenciais — sem descarte do início do dia — use `chunkDialogues`.
 */
export function summarizeDialogues(
  entries: DialogEntry[],
  options: { maxChars?: number; label?: string } = {}
): string {
  const maxChars = options.maxChars ?? 120_000;
  if (entries.length === 0) return options.label ? `${options.label}: (sem diálogos)` : "";

  const full = renderDialogueBlocks(entries);
  if (full.length <= maxChars) return full;
  // Truncamento invertido: fatiar o final da timeline com prefixo de omissão,
  // garantindo que as mensagens mais recentes do final do dia NUNCA sejam perdidas.
  const prefix = "[… início do dia omitido]\n\n";
  const budget = Math.max(0, maxChars - prefix.length);
  return prefix + full.slice(-budget).trimStart();
}

/**
 * Particiona um texto de diálogo em fatias sequenciais que respeitam, cada
 * uma, os orçamentos de caracteres E de bytes UTF-8 — SEM descartar nenhum
 * trecho (diferentemente do truncamento invertido histórico, que omitia o
 * início do dia). As fronteiras preferem quebras de linha; uma linha isolada
 * maior que o orçamento é fatiada por bytes, nunca partindo code points
 * multibyte (append seguro de `Buffer.subarray`).
 *
 * Garantias:
 *  - todo chunk resultante cabe em `maxCharsPerChunk` e em `maxBytesPerChunk`;
 *  - a concatenação dos chunks (com "\n") reconstitui todo o texto de entrada
 *    (nenhum caractere é perdido, salvo quebras de linha de fronteira).
 */
export function chunkDialogueText(
  text: string,
  options: ChunkDialogueOptions = {}
): string[] {
  const maxChars = normalizeChunkBudget(
    options.maxCharsPerChunk,
    DEFAULT_MAX_CHARS_PER_CHUNK
  );
  const maxBytes = normalizeChunkBudget(
    options.maxBytesPerChunk,
    DEFAULT_MAX_BYTES_PER_CHUNK
  );
  if (text.trim() === "") return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim() !== "") chunks.push(current);
    current = "";
  };
  const fits = (candidate: string): boolean =>
    candidate.length <= maxChars && dialogueUtf8Bytes(candidate) <= maxBytes;

  for (const line of text.split("\n")) {
    if (fits(line)) {
      if (current === "") {
        current = line;
        continue;
      }
      const candidate = `${current}\n${line}`;
      if (fits(candidate)) {
        current = candidate;
      } else {
        flush();
        current = line;
      }
      continue;
    }

    // Linha isolada maior que o orçamento: fecha o chunk corrente e fatia a
    // linha por bytes. O corte por bytes é seguido da remoção de eventuais
    // U+FFFD de fronteira (code point partido) antes de avançar o buffer.
    flush();
    let buffer = Buffer.from(line, "utf8");
    while (buffer.length > maxBytes || buffer.toString("utf8").length > maxChars) {
      const take = Math.min(buffer.length, maxBytes);
      let piece = buffer
        .subarray(0, take)
        .toString("utf8")
        .replace(/\uFFFD+$/, "");
      if (piece.length > maxChars) piece = piece.slice(0, maxChars);
      if (piece.length === 0) {
        // Orçamento mínimo extremo: garante progresso de ao menos 1 byte.
        piece = buffer.subarray(0, 1).toString("utf8").replace(/\uFFFD+/g, "") || "?";
      }
      chunks.push(piece);
      buffer = buffer.subarray(Math.max(1, dialogueUtf8Bytes(piece)));
    }
    current = buffer.toString("utf8");
  }

  flush();
  return chunks;
}

/**
 * Particiona os trechos de diálogo (já agrupados por sessão/cronologia) em
 * chunks textuais sequenciais seguros — a API de ingestão integral do
 * TICKET-DREAMS-08. Devolve `[]` quando não há trechos e NUNCA omite o início
 * do dia: a concatenação de `chunkDialogues(entries)` contém TODAS as
 * conversas do dia.
 */
export function chunkDialogues(
  entries: DialogEntry[],
  options: ChunkDialogueOptions = {}
): string[] {
  if (entries.length === 0) return [];
  return chunkDialogueText(renderDialogueBlocks(entries), options);
}

/**
 * Atalho único: lê o diálogo recente e devolve o resumo textual pronto para
 * prompt. Nunca lança exceção (retorna string vazia / aviso em caso de falha).
 *
 * Quando o schema do OpenCode é INCOMPATÍVEL (divergência crítica), o resumo
 * devolve a orientação semântica — é a única string que sai daqui, então é
 * ela que carrega a instrução de atualização para a usuária.
 */
export function readRecentDialogueSummary(options: SessionReaderOptions = {}): string {
  const fatalSchemaErrors: SessionSchemaError[] = [];
  try {
    const entries = readRecentDialogues({
      ...options,
      onError: (error) => {
        if (error instanceof SessionSchemaError && error.fatal) {
          fatalSchemaErrors.push(error);
        }
        options.onError?.(error);
      },
    });
    if (fatalSchemaErrors.length > 0) {
      return `(session_reader: ${fatalSchemaErrors[0].message})`;
    }
    return summarizeDialogues(entries);
  } catch (error) {
    // Defesa extra: só é alcançável se o próprio summarizer falhar.
    options.onError?.(error);
    return "(session_reader indisponível)";
  }
}
