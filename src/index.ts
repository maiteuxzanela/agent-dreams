import { tool, type Plugin } from "@opencode-ai/plugin";
import os from "os";
import path from "path";
import { DreamsDB } from "./core/db";
import { wrapSystemPromptInjection } from "./core/prompt_injector";
import { dream_learn, dream_recall } from "./tools";

const db = new DreamsDB();

// Raiz das memórias Dreams (~/.config/opencode/dreams):
//   collective/COLLECTIVE_MEMORY.md + personas/<agent>.md
const DREAMS_DIR = path.join(os.homedir(), ".config", "opencode", "dreams");

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
          return dream_learn(args as { scope: string; fact: string; category: "learning" | "decision" | "pitfall" | "preference" });
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
          return dream_recall(args, db);
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
      try {
        db.close();
      } catch (e) {
        console.error("[Dreams] Failed to close DB on dispose:", e);
      }
    }
  };
};

export const id = "opencode-plugin-dreams";

export default {
  id,
  server: serverPlugin,
};

