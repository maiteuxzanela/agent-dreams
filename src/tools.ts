import { DreamsDB } from "./core/db";
import fs from "fs";
import path from "path";
import os from "os";

const DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");
const DAILY_DIR = path.join(DREAMS_DIR, "daily");

// DEF-03: escopo válido é 'collective' ou 'agent:<nome>' com nome seguro.
// Bloqueia Directory Traversal e escopos malformados.
const SCOPE_PATTERN = /^(collective|agent:[a-zA-Z0-9_-]+)$/;

/**
 * `dream_learn` persiste o fato em DUAS camadas:
 *   1. Append no JSONL diário (dreams/daily/log_<YYYY-MM-DD>.jsonl), fonte de
 *      verdade durável ingerida pelo Light Sleep — é o caminho histórico.
 *   2. TICKET-DREAMS-03 (Frente A): dual-write SÍNCRONO no SQLite via
 *      `db.insertMemory()`, quando um `DreamsDB` é injetado. Isso torna o fato
 *      imediatamente consultável por `dream_recall` no mesmo turno de vigília,
 *      sem depender da consolidação noturna. O SQLite roda em WAL mode com
 *      busy_timeout, tornando o insert rápido e seguro para concorrência.
 *
 * O diretório é criado de forma lazy (sem efeito colateral na importação) e pode ser
 * injetado via `options.dailyDir` para testes isolados em /tmp. O `db` é opcional
 * para preservar o uso sem banco (ex.: testes puramente de JSONL).
 */
export function dream_learn(
  args: { scope: string, fact: string, category: "learning" | "decision" | "pitfall" | "preference" },
  options: { dailyDir?: string; db?: DreamsDB } = {}
) {
  if (!SCOPE_PATTERN.test(args.scope)) {
    throw new Error(
      `Invalid scope '${args.scope}'. Expected 'collective' or 'agent:<nome>' (allowed chars: [a-zA-Z0-9_-]).`
    );
  }

  const dailyDir = options.dailyDir ?? DAILY_DIR;
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const file = path.join(dailyDir, `log_${dateStr}.jsonl`);
  
  const record = {
    scope: args.scope,
    fact: args.fact,
    category: args.category,
    timestamp: new Date().toISOString()
  };

  // Fonte de verdade durável da vigília: o JSONL diário (ingerido no Light Sleep).
  fs.appendFileSync(file, JSON.stringify(record) + "\n");

  // TICKET-DREAMS-03 (Frente A) — DUAL-WRITE SÍNCRONO:
  // além do JSONL, espelha imediatamente no SQLite para que o fato seja
  // consultável por `dream_recall` JÁ no mesmo turno de vigília, sem esperar
  // o ciclo noturno. O JSONL permanece a fonte de verdade: se o espelho no
  // SQLite falhar (lock transitório, DB indisponível), o fato não é perdido e
  // a tool não quebra o chat do usuário — apenas registra o desvio.
  if (options.db) {
    try {
      options.db.insertMemory(args.scope, args.fact, args.category);
    } catch (e) {
      console.error("[Dreams] dual-write para SQLite falhou:", e);
    }
  }

  return `Memory logged to daily stream for scope '${args.scope}'. Will be consolidated tonight.`;
}

/**
 * `dream_recall` queries the SQLite FTS5 database immediately.
 */
export function dream_recall(args: { query: string, scope?: string, category?: string }, db: DreamsDB) {
  const results = db.recall(args.query, args.scope, args.category, 5);
  if (results.length === 0) return "No relevant memories found.";
  
  return results.map(r => `[Score: ${r.score.toFixed(2)}] [${r.scope}] ${r.fact}`).join("\n");
}
