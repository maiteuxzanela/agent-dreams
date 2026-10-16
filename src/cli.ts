import { Database } from "bun:sqlite";
import { DreamsDB, type MemoryRecord } from "./core/db";
import { SleepCycle } from "./core/sleep_cycle";
import fs from "fs";
import path from "path";
import os from "os";

// DEF-11: sem caminhos absolutos hardcoded — deriva do homedir do usuário.
const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

// ---------------------------------------------------------------------------
// TICKET-DREAMS-02 (Frente 2C / C5): códigos de saída semânticos, detecção de
// adiamento do REM Sleep e rotação de log.
// ---------------------------------------------------------------------------

/**
 * Códigos de saída semânticos (padrão sysexits.h).
 *
 *  - `EXIT_OK` (0): consolidação 100% íntegra, OU não havia diálogo a processar.
 *  - `EXIT_FATAL` (1): falha fatal inesperada (ex.: erro de banco/filesystem).
 *  - `EXIT_TEMPFAIL` (75): adiamento transitório — síntese REM não concluída por
 *    IA/cota/rede indisponível. O diálogo pendente é preservado; retry no próximo
 *    ciclo. O wrapper systemd enxerga o status não-zero e alerta a usuária.
 */
export const EXIT_OK = 0 as const;
export const EXIT_FATAL = 1 as const;
export const EXIT_TEMPFAIL = 75 as const;

/** Diretório base das Dreams (mesma raiz usada por `SleepCycle`). */
export function dreamsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "dreams");
}

/** Handoff Light → REM preservado quando a síntese é adiada. */
export function pendingDialoguePath(baseDir = dreamsDir()): string {
  return path.join(baseDir, "dialogue_pending.txt");
}

/** Relatório diário onde o status da síntese é registrado. */
export function dreamsMarkdownPath(baseDir = dreamsDir()): string {
  return path.join(baseDir, "DREAMS.md");
}

/** `true` se há diálogo pendente não consumido (síntese adiada). */
export function hasPendingDialogue(file = pendingDialoguePath()): boolean {
  try {
    return fs.readFileSync(file, "utf-8").trim() !== "";
  } catch {
    return false;
  }
}

/** Snapshot do estado de adiamento ANTES de rodar o ciclo (mtime do DREAMS.md). */
export interface DeferralSnapshot {
  /** mtime (ms) do DREAMS.md antes da execução; `-1` quando ausente. */
  dreamsMdMtimeMs: number;
}

export function snapshotDeferralState(baseDir = dreamsDir()): DeferralSnapshot {
  try {
    return { dreamsMdMtimeMs: fs.statSync(dreamsMarkdownPath(baseDir)).mtimeMs };
  } catch {
    return { dreamsMdMtimeMs: -1 };
  }
}

/** Veredito do ciclo: íntegro ou adiado (transitório). */
export type ConsolidationOutcome = "complete" | "deferred";

/**
 * Decide se o ciclo terminou ADIADO. Aceita, de forma defensiva, um resultado
 * estruturado opcional (caso `remSleep`/`runConsolidation` passem a devolvê-lo)
 * e, na ausência dele, infere pelo estado do disco:
 *
 *  1. `dialogue_pending.txt` ainda presente e não vazio ⇒ handoff preservado ⇒
 *     a síntese REM não limpou o pendente ⇒ adiada (caminho do wrapper);
 *  2. caso contrário, DREAMS.md reescrito APÓS o início desta execução com o
 *     marcador `**adiada**` ⇒ adiada (caminho de REM isolado lendo do opencode.db).
 *
 * Sem qualquer desses sinais, o ciclo é considerado 100% íntegro.
 */
export function evaluateConsolidationOutcome(
  snapshot: DeferralSnapshot,
  result: unknown = undefined,
  baseDir = dreamsDir()
): ConsolidationOutcome {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.deferred === true || r.synthesisDeferred === true || r.status === "deferred") {
      return "deferred";
    }
  }

  if (hasPendingDialogue(pendingDialoguePath(baseDir))) {
    return "deferred";
  }

  try {
    const mdPath = dreamsMarkdownPath(baseDir);
    const stat = fs.statSync(mdPath);
    if (stat.mtimeMs > snapshot.dreamsMdMtimeMs) {
      if (/\*\*adiada\*\*/.test(fs.readFileSync(mdPath, "utf-8"))) {
        return "deferred";
      }
    }
  } catch {
    // DREAMS.md ausente ⇒ nada a sintetizar ⇒ não é adiamento.
  }

  return "complete";
}

/** Log de estado consolidado do wrapper (também alvo da rotação). */
export const DEFAULT_LOG_PATH = path.join(
  os.homedir(),
  ".local",
  "state",
  "opencode-dreams.log"
);

/** Teto padrão do log antes da rotação: 5 MiB. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Rotação básica e segura de log: se `logFile` exceder `maxBytes`, move-o para
 * `<logFile>.1` (sobrescrevendo o anterior). Fail-soft: qualquer falha de I/O
 * retorna `false` e NUNCA lança, para jamais derrubar o ciclo de consolidação.
 */
export function rotateLogIfNeeded(
  logFile: string = DEFAULT_LOG_PATH,
  maxBytes: number = DEFAULT_LOG_MAX_BYTES
): boolean {
  try {
    if (maxBytes <= 0 || !fs.existsSync(logFile)) return false;
    if (fs.statSync(logFile).size <= maxBytes) return false;
    const rotated = `${logFile}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(logFile, rotated);
    return true;
  } catch (e) {
    console.error(`[rotate-log] Falha ao rotacionar ${logFile}:`, e);
    return false;
  }
}

/** Flags aceitas por `dreams list`. */
export interface ListArgs {
  scope?: string;
  limit: number;
}

/**
 * Parser determinístico das flags de `dreams list`:
 *   --scope <scope>  | --scope=<scope>
 *   --limit <n>      | --limit=<n>   (default 20; valores inválidos ignorados)
 *
 * Recebe os tokens APÓS o subcomando (`args.slice(1)`).
 */
export function parseListArgs(args: string[]): ListArgs {
  const result: ListArgs = { limit: 20 };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--scope") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        result.scope = value;
        i++;
      }
    } else if (token.startsWith("--scope=")) {
      const value = token.slice("--scope=".length);
      if (value !== "") result.scope = value;
    } else if (token === "--limit") {
      const value = args[i + 1];
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) {
        result.limit = n;
        i++;
      }
    } else if (token.startsWith("--limit=")) {
      const n = Number(token.slice("--limit=".length));
      if (Number.isInteger(n) && n > 0) result.limit = n;
    }
  }
  return result;
}

/** Formata uma memória em uma linha legível: id, escopo, categoria, score, fato. */
export function formatMemoryLine(m: MemoryRecord): string {
  const id = m.id ?? 0;
  const score = Number(m.score ?? 0);
  return `#${id} [${m.scope}] ${m.category} (score ${score.toFixed(2)}) ${m.fact}`;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // `consolidate` executa o ciclo completo; `light`/`rem`/`deep` permitem que o
  // wrapper bin/dreams-consolidate.sh rode as rotinas locais sempre e isole a
  // checagem de internet exclusivamente para a LLM remota do REM Sleep (DEF-07).
  if (cmd === "consolidate" || cmd === "light" || cmd === "rem" || cmd === "deep") {
    console.log(`Starting Dreams ${cmd}...`);
    const db = new DreamsDB();
    const cycle = new SleepCycle(db);

    // C5: apenas `rem` e `consolidate` sintetizam via IA e podem ser ADIADOS
    // (cota/rede/modelo indisponível). `light`/`deep` são 100% locais.
    const tracksDeferral = cmd === "rem" || cmd === "consolidate";
    const snapshot = tracksDeferral ? snapshotDeferralState() : null;

    try {
      // O resultado é capturado defensivamente: hoje `SleepCycle` devolve
      // `void`, mas se `remSleep`/`runConsolidation` passarem a expor um veredito
      // estruturado, `evaluateConsolidationOutcome` o consome.
      let result: unknown;
      if (cmd === "light") {
        await cycle.lightSleep();
      } else if (cmd === "rem") {
        result = await cycle.remSleep();
      } else if (cmd === "deep") {
        await cycle.deepSleep();
      } else {
        result = await cycle.runConsolidation();
      }

      if (snapshot && evaluateConsolidationOutcome(snapshot, result) === "deferred") {
        console.warn(
          "Consolidation deferred: a síntese REM não foi concluída " +
            "(IA/cota/rede indisponível). O diálogo pendente foi preservado para a próxima execução."
        );
        process.exitCode = EXIT_TEMPFAIL; // 75 — retry transitório
      } else {
        console.log("Consolidation complete.");
        process.exitCode = EXIT_OK;
      }
    } catch (e) {
      console.error("Error during consolidation:", e);
      // `process.exitCode` (não `process.exit`) para que o `finally` feche o DB.
      process.exitCode = EXIT_FATAL; // 1 — falha fatal
    } finally {
      db.close();
    }
  } else if (cmd === "rotate-log") {
    // C5: rotação invocável pelo wrapper ANTES de abrir o log para append.
    const target = args[1] || DEFAULT_LOG_PATH;
    const parsedMax = Number(args[2]);
    const maxBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_LOG_MAX_BYTES;
    const rotated = rotateLogIfNeeded(target, maxBytes);
    console.log(
      rotated ? `Rotated ${target} -> ${target}.1` : `No rotation needed for ${target}`
    );
  } else if (cmd === "backfill") {
    const limit = Number(args[1]) || 10;
    console.log(`Starting backfill (limit: ${limit})...`);
    
    // Open SQLite in readonly mode
    let sqliteDb: Database;
    try {
      sqliteDb = new Database(DB_PATH, { readonly: true });
    } catch (e) {
      console.error(`Error opening SQLite DB at ${DB_PATH}:`, e);
      process.exit(1);
    }
    
    // Ensure daily dir exists
    const dailyDir = path.join(os.homedir(), ".config/opencode/dreams/daily");
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().split("T")[0];
    const logFile = path.join(dailyDir, `log_${dateStr}.jsonl`);
    
    // Read last sessions and messages from SQLite and write to daily log
    try {
      // Read events from the event table (session.compacted, session.updated, message.updated)
      const events = sqliteDb.query<
        { id: string; aggregate_id: string; type: string; data: string; created: number },
        [string, number]
      >("SELECT id, aggregate_id, type, data, created FROM event WHERE type LIKE ? ORDER BY created DESC LIMIT ?")
        .all("%message.updated%", limit);
      
      let entries = 0;
      
      // Process events and write to daily log
      for (const ev of events) {
        let fact = "";
        let directory = "/opencode-chambers-harness";
        let scope = "collective";
        
        try {
          const data = JSON.parse(ev.data);
          
          // Extract based on event type
          if (ev.type.includes("session.updated")) {
            const info = data.info || {};
            directory = info.directory || "/opencode-chambers-harness";
            fact = `Sessão atualizada: ${info.title || info.slug || ev.aggregate_id}`;
            scope = "collective";
          } else if (ev.type.includes("message.updated")) {
            const d = data.data || {};
            fact = (d.text || "").substring(0, 200) || "Mensagem atualizada";
            scope = "collective";
          } else if (ev.type.includes("session.compacted")) {
            fact = `Sessão compactada: ${ev.aggregate_id}`;
            scope = "collective";
          } else {
            fact = ev.type || "Evento desconhecido";
            scope = "collective";
          }
        } catch (e) {
          // If data can't be parsed, use basic info
          fact = ev.type || "Evento desconhecido";
          scope = "collective";
        }
        
        const record = {
          type: "event_backfill",
          scope: scope,
          category: "learning",
          fact: fact.substring(0, 200),
          directory: directory,
          timestamp: ev.created > 0 ? new Date(ev.created).toISOString() : new Date().toISOString()
        };
        
        fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
        entries++;
        
        if (entries >= limit) break;
      }
      
      // If no events found, try sessions table
      if (entries === 0) {
        console.log("No events found, trying sessions table...");
        const sessions = sqliteDb.query<
          { id: string; directory: string; title: string; time_created: number },
          [number]
        >("SELECT id, directory, title, time_created FROM session ORDER BY time_created DESC LIMIT ?").all(limit);
        
        for (const s of sessions) {
          const record = {
            type: "session_backfill",
            scope: "collective",
            category: "learning",
            fact: `Sessão no diretório ${s.directory}: ${s.title || "sem título"}`,
            directory: s.directory || "/opencode-chambers-harness",
            timestamp: new Date(s.time_created).toISOString()
          };
          fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
          entries++;
          if (entries >= limit) break;
        }
      }
      
      // If still no entries, try generic approach
      if (entries === 0) {
        console.log("No sessions/events found, trying generic tables...");
        const tableNames = sqliteDb.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        
        for (const table of tableNames) {
          try {
            // Check if table has relevant columns
            const cols = (sqliteDb.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
            if (cols.includes("directory") || cols.includes("scope") || cols.includes("fact")) {
              const rows = sqliteDb.query<Record<string, unknown>, [number]>(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(limit);
              for (const row of rows) {
                const rowObj: any = row;
                const fact = rowObj.fact || rowObj.content || rowObj.value || JSON.stringify(rowObj).substring(0, 200);
                const scope = rowObj.scope || "collective";
                const dir = rowObj.directory || rowObj.dir || "/opencode-chambers-harness";
                const timestamp = rowObj.created_at || rowObj.time_created || new Date().toISOString();
                
                const record = {
                  type: "session_backfill",
                  scope: scope,
                  category: "learning",
                  fact: String(fact).substring(0, 200),
                  directory: dir,
                  timestamp: String(timestamp)
                };
                fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
                entries++;
                if (entries >= limit) break;
              }
            }
          } catch (e) {
            // Skip tables that can't be queried
          }
          if (entries >= limit) break;
        }
      }
      
      sqliteDb.close();
      console.log(`Backfill complete. ${entries} entries written to ${logFile}`);
    } catch (e) {
      sqliteDb.close();
      console.error("Error during backfill:", e);
      process.exit(1);
    }
  } else if (cmd === "forget") {
    // Curadoria manual: remove UMA memória específica pelo ID numérico.
    const raw = args[1];
    const id = Number(raw);
    if (raw === undefined || !Number.isInteger(id) || id <= 0) {
      console.error(`Invalid memory id '${raw ?? ""}'. Usage: bun run src/cli.ts forget <id>`);
      process.exit(1);
    }

    const db = new DreamsDB();
    try {
      const target = db.getAllMemories().find((m) => m.id === id);
      if (!target) {
        console.error(`No memory found with id ${id}.`);
        process.exitCode = 1;
        return;
      }
      db.deleteMemory(id);
      console.log(`Memory #${id} forgotten (${target.scope}: ${target.fact})`);
    } finally {
      db.close();
    }
  } else if (cmd === "list") {
    // Curadoria manual: lista memórias ativas (id, escopo, categoria, score, fato).
    const { scope, limit } = parseListArgs(args.slice(1));
    const db = new DreamsDB();
    try {
      const memories: MemoryRecord[] = scope
        ? db.getMemoriesByScope(scope, limit)
        : db.getAllMemories().sort((a, b) => b.score - a.score).slice(0, limit);

      if (memories.length === 0) {
        console.log("No memories found.");
        return;
      }
      for (const mem of memories) {
        console.log(formatMemoryLine(mem));
      }
    } finally {
      db.close();
    }
  } else {
    console.log(
      "Usage: bun run src/cli.ts [consolidate|light|rem|deep|backfill --limit N|forget <id>|list [--scope <scope>] [--limit <n>]|rotate-log [path] [maxBytes]]"
    );
  }
}

// Só executa quando invocado diretamente (`bun run src/cli.ts ...`); importar
// o módulo (testes determinísticos) NÃO dispara o CLI nem toca o banco.
if (import.meta.main) {
  main();
}
