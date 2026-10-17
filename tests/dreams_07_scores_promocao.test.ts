/**
 * TICKET-DREAMS-07 — SDET (Hugo)
 * Suíte determinística dedicada para a frentes A/B do ticket:
 *   7A — Anti-duplo reforço dual-write (`synced_to_db`) e preservação dos
 *        pesos de CATEGORY_WEIGHTS no Light Sleep (src/tools.ts, sleep_cycle.ts).
 *   7B — Reforço na promoção Persona➔Coletivo e isolamento de path no
 *        singleton getDB (src/core/db.ts, src/index.ts).
 *
 * Regras: SEM mocks — SQLite real (bun:sqlite) em diretórios temporários
 * isolados; getDB validado via subprocesso real com paths explícitos.
 * Nenhum acesso a ~/.config/opencode/dreams (DB de produção).
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DreamsDB, CATEGORY_WEIGHTS } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";
import { dream_learn } from "../src/tools";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GETDB_FIXTURE = path.join(import.meta.dir, "fixtures", "dreams_07_getdb_path.ts");

// ---------------------------------------------------------------------------
// Harness: base dir + SQLite reais e isolados por teste (limpeza WAL-safe).
// ---------------------------------------------------------------------------
interface Env {
  baseDir: string;
  dailyDir: string;
  db: DreamsDB;
}
const open: Env[] = [];

function makeEnv(): Env {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_07_"));
  const dailyDir = path.join(baseDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const db = new DreamsDB(path.join(baseDir, "dreams.db"));
  const env: Env = { baseDir, dailyDir, db };
  open.push(env);
  return env;
}

/** SleepCycle isolado: captura de diálogo desligada (nenhum opencode.db real). */
function makeCycle(env: Env): SleepCycle {
  return new SleepCycle(env.db, { baseDir: env.baseDir, captureDialogue: false });
}

/** DB real e isolado (apenas a instância) — para testes puros de db.ts. */
const openDbs: Array<{ db: DreamsDB; dir: string }> = [];
function makeDb(): { db: DreamsDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_07_db_"));
  const db = new DreamsDB(path.join(dir, "dreams.db"));
  openDbs.push({ db, dir });
  return { db, dir };
}

function rawRun(db: DreamsDB, sql: string, params: any[] = []): void {
  (db as any).db.run(sql, params);
}
function oneRow<T>(db: DreamsDB, sql: string, params: any[] = []): T {
  return (db as any).db.query(sql).get(...params) as T;
}

/** Lê e parseia TODAS as linhas JSONL presentes no diretório diário. */
function readDailyRecords(dailyDir: string): any[] {
  return fs
    .readdirSync(dailyDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dailyDir, f), "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l))
    );
}

const OLD = "2000-01-01T00:00:00.000Z";

afterEach(() => {
  while (openDbs.length > 0) {
    const { db, dir } = openDbs.pop()!;
    try {
      db.close();
    } catch {
      /* idempotente */
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  while (open.length > 0) {
    const { db, baseDir } = open.pop()!;
    try {
      db.close(); // fecha antes do rm: evita ENOTEMPTY do WAL (-wal/-shm)
    } catch {
      /* idempotente */
    }
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ===========================================================================
// 7A — Anti-duplo reforço dual-write (`synced_to_db`) + pesos de categoria
// ===========================================================================
describe("[7A] anti-duplo reforço: dual-write marca synced_to_db e o Light Sleep não reconfirma", () => {
  test("dream_learn com db grava synced_to_db=true e o fato nasce no SQLite com 1 confirmação", () => {
    const env = makeEnv();
    const fact = "Armadilha do dual-write sincrono no mesmo turno";
    dream_learn({ scope: "collective", fact, category: "pitfall" }, { dailyDir: env.dailyDir, db: env.db });

    const records = readDailyRecords(env.dailyDir);
    expect(records.length).toBe(1);
    expect(records[0].fact).toBe(fact);
    expect(records[0].category).toBe("pitfall");
    expect(records[0].synced_to_db).toBe(true); // sinal de dual-write OK

    const mem = env.db.getAllMemories().find((m) => m.fact === fact);
    expect(mem).toBeDefined();
    expect(mem!.confirmations).toBe(1);
    expect(mem!.score).toBe(CATEGORY_WEIGHTS.pitfall.base_weight); // 1.8
  });

  test("Light Sleep NÃO reconfirma fato já sincronizado: confirmations=1 e score original preservados", async () => {
    const env = makeEnv();
    const cycle = makeCycle(env);
    const fact = "Decisao deterministica do dual-write sem reforco duplo";
    dream_learn({ scope: "collective", fact, category: "decision" }, { dailyDir: env.dailyDir, db: env.db });

    const before = env.db.getAllMemories().find((m) => m.fact === fact)!;
    expect(before.confirmations).toBe(1);
    expect(before.score).toBe(2.0);

    await cycle.lightSleep(); // madrugada da 1ª noite

    const after = env.db.getAllMemories().find((m) => m.fact === fact)!;
    expect(after.confirmations).toBe(1); // anti-duplo: sem 2ª confirmação
    expect(after.score).toBe(2.0); // score original intacto
    expect(env.db.getAllMemories().length).toBe(1); // nenhum clone
    expect(fs.existsSync(path.join(env.dailyDir, `log_${new Date().toISOString().split("T")[0]}.jsonl`))).toBe(false);
  });

  test("Light Sleep SEM db no dream_learn OMITE synced_to_db e persiste com peso da categoria", async () => {
    const env = makeEnv();
    const cycle = makeCycle(env);
    const fact = "Preferencia registrada apenas no JSONL sem espelho imediato";
    dream_learn({ scope: "collective", fact, category: "preference" }, { dailyDir: env.dailyDir }); // sem db

    const records = readDailyRecords(env.dailyDir);
    expect(records.length).toBe(1);
    expect("synced_to_db" in records[0]).toBe(false); // flag omitida

    await cycle.lightSleep();

    const mem = env.db.getAllMemories().find((m) => m.fact === fact)!;
    expect(mem.confirmations).toBe(1);
    expect(mem.score).toBe(2.5); // CATEGORY_WEIGHTS.preference.base_weight
    expect(mem.decay_weight).toBe(0.1);
  });

  test("dream_learn com db que LANÇA (conexão real fechada) omite synced_to_db e mantém o fato durável no JSONL", () => {
    const env = makeEnv();
    const dead = new DreamsDB(path.join(env.baseDir, "dead.db"));
    dead.close(); // conexão real encerrada → insertMemory lança "database is closed"
    const fact = "Fato que sobrevive mesmo com o espelho SQLite indisponivel";
    dream_learn({ scope: "agent:hugo", fact, category: "learning" }, { dailyDir: env.dailyDir, db: dead });

    const records = readDailyRecords(env.dailyDir);
    expect(records.length).toBe(1); // fail-soft: fato NÃO é perdido
    expect(records[0].fact).toBe(fact);
    expect("synced_to_db" in records[0]).toBe(false); // flag omitida no caminho de falha
  });

  test("GATE DIFERENCIAL: record com synced_to_db=true NÃO reforça duplicata pré-existente; sem a flag SÍ reforça", async () => {
    // Caso A — flag true: duplicata no banco permanece com 1 confirmação.
    const a = makeEnv();
    const cycleA = makeCycle(a);
    const factA = "Fato pre-existente protegido pela flag de sincronia";
    a.db.insertMemory("collective", factA, "pitfall"); // 1.8 / 1
    fs.writeFileSync(
      path.join(a.dailyDir, "log_flag_true.jsonl"),
      JSON.stringify({ scope: "collective", fact: factA, category: "pitfall", timestamp: OLD, synced_to_db: true }) + "\n"
    );
    await cycleA.lightSleep();
    const memA = a.db.getAllMemories().find((m) => m.fact === factA)!;
    expect(memA.confirmations).toBe(1);
    expect(memA.score).toBe(1.8);

    // Caso B — flag false (ausente): a duplicata É reconfirmada (+1 / +0.5).
    const b = makeEnv();
    const cycleB = makeCycle(b);
    const factB = "Fato pre-existente que a vigilia NAO sincronizou";
    b.db.insertMemory("collective", factB, "pitfall"); // 1.8 / 1
    fs.writeFileSync(
      path.join(b.dailyDir, "log_flag_false.jsonl"),
      JSON.stringify({ scope: "collective", fact: factB, category: "pitfall", timestamp: OLD, synced_to_db: false }) + "\n"
    );
    await cycleB.lightSleep();
    const memB = b.db.getAllMemories().find((m) => m.fact === factB)!;
    expect(memB.confirmations).toBe(2);
    expect(memB.score).toBe(2.3);
  });
});

describe("[7A] Light Sleep herda CATEGORY_WEIGHTS quando score/decay são undefined", () => {
  test("pesos canônicos calibráveis (preference 2.5/0.1, decision 2.0/0.3, pitfall 1.8/0.5, learning 1.0/1.0)", () => {
    expect(CATEGORY_WEIGHTS.preference).toEqual({ base_weight: 2.5, decay_weight: 0.1 });
    expect(CATEGORY_WEIGHTS.decision).toEqual({ base_weight: 2.0, decay_weight: 0.3 });
    expect(CATEGORY_WEIGHTS.pitfall).toEqual({ base_weight: 1.8, decay_weight: 0.5 });
    expect(CATEGORY_WEIGHTS.learning).toEqual({ base_weight: 1.0, decay_weight: 1.0 });
  });

  test("fatos ingeridos do JSONL (sem score explícito) nascem com base_weight/decay_weight da categoria", async () => {
    const env = makeEnv();
    const cycle = makeCycle(env);
    const seeds: Array<[string, "learning" | "decision" | "pitfall" | "preference"]> = [
      ["Preferencia estavel sobre escrita limpa", "preference"],
      ["Decisao arquitetural usa transacao atomica", "decision"],
      ["Armadilha recorrente em caminhos relativos", "pitfall"],
      ["Aprendizado basico do ciclo noturno", "learning"],
    ];
    fs.writeFileSync(
      path.join(env.dailyDir, "log_weights.jsonl"),
      seeds
        .map(([fact, category]) => JSON.stringify({ scope: "collective", fact, category, timestamp: OLD }))
        .join("\n") + "\n"
    );

    await cycle.lightSleep();

    for (const [fact, category] of seeds) {
      const mem = env.db.getAllMemories().find((m) => m.fact === fact)!;
      expect(mem).toBeDefined();
      expect(mem.category).toBe(category);
      expect(mem.score).toBe(CATEGORY_WEIGHTS[category].base_weight);
      expect(mem.decay_weight).toBe(CATEGORY_WEIGHTS[category].decay_weight);
      expect(mem.confirmations).toBe(1);
    }
    expect(env.db.getAllMemories().length).toBe(seeds.length);
  });
});

// ===========================================================================
// 7B — Reforço na promoção Persona ➔ Coletivo
// ===========================================================================
describe("[7B] promoção Persona ➔ Coletivo reforça a memória promovida", () => {
  test("reinforce default: score +0.5 e confirmations +1, id/scope preservados e clones expurgados", () => {
    const { db } = makeDb();

    const xId = db.insertMemory("agent:x", "Laya RLCD usa inferencia local", "decision", 2.0, 0.3);
    const zId = db.insertMemory("agent:z", "inferencia local usa Laya RLCD", "decision", 1.0, 0.3);
    expect(xId).not.toBe(zId);
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, xId]);

    const cId = db.insertMemory("collective", "Usa Laya RLCD inferencia local!", "decision");

    expect(cId).toBe(xId); // a linha de maior score é promovida (id preservado)
    const all = db.getAllMemories();
    expect(all.length).toBe(1);
    expect(all[0].scope).toBe("collective");
    expect(all[0].id).toBe(xId);
    expect(all[0].confirmations).toBe(2); // 1 → reforço da promoção
    expect(all[0].score).toBe(2.5); // 2.0 + 0.5
    expect(all[0].last_reinforced).not.toBe(OLD);
    expect(new Date(all[0].last_reinforced).getTime()).toBeGreaterThan(new Date(OLD).getTime());

    expect(db.listMemories({ scope: "agent:x" }).length).toBe(0);
    expect(db.listMemories({ scope: "agent:z" }).length).toBe(0); // clone expurgado
    expect(db.listMemories({ scope: "collective" }).length).toBe(1);
  });

  test("reinforce:false: promoção preserva score/confirmações e last_reinforced (sem inflação)", () => {
    const { db } = makeDb();

    const xId = db.insertMemory("agent:x", "Mapa de plugins exige contrato estavel", "decision", 2.0, 0.3);
    db.insertMemory("agent:z", "Contrato estavel: mapa de plugins exige", "decision", 1.0, 0.3);
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, xId]);

    const cId = db.insertMemory("collective", "contrato estavel mapa plugins exige", "decision", undefined, undefined, {
      reinforce: false,
    });

    expect(cId).toBe(xId);
    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [xId]);
    expect(row.scope).toBe("collective");
    expect(row.confirmations).toBe(1); // intocado
    expect(row.score).toBe(2.0); // intocado
    expect(row.last_reinforced).toBe(OLD); // NÃO atualizado
    // Ainda assim promove e expurga o clone (dedup cross-scope continua valendo).
    expect(db.getAllMemories().length).toBe(1);
  });

  test("promoção respeita tetos de reforço (MAX_CONFIRMATIONS/MAX_SCORE) em memória saturada", () => {
    const { db } = makeDb();

    const xId = db.insertMemory("agent:x", "Fato saturado de reforco no escopo de persona", "learning", 5.0, 1.0);
    rawRun(db, "UPDATE memories SET confirmations = ? WHERE id = ?", [DreamsDB.MAX_CONFIRMATIONS, xId]);

    const cId = db.insertMemory("collective", "escopo de persona: fato saturado de reforco", "learning");
    expect(cId).toBe(xId);
    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [xId]);
    expect(row.confirmations).toBe(DreamsDB.MAX_CONFIRMATIONS); // teto
    expect(row.score).toBe(DreamsDB.MAX_SCORE); // teto
  });
});

// ===========================================================================
// 7B — Isolamento de path no singleton getDB (subprocesso real)
// ===========================================================================
describe("[7B] getDB isolamento de path (subprocesso real, sem mocks)", () => {
  test("pathA→pathB reabre instância nova e isolada; reuso por path; closeDB zera o singleton", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_07_getdb_"));
    const pathA = path.join(dir, "a", "dreams.db");
    const pathB = path.join(dir, "b", "dreams.db");
    try {
      const proc = Bun.spawnSync([process.execPath, GETDB_FIXTURE, pathA, pathB], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: dir }, // HOME isolado: nunca toca produção
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(proc.stdout);
      const line = stdout.split("\n").find((l) => l.startsWith("GETDB_RESULT:"));
      expect(line).toBeDefined();
      expect(proc.exitCode).toBe(0);

      const r = JSON.parse(line!.slice("GETDB_RESULT:".length));
      expect(r.initializedBefore).toBe(false); // lazy: nada aberto antes do 1º acesso
      expect(r.initializedWithA).toBe(true);
      expect(r.reusesA).toBe(true); // mesmo path → mesma instância
      expect(r.switchedToB).toBe(true); // path novo → NOVA instância
      expect(r.bEmpty).toBe(true); // B isolado: não enxerga os dados de A
      expect(r.fileAExists).toBe(true);
      expect(r.fileBExists).toBe(true);
      expect(r.reusesB).toBe(true);
      expect(r.reopenedA).toBe(true); // voltar a A reabre (a antiga foi fechada)
      expect(r.factAVisible).toBe(true); // dados persistidos em A continuam legíveis
      expect(r.initializedAfterClose).toBe(false); // closeDB zera o singleton

      // Verificação independente fora do subprocesso: os dois arquivos existem.
      expect(fs.existsSync(pathA)).toBe(true);
      expect(fs.existsSync(pathB)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
