import { DreamsDB, type MemoryCategory } from "./core/db";
import { redactSecrets } from "./core/security";
import fs from "fs";
import path from "path";
import os from "os";

const DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");
const DAILY_DIR = path.join(DREAMS_DIR, "daily");

// DEF-03: escopo válido é 'collective' ou 'agent:<nome>' com nome seguro.
// Bloqueia Directory Traversal e escopos malformados.
const SCOPE_PATTERN = /^(collective|agent:[a-zA-Z0-9_-]+)$/;

/**
 * Forma canônica de uma linha do JSONL diário (`dreams/daily/log_<data>.jsonl`).
 *
 * `synced_to_db` (TICKET-DREAMS-07, Frente A) é OPCIONAL e só é anexado quando
 * o dual-write SÍNCRONO no SQLite teve sucesso durante a vigília. É o sinal
 * consumido pelo Light Sleep para saber que o fato já possui sua confirmação
 * canônica no banco e não deve ser reforçado novamente na madrugada da
 * primeira noite (`reinforce: !isTrivial && !record.synced_to_db`).
 */
interface DailyRecord {
  scope: string;
  fact: string;
  category: MemoryCategory;
  timestamp: string;
  synced_to_db?: boolean;
}

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

  // DEFESA ATIVA (TICKET-DREAMS-06): o fato vindo do LLM/tool-call pode conter
  // credenciais coladas pelo usuário (OpenAI sk-, Google AIza, Bearer, JWT,
  // password=...). Mascara ANTES de qualquer persistência (JSONL e dual-write).
  const sanitizedFact = redactSecrets(args.fact);

  const dailyDir = options.dailyDir ?? DAILY_DIR;
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const file = path.join(dailyDir, `log_${dateStr}.jsonl`);

  const record: DailyRecord = {
    scope: args.scope,
    fact: sanitizedFact,
    category: args.category,
    timestamp: new Date().toISOString()
  };

  // TICKET-DREAMS-07 (Frente A) — DUAL-WRITE SÍNCRONO PRIMEIRO:
  // a tentativa de persistência no SQLite acontece ANTES do append no JSONL
  // diário. Se o insert síncrono tiver sucesso, o record é marcado com
  // `synced_to_db: true` — evidência de que o fato JÁ nasceu no banco com sua
  // confirmação canônica e NÃO deve ser reforçado de novo pelo Light Sleep na
  // madrugada da primeira noite. O JSONL permanece a fonte de verdade: se o
  // espelho no SQLite falhar (lock transitório, DB indisponível) ou se o `db`
  // não for injetado, a flag é simplesmente omitida e o fato não é perdido —
  // a tool nunca quebra o chat do usuário, apenas registra o desvio.
  if (options.db) {
    try {
      options.db.insertMemory(args.scope, sanitizedFact, args.category);
      record.synced_to_db = true;
    } catch (e) {
      console.error("[Dreams] dual-write para SQLite falhou:", e);
    }
  }

  // Fonte de verdade durável da vigília: o JSONL diário (ingerido no Light Sleep).
  fs.appendFileSync(file, JSON.stringify(record) + "\n");

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
