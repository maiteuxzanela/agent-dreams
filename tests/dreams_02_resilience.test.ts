/**
 * TICKET-DREAMS-02 — Suíte determinística REAL (sem mocks) da resiliência do
 * ciclo de consolidação (Frentes 2A/C3, 2B/C4 e 2C/C5).
 *
 * Cobre, com infraestrutura REAL (SQLite `bun:sqlite`, arquivos em /tmp,
 * subprocessos reais do CLI e scripts bash reais como seams de I/O):
 *
 *  2A — CHECKPOINT CUMULATIVO DE HANDOFF (src/core/sleep_cycle.ts)
 *    1. ACUMULA: lightSleep concatena o novo diálogo ao pendente com separador
 *       temporal, sem sobrescrever um handoff não consumido.
 *    2. FRONTEIRA: a captura usa `last_capture_at` e não re-acumula a mesma janela.
 *    3. PRESERVA: falhas consecutivas de síntese mantêm `dialogue_pending.txt`
 *       100% íntegro (sem amnésia, sem memórias falsas).
 *    4. LIMPEZA SÓ NO SUCESSO: o pendente é removido e `last_synthesized_at`
 *       avança APENAS quando a síntese REM teve sucesso comprovado.
 *    5. INGESTÃO INTEGRAL (TICKET-DREAMS-08): o handoff acumulado retém o dia
 *       inteiro (sem corte rígido de 120k); o teto `MAX_PROMPT_BYTES` passa a
 *       valer POR CHUNK no REM Sleep, nunca por descarte do início do dia.
 *    6. FRONTEIRA DE LEITURA: sem pendente em disco, `loadPendingDialogue` lê o
 *       DB SOMENTE após `last_synthesized_at`.
 *    7. `markSynthesisComplete` é o único caminho que limpa/avança a fronteira.
 *
 *  2C — CÓDIGOS DE SAÍDA SEMÂNTICOS E ROTAÇÃO DE LOG (src/cli.ts + wrapper)
 *    1. `rotateLogIfNeeded` (helper puro): rotação, sobrescrita do `.1`,
 *       tetos inválidos e fail-soft.
 *    2. CLI `rem`: `EX_TEMPFAIL` (75) em adiamento; 0 em consolidação limpa
 *       (com e sem diálogo); `EXIT_OK` no `rotate-log`.
 *    3. Wrapper bash `bin/dreams-consolidate.sh`: agregação semântica de exit
 *       (fatal 1 > tempfail 75 > sucesso 0) e alerta `notify-send` real.
 *
 * Nenhum `unittest.mock`/`jest.mock`/stub de módulo é usado. O seam de síntese
 * bem-sucedida é um script bash REAL (`OPENCODE_BIN`) que lê o stdin e imprime
 * o array JSON canônico — exatamente o contrato de transporte de produção.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { DreamsDB } from "../src/core/db";
import { SleepCycle, DIALOGUE_CHECKPOINT_FILENAME } from "../src/core/sleep_cycle";
import { MAX_PROMPT_BYTES, utf8ByteLength } from "../src/core/mimo_synthesizer";
import { chunkDialogueText } from "../src/core/session_reader";
import {
  EXIT_OK,
  EXIT_FATAL,
  EXIT_TEMPFAIL,
  hasPendingDialogue,
  pendingDialoguePath,
  dreamsMarkdownPath,
  rotateLogIfNeeded,
  evaluateConsolidationOutcome,
  snapshotDeferralState,
} from "../src/cli";

const REPO_ROOT = path.join(import.meta.dir, "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");
const WRAPPER = path.join(REPO_ROOT, "bin", "dreams-consolidate.sh");

const liveDbs: DreamsDB[] = [];
const liveDirs: string[] = [];

afterAll(() => {
  for (const db of liveDbs) {
    try {
      db.close();
    } catch {
      /* já fechado */
    }
  }
  for (const dir of liveDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Infra real (sem mocks)
// ---------------------------------------------------------------------------

function makeDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dreams02_${name}_`));
  liveDirs.push(dir);
  return dir;
}

function makeDb(name: string): { db: DreamsDB; baseDir: string } {
  const baseDir = makeDir(name);
  const db = new DreamsDB(path.join(baseDir, "dreams.db"));
  liveDbs.push(db);
  return { db, baseDir };
}

interface FMsg {
  id: string;
  session: string;
  t: number;
  role: "user" | "assistant";
  texts: string[];
}

/** Banco OpenCode REAL (tabelas `message`/`part`) do qual o Light Sleep lê. */
function buildSessionDb(dir: string, msgs: FMsg[]): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);`);
  for (const m of msgs) {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      m.id,
      m.session,
      m.t,
      JSON.stringify({ role: m.role }),
    ]);
    let n = 0;
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

/**
 * Seam REAL do caminho de sucesso: um script bash executável que captura o
 * prompt de STDIN e imprime o array JSON canônico. É honrado por
 * `resolveOpencodeBinaryPath` via `OPENCODE_BIN`.
 */
function makeSynthRecorder(dir: string, fact: string): { bin: string; stdinLog: string } {
  const bin = path.join(dir, "opencode_seam.sh");
  const stdinLog = path.join(dir, "seam_stdin.log");
  const payload = JSON.stringify([{ scope: "collective", category: "learning", fact }]);
  fs.writeFileSync(
    bin,
    ["#!/usr/bin/env bash", `cat > "${stdinLog}"`, `printf '%s\\n' '${payload}'`, ""].join("\n"),
    { mode: 0o755 }
  );
  return { bin, stdinLog };
}

/** Executa `fn` sem o fast-fail offline e com o binário seam em `OPENCODE_BIN`. */
async function withSynthSeam<T>(binPath: string, fn: () => Promise<T>): Promise<T> {
  const prevOffline = process.env.DREAMS_OFFLINE;
  const prevBin = process.env.OPENCODE_BIN;
  delete process.env.DREAMS_OFFLINE;
  process.env.OPENCODE_BIN = binPath;
  try {
    return await fn();
  } finally {
    if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
    else process.env.DREAMS_OFFLINE = prevOffline;
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
  }
}

/** Garante o caminho de adiamento determinístico (sem IA) dentro do teste. */
async function withOffline<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DREAMS_OFFLINE;
  process.env.DREAMS_OFFLINE = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DREAMS_OFFLINE;
    else process.env.DREAMS_OFFLINE = prev;
  }
}

function readCheckpoint(baseDir: string): { last_capture_at: string | null; last_synthesized_at: string | null } {
  return JSON.parse(fs.readFileSync(path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME), "utf8"));
}

function safeEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") merged[k] = v;
  // Baseline limpo: nenhum seam herdado acidentalmente.
  delete merged.OPENCODE_BIN;
  delete merged.DREAMS_OFFLINE;
  delete merged.NOTIFY_LOG;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

function runCli(args: string[], env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["run", CLI_ENTRY, ...args], {
    env: safeEnv(env),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ===========================================================================
// 2A — Checkpoint cumulativo de handoff (C3)
// ===========================================================================

describe("TICKET-DREAMS-02A — checkpoint cumulativo de handoff (C3)", () => {
  test("ACUMULA: lightSleep concatena o novo diálogo ao pendente com separador temporal", async () => {
    const { db, baseDir } = makeDb("accum");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    const earlier = "BLOCO ANTERIOR: combinamos de usar sempre a cota gratuita";
    fs.writeFileSync(pending, earlier);
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(pending, past, past);

    const sessionDb = buildSessionDb(baseDir, [
      { id: "m1", session: "ses_a", t: Date.now() - 5 * 60 * 1000, role: "user", texts: ["DIALOGO NOVO B sobre resiliencia"] },
    ]);
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: sessionDb });

    await cycle.lightSleep();

    const after = fs.readFileSync(pending, "utf8");
    expect(after).toContain(earlier);
    expect(after).toContain("DIALOGO NOVO B sobre resiliencia");
    expect(after).toContain("===== [Dreams] diálogo acumulado em");
    // Ordem temporal: o anterior precede o novo.
    expect(after.indexOf(earlier)).toBeLessThan(after.indexOf("DIALOGO NOVO B"));

    const cp = readCheckpoint(baseDir);
    expect(typeof cp.last_capture_at).toBe("string");
    // A captura NUNCA avança a fronteira de síntese.
    expect(cp.last_synthesized_at).toBeNull();
  });

  test("FRONTEIRA: 2º lightSleep não re-acumula a mesma janela e avança last_capture_at", async () => {
    const { db, baseDir } = makeDb("boundary_capture");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    fs.writeFileSync(pending, "BLOCO ANTERIOR UNICO");
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(pending, past, past);

    const sessionDb = buildSessionDb(baseDir, [
      { id: "m1", session: "ses_a", t: Date.now() - 5 * 60 * 1000, role: "user", texts: ["JANELA UNICA C"] },
    ]);
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: sessionDb });

    await cycle.lightSleep();
    const afterFirst = fs.readFileSync(pending, "utf8");
    const cp1 = readCheckpoint(baseDir);
    expect(afterFirst).toContain("JANELA UNICA C");
    expect(afterFirst.split("JANELA UNICA C").length - 1).toBe(1);

    await cycle.lightSleep();
    const afterSecond = fs.readFileSync(pending, "utf8");
    const cp2 = readCheckpoint(baseDir);

    // Conteúdo idêntico: a janela já capturada NÃO é re-acumulada.
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split("JANELA UNICA C").length - 1).toBe(1);
    expect(typeof cp1.last_capture_at).toBe("string");
    expect(typeof cp2.last_capture_at).toBe("string");
    // Mesmo sem conteúdo novo, a fronteira de captura permanece válida e a de
    // síntese segue intocada (só o REM a avança).
    expect(cp2.last_capture_at! >= cp1.last_capture_at!).toBe(true);
    expect(cp2.last_synthesized_at).toBeNull();
  });

  test("AVANÇA MESMO SEM CONTEÚDO NOVO: a fronteira de captura é reescrita sempre", async () => {
    const { db, baseDir } = makeDb("advance");
    const emptyDb = buildSessionDb(baseDir, []);
    const OLD = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(
      path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME),
      JSON.stringify({ last_capture_at: OLD, last_synthesized_at: null })
    );
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: emptyDb });

    await cycle.lightSleep();

    const cp = readCheckpoint(baseDir);
    expect(typeof cp.last_capture_at).toBe("string");
    expect(Date.parse(cp.last_capture_at!)).toBeGreaterThan(Date.parse(OLD));
    expect(cp.last_synthesized_at).toBeNull();
  });

  test("PRESERVA: 2 falhas consecutivas de síntese mantêm o pendente 100% íntegro", async () => {
    const { db, baseDir } = makeDb("preserve");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    const content = "HANDOFF INTEGRO: nao pode ser descartado\nsegunda linha\n";
    fs.writeFileSync(pending, content);
    // Checkpoint semeado: a fronteira de síntese NÃO pode avançar em falha.
    const seeded = { last_capture_at: "2026-01-01T00:00:00.000Z", last_synthesized_at: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME), JSON.stringify(seeded));
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: path.join(baseDir, "absent.db") });

    await withOffline(async () => {
      await cycle.remSleep();
      expect(fs.readFileSync(pending, "utf8")).toBe(content);
      expect(db.getAllMemories().length).toBe(0);
      await cycle.remSleep();
      expect(fs.readFileSync(pending, "utf8")).toBe(content);
    });

    expect(readCheckpoint(baseDir)).toEqual(seeded);
    // O relatório registra explicitamente o adiamento.
    const md = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf8");
    expect(/\*\*adiada\*\*/.test(md)).toBe(true);
  });

  test("LIMPEZA SÓ NO SUCESSO: síntese real remove o pendente e avança last_synthesized_at", async () => {
    const { db, baseDir } = makeDb("success");
    const rec = makeSynthRecorder(baseDir, "MEMORIA SINTETIZADA COM SUCESSO PELA SEAM REAL");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    fs.writeFileSync(pending, "DIALOGO PARA SINTETIZAR DE VERDADE");
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: path.join(baseDir, "absent.db") });

    await withSynthSeam(rec.bin, async () => {
      await cycle.remSleep();
    });

    expect(fs.existsSync(pending)).toBe(false);
    const cp = readCheckpoint(baseDir);
    expect(typeof cp.last_synthesized_at).toBe("string");

    const mems = db.getAllMemories();
    expect(mems.length).toBe(1);
    expect(mems[0].scope).toBe("collective");
    expect(mems[0].fact).toBe("MEMORIA SINTETIZADA COM SUCESSO PELA SEAM REAL");
  });

  test("INGESTÃO INTEGRAL: handoff acumulado retém o dia inteiro (sem corte de 120k); teto passa a ser POR CHUNK", async () => {
    const { db, baseDir } = makeDb("cap");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    const bigBlock = "A".repeat(200_000); // 200000 bytes > teto antigo de 120k
    fs.writeFileSync(pending, bigBlock);
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(pending, past, past);

    const sessionDb = buildSessionDb(baseDir, [
      { id: "m1", session: "ses_a", t: Date.now() - 5 * 60 * 1000, role: "user", texts: ["CAUDA NOVA UNICA"] },
    ]);
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: sessionDb });

    await cycle.lightSleep();

    // TICKET-DREAMS-08 (Frente 8A): o corte rígido por `MAX_PROMPT_BYTES` foi
    // REMOVIDO do handoff — o início do dia (bloco antigo de 200k) NÃO é mais
    // descartado; a cauda mais recente também sobrevive, em ordem temporal.
    const after = fs.readFileSync(pending, "utf8");
    expect(after).toContain(bigBlock);
    expect(after).toContain("CAUDA NOVA UNICA");
    expect(after.indexOf(bigBlock)).toBeLessThan(after.indexOf("CAUDA NOVA UNICA"));
    expect(after).not.toContain("início do dia omitido");

    // O teto do prompt permanece inviolável, agora POR CHUNK: cada fatia gerada
    // pelo particionador cabe com folga sob MAX_PROMPT_BYTES, e a concatenação
    // reconstrói o handoff inteiro (nenhum caractere perdido).
    const chunks = chunkDialogueText(after);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    }
    expect(chunks.join("\n").replace(/\n/g, "")).toBe(after.replace(/\n/g, ""));
    expect(past.getTime()).toBeLessThan(Date.now());
  });

  test("FRONTEIRA DE LEITURA: sem pendente em disco, loadPendingDialogue lê o DB só após last_synthesized_at", async () => {
    const { db, baseDir } = makeDb("boundary_read");
    const rec = makeSynthRecorder(baseDir, "MEMORIA NOVA");
    const T = Date.now() - 5 * 60 * 1000;
    fs.writeFileSync(
      path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME),
      JSON.stringify({ last_capture_at: null, last_synthesized_at: new Date(T).toISOString() })
    );
    const sessionDb = buildSessionDb(baseDir, [
      { id: "m_old", session: "ses_a", t: T - 60_000, role: "user", texts: ["DIALOGO ANTIGO NAO DEVE APARECER"] },
      { id: "m_new", session: "ses_a", t: T + 60_000, role: "user", texts: ["DIALOGO NOVO DEVE APARECER"] },
    ]);
    const cycle = new SleepCycle(db, { baseDir, sessionDbPath: sessionDb });

    await withSynthSeam(rec.bin, async () => {
      await cycle.remSleep();
    });

    const stdin = fs.readFileSync(rec.stdinLog, "utf8");
    expect(stdin).toContain("DIALOGO NOVO DEVE APARECER");
    expect(stdin).not.toContain("DIALOGO ANTIGO NAO DEVE APARECER");
  });
});

// ===========================================================================
// 2B — Projeções pós-deep, expurgo de personas órfãs e reordenação (C4)
// ===========================================================================

describe("TICKET-DREAMS-02B — projeções pós-deep e expurgo de personas órfãs (C4)", () => {
  test("PROJEÇÕES PÓS-DEEP: COLLECTIVE_MEMORY.md reflete a tabela pós-poda (sem fantasma)", async () => {
    const { db, baseDir } = makeDb("postdeep");
    const cycle = new SleepCycle(db, { baseDir });
    const freshId = db.insertMemory("collective", "FATO COLETIVO RECENTE PRESERVADO", "learning");
    const staleId = db.insertMemory("collective", "FATO COLETIVO ANTIGO SERA PODADO", "learning");

    // Envelhece a memória obsoleta além da meia-vida (learning: ~14d) via
    // conexão SQLite real (WAL) — nenhum mock de tempo.
    const raw = new Database(path.join(baseDir, "dreams.db"));
    raw.run("UPDATE memories SET last_reinforced = ? WHERE id = ?", [
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      staleId,
    ]);
    raw.close();

    await cycle.deepSleep();

    // A poda realmente ocorreu ANTES da projeção.
    const idsAfter = db.getAllMemories().map((m) => m.id);
    expect(idsAfter).not.toContain(staleId);
    expect(idsAfter).toContain(freshId);

    const col = fs.readFileSync(path.join(baseDir, "collective", "COLLECTIVE_MEMORY.md"), "utf8");
    expect(col).toContain("FATO COLETIVO RECENTE PRESERVADO");
    expect(col).not.toContain("FATO COLETIVO ANTIGO SERA PODADO");
  });

  test("EXPURGO: deepSleep remove personas/*.md sem memórias ativas e preserva os demais", async () => {
    const { db, baseDir } = makeDb("orphan");
    const cycle = new SleepCycle(db, { baseDir });
    const architectId = db.insertMemory("agent:architect", "Preferencia viva do architect", "preference");
    db.insertMemory("agent:auditor", "Decisao viva da auditor", "decision");

    cycle.updateProjections();
    const personasDir = path.join(baseDir, "personas");
    expect(fs.existsSync(path.join(personasDir, "architect.md"))).toBe(true);
    expect(fs.existsSync(path.join(personasDir, "auditor.md"))).toBe(true);

    // Arquivos que o projetor NÃO gerencia (não-.md / nomes não-canônicos).
    fs.writeFileSync(path.join(personasDir, "notes.txt"), "nao-md");
    fs.writeFileSync(path.join(personasDir, ".oculto.md"), "nome inseguro");
    fs.writeFileSync(path.join(personasDir, "a.b.md"), "nome nao-canonico");

    // architect perde TODAS as memórias ativas.
    db.deleteMemory(architectId);

    await cycle.deepSleep();

    expect(fs.existsSync(path.join(personasDir, "architect.md"))).toBe(false);
    expect(fs.existsSync(path.join(personasDir, "auditor.md"))).toBe(true);
    // Intocados pelo expurgo.
    expect(fs.existsSync(path.join(personasDir, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(personasDir, ".oculto.md"))).toBe(true);
    expect(fs.existsSync(path.join(personasDir, "a.b.md"))).toBe(true);
    expect(fs.readFileSync(path.join(personasDir, "auditor.md"), "utf8")).toContain("Decisao viva da auditor");
  });

  test("REORDENAÇÃO: remSleep NÃO projeta; a projeção só ocorre no deepSleep (pós-poda)", async () => {
    const { db, baseDir } = makeDb("reorder");
    const cycle = new SleepCycle(db, { baseDir });
    db.insertMemory("collective", "MEMORIA COLETIVA PRE-EXISTENTE", "learning");
    cycle.updateProjections();

    const colPath = path.join(baseDir, "collective", "COLLECTIVE_MEMORY.md");
    const before = fs.readFileSync(colPath, "utf8");
    expect(before).toContain("MEMORIA COLETIVA PRE-EXISTENTE");

    // remSleep com síntese de SUCESSO (seam real) que insere nova memória coletiva.
    const rec = makeSynthRecorder(baseDir, "MEMORIA NOVA DO REM NAO DEVE PROJETAR AINDA");
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "DIALOGO PARA O REM");
    await withSynthSeam(rec.bin, async () => {
      await cycle.remSleep();
    });

    // O REM não projetou: o arquivo permanece idêntico ao snapshot anterior.
    const afterRem = fs.readFileSync(colPath, "utf8");
    expect(afterRem).toBe(before);
    expect(afterRem).not.toContain("MEMORIA NOVA DO REM");

    // O deepSleep projeta o estado final.
    await cycle.deepSleep();
    const afterDeep = fs.readFileSync(colPath, "utf8");
    expect(afterDeep).toContain("MEMORIA NOVA DO REM");
    expect(afterDeep).toContain("MEMORIA COLETIVA PRE-EXISTENTE");
  });

  test("DREAMS.md é SEMPRE escrito no remSleep mesmo sem banco e sem diálogo (early-return removido)", async () => {
    const { db, baseDir } = makeDb("alwaysmd");
    const cycle = new SleepCycle(db, { baseDir, captureDialogue: false });
    const mdPath = path.join(baseDir, "DREAMS.md");
    expect(fs.existsSync(mdPath)).toBe(false);

    await cycle.remSleep();

    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.readFileSync(mdPath, "utf8")).toContain("# Daily Dreams Synthesis");
  });
});

// ===========================================================================
// 2C — Rotação de log (helper puro, C5)
// ===========================================================================

describe("TICKET-DREAMS-02C — rotateLogIfNeeded (rotação de log)", () => {
  test("rotaciona quando excede o teto, preservando o conteúdo em <log>.1", () => {
    const dir = makeDir("rot");
    const log = path.join(dir, "app.log");
    fs.writeFileSync(log, "X".repeat(5000));

    expect(rotateLogIfNeeded(log, 1024)).toBe(true);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(`${log}.1`)).toBe(true);
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("X".repeat(5000));
  });

  test("não rotaciona quando o arquivo está no limite ou abaixo", () => {
    const dir = makeDir("rot_noop");
    const log = path.join(dir, "app.log");
    fs.writeFileSync(log, "Y".repeat(1000));
    expect(rotateLogIfNeeded(log, 1024)).toBe(false);
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(`${log}.1`)).toBe(false);
  });

  test("arquivo inexistente e teto inválido retornam false sem lançar", () => {
    const dir = makeDir("rot_missing");
    const log = path.join(dir, "nope.log");
    expect(rotateLogIfNeeded(log, 10)).toBe(false);
    fs.writeFileSync(log, "Z".repeat(500));
    expect(rotateLogIfNeeded(log, 0)).toBe(false);
    expect(rotateLogIfNeeded(log, -1)).toBe(false);
    expect(fs.existsSync(log)).toBe(true);
  });

  test("sobrescreve um <log>.1 anterior (política de 1 geração)", () => {
    const dir = makeDir("rot_over");
    const log = path.join(dir, "app.log");
    fs.writeFileSync(`${log}.1`, "GEN_ANTIGA");
    fs.writeFileSync(log, "N".repeat(3000));

    expect(rotateLogIfNeeded(log, 1024)).toBe(true);
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("N".repeat(3000));
  });

  test("FAIL-SOFT: se a rotação não puder ocorrer, retorna false e não destrói o log", () => {
    const dir = makeDir("rot_failsoft");
    const log = path.join(dir, "app.log");
    fs.writeFileSync(log, "K".repeat(3000));
    // Destino `.1` é um diretório NÃO-vazio → rmSync({force}) falha em POSIX.
    const rotated = `${log}.1`;
    fs.mkdirSync(rotated);
    fs.writeFileSync(path.join(rotated, "keep.txt"), "bloqueio");

    expect(rotateLogIfNeeded(log, 1024)).toBe(false);
    // O log original permanece intacto.
    expect(fs.readFileSync(log, "utf8")).toBe("K".repeat(3000));
  });
});

// ===========================================================================
// 2C — Avaliação de adiamento (helper puro, C5)
// ===========================================================================

describe("TICKET-DREAMS-02C — evaluateConsolidationOutcome", () => {
  test("pendente não vazio ⇒ deferred; ausência de pendente e de DREAMS.md ⇒ complete", () => {
    const dir = makeDir("outcome");
    const emptySnapshot = snapshotDeferralState(dir);
    expect(emptySnapshot.dreamsMdMtimeMs).toBe(-1);
    expect(evaluateConsolidationOutcome(emptySnapshot, undefined, dir)).toBe("complete");

    fs.writeFileSync(pendingDialoguePath(dir), "PENDENTE");
    expect(hasPendingDialogue(pendingDialoguePath(dir))).toBe(true);
    expect(evaluateConsolidationOutcome(emptySnapshot, undefined, dir)).toBe("deferred");
  });

  test("DREAMS.md reescrito com marcador **adiada** ⇒ deferred", () => {
    const dir = makeDir("outcome_md");
    const snapshot = { dreamsMdMtimeMs: Date.now() - 60_000 };
    fs.writeFileSync(dreamsMarkdownPath(dir), "# Daily Dreams Synthesis\n> status: **adiada** (offline)\n");
    expect(evaluateConsolidationOutcome(snapshot, undefined, dir)).toBe("deferred");
  });

  test("resultado estruturado com deferred:true ⇒ deferred (defensivo)", () => {
    const dir = makeDir("outcome_struct");
    const snapshot = snapshotDeferralState(dir);
    expect(evaluateConsolidationOutcome(snapshot, { deferred: true }, dir)).toBe("deferred");
    expect(evaluateConsolidationOutcome(snapshot, { status: "deferred" }, dir)).toBe("deferred");
  });
});

// ===========================================================================
// 2C — Códigos de saída semânticos da CLI (processo real, C5)
// ===========================================================================

describe("TICKET-DREAMS-02C — exit codes semânticos da CLI (processo real)", () => {
  test("EX_TEMPFAIL (75): adiamento da síntese preserva o pendente", () => {
    const home = makeDir("cli75");
    const dreamsDir = path.join(home, ".config", "opencode", "dreams");
    fs.mkdirSync(dreamsDir, { recursive: true });
    const pending = path.join(dreamsDir, "dialogue_pending.txt");
    const content = "DIALOGO PENDENTE QUE DEVE SOBREVIVER AO ADIAMENTO";
    fs.writeFileSync(pending, content);

    const r = runCli(["rem"], { HOME: home, DREAMS_OFFLINE: "1" });
    expect(r.code).toBe(EXIT_TEMPFAIL);
    expect(EXIT_TEMPFAIL).toBe(75);
    expect(fs.readFileSync(pending, "utf8")).toBe(content);
    expect(/\*\*adiada\*\*/.test(fs.readFileSync(path.join(dreamsDir, "DREAMS.md"), "utf8"))).toBe(true);
  });

  test("EXIT_OK (0): consolidação limpa consome o pendente apenas em sucesso real", () => {
    const home = makeDir("cli0");
    const dreamsDir = path.join(home, ".config", "opencode", "dreams");
    fs.mkdirSync(dreamsDir, { recursive: true });
    const pending = path.join(dreamsDir, "dialogue_pending.txt");
    fs.writeFileSync(pending, "DIALOGO QUE SERA SINTETIZADO");
    const rec = makeSynthRecorder(home, "MEMORIA VIA CLI REAL");

    const r = runCli(["rem"], { HOME: home, DREAMS_OFFLINE: undefined, OPENCODE_BIN: rec.bin });
    expect(r.code).toBe(EXIT_OK);
    expect(EXIT_OK).toBe(0);
    expect(fs.existsSync(pending)).toBe(false);
  });

  test("EXIT_OK (0): sem diálogo pendente não há adiamento", () => {
    const home = makeDir("cli0_none");
    const dreamsDir = path.join(home, ".config", "opencode", "dreams");
    fs.mkdirSync(dreamsDir, { recursive: true });

    const r = runCli(["rem"], { HOME: home, DREAMS_OFFLINE: "1" });
    expect(r.code).toBe(EXIT_OK);
  });

  test("subcomando rotate-log existe na CLI e retorna 0 (acionável pelo wrapper)", () => {
    const home = makeDir("cli_rotate");
    const logDir = path.join(home, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, "app.log");
    fs.writeFileSync(log, "L".repeat(5000));

    const r = runCli(["rotate-log", log, "1024"], { HOME: home });
    expect(r.code).toBe(EXIT_OK);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("L".repeat(5000));
  });
});

// ===========================================================================
// 2C — Wrapper bash: agregação semântica de exit + alerta (C5)
// ===========================================================================

interface WrapperCodes {
  light: number;
  rem: number;
  deep: number;
}

/**
 * Prepara um HOME isolado com seams REAIS na frente do PATH: um `bun` que
 * devolve os exit codes pedidos, um `ping` que sinaliza rede online e um
 * `notify-send` que registra a chamada. O `cli.ts` é um placeholder que apenas
 * satisfaz o guard `[ -f "$CLI_PATH" ]` do wrapper (o `bun` é o seam).
 */
function setupWrapper(name: string, codes: WrapperCodes): { home: string; notifyLog: string } {
  const home = makeDir(`wrap_${name}`);
  const fakeBin = path.join(home, ".opencode", "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const notifyLog = path.join(home, "notify.log");

  const cliDir = path.join(home, ".config", "opencode", "plugins", "opencode-plugin-dreams", "src");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, "cli.ts"), "// placeholder de guard\n");

  fs.writeFileSync(
    path.join(fakeBin, "bun"),
    [
      "#!/usr/bin/env bash",
      'sub=""',
      'for a in "$@"; do case "$a" in light|rem|deep|rotate-log) sub="$a";; esac; done',
      'case "$sub" in',
      `  light) exit ${codes.light};;`,
      `  rem) exit ${codes.rem};;`,
      `  deep) exit ${codes.deep};;`,
      "  rotate-log) exit 0;;",
      "  *) exit 0;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(fakeBin, "ping"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(fakeBin, "notify-send"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${notifyLog}"\nexit 0\n`,
    { mode: 0o755 }
  );

  return { home, notifyLog };
}

function runWrapper(home: string, notifyLog: string): number {
  const r = spawnSync("bash", [WRAPPER], {
    env: safeEnv({ HOME: home, NOTIFY_LOG: notifyLog }),
    encoding: "utf8",
    timeout: 60_000,
  });
  return r.status ?? -1;
}

describe("TICKET-DREAMS-02C — wrapper bash (agregação de exit + alerta)", () => {
  test("todas as etapas OK ⇒ exit 0 e nenhum alerta", () => {
    const { home, notifyLog } = setupWrapper("ok", { light: 0, rem: 0, deep: 0 });
    expect(runWrapper(home, notifyLog)).toBe(EXIT_OK);
    expect(fs.existsSync(notifyLog)).toBe(false);
  });

  test("REM adiado (75) ⇒ wrapper propaga 75 e alerta a usuária", () => {
    const { home, notifyLog } = setupWrapper("defer", { light: 0, rem: 75, deep: 0 });
    expect(runWrapper(home, notifyLog)).toBe(EXIT_TEMPFAIL);
    const calls = fs.readFileSync(notifyLog, "utf8");
    expect(calls).toContain("OpenCode Dreams");
    expect(calls.toLowerCase()).toContain("adiad");
  });

  test("falha fatal (1) em etapa local ⇒ wrapper propaga 1 e alerta de FALHA", () => {
    const { home, notifyLog } = setupWrapper("fatal", { light: 0, rem: 0, deep: 1 });
    expect(runWrapper(home, notifyLog)).toBe(EXIT_FATAL);
    expect(EXIT_FATAL).toBe(1);
    expect(fs.readFileSync(notifyLog, "utf8")).toContain("FALHA");
  });

  test("PRIORIDADE: fatal (1) prevalece sobre adiado (75)", () => {
    const { home, notifyLog } = setupWrapper("priority", { light: 1, rem: 75, deep: 0 });
    expect(runWrapper(home, notifyLog)).toBe(EXIT_FATAL);
  });
});
