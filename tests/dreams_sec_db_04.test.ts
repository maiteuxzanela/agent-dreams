/**
 * TICKET-DREAMS-04 — Suíte determinística REAL (SDET) — ZERO mocks.
 *
 * Escopo deste arquivo (card "Permissões POSIX 0o700/0o600 e esteira
 * determinística de migrações via PRAGMA user_version"):
 *
 *   FRENTE 1 — src/core/db.ts · PERMISSÕES POSIX
 *     - diretório do banco `0o700`; `dreams.db`, `dreams.db-wal` e
 *       `dreams.db-shm` em `0o600`;
 *     - as permissões são REAPLICADAS a cada abertura (o SQLite recria
 *       -wal/-shm);
 *     - diretórios de sistema (/, /tmp, /var, /home...) NUNCA são chmodados.
 *
 *   FRENTE 2 — src/core/db.ts · VERSIONAMENTO DE SCHEMA (PRAGMA user_version)
 *     - leitura declarativa da versão; esteira `MIGRATIONS` extensível e
 *       monotônica; versão = SCHEMA_VERSION após a abertura;
 *     - banco legado (user_version=0) migra PRESERVANDO os dados;
 *     - ATOMICIDADE: falha no meio do passo ⇒ ROLLBACK ⇒ NEM o schema NEM a
 *       versão avançam (schema+versão andam juntos);
 *     - idempotência: reabrir N vezes não reprocessa nem regride;
 *     - banco gravado por versão FUTURA ⇒ SchemaVersionError (sem "des-migrar").
 *
 *   FRENTE 3 — src/core/session_reader.ts · CHECAGEM PREVENTIVA DE SCHEMA
 *     - schema completo ⇒ nenhuma divergência;
 *     - tabela/coluna crítica ausente ⇒ SessionSchemaError fatal (orientação
 *       semântica NO lugar do crash genérico do SQLite);
 *     - tabela opcional ausente ⇒ divergência ADVISORY reportada, leitura
 *       continua (degradação suportada);
 *     - paridade da exclusão anti-recursão após a reescrita do SQL estático.
 *
 * Infraestrutura REAL: bancos SQLite reais em diretórios temporários,
 * DDL real, o módulo de produção real e um sandbox bwrap real para o teste de
 * diretório protegido (onde o chmod de /tmp é de fato possível).
 * ZERO `unittest.mock`/`jest.mock`/stubs/fakes.
 */
import { test, expect, describe, afterEach, afterAll } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DreamsDB,
  SCHEMA_VERSION,
  MIGRATIONS,
  DREAMS_DIR_MODE,
  DREAMS_FILE_MODE,
  readSchemaVersion,
  MigrationError,
  SchemaVersionError,
  DatabaseInitError,
} from "../src/core/db";
import {
  inspectSessionSchema,
  assertSessionSchema,
  SessionSchemaError,
  readRecentDialogues,
  readRecentDialogueSummary,
  SESSION_SCHEMA_TABLES,
  SESSION_SCHEMA_COLUMNS,
  SESSION_TITLE_COLUMNS,
  DEFAULT_EXCLUDED_SESSION_TITLES,
} from "../src/core/session_reader";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const tempDirs: string[] = [];

/** Cria um diretório temporário isolado (registrado para limpeza). */
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Modo POSIX (só os bits de permissão) de um caminho existente. */
function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      // Limpeza best-effort: o diretório temporário é descartado pelo SO no
      // final do processo de teste. O erro é engolido DE PROPÓSITO (e de forma
      // explícita) para não mascarar a asserção que está sendo avaliada.
      void error;
    }
  }
});

// ===========================================================================
// FRENTE 1 — PERMISSÕES POSIX (src/core/db.ts)
// ===========================================================================
describe("[DREAMS-04/1] db.ts: permissões POSIX 0o700 (dir) e 0o600 (artefatos)", () => {
  test("as constantes canônicas de modo são 0o700 e 0o600", () => {
    expect(DREAMS_DIR_MODE).toBe(0o700);
    expect(DREAMS_FILE_MODE).toBe(0o600);
  });

  test("CONTROLE DE SENSIBILIDADE: o modo natural do filesystem NÃO é 0o600/0o700", () => {
    // Sem este controle, um assert de "0o600" seria vacuamente verdadeiro em
    // qualquer filesystem cujo umask já fosse 0077 — o teste não provaria nada.
    // Propriedade discriminante: o arquivo "natural" é legível por grupo/outros
    // (bits 0o077 != 0), logo 0o600 NÃO é o default do processo.
    const dir = makeTmp("dreams04_sense_");
    const probe = path.join(dir, "probe.txt");
    fs.writeFileSync(probe, "x", "utf8");
    const natural = modeOf(probe);
    expect(natural & 0o077).toBeGreaterThan(0);
    expect(natural).not.toBe(0o600); // o umask do processo NÃO produz 0600
    expect(natural).not.toBe(0o700); // ...nem 0700
  });

  test("diretório do banco é 0o700 e dreams.db/-wal/-shm são 0o600", () => {
    const dir = makeTmp("dreams04_perm_");
    // Simula o diretório "solto" (0o755, como o mkdir padrão do usuário cria).
    fs.chmodSync(dir, 0o755);
    expect(modeOf(dir)).toBe(0o755); // pré-condição real

    const dbPath = path.join(dir, "dreams.db");
    const db = new DreamsDB(dbPath);

    // Diretório: só o dono entra.
    expect(modeOf(dir)).toBe(0o700);
    // Banco: só o dono lê/escreve.
    expect(modeOf(dbPath)).toBe(0o600);

    // WAL e SHM: criados na 1ª escrita (a transação vazia do enforcement) e
    // endurecidos em 0o600 — verificados ENQUANTO o handle está aberto.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);

    db.close();
  });

  test("as permissões são REAPLICADAS a cada abertura (o SQLite recria -wal/-shm)", () => {
    const dir = makeTmp("dreams04_reopen_");
    const dbPath = path.join(dir, "dreams.db");

    const first = new DreamsDB(dbPath);
    first.close();
    // O SQLite APAGA -wal/-shm no close: o próximo open os recria do zero —
    // exatamente a janela em que um chmod apenas na criação ficaria aberto.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

    // Sabotagem explícita do modo (simula um arquivo criado por outra
    // ferramenta com umask permissivo) — a reabertura deve corrigir.
    fs.chmodSync(dbPath, 0o644);
    expect(modeOf(dbPath)).toBe(0o644); // pré-condição real

    const second = new DreamsDB(dbPath);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    second.close();
  });

  test("a escrita REAL de memória não reabre a janela 0o644 no WAL/SHM", () => {
    const dir = makeTmp("dreams04_write_");
    const dbPath = path.join(dir, "dreams.db");
    const db = new DreamsDB(dbPath);
    db.insertMemory("collective", "fato de teste de permissão", "learning");
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    db.close();
  });

  test("diretórios de sistema PROTEGIDOS nunca são chmodados (sandbox bwrap real)", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      // Dependência externa ausente: skip DETERMINÍSTICO e documentado
      // (o ambiente de CI deste repo não garante bubblewrap).
      console.warn("[skip] bwrap indisponível — teste de diretório protegido ignorado");
      expect(true).toBe(true);
      return;
    }

    // No sandbox, /tmp é um tmpfs PRIVADO e gravável pelo usuário — ou seja,
    // o chmod de 0o700 REALMENTE happens lá dentro. Isso torna a proteção
    // observável (e a mutação que a remove, detectável) SEM tocar no /tmp real.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreams04_bwrap_"));
    // O repositório é montado explicitamente em /tmp/repo DENTRO do sandbox:
    // o tmpfs do sandbox sombreia o /tmp do host, então um repo que viva
    // sob /tmp (ex.: cópia de mutação) precisa do bind explícito.
    const scriptPath = path.join(probeDir, "probe.ts");
    fs.writeFileSync(
      scriptPath,
      [
        `import { DreamsDB } from "/tmp/repo/src/core/db.ts";`,
        `import fs from "fs";`,
        `const mode = () => (fs.statSync("/tmp").mode & 0o7777).toString(8);`,
        `const before = mode();`,
        `const db = new DreamsDB("/tmp/dreams04_bwrap_probe.db");`,
        `db.close();`,
        `console.log(JSON.stringify({ before, after: mode() }));`,
      ].join("\n"),
      "utf8"
    );

    const result = Bun.spawnSync(
      [
        bwrap,
        "--unshare-user",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--ro-bind",
        REPO_ROOT,
        "/tmp/repo",
        "--ro-bind",
        probeDir,
        "/tmp/probe",
        "--chdir",
        "/tmp",
        "--setenv",
        "HOME",
        "/tmp/home",
        "--setenv",
        "PATH",
        `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        "--setenv",
        "BUN_INSTALL",
        "/tmp/home/.bun",
        process.execPath,
        "run",
        "/tmp/probe/probe.ts",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("panic");
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(stdout.split("\n").filter((l) => l.startsWith("{"))[0]);
    // O diretório de sistema PROTEGIDO (/tmp) manteve o modo original: o
    // enforcement NÃO o tocou. (Sem a proteção, viraria 0700.)
    expect(parsed.before).toBe(parsed.after);
    expect(parsed.after).not.toBe("700");

    fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

// ===========================================================================
// FRENTE 2 — VERSIONAMENTO DE SCHEMA VIA PRAGMA user_version (src/core/db.ts)
// ===========================================================================
describe("[DREAMS-04/2] db.ts: versionamento de schema via PRAGMA user_version", () => {
  test("a esteira MIGRATIONS é monotônica e termina em SCHEMA_VERSION", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0].version).toBe(1);
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version);
    }
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    expect(last.version).toBe(SCHEMA_VERSION);
    for (const step of MIGRATIONS) {
      expect(typeof step.name).toBe("string");
      expect(step.name.length).toBeGreaterThan(0);
      expect(typeof step.apply).toBe("function");
    }
  });

  test("abertura grava user_version = SCHEMA_VERSION e cria o schema completo", () => {
    const dir = makeTmp("dreams04_ver_");
    const dbPath = path.join(dir, "dreams.db");
    const db = new DreamsDB(dbPath);
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    // Leitura declarativa pela função EXPORTADA (não só pelo getter).
    const raw = new Database(dbPath, { readonly: true });
    expect(readSchemaVersion(raw)).toBe(SCHEMA_VERSION);
    const tables = raw
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toContain("memories");
    expect(tables).toContain("memories_fts");
    raw.close();
    db.close();
  });

  test("IDEMPOTÊNCIA: reabrir N vezes não regride nem reprocessa a versão", () => {
    const dir = makeTmp("dreams04_idem_");
    const dbPath = path.join(dir, "dreams.db");

    const first = new DreamsDB(dbPath);
    first.insertMemory("collective", "memória para idempotência", "decision");
    first.close();

    for (let i = 0; i < 3; i++) {
      const db = new DreamsDB(dbPath);
      expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
      // O dado persistido NÃO foi perdido nem duplicado pela reabertura.
      const all = db.getAllMemories();
      expect(all.length).toBe(1);
      expect(all[0].fact).toBe("memória para idempotência");
      db.close();
    }
  });

  test("banco LEGADO (user_version=0) migra preservando os dados e reparando o tokenizer", () => {
    const dir = makeTmp("dreams04_legacy_");
    const dbPath = path.join(dir, "dreams.db");

    // Schema legado: FTS5 com tokenizer 'unicode61' (sem remove_diacritics).
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, fact TEXT NOT NULL, category TEXT NOT NULL,
      score REAL DEFAULT 1.0, decay_weight REAL DEFAULT 1.0,
      recall_count INTEGER DEFAULT 0, confirmations INTEGER DEFAULT 1,
      last_reinforced TEXT NOT NULL, created_at TEXT NOT NULL);`);
    legacy.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(
      fact, category, content='memories', content_rowid='id', tokenize='unicode61');`);
    legacy.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category); END;`);
    legacy.run(
      `INSERT INTO memories (scope, fact, category, last_reinforced, created_at)
       VALUES (?,?,?,?,?)`,
      ["collective", "Inferência do modelo pesa", "learning", "t", "t"]
    );
    legacy.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild');`);
    legacy.close();

    const db = new DreamsDB(dbPath);
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    // Dado preservado.
    const all = db.getAllMemories();
    expect(all.length).toBe(1);
    expect(all[0].fact).toBe("Inferência do modelo pesa");

    // Tokenizer legado reparado (a FTS passa a casar com/sem diacrítico).
    const raw = new Database(dbPath, { readonly: true });
    const ftsSql = raw
      .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'")
      .get();
    expect(ftsSql?.sql ?? "").toMatch(/remove_diacritics/i);
    raw.close();

    expect(db.recall("inferencia").map((m) => m.fact)).toContain("Inferência do modelo pesa");
    expect(db.recall("inferência").map((m) => m.fact)).toContain("Inferência do modelo pesa");
    db.close();
  });

  test("ATOMICIDADE: falha no meio do passo ⇒ ROLLBACK ⇒ schema E versão intactos", () => {
    const dir = makeTmp("dreams04_atomic_");
    const dbPath = path.join(dir, "dreams.db");

    // Injeção de falha REAL e determinística: `memories` pré-existente como
    // tabela VIRTUAL faz a criação dos triggers falhar ("cannot create
    // triggers on virtual tables") NO MEIO do passo de migração.
    const seed = new Database(dbPath);
    seed.exec("CREATE VIRTUAL TABLE memories USING fts5(fact, category)");
    seed.close();

    expect(() => new DreamsDB(dbPath)).toThrow(MigrationError);

    // O erro semântico carrega o NOME do passo (contrato do ticket).
    try {
      new DreamsDB(dbPath);
      throw new Error("deveria ter lançado MigrationError");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      // O envelope de inicialização NÃO embrulha o erro semântico do passo.
      expect(error).not.toBeInstanceOf(DatabaseInitError);
      expect((error as MigrationError).step).toBe("baseline_memories_schema");
      expect((error as MigrationError).version).toBe(1);
      expect((error as MigrationError).message).toContain("baseline_memories_schema");
    }

    // NEM a versão NEM o schema avançaram — os dois andam juntos.
    const raw = new Database(dbPath, { readonly: true });
    expect(readSchemaVersion(raw)).toBe(0);
    const tables = raw
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    // A FTS criada dentro da transação desfeita NÃO sobreviveu ao ROLLBACK.
    expect(tables).not.toContain("memories_fts");
    expect(tables).not.toContain("memories_ai"); // trigger idem desfeito
    raw.close();

    // IDEMPOTÊNCIA DA FALHA: a segunda tentativa falha igual e o estado
    // continua intacto (nenhuma migração parcial accumulates).
    expect(() => new DreamsDB(dbPath)).toThrow(MigrationError);
    const raw2 = new Database(dbPath, { readonly: true });
    expect(readSchemaVersion(raw2)).toBe(0);
    raw2.close();
  });

  test("banco de versão FUTURA ⇒ SchemaVersionError (sem 'des-migrar')", () => {
    const dir = makeTmp("dreams04_future_");
    const dbPath = path.join(dir, "dreams.db");

    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, fact TEXT)");
    seed.exec("PRAGMA user_version = 999");
    seed.close();

    expect(() => new DreamsDB(dbPath)).toThrow(SchemaVersionError);
    try {
      new DreamsDB(dbPath);
      throw new Error("deveria ter lançado SchemaVersionError");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaVersionError);
      expect((error as SchemaVersionError).found).toBe(999);
      expect((error as SchemaVersionError).expected).toBe(SCHEMA_VERSION);
      expect((error as SchemaVersionError).message).toContain("999");
    }

    // A versão gravada NÃO foi rebaixada (nenhuma 'des-migração').
    const raw = new Database(dbPath, { readonly: true });
    expect(readSchemaVersion(raw)).toBe(999);
    raw.close();
  });

  test("a migração grava a versão como ÚLTIMA instrução da transação (atomicidade do par)", () => {
    // Prova estrutural + comportamental: a instrução `PRAGMA user_version = N`
    // é executada DEPOIS do DDL do passo e ANTES do COMMIT — logo, um passo
    // que falhe depois de gravar a versão tem TUDO desfeito.
    const source = fs.readFileSync(path.join(REPO_ROOT, "src/core/db.ts"), "utf8");
    const applyIdx = source.indexOf("step.apply(this.db);");
    const versionIdx = source.indexOf("PRAGMA user_version = ${step.version}");
    const commitIdx = source.indexOf('this.db.exec("COMMIT");', applyIdx);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeGreaterThan(applyIdx); // versão DEPOIS do DDL
    expect(commitIdx).toBeGreaterThan(versionIdx); // versão ANTES do COMMIT
  });
});

// ===========================================================================
// FRENTE 4 — ENVELOPE SEMÂNTICO DE INICIALIZAÇÃO (src/core/db.ts)
// ===========================================================================

/** Executa `new DreamsDB(dbPath)` e devolve o erro lançado (ou null). */
function captureInitError(dbPath: string): unknown {
  try {
    new DreamsDB(dbPath).close();
    return null;
  } catch (error) {
    return error;
  }
}

/** Lê o estado persistido do banco sem alterar nada (conexão read-only). */
function inspectPersistedState(dbPath: string): { version: number; tables: string[] } {
  const db = new Database(dbPath, { readonly: true });
  const version = readSchemaVersion(db);
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  db.close();
  return { version, tables };
}

describe("[DREAMS-04/4] db.ts: envelope semântico de inicialização (DatabaseInitError)", () => {
  test("arquivo somente-leitura ⇒ DatabaseInitError com caminho e ORIENTAÇÃO (não SQLiteError cru)", () => {
    const dir = makeTmp("dreams04_ro_");
    const dbPath = path.join(dir, "dreams.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE keeper (x TEXT)");
    seed.close();
    // 0o444: o arquivo existe e é legível, mas NENHUMA escrita é possível.
    fs.chmodSync(dbPath, 0o444);

    const thrown = captureInitError(dbPath);
    expect(thrown).toBeInstanceOf(DatabaseInitError);
    // O erro CRU do SQLite não pode vazar: a orientação semântica o substitui.
    expect(thrown).not.toBeInstanceOf(SQLiteError);
    expect(thrown).not.toBeInstanceOf(MigrationError);
    expect(thrown).not.toBeInstanceOf(SchemaVersionError);

    const error = thrown as DatabaseInitError;
    expect(error.dbPath).toBe(dbPath);
    expect(error.message).toContain(dbPath);
    expect(error.message).toContain("0o600"); // permissão esperada do arquivo
    expect(error.message).toContain("0o700"); // ...e do diretório
    expect(error.message).toContain("bloqueado por outro processo");
    // A CAUSA original é preservada (para diagnóstico), mas embrulhada.
    expect(error.cause).toBeInstanceOf(Error);
    expect(String((error.cause as Error).message)).toContain("readonly");

    // INVARIANTE: nada foi aplicado no banco.
    const state = inspectPersistedState(dbPath);
    expect(state.version).toBe(0);
    expect(state.tables).toEqual(["keeper"]);
  });

  test("arquivo somente-leitura JÁ EM WAL ⇒ a 1ª ESCRITA do passo falha ⇒ MigrationError NOMEANDO o passo", () => {
    const dir = makeTmp("dreams04_ro_wal_");
    const dbPath = path.join(dir, "dreams.db");
    const seed = new Database(dbPath);
    // Grava o modo WAL no CABEÇALHO do arquivo: assim o `PRAGMA journal_mode`
    // da abertura é um no-op (não exige escrita) e a falha recai NA PRIMEIRA
    // ESCRITA do passo — o `CREATE TABLE` dentro de step.apply.
    //
    // NOTA DE PRECISÃO (revisão do Quality Gate): este caso NÃO exercita a
    // AQUISIÇÃO do BEGIN (o `BEGIN EXCLUSIVE` em si CONSEGUE abrir a
    // transação mesmo em arquivo somente-leitura; quem falha é o DDL). O
    // caminho da falha de aquisição é provado pelo teste IRMÃO logo abaixo
    // (contenção de lock real) e pela asserção estrutural do BEGIN dentro do
    // `try`. Aqui o que se prova é: falha de escrita NO PASSO ⇒ MigrationError
    // nomeando o passo — e nunca SQLiteError cru.
    seed.exec("PRAGMA journal_mode = WAL;");
    seed.exec("CREATE TABLE keeper (x TEXT)");
    seed.close();
    fs.chmodSync(dbPath, 0o444);

    const thrown = captureInitError(dbPath);
    expect(thrown).toBeInstanceOf(MigrationError);
    expect(thrown).not.toBeInstanceOf(DatabaseInitError);
    expect(thrown).not.toBeInstanceOf(SQLiteError);

    const error = thrown as MigrationError;
    expect(error.step).toBe("baseline_memories_schema");
    expect(error.version).toBe(1);
    expect(error.message).toContain("baseline_memories_schema");

    // INVARIANTE: nada foi aplicado.
    const state = inspectPersistedState(dbPath);
    expect(state.version).toBe(0);
    expect(state.tables).toEqual(["keeper"]);
  });

  test("ESTRUTURAL: o BEGIN EXCLUSIVE fica DENTRO do try de runMigration (a falha de aquisição vira MigrationError)", () => {
    // Complementa (e antecipa, sem esperar o busy_timeout) o teste de contenção
    // de lock: se alguém mover o BEGIN para fora do try, esta asserção quebra
    // na hora — e o teste comportamental quebra junto.
    const source = fs.readFileSync(path.join(REPO_ROOT, "src/core/db.ts"), "utf8");
    const methodIdx = source.indexOf("private runMigration(step: MigrationStep): void {");
    expect(methodIdx).toBeGreaterThan(-1);

    const body = source.slice(methodIdx, source.indexOf("\n  }\n", methodIdx));
    const tryIdx = body.indexOf("try {");
    const beginIdx = body.indexOf('this.db.exec("BEGIN EXCLUSIVE TRANSACTION");');
    const applyIdx = body.indexOf("step.apply(this.db);");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(tryIdx); // o BEGIN fica DEPOIS do try {
    expect(applyIdx).toBeGreaterThan(beginIdx); // ...e ANTES da aplicação do passo
  });

  test("banco BLOQUEADO por outra conexão ⇒ a aquisição da transação falha como MigrationError (passo nomeado)", () => {
    const dir = makeTmp("dreams04_locked_");
    const dbPath = path.join(dir, "dreams.db");
    const seed = new Database(dbPath);
    // Já em WAL: o `PRAGMA journal_mode` da abertura vira no-op (não exige
    // escrita), então a CONTENÇÃO recai na aquisição da transação — que é o
    // cenário exato que o `BEGIN` dentro do `try` precisa cobrir.
    seed.exec("PRAGMA journal_mode = WAL;");
    seed.exec("CREATE TABLE keeper (x TEXT)");
    seed.close();

    // Conexão REAL que RETÉM a trava de escrita (contensão de lock real, sem
    // mock): o `BEGIN EXCLUSIVE` da migração não consegue a trava.
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    holder.run("INSERT INTO keeper (x) VALUES ('lock')");
    try {
      const thrown = captureInitError(dbPath);
      expect(thrown).toBeInstanceOf(MigrationError);
      expect(thrown).not.toBeInstanceOf(DatabaseInitError);
      expect(thrown).not.toBeInstanceOf(SQLiteError);
      const error = thrown as MigrationError;
      expect(error.step).toBe("baseline_memories_schema");
      expect(error.version).toBe(1);
      expect(error.message).toContain("locked");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // NOTA DE TEMPO: este caso leva ~5s — o `busy_timeout = 5000` fixado pela
    // produção (espera pelo lock antes de falhar). É espera ATIVA por estado,
    // nunca `sleep` arbitrário. O timeout do teste é explícito (15s) porque o
    // default do runner (5s) colidiria com o busy_timeout da produção.
  }, 15_000);

  test("erros JÁ semânticos passam INTACTOS (não são embrulhados em DatabaseInitError)", () => {
    // (a) SchemaVersionError — banco gravado por versão futura.
    const dirFuture = makeTmp("dreams04_future_passthrough_");
    const futurePath = path.join(dirFuture, "dreams.db");
    const seedFuture = new Database(futurePath);
    seedFuture.exec("PRAGMA user_version = 999");
    seedFuture.close();

    const thrownFuture = captureInitError(futurePath);
    expect(thrownFuture).toBeInstanceOf(SchemaVersionError);
    expect(thrownFuture).not.toBeInstanceOf(DatabaseInitError);
    expect((thrownFuture as SchemaVersionError).found).toBe(999);

    // (b) MigrationError — falha DENTRO de step.apply.
    const dirStep = makeTmp("dreams04_step_passthrough_");
    const stepPath = path.join(dirStep, "dreams.db");
    const seedStep = new Database(stepPath);
    seedStep.exec("CREATE VIRTUAL TABLE memories USING fts5(fact, category)");
    seedStep.close();

    const thrownStep = captureInitError(stepPath);
    expect(thrownStep).toBeInstanceOf(MigrationError);
    expect(thrownStep).not.toBeInstanceOf(DatabaseInitError);
    expect((thrownStep as MigrationError).step).toBe("baseline_memories_schema");
  });
});

// ===========================================================================
// FRENTE 3 — CHECAGEM PREVENTIVA DE SCHEMA (src/core/session_reader.ts)
// ===========================================================================
/**
 * DDLs ESTÁTICOS por variante do schema da tabela `message`.
 *
 * O schema divergente é obtido por ESCOLHA de uma variante — nunca por
 * concatenação de colunas em template literal. O guard anti-SQL-injection
 * (heurística sobre template literal com DDL) exige DDL estático, e a razão
 * técnica é a mesma: um DDL montado por concatenação é um DDL que pode ser
 * corrompido por um valor inesperado.
 */
const MESSAGE_DDL = {
  completa: "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);",
  sem_data: "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER);",
} as const;

/** Variante do schema da tabela `message` usada pela fixture. */
type MessageVariant = keyof typeof MESSAGE_DDL;

const PART_DDL =
  "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);";
const SESSION_DDL = "CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);";

interface SessionFixtureOptions {
  message?: boolean;
  part?: boolean;
  session?: boolean;
  /** Variante (estática) do DDL da tabela `message`. */
  messageVariant?: MessageVariant;
  /** Linhas da tabela `message`. */
  messages?: { id: string; session: string; t: number; role: string }[];
  /** Linhas da tabela `part`. */
  parts?: { id: string; message: string; t: number; type: string; text: string }[];
  /** Linhas da tabela `session`. */
  sessions?: { id: string; title: string }[];
}

/** Cria um banco OpenCode REAL (DDL real) no diretório temporário. */
function buildSessionDb(options: SessionFixtureOptions = {}): string {
  const dir = makeTmp("dreams04_sess_");
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);

  if (options.message !== false) {
    db.exec(MESSAGE_DDL[options.messageVariant ?? "completa"]);
  }
  if (options.part !== false) {
    db.exec(PART_DDL);
  }
  if (options.session !== false) {
    db.exec(SESSION_DDL);
    for (const s of options.sessions ?? []) {
      db.run("INSERT INTO session (id, data) VALUES (?, ?)", [s.id, JSON.stringify({ title: s.title })]);
    }
  }
  for (const m of options.messages ?? []) {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)", [
      m.id,
      m.session,
      m.t,
      JSON.stringify({ role: m.role }),
    ]);
  }
  for (const p of options.parts ?? []) {
    db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?,?,?,?)", [
      p.id,
      p.message,
      p.t,
      JSON.stringify({ type: p.type, text: p.text }),
    ]);
  }
  db.close();
  return dbPath;
}

const NOW = Date.now();

describe("[DREAMS-04/3] session_reader.ts: checagem preventiva de schema", () => {
  test("o contrato de tabelas/colunas críticas é o esperado", () => {
    expect([...SESSION_SCHEMA_TABLES]).toEqual(["message", "part", "session"]);
    expect(SESSION_SCHEMA_COLUMNS.message).toEqual(["id", "session_id", "time_created", "data"]);
    expect(SESSION_SCHEMA_COLUMNS.part).toEqual(["id", "message_id", "time_created", "data"]);
    // TICKET-DREAMS-09: de `session` só se exige a identidade — a fonte do
    // título é polimórfica (`title` nativo OU `data` JSON legado), e ambas
    // sustentam a exclusão anti-recursão.
    expect(SESSION_SCHEMA_COLUMNS.session).toEqual(["id"]);
    expect([...SESSION_TITLE_COLUMNS]).toEqual(["title", "data"]);
  });

  test("schema completo ⇒ nenhuma divergência e a leitura funciona", () => {
    const dbPath = buildSessionDb({
      messages: [{ id: "m1", session: "s1", t: NOW, role: "user" }],
      parts: [{ id: "p1", message: "m1", t: NOW, type: "text", text: "olá mundo" }],
    });

    const db = new Database(dbPath, { readonly: true });
    expect(inspectSessionSchema(db)).toEqual([]);
    expect(assertSessionSchema(db, dbPath)).toEqual([]);
    db.close();

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, onError: (e) => errors.push(e) });
    expect(errors).toEqual([]);
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe("olá mundo");
    expect(entries[0].role).toBe("user");
  });

  test("tabela CRÍTICA ausente ⇒ SessionSchemaError fatal, sem crash genérico do SQLite", () => {
    const dbPath = buildSessionDb({ message: false });

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, onError: (e) => errors.push(e) });

    expect(entries).toEqual([]);
    expect(errors.length).toBe(1);
    const error = errors[0] as SessionSchemaError;
    expect(error).toBeInstanceOf(SessionSchemaError);
    expect(error.fatal).toBe(true);
    expect(error.divergences.length).toBe(1);
    expect(error.divergences[0].table).toBe("message");
    expect(error.divergences[0].severity).toBe("critical");
    expect(error.divergences[0].missingTable).toBe(true);
    // A orientação semântica substitui o crash genérico ("no such table").
    expect(error.message).toContain("Atualize o OpenCode");
    expect(error.message).not.toContain("SQLiteError");
    expect(error.message).not.toContain("no such table");
  });

  test("coluna CRÍTICA ausente ⇒ divergência crítica com a coluna nomeada", () => {
    const dbPath = buildSessionDb({ messageVariant: "sem_data" });

    const errors: unknown[] = [];
    readRecentDialogues({ dbPath, onError: (e) => errors.push(e) });

    const error = errors[0] as SessionSchemaError;
    expect(error).toBeInstanceOf(SessionSchemaError);
    expect(error.fatal).toBe(true);
    expect(error.divergences[0].missingTable).toBe(false);
    expect(error.divergences[0].missingColumns).toContain("data");
  });

  test("tabela OPCIONAL ausente ⇒ divergência ADVISORY: reporta, mas NÃO aborta a leitura", () => {
    const dbPath = buildSessionDb({
      session: false,
      messages: [{ id: "m1", session: "s1", t: NOW, role: "assistant" }],
      parts: [{ id: "p1", message: "m1", t: NOW, type: "text", text: "resposta do agente" }],
    });

    const errors: unknown[] = [];
    const entries = readRecentDialogues({ dbPath, onError: (e) => errors.push(e) });

    // A leitura CONTINUA (degradação suportada: só a exclusão anti-recursão
    // fica inativa).
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe("resposta do agente");

    // ... mas a divergência é REPORTADA.
    expect(errors.length).toBe(1);
    const error = errors[0] as SessionSchemaError;
    expect(error).toBeInstanceOf(SessionSchemaError);
    expect(error.fatal).toBe(false);
    expect(error.divergences[0].table).toBe("session");
    expect(error.divergences[0].severity).toBe("advisory");
  });

  test("readRecentDialogueSummary carrega a ORIENTAÇÃO semântica no schema incompatível", () => {
    const dbPath = buildSessionDb({ part: false });
    const summary = readRecentDialogueSummary({ dbPath });
    expect(summary).toContain("session_reader:");
    expect(summary).toContain("Atualize o OpenCode");
    expect(summary).toContain("'part'");
  });

  test("paridade da exclusão anti-recursão após a reescrita do SQL estático", () => {
    const dbPath = buildSessionDb({
      sessions: [
        { id: "ses_synth", title: "Dreams Synthesis" },
        { id: "ses_user", title: "Conversa real" },
      ],
      messages: [
        { id: "m_synth", session: "ses_synth", t: NOW - 1000, role: "assistant" },
        { id: "m_user", session: "ses_user", t: NOW, role: "user" },
      ],
      parts: [
        { id: "p_synth", message: "m_synth", t: NOW - 1000, type: "text", text: "síntese interna" },
        { id: "p_user", message: "m_user", t: NOW, type: "text", text: "fala da usuária" },
      ],
    });

    // AS DUAS variantes do SQL (COM teto e SEM teto) devem excluir a sessão
    // interna — o filtro vive nas duas queries estáticas.
    for (const options of [{}, { limit: 10 }]) {
      const entries = readRecentDialogues({ dbPath, ...options });
      const texts = entries.map((e) => e.text);
      expect(texts).toContain("fala da usuária");
      expect(texts).not.toContain("síntese interna");
      expect(entries.every((e) => e.session_id !== "ses_synth")).toBe(true);
    }
  });

  test("títulos de sessão são PARAMETRIZADOS: tentativa de SQL injection é tratada como literal", () => {
    const evil = "Dreams Synthesis'; DROP TABLE message; --";
    const dbPath = buildSessionDb({
      sessions: [
        { id: "ses_evil", title: evil },
        { id: "ses_ok", title: "Conversa real" },
      ],
      messages: [
        { id: "m_evil", session: "ses_evil", t: NOW - 1000, role: "assistant" },
        { id: "m_ok", session: "ses_ok", t: NOW, role: "user" },
      ],
      parts: [
        { id: "p_evil", message: "m_evil", t: NOW - 1000, type: "text", text: "payload malicioso" },
        { id: "p_ok", message: "m_ok", t: NOW, type: "text", text: "texto legítimo" },
      ],
    });

    const entries = readRecentDialogues({ dbPath, excludeSessionTitles: [evil] });
    const texts = entries.map((e) => e.text);
    expect(texts).toContain("texto legítimo");
    expect(texts).not.toContain("payload malicioso");

    // A tabela NÃO foi derrubada: a query seguinte ainda funciona.
    const after = readRecentDialogues({ dbPath });
    expect(after.some((e) => e.text === "texto legítimo")).toBe(true);

    // Idem na variante COM teto (o outro SQL estático).
    const limited = readRecentDialogues({ dbPath, excludeSessionTitles: [evil], limit: 10 });
    expect(limited.map((e) => e.text)).toContain("texto legítimo");
    expect(limited.map((e) => e.text)).not.toContain("payload malicioso");
  });

  test("a lista padrão de títulos excluídos é a canônica", () => {
    // TICKET-DREAMS-06-FIX: os DOIS títulos internos do Dreams são excluídos —
    // a síntese diária e o julgamento neural de reconciliação.
    expect([...DEFAULT_EXCLUDED_SESSION_TITLES]).toEqual([
      "Dreams Synthesis",
      "Dreams Reconciliation",
    ]);
  });
});

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      // Limpeza best-effort do teardown da suíte (ver comentário equivalente no
      // afterEach): o erro é deliberadamente engolido e declarado.
      void error;
    }
  }
});
