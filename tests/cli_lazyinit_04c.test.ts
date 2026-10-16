/**
 * TICKET-DREAMS-04 — Frente 4C
 * Suíte determinística (SDET / Hugo) para:
 *   - src/index.ts  → lazy init / singleton do DreamsDB (getDB/closeDB/isDBInitialized)
 *   - src/cli.ts    → parseListArgs/formatMemoryLine (puros) e comandos forget/list
 *
 * Regras: SEM mocks — SQLite real em HOME isolado (/tmp) e subprocessos reais.
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { parseListArgs, formatMemoryLine } from "../src/cli";
import { DreamsDB } from "../src/core/db";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const FIXTURE = path.join(import.meta.dir, "fixtures", "index_lazyinit_04c.ts");

const tempHomes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_04c_"));
  tempHomes.push(home);
  return home;
}

function dreamsDbPath(home: string): string {
  return path.join(home, ".config", "opencode", "dreams", "dreams.db");
}

function runCli(args: string[], home: string) {
  return Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const out = (proc: ReturnType<typeof Bun.spawnSync>): string => new TextDecoder().decode(proc.stdout);
const err = (proc: ReturnType<typeof Bun.spawnSync>): string => new TextDecoder().decode(proc.stderr);
const memLines = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("#"));

afterEach(() => {
  while (tempHomes.length > 0) {
    fs.rmSync(tempHomes.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// parseListArgs — parser puro
// ---------------------------------------------------------------------------
describe("[4C] cli.ts parseListArgs (puro)", () => {
  test("default limit 20 sem flags", () => {
    expect(parseListArgs([])).toEqual({ limit: 20 });
  });

  test("--scope aceita as formas separada e com '='", () => {
    expect(parseListArgs(["--scope", "agent:hugo"])).toEqual({ scope: "agent:hugo", limit: 20 });
    expect(parseListArgs(["--scope=collective"])).toEqual({ scope: "collective", limit: 20 });
  });

  test("--limit aceita as formas separada e com '='", () => {
    expect(parseListArgs(["--limit", "5"])).toEqual({ limit: 5 });
    expect(parseListArgs(["--limit=7"])).toEqual({ limit: 7 });
  });

  test("valores inválidos de --limit são ignorados (default 20)", () => {
    expect(parseListArgs(["--limit", "abc"])).toEqual({ limit: 20 });
    expect(parseListArgs(["--limit", "0"])).toEqual({ limit: 20 });
    expect(parseListArgs(["--limit", "-3"])).toEqual({ limit: 20 });
    expect(parseListArgs(["--limit", "2.5"])).toEqual({ limit: 20 });
    expect(parseListArgs(["--limit="])).toEqual({ limit: 20 });
  });

  test("valor ausente ou iniciado por '--' não vira scope", () => {
    expect(parseListArgs(["--scope"])).toEqual({ limit: 20 });
    expect(parseListArgs(["--scope", "--limit", "9"])).toEqual({ limit: 9 });
    expect(parseListArgs(["--scope="])).toEqual({ limit: 20 });
  });

  test("combinação de flags na mesma invocação", () => {
    expect(parseListArgs(["--scope", "agent:x", "--limit=3"])).toEqual({ scope: "agent:x", limit: 3 });
  });
});

// ---------------------------------------------------------------------------
// formatMemoryLine — formatação pura
// ---------------------------------------------------------------------------
describe("[4C] cli.ts formatMemoryLine (puro)", () => {
  test("formata id, escopo, categoria, score (2 casas) e fato", () => {
    const line = formatMemoryLine({
      id: 7,
      scope: "collective",
      category: "learning",
      score: 2.5,
      fact: "Fato formatado",
    } as any);
    expect(line).toBe("#7 [collective] learning (score 2.50) Fato formatado");
  });

  test("defaults determinísticos para id/score ausentes", () => {
    const line = formatMemoryLine({ scope: "agent:hugo", category: "pitfall", fact: "" } as any);
    expect(line).toBe("#0 [agent:hugo] pitfall (score 0.00) ");
  });
});

// ---------------------------------------------------------------------------
// Lazy init / singleton — subprocesso real com HOME isolado
// ---------------------------------------------------------------------------
describe("[4C] src/index.ts lazy init / singleton (HOME isolado)", () => {
  test("import não abre; 1º acesso abre; dispose fecha/zero; reabre transparente; closeDB idempotente", () => {
    const home = makeHome();
    const proc = Bun.spawnSync([process.execPath, FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = out(proc);
    const line = stdout.split("\n").find((l) => l.startsWith("LAZY_RESULT:"));
    expect(line).toBeDefined();
    expect(proc.exitCode).toBe(0);

    const r = JSON.parse(line!.slice("LAZY_RESULT:".length));
    expect(r.initializedAfterImport).toBe(false); // lazy: nada aberto na importação
    expect(r.dbFileExistsAfterImport).toBe(false); // nem arquivo criado
    expect(r.initializedAfterFirstAccess).toBe(true);
    expect(r.dbFileExistsAfterFirstAccess).toBe(true);
    expect(r.initializedAfterClose).toBe(false); // dispose zera o singleton
    expect(r.reopenedTransparently).toBe(true); // reabre no mesmo processo
    expect(r.factReadableAfterReopen).toBe(true); // dados persistidos legíveis
    expect(r.initializedAfterSecondClose).toBe(false); // idempotente
  });
});

// ---------------------------------------------------------------------------
// Comandos CLI forget/list — subprocesso real com DB seedado em HOME isolado
// ---------------------------------------------------------------------------
describe("[4C] cli.ts forget/list (HOME isolado, SQLite real)", () => {
  function seed(home: string): { idLow: number; idHigh: number; idMid: number } {
    const dbPath = dreamsDbPath(home);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DreamsDB(dbPath);
    const idLow = db.insertMemory("collective", "Fato coletivo de pontuacao baixa", "learning", 1.0);
    const idHigh = db.insertMemory("collective", "Decisao coletiva de pontuacao alta", "decision", 4.0);
    const idMid = db.insertMemory("agent:hugo", "Preferencia pessoal de pontuacao media", "preference", 2.5);
    db.close();
    return { idLow, idHigh, idMid };
  }

  test("forget <id inválido> retorna exitCode 1", () => {
    const home = makeHome();
    const proc = runCli(["forget", "abc"], home);
    expect(proc.exitCode).toBe(1);
    expect(err(proc)).toContain("Invalid memory id");
  });

  test("forget <id inexistente> retorna exitCode 1", () => {
    const home = makeHome();
    seed(home);
    const proc = runCli(["forget", "999999"], home);
    expect(proc.exitCode).toBe(1);
    expect(err(proc)).toContain("No memory found with id 999999");
  });

  test("forget <id existente> remove a memória e retorna exitCode 0", () => {
    const home = makeHome();
    const { idLow } = seed(home);
    const proc = runCli(["forget", String(idLow)], home);
    expect(proc.exitCode).toBe(0);
    expect(out(proc)).toContain(`Memory #${idLow} forgotten`);

    // Verificação independente reabrindo o banco após o subprocesso encerrar.
    const db = new DreamsDB(dreamsDbPath(home));
    const ids = db.getAllMemories().map((m) => m.id);
    db.close();
    expect(ids).not.toContain(idLow);
    expect(ids.length).toBe(2);
  });

  test("list default ordena por score desc e respeita limit 20", () => {
    const home = makeHome();
    const { idHigh } = seed(home);
    const proc = runCli(["list"], home);
    expect(proc.exitCode).toBe(0);
    const lines = memLines(out(proc));
    expect(lines.length).toBe(3);
    expect(lines[0].startsWith(`#${idHigh}`)).toBe(true); // maior score primeiro
  });

  test("list --limit=2 retorna exatamente 2 linhas", () => {
    const home = makeHome();
    seed(home);
    const proc = runCli(["list", "--limit=2"], home);
    expect(proc.exitCode).toBe(0);
    expect(memLines(out(proc)).length).toBe(2);
  });

  test("list --scope filtra pelo escopo informado", () => {
    const home = makeHome();
    const { idMid } = seed(home);
    const proc = runCli(["list", "--scope", "agent:hugo"], home);
    expect(proc.exitCode).toBe(0);
    const lines = memLines(out(proc));
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith(`#${idMid}`)).toBe(true);
    expect(lines[0]).toContain("[agent:hugo]");
  });
});
