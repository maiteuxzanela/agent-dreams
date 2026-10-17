/**
 * TICKET-DREAMS-09 — Suíte determinística SDET (Hugo).
 *
 * Cobre as duas frentes consolidadas:
 *   Card A — src/core/sleep_cycle.ts   : projeções atômicas POSIX (write-temp+rename)
 *            src/core/prompt_injector.ts: cache em memória de agente por sessão.
 *   Card B — src/cli.ts                : `forget` reativo em disco + `list` paginado.
 *            README.md                  : fórmula real de produção.
 *
 * Regras: SEM MOCKS. Dependências REAIS:
 *   - SQLite real via bun:sqlite (memórias e banco de sessões) em diretórios /tmp;
 *   - arquivos .md reais em disco;
 *   - CLI via subprocesso real (`bun src/cli.ts ...`) com HOME isolado;
 *   - leitura concorrente real via processo filho separado (fixture dedicada);
 *   - controle de tempo real via `setSystemTime` (bun:test) para o TTL do cache.
 */
import { test, expect, describe, afterEach, beforeEach, setSystemTime } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import { DreamsDB } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";
import {
  resolveSessionAgent,
  clearAgentSessionCache,
  AGENT_SESSION_CACHE_TTL_MS,
} from "../src/core/prompt_injector";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const READER_FIXTURE = path.join(import.meta.dir, "fixtures", "dreams_09_projection_reader.ts");

const COLLECTIVE_HEADER = "<!-- COLLECTIVE MEMORY INJECTION (DO NOT EDIT) -->";

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Raiz Dreams padrão derivada de um HOME isolado (mesma fórmula do CLI/DB). */
function dreamsDirFor(home: string): string {
  return path.join(home, ".config", "opencode", "dreams");
}
function dreamsDbPath(home: string): string {
  return path.join(dreamsDirFor(home), "dreams.db");
}

function runCli(args: string[], home: string) {
  return Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, DREAMS_OFFLINE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}
const out = (p: ReturnType<typeof Bun.spawnSync>): string => new TextDecoder().decode(p.stdout);
const err = (p: ReturnType<typeof Bun.spawnSync>): string => new TextDecoder().decode(p.stderr);
const memLines = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("#"));

function writeSessionDb(dbPath: string, id: string, agent: string, title = ""): void {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, title TEXT)");
  db.query("INSERT INTO session (id, agent, title) VALUES (?, ?, ?)").run(id, agent, title);
  db.close();
}
function writeEmptySessionDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, title TEXT)");
  db.close();
}
function insertSessionRow(dbPath: string, id: string, agent: string, title = ""): void {
  const db = new Database(dbPath);
  db.query("INSERT INTO session (id, agent, title) VALUES (?, ?, ?)").run(id, agent, title);
  db.close();
}

beforeEach(() => {
  clearAgentSessionCache();
});

afterEach(() => {
  setSystemTime(); // restaura o relógio real (TTL)
  clearAgentSessionCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ===========================================================================
// FRENTE B (cli.ts) — `forget` reativo em disco (mata a memória zumbi)
// ===========================================================================
describe("[DREAMS-09-B] forget <id> — reatividade imediata em disco (subprocesso real)", () => {
  test("reescreve a projeção no MESMO processo: zumbi removido, legítima preservada, persona órfã expurgada", () => {
    const home = mkTmp("dreams_09_forget_");
    const dreamsDir = dreamsDirFor(home);
    const collectiveFile = path.join(dreamsDir, "collective", "COLLECTIVE_MEMORY.md");
    const personasDir = path.join(dreamsDir, "personas");

    // 1. Semente REAL no SQLite: um zumbi, uma legítima coletiva e uma persona viva.
    fs.mkdirSync(dreamsDir, { recursive: true });
    const db = new DreamsDB(dreamsDbPath(home));
    const idZombie = db.insertMemory(
      "collective",
      "MEMORIA-ZUMBI que deve sumir imediatamente do markdown",
      "learning",
      3.0
    );
    const idLegit = db.insertMemory(
      "collective",
      "Fato coletivo legitimo que deve permanecer projetado",
      "decision",
      4.0
    );
    db.insertMemory("agent:hugo", "Hugo escreve testes deterministicos reais", "learning", 2.0);
    db.close();

    // 2. Projeção STALE em disco (como o Deep Sleep a deixou há horas): contém o
    //    zumbi + uma persona órfã (ghost = 0 memórias ativas no SQLite).
    fs.mkdirSync(path.join(dreamsDir, "collective"), { recursive: true });
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(
      collectiveFile,
      [
        COLLECTIVE_HEADER,
        "- [LEARNING] MEMORIA-ZUMBI que deve sumir imediatamente do markdown",
        "- [DECISION] Fato coletivo legitimo que deve permanecer projetado",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(personasDir, "hugo.md"),
      "<!-- INDIVIDUAL MEMORY FOR HUGO -->\n- [LEARNING] Hugo escreve testes deterministicos reais\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(personasDir, "ghost.md"),
      "<!-- INDIVIDUAL MEMORY FOR GHOST -->\n- [LEARNING] persona orfa sem memoria ativa\n",
      "utf8"
    );

    // Pré-condição: os arquivos stale existem e o zumbi está em disco.
    expect(fs.readFileSync(collectiveFile, "utf8")).toContain("MEMORIA-ZUMBI");
    expect(fs.existsSync(path.join(personasDir, "ghost.md"))).toBe(true);

    // 3. Executa o CLI REAL e observa o disco no mesmo instante — sem deepSleep.
    const proc = runCli(["forget", String(idZombie)], home);
    expect(proc.exitCode).toBe(0);
    expect(out(proc)).toContain(`Memory #${idZombie} forgotten`);

    const after = fs.readFileSync(collectiveFile, "utf8");
    expect(after).toContain(COLLECTIVE_HEADER);
    expect(after).not.toContain("MEMORIA-ZUMBI");
    expect(after).toContain("Fato coletivo legitimo que deve permanecer projetado");

    // persona órfã expurgada; persona viva regravada com o fato corrente.
    expect(fs.existsSync(path.join(personasDir, "ghost.md"))).toBe(false);
    expect(fs.existsSync(path.join(personasDir, "hugo.md"))).toBe(true);
    expect(fs.readFileSync(path.join(personasDir, "hugo.md"), "utf8")).toContain(
      "Hugo escreve testes deterministicos reais"
    );

    // 4. Verificação independente: a linha sumiu do SQLite.
    const db2 = new DreamsDB(dreamsDbPath(home));
    const ids = db2.getAllMemories().map((m) => m.id);
    db2.close();
    expect(ids).not.toContain(idZombie);
    expect(ids).toContain(idLegit);
  });

  test("forget <id inexistente> NÃO regrava a projeção e retorna exit 1", () => {
    const home = mkTmp("dreams_09_forget_miss_");
    const dreamsDir = dreamsDirFor(home);
    fs.mkdirSync(dreamsDir, { recursive: true });
    const db = new DreamsDB(dreamsDbPath(home));
    db.insertMemory("collective", "Fato qualquer", "learning", 1.0);
    db.close();

    const collectiveFile = path.join(dreamsDir, "collective", "COLLECTIVE_MEMORY.md");
    const sentinel = "SENTINELA-NAO-DEVE-SER-REESCRITA";
    fs.mkdirSync(path.dirname(collectiveFile), { recursive: true });
    fs.writeFileSync(collectiveFile, sentinel, "utf8");

    const proc = runCli(["forget", "999999"], home);
    expect(proc.exitCode).toBe(1);
    expect(err(proc)).toContain("No memory found with id 999999");
    // Caminho de erro não toca na projeção (sentinela intacta).
    expect(fs.readFileSync(collectiveFile, "utf8")).toBe(sentinel);
  });
});

// ===========================================================================
// FRENTE B (cli.ts) — `list` paginado/filtrado no SQLite
// ===========================================================================
describe("[DREAMS-09-B] list — paginação e filtro no SQLite (subprocesso real)", () => {
  function seedScored(home: string): void {
    fs.mkdirSync(dreamsDirFor(home), { recursive: true });
    const db = new DreamsDB(dreamsDbPath(home));
    for (let i = 1; i <= 25; i++) {
      db.insertMemory("collective", `Fato coletivo numero ${i}`, "learning", i);
    }
    for (let i = 1; i <= 5; i++) {
      db.insertMemory("agent:hugo", `Fato da persona hugo numero ${i}`, "pitfall", 100 + i);
    }
    db.close();
  }

  test("default limita a 20 (paginação no SQLite, não slice em JS)", () => {
    const home = mkTmp("dreams_09_list_default_");
    seedScored(home);
    const proc = runCli(["list"], home);
    expect(proc.exitCode).toBe(0);
    expect(memLines(out(proc)).length).toBe(20);
  });

  test("--limit=3 retorna exatamente 3, os de maior score primeiro", () => {
    const home = mkTmp("dreams_09_list_limit_");
    seedScored(home);
    const proc = runCli(["list", "--limit=3"], home);
    expect(proc.exitCode).toBe(0);
    const lines = memLines(out(proc));
    expect(lines.length).toBe(3);
    // Maiores scores são as personas (100+i): 105, 104, 103 primeiro.
    expect(lines[0]).toContain("[agent:hugo]");
    expect(lines[0]).toContain("score 105.00");
    expect(lines[1]).toContain("score 104.00");
    expect(lines[2]).toContain("score 103.00");
  });

  test("--scope filtra E pagina (interseção correta, ordem por score)", () => {
    const home = mkTmp("dreams_09_list_scope_");
    seedScored(home);
    const proc = runCli(["list", "--scope", "agent:hugo", "--limit=2"], home);
    expect(proc.exitCode).toBe(0);
    const lines = memLines(out(proc));
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toContain("[agent:hugo]");
    expect(lines[0]).toContain("score 105.00");
    expect(lines[1]).toContain("score 104.00");
  });

  test("--scope coletivo com --limit=5 respeita os 5 maiores do escopo coletivo", () => {
    const home = mkTmp("dreams_09_list_scope2_");
    seedScored(home);
    const proc = runCli(["list", "--scope", "collective", "--limit=5"], home);
    expect(proc.exitCode).toBe(0);
    const lines = memLines(out(proc));
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain("Fato coletivo numero 25");
    expect(lines[4]).toContain("Fato coletivo numero 21");
  });

  test("escopo sem memórias → 'No memories found.'", () => {
    const home = mkTmp("dreams_09_list_empty_");
    seedScored(home);
    const proc = runCli(["list", "--scope", "agent:inexistente"], home);
    expect(proc.exitCode).toBe(0);
    expect(out(proc)).toContain("No memories found.");
    expect(memLines(out(proc)).length).toBe(0);
  });
});

// DreamsDB.listMemories — contrato unitário de paginação/filtro/ordenação
describe("[DREAMS-09-B] DreamsDB.listMemories — contrato SQL nativo", () => {
  test("limit aplica no SQLite; ordem score DESC, last_reinforced DESC", () => {
    const base = mkTmp("dreams_09_listmem_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "score baixo", "learning", 1.0);
    db.insertMemory("collective", "score alto", "learning", 9.0);
    db.insertMemory("collective", "score medio", "learning", 5.0);

    const all = db.listMemories({ scope: "collective" });
    expect(all.map((m) => m.score)).toEqual([9.0, 5.0, 1.0]);

    const top2 = db.listMemories({ scope: "collective", limit: 2 });
    expect(top2.length).toBe(2);
    expect(top2[0].score).toBe(9.0);
    expect(top2[1].score).toBe(5.0);

    // limit ausente/<=0 => sem LIMIT (todas as linhas elegíveis).
    expect(db.listMemories({ limit: 0 }).length).toBe(3);
    db.close();
  });

  test("filtros scope e category são parametrizados e combináveis", () => {
    const base = mkTmp("dreams_09_listmem2_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "coletiva pitfall", "pitfall", 4.0);
    db.insertMemory("collective", "coletiva decision", "decision", 3.0);
    db.insertMemory("agent:hugo", "hugo pitfall", "pitfall", 5.0);

    expect(db.listMemories({ scope: "agent:hugo" }).length).toBe(1);
    expect(db.listMemories({ category: "pitfall" }).length).toBe(2);
    const combo = db.listMemories({ scope: "collective", category: "pitfall" });
    expect(combo.length).toBe(1);
    expect(combo[0].fact).toBe("coletiva pitfall");
    db.close();
  });
});

// Guarda estática: o CLI realmente usa a API paginada e o forget reativo.
describe("[DREAMS-09-B] guarda estática de src/cli.ts", () => {
  const src = fs.readFileSync(CLI_PATH, "utf8");

  test("branch `list` usa db.listMemories (não materializa a tabela em JS)", () => {
    const start = src.indexOf('cmd === "list"');
    const end = src.indexOf("} else {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = src.slice(start, end);
    expect(branch).toContain("db.listMemories({ scope, limit })");
    expect(branch).not.toContain("getAllMemories");
    expect(branch).not.toContain(".sort(");
  });

  test("branch `forget` regenera as projeções (updateProjections) após o delete", () => {
    const start = src.indexOf('cmd === "forget"');
    const end = src.indexOf('cmd === "list"', start);
    const branch = src.slice(start, end);
    expect(branch).toContain("db.deleteMemory(id)");
    expect(branch).toContain("new SleepCycle(db).updateProjections()");
    // O updateProjections vem DEPOIS do delete (reatividade pós-remoção).
    expect(branch.indexOf("updateProjections")).toBeGreaterThan(branch.indexOf("deleteMemory"));
  });
});

// ===========================================================================
// FRENTE A — escrita ATÔMICA POSIX das projeções
// ===========================================================================
describe("[DREAMS-09-A] updateProjections — escrita atômica write-temp+rename", () => {
  test("grava collective + personas com conteúdo do DB e sem temporários residuais", () => {
    const base = mkTmp("dreams_09_atomic_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "Fato para projecao atomica coletiva", "learning", 2.0);
    db.insertMemory("agent:hugo", "Fato da persona hugo na projecao", "pitfall", 1.5);
    const sc = new SleepCycle(db, { baseDir: base, captureDialogue: false });
    sc.updateProjections();

    const cfile = path.join(base, "collective", "COLLECTIVE_MEMORY.md");
    const pfile = path.join(base, "personas", "hugo.md");
    expect(fs.existsSync(cfile)).toBe(true);
    expect(fs.existsSync(pfile)).toBe(true);
    expect(fs.readFileSync(cfile, "utf8")).toContain("Fato para projecao atomica coletiva");
    expect(fs.readFileSync(pfile, "utf8")).toContain("Fato da persona hugo na projecao");

    const leftovers = [
      ...fs.readdirSync(path.join(base, "collective")),
      ...fs.readdirSync(path.join(base, "personas")),
    ].filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
    db.close();
  });

  test("rename(2) substitui o alvo (inode muda) — prova de NÃO ser truncate in-place", () => {
    const base = mkTmp("dreams_09_inode_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "Fato inicial", "learning", 1.0);
    const sc = new SleepCycle(db, { baseDir: base, captureDialogue: false });
    sc.updateProjections();

    const cfile = path.join(base, "collective", "COLLECTIVE_MEMORY.md");
    const ino1 = fs.statSync(cfile).ino;

    // Segura o inode antigo aberto: impede que o kernel o recicle para o novo
    // temp, tornando a comparação de inodes 100% determinística.
    const pinned = fs.openSync(cfile, "r");
    sc.updateProjections();
    const ino2 = fs.statSync(cfile).ino;
    fs.closeSync(pinned);

    // rename(2) move o inode do temporário para o nome de destino → inode troca.
    expect(ino2).not.toBe(ino1);

    // CONTROLE DE SENSIBILIDADE: escrita não-atômica (truncate in-place)
    // PRESERVA o inode — prova que o assert de inode discrimina os dois modos.
    const ctrl = path.join(base, "control.txt");
    fs.writeFileSync(ctrl, "AAAA");
    const ctrlIno1 = fs.statSync(ctrl).ino;
    fs.writeFileSync(ctrl, "BBBBBBBB");
    expect(fs.statSync(ctrl).ino).toBe(ctrlIno1);
    db.close();
  });

  test("leitura concorrente REAL (processo filho) nunca observa size 0 nem conteúdo rasgado", async () => {
    const base = mkTmp("dreams_09_concurrent_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    const factA = "Fato versao ALFA: " + Array(160).fill("alfa").join(" ");
    const factB = "Fato versao BRAVO: " + Array(160).fill("bravo").join(" ");

    let id = db.insertMemory("collective", factA, "learning", 2.0);
    const sc = new SleepCycle(db, { baseDir: base, captureDialogue: false });
    sc.updateProjections();
    const cfile = path.join(base, "collective", "COLLECTIVE_MEMORY.md");
    const bytesA = fs.readFileSync(cfile);

    db.deleteMemory(id);
    id = db.insertMemory("collective", factB, "learning", 2.0);
    sc.updateProjections();
    const bytesB = fs.readFileSync(cfile);

    expect(bytesA.equals(bytesB)).toBe(false); // estados A/B realmente distintos
    const sha = (b: Buffer): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");

    // Reader REAL em processo separado, lendo em loop por 2,5 s.
    const child = Bun.spawn([process.execPath, READER_FIXTURE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROJ_FILE: cfile,
        PROJ_DURATION_MS: "2500",
        PROJ_HASH_A: sha(bytesA),
        PROJ_HASH_B: sha(bytesB),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Escritor REAL alternando A/B por 1,5 s (renames concorrentes com o reader).
    const deadline = Date.now() + 1500;
    let toggle = false;
    while (Date.now() < deadline) {
      toggle = !toggle;
      db.deleteMemory(id);
      id = db.insertMemory("collective", toggle ? factA : factB, "learning", 2.0);
      sc.updateProjections();
    }

    const exit = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exit).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith("PROJ_READER_RESULT:"));
    expect(line, `reader sem resultado. stderr=${stderr}`).toBeDefined();
    const r = JSON.parse(line!.slice("PROJ_READER_RESULT:".length)) as {
      reads: number;
      empty: number;
      torn: number;
      samples: string[];
    };

    expect(r.reads).toBeGreaterThan(0);
    expect(r.empty).toBe(0);
    expect(r.torn, `leituras rasgadas: ${JSON.stringify(r.samples)}`).toBe(0);
    db.close();
  }, 20000);
});

// ===========================================================================
// FRENTE A/B — cache em memória de agente por sessão (prompt_injector)
// ===========================================================================
describe("[DREAMS-09-A] cache de sessão em prompt_injector (SQLite real, sem reabrir o banco)", () => {
  test("constante de TTL pública = 60000 ms", () => {
    expect(AGENT_SESSION_CACHE_TTL_MS).toBe(60000);
  });

  test("2ª chamada resolve do cache: trocar o dbPath NÃO muda o resultado até clear", async () => {
    const base = mkTmp("dreams_09_cache_");
    const db1 = path.join(base, "agent1.db");
    const db2 = path.join(base, "agent2.db");
    writeSessionDb(db1, "ses_cache_x", "hugo");
    writeSessionDb(db2, "ses_cache_x", "clara");

    // 1ª leitura: SQLite real (db1) → hugo, memorizado.
    expect(await resolveSessionAgent("ses_cache_x", null, db1)).toBe("hugo");
    // 2ª leitura aponta para OUTRO banco (agente diferente): se tocasse o SQLite
    // devolveria 'clara'; devolve 'hugo' ⇒ veio do cache, sem I/O.
    expect(await resolveSessionAgent("ses_cache_x", null, db2)).toBe("hugo");
    // clearAgentSessionCache() força releitura → agora vê o db2.
    clearAgentSessionCache();
    expect(await resolveSessionAgent("ses_cache_x", null, db2)).toBe("clara");
  });

  test("após cachear, apagar o arquivo SQLite não afeta a resolução (prova de não-leitura)", async () => {
    const base = mkTmp("dreams_09_cache_del_");
    const dbp = path.join(base, "sessions.db");
    writeSessionDb(dbp, "ses_del", "hugo");

    expect(await resolveSessionAgent("ses_del", null, dbp)).toBe("hugo");
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbp + suffix, { force: true });

    // Cache ainda serve o valor memorizado, mesmo com o arquivo destruído.
    expect(await resolveSessionAgent("ses_del", null, dbp)).toBe("hugo");
    clearAgentSessionCache();
    expect(await resolveSessionAgent("ses_del", null, dbp)).toBeNull();
  });

  test("cache NEGATIVO: sessão ausente memoriza null e não martela o banco", async () => {
    const base = mkTmp("dreams_09_cache_neg_");
    const dbp = path.join(base, "sessions.db");
    writeEmptySessionDb(dbp);

    expect(await resolveSessionAgent("ses_neg", null, dbp)).toBeNull();
    // A linha aparece depois; sem clear, o null cacheado continua valendo.
    insertSessionRow(dbp, "ses_neg", "maya");
    expect(await resolveSessionAgent("ses_neg", null, dbp)).toBeNull();
    clearAgentSessionCache();
    expect(await resolveSessionAgent("ses_neg", null, dbp)).toBe("maya");
  });

  test("TTL expira a entrada (lazy eviction) e força releitura do SQLite", async () => {
    const base = mkTmp("dreams_09_cache_ttl_");
    const db1 = path.join(base, "a.db");
    const db2 = path.join(base, "b.db");
    writeSessionDb(db1, "ses_ttl", "hugo");
    writeSessionDb(db2, "ses_ttl", "clara");

    expect(await resolveSessionAgent("ses_ttl", null, db1)).toBe("hugo");

    // Avança o relógio REAL além do TTL: a entrada fica vencida.
    setSystemTime(Date.now() + AGENT_SESSION_CACHE_TTL_MS + 1000);

    // Entrada expirada ⇒ lazily removida ⇒ relê o SQLite (db2) ⇒ 'clara'.
    expect(await resolveSessionAgent("ses_ttl", null, db2)).toBe("clara");
  });

  test("título do Ensemble tem precedência e também é cacheado (sem reabrir o banco)", async () => {
    const base = mkTmp("dreams_09_cache_title_");
    const db1 = path.join(base, "t1.db");
    const db2 = path.join(base, "t2.db");
    writeSessionDb(db1, "ses_t", "dante", "clara (@clara teammate)");
    writeSessionDb(db2, "ses_t", "dante", "Chat normal");

    expect(await resolveSessionAgent("ses_t", null, db1)).toBe("clara");
    // Sem clear: continua 'clara' mesmo apontando para o db2 (sem title assinado).
    expect(await resolveSessionAgent("ses_t", null, db2)).toBe("clara");
    clearAgentSessionCache();
    expect(await resolveSessionAgent("ses_t", null, db2)).toBe("dante");
  });
});

// ===========================================================================
// FRENTE B — README alinhado à fórmula real de produção
// ===========================================================================
describe("[DREAMS-09-B] README — fórmula real (amortecimento log-sublinear)", () => {
  test("documenta ln(1+recall) e o limiar de poda 0.50; não a fórmula linear antiga", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("ln(1+recall)");
    expect(readme).toContain("0.50");
    expect(readme).not.toContain("Base + RecallCount");
  });
});
