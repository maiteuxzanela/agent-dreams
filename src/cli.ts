import { DreamsDB, type MemoryRecord } from "./core/db";
import { SleepCycle } from "./core/sleep_cycle";
import { readRecentDialogues, type DialogEntry } from "./core/session_reader";
import fs from "fs";
import path from "path";
import os from "os";

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

// ---------------------------------------------------------------------------
// TICKET-DREAMS-08 (Card B): `dreams backfill` reescrito sobre o leitor canônico
// de sessões. A implementação antiga consultava tabelas/colunas inexistentes
// (`session.time_created`, `event`, `sqlite_master` genérico) e gravava eventos
// triviais ("Sessão atualizada"/"Sessão compactada"). Agora o backfill lê o
// diálogo REAL via `readRecentDialogues` (mesma fonte do Light/REM Sleep) e
// escreve registros de qualidade no log diário canônico que o Light Sleep já
// ingere (`{scope, fact, category, type}` → `db.insertMemory`).
// ---------------------------------------------------------------------------

/** Limite padrão de trechos reprocessados pelo `backfill`. */
export const BACKFILL_DEFAULT_LIMIT = 10;

/** Fatos abaixo deste tamanho são ruído (saudações, "ok", etc.) e descartados. */
const BACKFILL_MIN_FACT_CHARS = 20;

/** Teto de caracteres de cada fato gravado no log diário. */
const BACKFILL_MAX_FACT_CHARS = 500;

/** Flags aceitas por `dreams backfill`. */
export interface BackfillArgs {
  limit: number;
}

/**
 * Parser determinístico de `dreams backfill`:
 *   --limit <n> | --limit=<n> | <n> posicional   (default 10; inválidos ignorados)
 *
 * Recebe os tokens APÓS o subcomando (`args.slice(1)`). O último valor válido
 * vence, permitindo overrides previsíveis (`backfill 50 --limit=5` ⇒ 5).
 */
export function parseBackfillArgs(args: string[]): BackfillArgs {
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--limit") {
      const value = args[i + 1];
      const n = Number(value);
      if (value !== undefined && !value.startsWith("-") && Number.isInteger(n) && n > 0) {
        limit = n;
        i++;
      }
    } else if (token.startsWith("--limit=")) {
      const n = Number(token.slice("--limit=".length));
      if (Number.isInteger(n) && n > 0) limit = n;
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (Number.isInteger(n) && n > 0) limit = n;
    }
  }
  return { limit: limit ?? BACKFILL_DEFAULT_LIMIT };
}

/** Opções de `runBackfill` (todas injetáveis para testes determinísticos). */
export interface BackfillOptions {
  /** Caminho do SQLite de sessões. Padrão: `~/.local/share/opencode/opencode.db`. */
  dbPath?: string;
  /** Diretório raiz das Dreams (isola `daily/` em testes). Padrão: `dreamsDir()`. */
  baseDir?: string;
  /** Máximo de trechos gravados. Padrão: `BACKFILL_DEFAULT_LIMIT`. */
  limit?: number;
  /** Incluir trechos de `reasoning` (padrão: false — domina o volume e vira ruído). */
  includeReasoning?: boolean;
  /** Relógio injetável para nomear `log_<YYYY-MM-DD>.jsonl` de forma determinística. */
  now?: Date;
  /** Observabilidade opcional dos erros engolidos pelo fail-soft do leitor. */
  onError?: (error: unknown) => void;
}

/** Resultado do backfill (para relatório e asserções de teste). */
export interface BackfillResult {
  /** Trechos lidos do diálogo real (antes dos filtros de qualidade). */
  entriesRead: number;
  /** Registros efetivamente anexados ao log diário. */
  written: number;
  /** Trechos descartados por ruído/deduplicação. */
  skipped: number;
  /** Caminho absoluto do log diário canônico. */
  logFile: string;
}

/** Um registro do log diário canônico (formato ingerido por `lightSleep`). */
export interface DailyLogRecord {
  type: string;
  scope: string;
  category: string;
  fact: string;
  timestamp: string;
}

/** Colapsa espaços/quebras e apara as bordas de um trecho de diálogo. */
function normalizeFactText(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Corta o fato em `BACKFILL_MAX_FACT_CHARS`, sinalizando a elipse. */
function clampFact(text: string): string {
  if (text.length <= BACKFILL_MAX_FACT_CHARS) return text;
  return text.slice(0, BACKFILL_MAX_FACT_CHARS).trimEnd() + " …";
}

/**
 * Extrai fatos úteis do diálogo real do OpenCode e os grava no log diário
 * canônico (`~/.config/opencode/dreams/daily/log_<data>.jsonl`) com
 * `type: "dialogue_backfill"` — formato que o Light Sleep já ingere como memória.
 *
 * Fail-soft: banco ausente, vazio, corrompido ou schema divergente produzem
 * `entriesRead: 0` (o `readRecentDialogues` nunca lança) e nada é gravado; o
 * arquivo diário só é criado quando há pelo menos um fato de qualidade. Uma
 * falha real de escrita no log diário é propagada (o chamador decide o exit code).
 */
export function runBackfill(options: BackfillOptions = {}): BackfillResult {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? (options.limit as number)
    : BACKFILL_DEFAULT_LIMIT;
  const baseDir = options.baseDir ?? dreamsDir();
  const dailyDir = path.join(baseDir, "daily");
  const now = options.now ?? new Date();
  const dateStr = now.toISOString().split("T")[0];
  const logFile = path.join(dailyDir, `log_${dateStr}.jsonl`);

  // Fonte canônica: mesma leitura read-only do OpenCode usada pelo Light Sleep.
  // Overfetch deliberado: o `limit` do leitor conta MENSAGENS, e mensagens sem
  // trecho textual (só ferramentas/ruído) não rendem fato. Lemos um múltiplo
  // limitado e depois retemos os `limit` TRECHOS mais recentes, para que
  // `--limit N` signifique de fato "até N fatos gravados". Falha ⇒ lista vazia.
  const fetchLimit = Math.min(Math.max(limit * 4, limit), 2000);
  const entries: DialogEntry[] = readRecentDialogues({
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    limit: fetchLimit,
    includeReasoning: options.includeReasoning ?? false,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  // Retém os `limit` trechos mais RECENTES, preservando a ordem cronológica.
  const selected = entries.slice(-limit);

  // Idempotência entre execuções: um `backfill` repetido não deve re-anexar o
  // mesmo fato ao log do dia (spam). Fail-soft: log ausente/ilegível ⇒ sem dedup.
  const existingFacts = new Set<string>();
  try {
    if (fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, "utf-8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const prior = JSON.parse(line) as { fact?: unknown };
          if (typeof prior.fact === "string") existingFacts.add(prior.fact);
        } catch {
          /* linha corrompida isolada: ignora e continua */
        }
      }
    }
  } catch {
    /* log ilegível: segue sem dedup, preservando o comportamento fail-soft */
  }

  const seen = new Set<string>();
  const records: DailyLogRecord[] = [];
  let skipped = 0;

  for (const entry of selected) {
    const text = normalizeFactText(entry.text);
    if (text.length < BACKFILL_MIN_FACT_CHARS) {
      skipped++;
      continue;
    }
    const fact = `[${entry.role}] ${clampFact(text)}`;
    if (seen.has(fact) || existingFacts.has(fact)) {
      skipped++;
      continue;
    }
    seen.add(fact);
    records.push({
      type: "dialogue_backfill",
      scope: "collective",
      category: "learning",
      fact,
      timestamp: entry.time_iso,
    });
  }

  if (records.length > 0) {
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.appendFileSync(logFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  return { entriesRead: entries.length, written: records.length, skipped, logFile };
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
    // Card B (TICKET-DREAMS-08): aceita `--limit 50`, `--limit=50` e `50` (default 10).
    const { limit } = parseBackfillArgs(args.slice(1));
    console.log(`Starting backfill (limit: ${limit})...`);
    try {
      const result = runBackfill({
        limit,
        onError: (error) => console.error("[backfill] session_reader:", error),
      });
      if (result.written === 0) {
        if (result.entriesRead === 0) {
          console.log(
            "Backfill complete. Nenhum diálogo encontrado " +
              "(banco de sessões ausente, vazio ou sem conversas legíveis)."
          );
        } else {
          console.log(
            `Backfill complete. Nenhum fato novo de qualidade ` +
              `(${result.entriesRead} trecho(s) lido(s), ${result.skipped} descartado(s): ` +
              `ruído, texto curto ou já registrado).`
          );
        }
      } else {
        console.log(
          `Backfill complete. ${result.written} entradas gravadas em ${result.logFile} ` +
            `(${result.entriesRead} lida(s), ${result.skipped} descartada(s)).`
        );
      }
      process.exitCode = EXIT_OK;
    } catch (e) {
      console.error("Error during backfill:", e);
      process.exitCode = EXIT_FATAL;
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
      // TICKET-DREAMS-09 (Card B): reatividade imediata em disco. Apagar a linha
      // do SQLite NÃO basta — `COLLECTIVE_MEMORY.md`/`personas/*.md` continuariam
      // injetando a "memória zumbi" no system prompt por até 24h, até o próximo
      // Deep Sleep regravar as projeções. Regenerá-las aqui torna o `forget`
      // observável no disco no mesmo instante (o `purgeOrphanPersonaFiles` interno
      // também remove o arquivo da persona que ficou com 0 memórias ativas).
      new SleepCycle(db).updateProjections();
      console.log(`Memory #${id} forgotten (${target.scope}: ${target.fact})`);
    } finally {
      db.close();
    }
  } else if (cmd === "list") {
    // Curadoria manual: lista memórias ativas (id, escopo, categoria, score, fato).
    const { scope, limit } = parseListArgs(args.slice(1));
    const db = new DreamsDB();
    try {
      // TICKET-DREAMS-09 (Card B): filtro + paginação no PRÓPRIO SQLite via a
      // query indexada `listMemories` (ORDER BY score DESC, last_reinforced DESC
      // LIMIT ?) em vez de materializar TODAS as linhas em memória e fatiar em
      // JavaScript — economiza RAM e I/O em bases grandes.
      const memories: MemoryRecord[] = db.listMemories({ scope, limit });

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
      "Usage: bun run src/cli.ts [consolidate|light|rem|deep|backfill [--limit N]|forget <id>|list [--scope <scope>] [--limit <n>]|rotate-log [path] [maxBytes]]"
    );
  }
}

// Só executa quando invocado diretamente (`bun run src/cli.ts ...`); importar
// o módulo (testes determinísticos) NÃO dispara o CLI nem toca o banco.
if (import.meta.main) {
  main();
}
