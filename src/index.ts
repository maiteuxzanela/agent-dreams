import { tool, type Plugin } from "@opencode-ai/plugin";
import os from "os";
import path from "path";
import { DreamsDB } from "./core/db";
import { wrapSystemPromptInjection } from "./core/prompt_injector";
import { dream_learn, dream_recall } from "./tools";

// Raiz das memórias Dreams (~/.config/opencode/dreams):
//   collective/COLLECTIVE_MEMORY.md + personas/<agent>.md
const DREAMS_DIR = path.join(os.homedir(), ".config", "opencode", "dreams");

// TICKET-DREAMS-04 (Frente 4C) — LAZY INIT / SINGLETON.
//
// A conexão SQLite NÃO é aberta na importação do módulo (o antigo
// `const db = new DreamsDB()` rodava abrir/DDL/WAL no top-level, gerando
// efeito colateral prematuro ao carregar o plugin). A instância nasce apenas
// no primeiro uso real (tool call), via `getDB()`.
//
// Ciclo de vida de descarte: `dispose()` chama `closeDB()`, que fecha a
// conexão E zera o singleton. Se o plugin for recarregado no MESMO processo,
// o próximo `getDB()` reabre o banco de forma transparente — nunca se
// devolve uma referência a uma conexão já fechada ("database is closed").
let dbInstance: DreamsDB | null = null;

// TICKET-DREAMS-07B: caminho efetivamente ligado ao `dbInstance` vivo.
// `null` representa o caminho DEFAULT (quando `getDB()` é chamado sem
// argumento). Rastreá-lo permite que um novo `dbPath` EXPLÍCITO e diferente
// force o fechamento da conexão atual e a reabertura no caminho pedido —
// antes o argumento era silenciosamente ignorado após a 1ª abertura.
let currentDbPath: string | null = null;

/**
 * Retorna a conexão única com o `DreamsDB`, abrindo-a sob demanda.
 *
 * @param dbPath Caminho opcional do banco. Se um caminho explícito DIFERENTE do
 *               que está ligado à conexão viva for passado, a conexão atual é
 *               fechada e reaberta no novo caminho (isolação em testes
 *               determinísticos). Produção usa o default.
 */
export function getDB(dbPath?: string): DreamsDB {
  if (dbPath !== undefined && dbPath !== currentDbPath) {
    if (dbInstance) {
      // Fecha e zera o singleton com segurança antes de reabrir no novo path.
      closeDB();
    }
    dbInstance = new DreamsDB(dbPath);
    currentDbPath = dbPath;
    return dbInstance;
  }
  if (!dbInstance) {
    dbInstance = new DreamsDB(dbPath);
    currentDbPath = dbPath ?? null;
  }
  return dbInstance;
}

/**
 * Fecha a conexão (se aberta) e zera o singleton; a próxima chamada a
 * `getDB()` reabre o banco. Idempotente e fail-soft (nunca lança).
 */
export function closeDB(): void {
  const current = dbInstance;
  // Zera ANTES de fechar: mesmo que `close()` lance, o singleton não fica
  // apontando para uma conexão morta e o próximo `getDB()` reabre limpo.
  dbInstance = null;
  // TICKET-DREAMS-07B: zera também o caminho rastreado, para que a próxima
  // abertura (com ou sem argumento) seja tratada como inicialização limpa.
  currentDbPath = null;
  if (!current) return;
  try {
    current.close();
  } catch (e) {
    console.error("[Dreams] Failed to close DB on dispose:", e);
  }
}

/**
 * Introspecção determinística do estado do singleton (sem mocks):
 * `true` apenas enquanto há uma conexão viva aberta por `getDB()`.
 */
export function isDBInitialized(): boolean {
  return dbInstance !== null;
}

// Hook de eventos LIMPO: a telemetria trivial de ciclo de vida
// ("Sessão finalizada no diretório...", "Sessão compactada...",
// "Sessão deletada...") foi REMOVIDA — eram spam sem valor preditivo
// (DEF-10 já as classificava como triviais). O conteúdo real das conversas
// agora é ingerido pelo Light Sleep via `session_reader` (leitura read-only
// do opencode.db) e destilado pelo MimoSynthesizer no REM Sleep.
export const serverPlugin: Plugin = async (input) => {
  const { client } = input;
  return {
    tool: {
      dream_learn: tool({
        description: "Learn a new fact, rule, or preference. Saved to daily stream for nightly consolidation.",
        args: {
          scope: tool.schema.string().describe("'collective' or 'agent:<nome>'"),
          fact: tool.schema.string().describe("The fact to learn"),
          category: tool.schema.enum(["learning", "decision", "pitfall", "preference"]).describe("Category of memory"),
        },
        async execute(args) {
          // Frente A (TICKET-DREAMS-03): injeta o DreamsDB para o dual-write
          // síncrono — o fato fica consultável por dream_recall no mesmo turno.
          // Frente 4C: a conexão é obtida LAZY dentro do execute (nunca no
          // topo do módulo) e o JSONL diário segue como fonte de verdade mesmo
          // se o SQLite estiver indisponível (fail-soft).
          let database: DreamsDB | undefined;
          try {
            database = getDB();
          } catch (e) {
            console.error("[Dreams] dream_learn: SQLite indisponível (JSONL preservado):", e);
          }
          return dream_learn(
            args as { scope: string; fact: string; category: "learning" | "decision" | "pitfall" | "preference" },
            { db: database }
          );
        },
      }),

      dream_recall: tool({
        description: "Recall memories using full-text search.",
        args: {
          query: tool.schema.string().describe("Search query"),
          scope: tool.schema.string().optional().describe("Scope filter"),
          category: tool.schema.string().optional().describe("Category filter"),
        },
        async execute(args) {
          // Frente 4C: conexão aberta sob demanda no primeiro recall real.
          return dream_recall(args, getDB());
        },
      }),
    },

    // Hook de injecao de memorias Dreams no system prompt do chat.
    // Contrato SDK: experimental.chat.system.transform(input, output) => Promise<void>
    // Fail-safe total: qualquer erro de I/O (SQLite, filesystem, resolucao
    // de agente) e engolido por try/catch — o chat do usuario nunca quebra.
    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        const memoryBlock = await wrapSystemPromptInjection(
          DREAMS_DIR,
          hookInput.sessionID,
          client
        );
        if (memoryBlock) {
          output.system.push(memoryBlock);
        }
      } catch (e) {
        // DEFESA EM PROFUNDIDADE: o injector ja tem try/catch proprio e
        // retorna null em falha; este catch cobre bugs inesperados no hook.
        console.debug("[Dreams] system.prompt injection skipped:", e);
      }
    },

    dispose: async () => {
      // DEF-09: libera a conexão SQLite (WAL) no unload do plugin.
      // Frente 4C: `closeDB()` fecha E zera o singleton — um reload no mesmo
      // processo reabre o banco via `getDB()` sem erro de conexão fechada.
      closeDB();
    }
  };
};

export const id = "opencode-plugin-dreams";

export default {
  id,
  server: serverPlugin,
};

