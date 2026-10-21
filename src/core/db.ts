import { Database } from "bun:sqlite";
import { redactSecrets } from "./security";
import path from "path";
import os from "os";
import fs from "fs";

/**
 * TICKET-DREAMS-04 — Permissões POSIX canônicas do banco de memórias.
 *
 * O diretório do banco (`~/.config/opencode/dreams`) é `0o700` (somente o
 * dono entra) e os artefatos SQLite (`dreams.db`, `dreams.db-wal`,
 * `dreams.db-shm`) são `0o600` (somente o dono lê/escreve).
 *
 * Sem esse endosso, o SQLite cria os arquivos com o umask do processo
 * (tipicamente `0o644`) — o que deixaria as memórias do agente legíveis por
 * QUALQUER usuário da máquina. O `chmod` explícito fecha essa janela.
 */
export const DREAMS_DIR_MODE = 0o700;
export const DREAMS_FILE_MODE = 0o600;

/**
 * Diretórios de sistema que NUNCA podem ter a permissão apertada: são
 * compartilhados pelo sistema operacional (e/ou por outros usuários) e um
 * `chmod 0o700` neles quebraria o ambiente inteiro. O banco do Dreams vive
 * sempre sob o home do usuário, então o caminho normal nunca colide aqui —
 * a lista é apenas uma rede de segurança para `dbPath` customizado.
 */
const PROTECTED_SYSTEM_DIRECTORIES = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
]);

/**
 * Descarta explicitamente o erro de uma operação best-effort.
 *
 * Existe para que NENHUM `catch` do módulo fique VAZIO: o bloco sempre
 * declara a intenção ("isto é um best-effort deliberado") em vez de engolir a
 * falha em silêncio. Usada só onde a falha NÃO pode derrubar o plugin
 * (chmod em filesystem hostil, `ROLLBACK` de uma transação já desfeita).
 */
function ignoreError(error: unknown): void {
  void error;
}

/**
 * Garante `0o700` no diretório do banco. Best-effort: sistemas de arquivos
 * que rejeitam o `chmod` (read-only, owner divergente) não derrubam o
 * plugin — o banco segue funcionando, apenas sem o endosso do modo.
 */
function enforceDirectoryMode(dir: string): void {
  const resolved = path.resolve(dir);
  if (PROTECTED_SYSTEM_DIRECTORIES.has(resolved)) return;
  try {
    fs.chmodSync(resolved, DREAMS_DIR_MODE);
  } catch (error) {
    // best-effort: o diretório pertence a outro owner ou é read-only.
    ignoreError(error);
  }
}

/**
 * Garante `0o600` num artefato do SQLite (banco, WAL ou SHM) quando ele
 * existe. Best-effort pela mesma razão de `enforceDirectoryMode`.
 */
function enforceFileMode(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, DREAMS_FILE_MODE);
    }
  } catch (error) {
    // best-effort: artefato em filesystem read-only ou de outro owner.
    ignoreError(error);
  }
}

/**
 * TICKET-DREAMS-04 — Versão de schema do banco de memórias.
 *
 * A versão vive em `PRAGMA user_version` (cabeçalho do arquivo SQLite) e é
 * lida/escrita de forma DECLARATIVA: o número é o contrato, o código é a
 * esteira. Cada passo roda dentro de `BEGIN EXCLUSIVE TRANSACTION` e grava a
 * nova versão como ÚLTIMA instrução da transação — schema e versão avançam
 * juntos (ou nenhum dos dois), mesmo após um crash no meio de uma migração
 * (o `ROLLBACK` desfaz DDL e versão juntos).
 */
export const SCHEMA_VERSION = 1;

/** Um passo da esteira de migrações. */
export interface MigrationStep {
  /** Versão alvo gravada em `PRAGMA user_version` ao final do passo. */
  readonly version: number;
  /** Identificador legível do passo (usado nas mensagens de erro). */
  readonly name: string;
  /** DDL/DML do passo. DEVE ser idempotente. */
  readonly apply: (db: Database) => void;
}

/** Falha na aplicação de um passo de migração (transação desfeita). */
export class MigrationError extends Error {
  readonly step: string;
  readonly version: number;
  readonly cause: unknown;

  constructor(step: MigrationStep, cause: unknown) {
    super(
      `Falha na migração do banco de memórias (passo '${step.name}', versão ${step.version}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "MigrationError";
    this.step = step.name;
    this.version = step.version;
    this.cause = cause;
  }
}

/** Banco gravado por uma versão mais nova do plugin (schema incompatível). */
export class SchemaVersionError extends Error {
  readonly found: number;
  readonly expected: number;

  constructor(found: number, expected: number) {
    super(
      `Banco de memórias gravado por uma versão mais nova do plugin ` +
        `(PRAGMA user_version=${found} > ${expected}). ` +
        `Atualize o plugin agent-dreams para poder ler este banco.`
    );
    this.name = "SchemaVersionError";
    this.found = found;
    this.expected = expected;
  }
}

/**
 * Falha ao PREPARAR o banco de memórias — arquivo/diretório sem permissão de
 * escrita, banco bloqueado por outro processo, arquivo ilegível.
 *
 * Existe para que a falha de infraestrutura saia SEMÂNTICA (com o caminho e a
 * orientação de ação) em vez de vazar um `SQLiteError` cru
 * ("attempt to write a readonly database"), que não diz ao usuário O QUE
 * fazer.
 */
export class DatabaseInitError extends Error {
  readonly dbPath: string;
  readonly cause: unknown;

  constructor(dbPath: string, cause: unknown) {
    super(
      `Não foi possível preparar o banco de memórias (${dbPath}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Verifique se o arquivo e o diretório permitem escrita ` +
        `(permissões esperadas: 0o600 no arquivo e 0o700 no diretório) e se ` +
        `o banco não está bloqueado por outro processo.`
    );
    this.name = "DatabaseInitError";
    this.dbPath = dbPath;
    this.cause = cause;
  }
}

/**
 * Lê a versão de schema declarada em `PRAGMA user_version`.
 * Valores ausentes/inválidos são normalizados para 0 (re-migra do zero).
 */
export function readSchemaVersion(db: Database): number {
  const row = db.query<{ user_version: number | null }, []>("PRAGMA user_version").get();
  const version = row?.user_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return 0;
  return version;
}

/**
 * Cria (se ausente) a tabela base de memórias. Idempotente.
 */
function ensureMemoriesTable(db: Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT NOT NULL,
        score REAL DEFAULT 1.0,
        decay_weight REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0,
        confirmations INTEGER DEFAULT 1,
        last_reinforced TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
}

/**
 * TICKET-DREAMS-03 (Frente A) — Tokenizer com folding de diacríticos.
 *
 * Cria `memories_fts` com `tokenize='unicode61 remove_diacritics 2'`, de modo
 * que "inferência" e "inferencia" (com/sem acento) tokenizem para a MESMA
 * representação e casem de forma idêntica tanto no índice quanto na query.
 *
 * Migração idempotente: um DB pré-existente criado sem `remove_diacritics`
 * mantém o DDL antigo no `sqlite_master` (o `CREATE VIRTUAL TABLE IF NOT
 * EXISTS` nunca o alteraria). Detectamos essa configuração legada e
 * reconstruímos a tabela virtual + `rebuild` do índice a partir do conteúdo
 * de `memories` (a FTS é derivada; nenhum dado de memória é perdido).
 */
function ensureFtsTable(db: Database): void {
  const existing = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
  ).get();

  const legacyTokenizer =
    !!existing?.sql && !/remove_diacritics/i.test(existing.sql);

  if (legacyTokenizer) {
    db.exec("DROP TABLE IF EXISTS memories_fts;");
  }

  db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact,
        category,
        content='memories',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

  if (legacyTokenizer) {
    // Repopula o índice externo a partir da tabela de conteúdo.
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
  }
}

/**
 * (Re)cria os triggers que mantêm a FTS sincronizada com `memories`.
 * Idempotente: `IF NOT EXISTS` + recriação é necessária porque o reparo do
 * tokenizer legado DERRUBA a tabela virtual — e, junto com ela, os triggers
 * que a referenciam.
 */
function ensureFtsTriggers(db: Database): void {
  db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;
    `);
}

/**
 * Esteira de migrações — a ordem de `version` É a ordem de execução.
 *
 * Para adicionar uma migração: acrescente um passo com `version` nova e DDL
 * idempotente. NUNCA edite um passo já publicado (bancos em produção já
 * podem ter aplicado a versão antiga dele).
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    name: "baseline_memories_schema",
    apply: (db) => {
      ensureMemoriesTable(db);
      ensureFtsTable(db);
      ensureFtsTriggers(db);
    },
  },
];

export interface MemoryRecord {
  id?: number;
  scope: string; // 'collective' or 'agent:<name>'
  fact: string;
  category: "learning" | "decision" | "pitfall" | "preference";
  score: number;
  decay_weight: number;
  recall_count: number;
  confirmations: number;
  last_reinforced: string;
  created_at: string;
}

export type MemoryCategory = "learning" | "decision" | "pitfall" | "preference";

/**
 * TICKET-DREAMS-03B — Pesos canônicos por categoria de memória.
 *
 * `base_weight`  → viés de prioridade/retensão: preferências e decisões
 *                  nascem com score maior que aprendizados triviais.
 * `decay_weight` → multiplicador da taxa de decaimento temporal aplicada em
 *                  `SleepCycle.deepSleep()`. Quanto MENOR, mais lenta é a
 *                  meia-vida (memória mais resistente ao esquecimento).
 *
 * Meia-vida aproximada com o lambda padrão (0,05/dia):
 *   preference ~140d | decision ~46d | pitfall ~28d | learning ~14d
 */
export const CATEGORY_WEIGHTS: Record<
  MemoryCategory,
  { base_weight: number; decay_weight: number }
> = {
  preference: { base_weight: 2.5, decay_weight: 0.1 },
  decision: { base_weight: 2.0, decay_weight: 0.3 },
  pitfall: { base_weight: 1.8, decay_weight: 0.5 },
  learning: { base_weight: 1.0, decay_weight: 1.0 },
};

/**
 * TICKET-DREAMS-04 (Frente 4A) — Limiar de similaridade léxica (Jaccard) para
 * considerar dois fatos "semanticamente equivalentes".
 *
 * Calibração: 0,80 exige sobreposição substancial de tokens normalizados, mas
 * ainda tolera reordenação, pontuação e acentos (que colapsam para os mesmos
 * tokens). Fatos que diferem apenas no "sujeito/objeto" final (ex.:
 * `Sessão finalizada no diretório /tmp/def10_repeticao` vs
 * `... /tmp/def10_teto`, Jaccard ≈ 0,75) NÃO são fundidos — evita falso
 * positivo que apagaria a distinção semântica.
 */
export const FACT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Normaliza um fato para comparação: minúsculas, remoção de diacríticos
 * (NFD) e de toda pontuação, colapsando espaços. Determinística e pura.
 *
 * @example
 *   normalizeFactText("Inferência, (c/d) & Motor!") // => "inferencia c d motor"
 */
export function normalizeFactText(fact: string): string {
  if (typeof fact !== "string") return "";
  return fact
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokeniza um fato normalizado em um conjunto de termos (sem repetição). */
export function tokenizeFact(fact: string): Set<string> {
  const normalized = normalizeFactText(fact);
  if (!normalized) return new Set<string>();
  return new Set(normalized.split(" ").filter((t) => t.length > 0));
}

/**
 * Similaridade de Jaccard entre dois conjuntos de tokens:
 * `|A ∩ B| / |A ∪ B|`, em `[0, 1]`. Conjuntos vazios ⇒ 0.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * TICKET-DREAMS-06 (Frente A) — Limiar canônico da triagem léxica do Sono REM.
 *
 * 0,15 (15%) é o ponto de corte entre "fato autônomo" (entra direto no SQLite,
 * sem consumir tokens de IA) e "candidato a reconciliação" (segue para o
 * julgamento neural em lote daquela noite).
 *
 * Calibração: bem mais permissivo que `FACT_SIMILARITY_THRESHOLD` (0,80), que
 * decide EQUIVALÊNCIA semântica dentro do `insertMemory`. Aqui o objetivo é
 * apenas RECLAMAR um par para julgamento neural — a decisão final
 * (reinforce/supersede/merge/independent) é do modelo, não do limiar.
 */
export const RECONCILIATION_SIMILARITY_THRESHOLD = 0.15;

/**
 * Teto de linhas varridas pelo FTS5 em uma triagem de reconciliação.
 *
 * A varredura é AMPLA de propósito: o corte fino é o Jaccard (≥ 15%), não o
 * limite de linhas. 2000 linhas cobrem folgadamente o acervo real sem varrer o
 * banco inteiro; o corte final é determinístico (ordem do `id`).
 */
export const RECONCILIATION_CANDIDATE_LIMIT = 2000;

/**
 * TICKET-DREAMS-06 — Falha semântica numa operação de reconciliação.
 *
 * Existe para que uma reconciliação impossível (memória inexistente, fato
 * vazio, escopo inválido) saia IDENTIFICÁVEL — com a operação e a causa — em
 * vez de um `SQLiteError` cru. NUNCA é engolida: a transação é revertida e o
 * erro sobe para o chamador.
 */
export class ReconciliationError extends Error {
  /** Operação que falhou (`reinforceMemory`, `supersedeMemory`, `mergeMemories`). */
  readonly operation: string;
  readonly cause: unknown;

  constructor(operation: string, message: string, cause?: unknown) {
    super(`Falha na reconciliação de memórias (${operation}): ${message}`);
    this.name = "ReconciliationError";
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * Candidato de fusão: o fato novo (ou pré-existente) que será fundido na
 * memória `existingId`. `score`/`confirmations` são opcionais — quando
 * ausentes, valem os canônicos (1.0 e 1).
 */
export interface MergeCandidate {
  fact: string;
  category: MemoryCategory;
  scope: string;
  score?: number;
  confirmations?: number;
}

/** Normaliza um limiar de similaridade para a faixa válida `[0, 1]`. */
function normalizeReconciliationThreshold(threshold: number): number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return RECONCILIATION_SIMILARITY_THRESHOLD;
  }
  if (threshold < 0) return 0;
  if (threshold > 1) return 1;
  return threshold;
}

/**
 * Constrói uma query FTS5 com filtro de COLUNA (`fact : (...)`).
 *
 * O filtro de coluna restringe o casamento ao texto do fato — sem ele, uma
 * palavra como "learning" (nome de categoria) puxaria para o conjunto de
 * candidatos TODAS as memórias daquela categoria, poluindo a triagem de 15%.
 * Os tokens vêm de `normalizeFactText` (apenas `\p{L}`/`\p{N}`), então nunca
 * carregam a sintaxe do dialeto MATCH.
 */
function buildFtsFactColumnQuery(tokens: Set<string>): string {
  const terms = [...tokens].map((token) => `"${token}"`).join(" OR ");
  return `fact : (${terms})`;
}

export class DreamsDB {
  // DEF-10: limites de reforço — eventos triviais repetitivos (ex.: session.idle)
  // não podem inflar score/confirmations indefinidamente.
  static readonly MAX_CONFIRMATIONS = 10;
  static readonly MAX_SCORE = 5.0;

  private db: Database;
  /** Caminho absoluto do arquivo SQLite (usado no enforcement POSIX). */
  private readonly dbPath: string;
  /**
   * Profundidade da transação SQLite em curso (0 = fora de transação).
   *
   * O SQLite NÃO aceita `BEGIN` aninhado ("cannot start a transaction within
   * a transaction"). O contador torna as operações transacionais RE-ENTRANTES:
   * uma chamada interna dentro de uma transação aberta participa dela (a
   * atomicidade já está garantida pela transação externa) em vez de tentar
   * abrir uma segunda.
   */
  private txDepth: number = 0;

  constructor(dbPath?: string) {
    const finalPath = path.resolve(
      dbPath || path.join(os.homedir(), ".config/opencode/dreams/dreams.db")
    );
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: DREAMS_DIR_MODE });
    }
    // TICKET-DREAMS-04: o diretório do banco é `0o700` (só o dono entra).
    enforceDirectoryMode(dir);
    this.dbPath = finalPath;
    this.db = new Database(finalPath);
    this.init();
  }

  /**
   * Versão de schema aplicada nesta instância (`PRAGMA user_version`), lida
   * DEPOIS da esteira de migrações: sempre `SCHEMA_VERSION` (ou superior, se
   * o arquivo foi gravado por outra versão do plugin).
   */
  public getSchemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  /**
   * Prepara o banco: pragmas, esteira de migrações, reparo idempotente do
   * schema e permissões POSIX.
   *
   * Envelope semântico: qualquer falha de infraestrutura (permissão de
   * escrita, banco bloqueado, arquivo ilegível) sai como
   * `DatabaseInitError` — com caminho e orientação de ação — em vez de um
   * `SQLiteError` cru. Os erros JÁ semânticos (`MigrationError`,
   * `SchemaVersionError`) passam intactos, porque nomeiam o passo/versão
   * exatos do problema.
   */
  private init() {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      // TICKET-DREAMS-04: esteira determinística de migrações (PRAGMA user_version).
      this.applyMigrations();
      // Reparo idempotente: garante o schema mesmo se o arquivo foi criado por
      // outra ferramenta (ou por uma versão anterior do plugin).
      this.ensureSchemaObjects();
      // TICKET-DREAMS-04: permissões POSIX do banco, do WAL e do SHM.
      this.enforcePermissions();
    } catch (error) {
      if (error instanceof MigrationError || error instanceof SchemaVersionError) {
        throw error;
      }
      throw new DatabaseInitError(this.dbPath, error);
    }
  }

  /**
   * Aplica, em ordem, os passos de migração pendentes (`version` > atual).
   *
   * Cada passo roda em `BEGIN EXCLUSIVE TRANSACTION` e grava o
   * `PRAGMA user_version` NOVO como última instrução da transação: schema e
   * versão avançam juntos (ou nenhum dos dois). Um banco gravado por uma
   * versão mais nova do plugin NÃO é "des-migrado" — o erro é explícito.
   */
  private applyMigrations(): void {
    const current = readSchemaVersion(this.db);

    if (current > SCHEMA_VERSION) {
      throw new SchemaVersionError(current, SCHEMA_VERSION);
    }

    const pending = MIGRATIONS.filter((step) => step.version > current).sort(
      (a, b) => a.version - b.version
    );

    for (const step of pending) {
      this.runMigration(step);
    }
  }

  /**
   * Executa UM passo de migração em transação exclusiva. Em falha: `ROLLBACK`
   * (desfaz DDL e versão juntos) e erro semântico com o nome do passo.
   *
   * O `BEGIN EXCLUSIVE TRANSACTION` fica DENTRO do `try` de propósito: a
   *aquisição do lock pode falhar ANTES de qualquer escrita (arquivo
   * somente-leitura, banco bloqueado por outro processo) e essa falha também
   * precisa sair como `MigrationError` — identificando o passo — em vez de
   * vazar um `SQLiteError` cru e genérico. Nesses casos o `ROLLBACK` é
   * inofensivo: sem transação ativa ele apenas falha e é descartado.
   */
  private runMigration(step: MigrationStep): void {
    if (!Number.isInteger(step.version) || step.version < 0) {
      throw new Error(
        `Passo de migração inválido ('${step.name}'): a versão deve ser um inteiro >= 0.`
      );
    }

    try {
      this.db.exec("BEGIN EXCLUSIVE TRANSACTION");
      step.apply(this.db);
      // Atualização ATÔMICA da versão (mesma transação do DDL acima).
      this.db.exec(`PRAGMA user_version = ${step.version}`);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        // A transação pode já ter sido desfeita pelo próprio SQLite — ou
        // nunca ter sido aberta (falha na aquisição do BEGIN).
        ignoreError(rollbackError);
      }
      throw new MigrationError(step, error);
    }
  }

  /**
   * Garante que o schema esperado exista. Idempotente e segura para rodar em
   * toda abertura: `CREATE ... IF NOT EXISTS` + o reparo do tokenizer legado
   * da FTS (que pode ter sido derrubado junto com a tabela virtual).
   */
  private ensureSchemaObjects(): void {
    ensureMemoriesTable(this.db);
    ensureFtsTable(this.db);
    ensureFtsTriggers(this.db);
  }

  /**
   * TICKET-DREAMS-04 — Permissões POSIX dos artefatos SQLite: `0o600` no
   * banco e nos arquivos WAL/SHM.
   *
   * O SQLite só cria `-wal`/`-shm` na PRIMEIRA escrita, com o umask do
   * processo (tipicamente `0o644`). Uma transação de escrita vazia força a
   * criação determinística dos dois arquivos aqui — para que o `chmod` abaixo
   * seja garantido desde a abertura, e não só depois do próximo insert.
   */
  private enforcePermissions(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE; COMMIT;");
    } catch (error) {
      // best-effort: banco bloqueado por outro processo.
      ignoreError(error);
    }
    enforceFileMode(this.dbPath);
    enforceFileMode(`${this.dbPath}-wal`);
    enforceFileMode(`${this.dbPath}-shm`);
  }

  /**
   * Insere (ou reforça) uma memória com deduplicação semântica e hierarquia
   * cross-scope (TICKET-DREAMS-04, Frente 4A).
   *
   * Ordem de decisão:
   *  1. Dedup EXATO no MESMO escopo (comportamento histórico, DEF-10).
   *  2. Dedup SEMÂNTICO no MESMO escopo (FTS5 + Jaccard ≥ `FACT_SIMILARITY_THRESHOLD`).
   *  3. Promoção Persona ➔ Coletivo: um fato inserido em `collective` que já
   *     existe em `agent:<nome>` é PROMOVIDO para `collective` (herdando score
   *     e confirmações acumulados) e as cópias individuais equivalentes são
   *     removidas — evita que o agente receba a mesma memória duas vezes.
   *  4. Herança Coletivo ➔ Persona: uma inserção direcionada a `agent:<nome>`
   *     cujo fato equivalente já está em `collective` reforça o registro
   *     coletivo (confirmations + 1, last_reinforced = now) sem criar cópia.
   *  5. Nenhum equivalente → novo registro.
   *
   * `options.reinforce === false` (eventos triviais de ciclo de vida, DEF-10)
   * desliga a inflação de score/confirmations, mas NUNCA cria clones: a
   * deduplicação (exata, semântica e cross-scope) continua valendo.
   */
  public insertMemory(
    scope: string,
    fact: string,
    category: MemoryCategory,
    // TICKET-DREAMS-03B: defaults canônicos por categoria quando o chamador não
    // fornece score/decay_weight (ex.: remSleep insere só com os 3 primeiros).
    score: number = CATEGORY_WEIGHTS[category]?.base_weight ?? 1.0,
    decay_weight: number = CATEGORY_WEIGHTS[category]?.decay_weight ?? 1.0,
    options: { reinforce?: boolean } = {}
  ): number {
    // DEFESA EM PROFUNDIDADE (TICKET-DREAMS-06): mesmo que o chamador
    // (tool `dream_learn`, remSleep, etc.) já tenha redigido, o seam de
    // persistência reaplica `redactSecrets` de forma idempotente. Garante que
    // NENHUM credencial (sk-, AIza, Bearer, JWT, password=...) alcance o
    // SQLite, independentemente do caminho de chamada.
    const sanitizedFact = redactSecrets(fact);
    const now = new Date().toISOString();
    const shouldReinforce = options.reinforce !== false;

    // 1. Duplicata EXATA no mesmo escopo (comportamento histórico).
    const existing = this.db.query<MemoryRecord, [string, string]>(
      "SELECT * FROM memories WHERE scope = ? AND fact = ?"
    ).get(scope, sanitizedFact);

    if (existing && existing.id) {
      // DEF-10: reforço opcional e SEMPRE limitado. `reinforce: false`
      // (eventos triviais de ciclo de vida) mantém o registro intacto.
      if (shouldReinforce) {
        this.reinforceMemory(existing, now);
      }
      // Promoção: o mesmo fato já no coletivo torna a cópia de persona obsoleta.
      if (scope === "collective") {
        this.removeSimilarPersonas(sanitizedFact);
      }
      return existing.id;
    }

    // 2. Duplicata SEMÂNTICA no mesmo escopo (FTS5 + Jaccard).
    const semanticSameScope = this.findSimilarMemory(sanitizedFact, { scope });
    if (semanticSameScope && semanticSameScope.id) {
      if (shouldReinforce) {
        this.reinforceMemory(semanticSameScope, now);
      }
      if (scope === "collective") {
        this.removeSimilarPersonas(sanitizedFact);
      }
      return semanticSameScope.id;
    }

    // 3. Hierarquia cross-scope.
    if (scope === "collective") {
      // 3a. Promoção Persona ➔ Coletivo.
      const personaMatches = this.findSimilarPersonas(sanitizedFact);
      const promoted = personaMatches[0];
      if (promoted && typeof promoted.id === "number") {
        const promotedId = promoted.id;
        // Promove o registro individual para 'collective' herdando, sem
        // reinventar, o score e as confirmações já acumulados.
        this.db.run("UPDATE memories SET scope = 'collective' WHERE id = ?", [promotedId]);
        // TICKET-DREAMS-07B: a promoção Persona ➔ Coletivo também CONFIRMA a
        // memória — incrementa `confirmations + 1` (teto MAX_CONFIRMATIONS),
        // aplica o bônus de score (+0.5, teto MAX_SCORE) e atualiza
        // `last_reinforced = now`, respeitando `reinforce: false`.
        if (shouldReinforce) {
          this.reinforceMemory(promoted, now);
        }
        // Arranca as demais cópias equivalentes (evita dupla injeção no prompt).
        for (const dup of personaMatches.slice(1)) {
          if (typeof dup.id === "number") this.deleteMemory(dup.id);
        }
        return promotedId;
      }
    } else if (scope.startsWith("agent:")) {
      // 3b. Herança Coletivo ➔ Persona: reforça o coletivo, não clona.
      const collectiveEquivalent = this.findSimilarMemory(sanitizedFact, { scope: "collective" });
      if (collectiveEquivalent && collectiveEquivalent.id) {
        if (shouldReinforce) {
          this.reinforceMemory(collectiveEquivalent, now);
        }
        return collectiveEquivalent.id;
      }
    }

    // 4. Nenhum equivalente — cria um novo registro.
    const query = this.db.query(
      `INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`
    );
    const result = query.run(scope, sanitizedFact, category, score, decay_weight, now, now);
    return Number(result.lastInsertRowid);
  }

  /**
   * TICKET-DREAMS-06 (Frente A) — Execução transacional EXCLUSIVA.
   *
   * `BEGIN IMMEDIATE TRANSACTION` obtém o lock RESERVED já no início: a
   * transação de escrita é a única admitida, e nenhum leitor concorrente
   * consegue ler estados intermediários. O `COMMIT` só ocorre se o corpo
   * termina sem erro; qualquer exceção dispara `ROLLBACK` (desfaz DML E FTS5
   * juntos, pois os triggers participam da mesma transação) e o erro sobe
   * intacto.
   *
   * RE-ENTRÂNCIA: se já existe uma transação aberta (contador `txDepth > 0`),
   * o corpo roda dentro dela — abrir um segundo `BEGIN` seria erro do SQLite.
   * A atomicidade continua garantida: é a transação EXTERNA que a assegura.
   */
  private runExclusiveTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        // A transação pode já ter sido desfeita pelo próprio SQLite (ou o
        // BEGIN pode ter falhado antes de abrir). O ROLLBACK é inofensivo.
        ignoreError(rollbackError);
      }
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Busca uma memória pelo id. Devolve `null` quando o registro não existe.
   */
  public getMemoryById(id: number): MemoryRecord | null {
    if (!Number.isInteger(id)) return null;
    const row = this.db.query<MemoryRecord, [number]>(
      "SELECT * FROM memories WHERE id = ?"
    ).get(id);
    return row ?? null;
  }

  /**
   * Reforço limitado e canônico (DEF-10): `confirmations + 1` (teto
   * `MAX_CONFIRMATIONS`), `score + 0.5` (teto `MAX_SCORE`) e
   * `last_reinforced = now`.
   *
   * TICKET-DREAMS-06: tornado OPÉRÇÃO TRANSACIONAL (`BEGIN IMMEDIATE`) e
   * PÚBLICO — o Sono REM despacha a ação `reinforce` por esta API. O `now` é
   * opcional: sem ele, usa o instante corrente (ISO-8601).
   */
  public reinforceMemory(existing: MemoryRecord, now?: string): void {
    if (typeof existing.id !== "number") return;
    // Captura local: o estreitamento de `existing.id` não sobrevive ao
    // fechamento (o TypeScript não presume imutabilidade de propriedade).
    const memoryId: number = existing.id;
    const timestamp = typeof now === "string" && now.length > 0 ? now : new Date().toISOString();

    this.runExclusiveTransaction(() => {
      const baseConfirmations = Number.isFinite(existing.confirmations)
        ? existing.confirmations
        : 0;
      const baseScore = Number.isFinite(existing.score) ? existing.score : 0;
      const confirmations = Math.min(
        DreamsDB.MAX_CONFIRMATIONS,
        Math.max(0, baseConfirmations + 1)
      );
      const nextScore = Math.min(DreamsDB.MAX_SCORE, Math.max(0, baseScore + 0.5));
      this.db.run(
        "UPDATE memories SET score = ?, confirmations = ?, last_reinforced = ? WHERE id = ?",
        [nextScore, confirmations, timestamp, memoryId]
      );
    });
  }

  /**
   * TICKET-DREAMS-06 (Frente A) — Triagem léxica da Etapa 1 (CPU).
   *
   * Varre o acervo via FTS5 e devolve TODOS os candidatos do MESMO escopo com
   * Jaccard de tokens ≥ `threshold`, ordenados por similaridade DECRESCENTE.
   *
   * ISOLAMENTO ESTRITO DE ESCOPO (requisito invariante do TICKET-DREAMS-06):
   * o filtro `m.scope = ?` é uma IGUALDADE EXATA. Um candidato `collective`
   * NUNCA é comparado com um fato `agent:<nome>` (e vice-versa) — a
   * impermeabilidade entre personas é a garantia central do modelo de memória.
   *
   * A tokenização é a mesma de `tokenizeFact` (minúsculas, diacríticos
   * removidos, pontuação descartada) e NÃO aplica stopword filter: o ticket
   * exige a sobreposição lexical bruta, sem lista de stopwords — quem decide
   * a semântica final é o julgamento neural, não a triagem.
   */
  public findReconciliationCandidates(
    scope: string,
    fact: string,
    threshold: number = RECONCILIATION_SIMILARITY_THRESHOLD
  ): MemoryRecord[] {
    const safeScope = typeof scope === "string" ? scope.trim() : "";
    if (!safeScope) return [];

    // Defesa em profundidade: o fato recebido passa pela redação (idempotente)
    // antes de qualquer comparação — nenhum segredo participa da tokenização.
    const sanitized = redactSecrets(typeof fact === "string" ? fact : "");
    const target = tokenizeFact(sanitized);
    if (target.size === 0) return [];

    const minSimilarity = normalizeReconciliationThreshold(threshold);

    const sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.id = f.rowid
      WHERE memories_fts MATCH ? AND m.scope = ?
      LIMIT ?
    `;

    let rows: MemoryRecord[];
    try {
      rows = this.db
        .query<MemoryRecord, any[]>(sql)
        .all(buildFtsFactColumnQuery(target), safeScope, RECONCILIATION_CANDIDATE_LIMIT);
    } catch (error) {
      // Fallback: query sem o filtro de coluna (compatibilidade com um FTS5
      // mal configurado). A precisão fina continua sendo o Jaccard.
      ignoreError(error);
      rows = this.db
        .query<MemoryRecord, any[]>(sql)
        .all(this.buildOrFtsQuery(target), safeScope, RECONCILIATION_CANDIDATE_LIMIT);
    }

    const scored: Array<{ record: MemoryRecord; similarity: number }> = [];
    for (const row of rows) {
      const similarity = jaccardSimilarity(target, tokenizeFact(row.fact));
      if (similarity >= minSimilarity) {
        scored.push({ record: row, similarity });
      }
    }

    // Ordenação determinística: similaridade DESC → score DESC →
    // confirmações DESC → id ASC (desempate estável e reproduzível).
    scored.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const scoreDiff = (b.record.score ?? 0) - (a.record.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const confDiff = (b.record.confirmations ?? 0) - (a.record.confirmations ?? 0);
      if (confDiff !== 0) return confDiff;
      return (a.record.id ?? 0) - (b.record.id ?? 0);
    });

    return scored.map((entry) => entry.record);
  }

  /**
   * TICKET-DREAMS-06 (Frente A) — Revogação transacional de diretriz.
   *
   * Semântica: a diretriz antiga é REMOVIDA FISICAMENTE e a nova entra no
   * seu lugar, na MESMA transação `BEGIN IMMEDIATE ... COMMIT`. Não existe
   * estado intermediário observável: um leitor concorrente (o MCP) enxerga
   * OU a diretriz antiga OU a nova — nunca as duas, nunca nenhuma.
   *
   * A remoção do registro antigo dispara o trigger `memories_ad`, que expurga
   * a linha correspondente do índice FTS5; a inserção dispara `memories_ai`,
   * que indexa a nova. Os dois participates da mesma transação ⇒ o índice
   * FTS5 permanece consistente com `memories` em qualquer instante observável.
   *
   * Metadados: `score`, `confirmations`, `recall_count` e `created_at` são
   * HERDADOS da diretriz revogada (a nova diretriz não pode perder a
   * relevância já conquistada); `decay_weight` segue o canônico da categoria
   * nova; `last_reinforced` passa a ser o instante da revogação.
   *
   * @returns o id do NOVO registro (o antigo é destruído).
   */
  public supersedeMemory(
    oldId: number,
    newFact: string,
    category: MemoryCategory,
    scope: string
  ): number {
    const sanitizedFact = redactSecrets(typeof newFact === "string" ? newFact : "").trim();
    if (!sanitizedFact) {
      throw new ReconciliationError(
        "supersedeMemory",
        "o fato substituto não pode ser vazio após a redação."
      );
    }
    const targetScope = typeof scope === "string" ? scope.trim() : "";
    if (!targetScope) {
      throw new ReconciliationError("supersedeMemory", "o escopo não pode ser vazio.");
    }

    return this.runExclusiveTransaction(() => {
      const old = this.getMemoryById(oldId);
      if (!old) {
        throw new ReconciliationError(
          "supersedeMemory",
          `a memória ${oldId} não existe (nada a revogar).`
        );
      }

      const now = new Date().toISOString();

      // 1. REMOÇÃO FÍSICA da diretriz revogada (o trigger expurga o FTS5).
      this.db.run("DELETE FROM memories WHERE id = ?", [oldId]);

      // 2. INSERÇÃO da diretriz nova, herdando os metadados de relevância.
      const result = this.db.run(
        `INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          targetScope,
          sanitizedFact,
          category,
          Number.isFinite(old.score) ? old.score : 1.0,
          CATEGORY_WEIGHTS[category]?.decay_weight ?? old.decay_weight ?? 1.0,
          old.recall_count ?? 0,
          old.confirmations ?? 1,
          now,
          old.created_at ?? now,
        ]
      );
      return Number(result.lastInsertRowid);
    });
  }

  /**
   * TICKET-DREAMS-06 (Frente A) — Fusão transacional de duas memórias.
   *
   * Sintetiza o fato unificado na memória sobrevivente (`existingId`) e
   * expurga o registro redundante do candidato, tudo dentro da MESMA
   * transação `BEGIN IMMEDIATE ... COMMIT`:
   *
   *   score        = min(5.0, max(existing.score, candidate.score ?? 1.0) + 0.5)
   *   confirmations= max(existing.confirmations, candidate.confirmations ?? 1) + 1
   *   last_reinforced = now
   *
   * A atualização do texto passa pelos triggers do FTS5 (`memories_au`),
   * que reindexam o registro; a expurgo do redundante passa por
   * `memories_ad`, que o remove do índice. Se QUALQUER passo falhar, o
   * `ROLLBACK` restaura texto, score, confirmações e índice — nenhum estado
   * intermediário sobrevive.
   *
   * Escopo: o redundante é procurado APENAS no escopo do candidato
   * (`candidate.scope`) — a fusão nunca arrasta registros de outra persona.
   * `scope`/`category` da memória sobrevivente são PRESERVADOS: a fusão
   * sintetiza o TEXTO, não reetiqueta a memória.
   *
   * @returns o id da memória unificada (sempre `existingId`).
   */
  public mergeMemories(
    existingId: number,
    candidate: MergeCandidate,
    mergedFact: string
  ): number {
    const sanitizedMerged = redactSecrets(
      typeof mergedFact === "string" ? mergedFact : ""
    ).trim();
    if (!sanitizedMerged) {
      throw new ReconciliationError(
        "mergeMemories",
        "o fato unificado não pode ser vazio após a redação."
      );
    }
    const candidateFact = redactSecrets(
      typeof candidate?.fact === "string" ? candidate.fact : ""
    ).trim();
    const candidateScope = typeof candidate?.scope === "string" ? candidate.scope.trim() : "";

    return this.runExclusiveTransaction(() => {
      const existing = this.getMemoryById(existingId);
      if (!existing) {
        throw new ReconciliationError(
          "mergeMemories",
          `a memória ${existingId} não existe (nada para fundir).`
        );
      }

      const now = new Date().toISOString();

      // Bônus de confirmação diária: max(score_A, score_B) + 0.5, teto 5.0.
      const existingScore = Number.isFinite(existing.score) ? existing.score : 0;
      const candidateScore = Number.isFinite(candidate?.score)
        ? (candidate.score as number)
        : 1.0;
      const nextScore = Math.min(
        DreamsDB.MAX_SCORE,
        Math.max(existingScore, candidateScore) + 0.5
      );

      // Consolidação das confirmações: max(confirmations_A, confirmations_B) + 1.
      const existingConfirmations = Number.isFinite(existing.confirmations)
        ? existing.confirmations
        : 1;
      const candidateConfirmations = Number.isFinite(candidate?.confirmations)
        ? (candidate.confirmations as number)
        : 1;
      const nextConfirmations =
        Math.max(existingConfirmations, candidateConfirmations) + 1;

      // 1. SINTETIZA o fato unificado na memória sobrevivente (FTS5 via trigger).
      this.db.run(
        "UPDATE memories SET fact = ?, score = ?, confirmations = ?, last_reinforced = ? WHERE id = ?",
        [sanitizedMerged, nextScore, nextConfirmations, now, existingId]
      );

      // 2. EXPURGA o registro redundante do candidato (mesma transação).
      //
      // ISOLAMENTO ESTRITO DE ESCOPO: o expurgo só ocorre quando o candidato
      // pertence AO MESMO escopo da memória sobrevivente. Uma fusão disparada
      // com um candidato de outra persona jamais apaga, altera ou reetiqueta
      // o registro daquela persona — nem o redundante, nem qualquer outro.
      if (candidateFact && candidateScope === existing.scope) {
        this.db.run("DELETE FROM memories WHERE scope = ? AND fact = ? AND id != ?", [
          candidateScope,
          candidateFact,
          existingId,
        ]);
      }

      return existingId;
    });
  }

  /**
   * Busca o registro mais similar a `fact` dentro de um escopo EXATO via FTS5
   * (OR dos tokens) + Jaccard ≥ `FACT_SIMILARITY_THRESHOLD`.
   *
   * A query FTS5 é montada com OR de termos entre aspas — nunca com os
   * operadores do usuário — e o filtro fino de similaridade é aplicado em JS
   * sobre os candidatos retornados. Devolve `null` se não houver equivalente.
   */
  private findSimilarMemory(fact: string, options: { scope?: string } = {}): MemoryRecord | null {
    const target = tokenizeFact(fact);
    if (target.size === 0) return null;

    const ftsQuery = this.buildOrFtsQuery(target);
    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.id = f.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: any[] = [ftsQuery];

    if (options.scope) {
      sql += " AND m.scope = ?";
      params.push(options.scope);
    }
    sql += " LIMIT 200";

    const candidates = this.db.query<MemoryRecord, any[]>(sql).all(...params);

    let best: MemoryRecord | null = null;
    let bestSimilarity = 0;
    for (const candidate of candidates) {
      const similarity = jaccardSimilarity(target, tokenizeFact(candidate.fact));
      if (similarity >= FACT_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        best = candidate;
        bestSimilarity = similarity;
      }
    }
    return best;
  }

  /**
   * Todos os registros de persona (`agent:*`) semanticamente equivalentes a
   * `fact`, ordenados por score (e confirmações) decrescentes — o primeiro é o
   * candidato natural à promoção para `collective`.
   */
  private findSimilarPersonas(fact: string): MemoryRecord[] {
    const target = tokenizeFact(fact);
    if (target.size === 0) return [];

    const ftsQuery = this.buildOrFtsQuery(target);
    const candidates = this.db.query<MemoryRecord, any[]>(
      `SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.scope LIKE 'agent:%'
       LIMIT 200`
    ).all(ftsQuery);

    return candidates
      .filter((c) => jaccardSimilarity(target, tokenizeFact(c.fact)) >= FACT_SIMILARITY_THRESHOLD)
      .sort(
        (a, b) =>
          (b.score ?? 0) - (a.score ?? 0) ||
          (b.confirmations ?? 0) - (a.confirmations ?? 0)
      );
  }

  /** Remove as cópias de persona equivalentes a `fact`; devolve os ids removidos. */
  private removeSimilarPersonas(fact: string): number[] {
    const duplicates = this.findSimilarPersonas(fact);
    const removed: number[] = [];
    for (const dup of duplicates) {
      if (dup.id) {
        this.deleteMemory(dup.id);
        removed.push(dup.id);
      }
    }
    return removed;
  }

  /** Constrói uma query FTS5 literal (`"tok" OR "tok" ...`) a partir de tokens. */
  private buildOrFtsQuery(tokens: Set<string>): string {
    return [...tokens].map((token) => `"${token}"`).join(" OR ");
  }

  public recall(queryText: string, scope?: string, category?: string, limit: number = 5): MemoryRecord[] {
    // TICKET-DREAMS-03 (Frente A): higieniza a query ANTES do MATCH FTS5.
    // Identificadores como 'agent:developer' ou hífens ('ensemble-room') seriam
    // interpretados como operador de coluna/negação pelo FTS5 e lançariam erro
    // de sintaxe, forçando (ou piorando) o fallback. O sanitizador converte a
    // query crua em termos literais e seguros.
    const ftsQuery = sanitizeFts5Query(queryText);

    // Sem tokens aproveitáveis não há o que casar no FTS5 (MATCH '' é inválido);
    // segue direto para o fallback LIKE, preservando o comportamento histórico.
    if (ftsQuery) {
      let sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.rowid
        WHERE memories_fts MATCH ?
      `;
      const params: any[] = [ftsQuery];

      if (scope) {
        sql += " AND m.scope = ?";
        params.push(scope);
      }
      if (category) {
        sql += " AND m.category = ?";
        params.push(category);
      }

      sql += " ORDER BY rank, m.score DESC LIMIT ?";
      params.push(limit);

      try {
        const records = this.db.query<MemoryRecord, any[]>(sql).all(...params);
        return this.touchRecall(records);
      } catch (error) {
        // Fallback para LIKE se, ainda assim, a query FTS for rejeitada.
        ignoreError(error);
      }
    }

    return this.likeRecall(queryText, scope, category, limit);
  }

  /**
   * Fallback resiliente: busca literal por substring via LIKE. Acionado quando
   * a query sanitizada não produz tokens válidos ou quando o MATCH FTS5 falha.
   */
  private likeRecall(queryText: string, scope?: string, category?: string, limit: number = 5): MemoryRecord[] {
    let fallbackSql = "SELECT * FROM memories WHERE fact LIKE ?";
    const fallbackParams: any[] = [`%${queryText}%`];
    if (scope) {
      fallbackSql += " AND scope = ?";
      fallbackParams.push(scope);
    }
    if (category) {
      fallbackSql += " AND category = ?";
      fallbackParams.push(category);
    }
    fallbackSql += " ORDER BY score DESC LIMIT ?";
    fallbackParams.push(limit);
    const records = this.db.query<MemoryRecord, any[]>(fallbackSql).all(...fallbackParams);
    return this.touchRecall(records);
  }

  /** Incrementa recall_count e atualiza last_reinforced das memórias retornadas. */
  private touchRecall(records: MemoryRecord[]): MemoryRecord[] {
    const now = new Date().toISOString();
    for (const rec of records) {
      if (rec.id) {
        this.db.run(
          "UPDATE memories SET recall_count = recall_count + 1, last_reinforced = ? WHERE id = ?",
          [now, rec.id]
        );
        rec.recall_count = (rec.recall_count || 0) + 1;
        rec.last_reinforced = now;
      }
    }
    return records;
  }

  public getMemoriesByScope(scope: string, limit: number = 5): MemoryRecord[] {
    return this.db.query<MemoryRecord, [string, number]>(
      "SELECT * FROM memories WHERE scope = ? ORDER BY score DESC, last_reinforced DESC LIMIT ?"
    ).all(scope, limit);
  }

  public getAllMemories(): MemoryRecord[] {
    return this.db.query<MemoryRecord, []>("SELECT * FROM memories").all();
  }

  public updateMemoryScore(id: number, score: number) {
    this.db.run("UPDATE memories SET score = ? WHERE id = ?", [score, id]);
  }

  public deleteMemory(id: number) {
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
  }

  /**
   * TICKET-DREAMS-04 (Frente 4A) — Listagem para curadoria manual.
   *
   * Complementa `deleteMemory(id)` (poda cirúrgica por id) e
   * `getMemoriesByScope(scope, limit)` (top-N de um escopo). Aqui a listagem é
   * filtrável por escopo E categoria, sem limite obrigatório, ordenada por
   * `score DESC, last_reinforced DESC` — formato natural para inspeção/curation.
   *
   * Todos os filtros são parametrizados (`?`), jamais interpolados.
   */
  public listMemories(
    options: { scope?: string; category?: MemoryCategory; limit?: number } = {}
  ): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const clauses: string[] = [];
    const params: any[] = [];

    if (options.scope) {
      clauses.push("scope = ?");
      params.push(options.scope);
    }
    if (options.category) {
      clauses.push("category = ?");
      params.push(options.category);
    }
    if (clauses.length > 0) {
      sql += " WHERE " + clauses.join(" AND ");
    }

    sql += " ORDER BY score DESC, last_reinforced DESC";

    if (typeof options.limit === "number" && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    return this.db.query<MemoryRecord, any[]>(sql).all(...params);
  }

  public close() {
    this.db.close();
  }
}

/**
 * TICKET-DREAMS-03 (Frente A) — Sanitizador de query para SQLite FTS5.
 *
 * O dialeto MATCH do FTS5 interpreta muitos caracteres como sintaxe: `:` (filtro
 * de coluna, ex.: `agent:developer`), `-` (negação, ex.: `ensemble-room`), `*`
 * (prefixo), `"` (frase), `AND/OR/NOT`, parênteses, `^`, `.`, etc. Identificadores
 * legítimos de memória — escopos `agent:<nome>`, nomes com hífen como
 * `ensemble-room` ou `open-tool` — disparam `fts5: syntax error` e derrubam a
 * busca no fallback LIKE.
 *
 * Estratégia: extrai apenas os tokens alfanuméricos Unicode (`\p{L}`/`\p{N}`),
 * descartando toda a pontuação/operadores, e reconstrói a query como uma
 * conjunção implícita (AND) de termos literais entre aspas duplas. As aspas
 * garantem que cada termo seja tratado como string literal — nunca como
 * operador ou nome de coluna — e o tokenizer `unicode61 remove_diacritics 2`
 * cuida da equivalência acento/no-acento. Query sem tokens aproveitáveis
 * retorna `""`; o chamador (`recall`) então recorre ao fallback LIKE.
 *
 * @example
 *   sanitizeFts5Query("agent:developer")   // => '"agent" "developer"'
 *   sanitizeFts5Query("ensemble-room") // => '"ensemble" "room"'
 *   sanitizeFts5Query('AST "parser"')  // => '"AST" "parser"'
 *   sanitizeFts5Query("(c/d) * &")     // => '"c" "d"'
 *   sanitizeFts5Query("***")           // => ''
 */
export function sanitizeFts5Query(query: string): string {
  if (!query || typeof query !== "string") return "";
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}
