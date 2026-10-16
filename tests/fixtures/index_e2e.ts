// Fixture E2E (sem mocks): executa o plugin real de src/index.ts com HOME
// apontando para um diretório temporário isolado, provando em runtime:
//   - DEF-05: o path do log diário é derivado da data no momento da escrita
//     (sem constantes estáticas dateStr/logFile congeladas na importação);
//   - DEF-09 + Frente 4C: dispose() fecha e ZERA o singleton; o próximo
//     acesso reabre o SQLite de forma transparente (sem "database is closed");
//   - Hook de telemetria trivial REMOVIDO: session.idle não gera mais log.
import { serverPlugin } from "../../src/index";
import fs from "fs";
import path from "path";
import os from "os";

const directory = "/tmp/e2e_dreams_project";

const plugin: any = await (serverPlugin as any)({ directory });

const result: Record<string, unknown> = {};

// Hook limpo: o plugin não expõe mais handler de eventos (a telemetria
// "Sessão finalizada no diretório..." / "Sessão compactada..." foi removida;
// o diálogo real passa a ser lido do opencode.db no Light Sleep).
result.eventHookRemoved = typeof plugin.event !== "function";

// DEF-05: escrita do log diário deriva o path no momento da escrita, via
// dream_learn (o caminho do arquivo é calculado com a data corrente ali).
await plugin.tool.dream_learn.execute({
  scope: "collective",
  fact: "Fato E2E DEF-05 gravado no log do dia corrente",
  category: "learning",
});
const dailyDir = path.join(os.homedir(), ".config/opencode/dreams/daily");
const today = new Date().toISOString().split("T")[0];
const todayLog = path.join(dailyDir, `log_${today}.jsonl`);
result.dailyDir = dailyDir;
result.todayLogExists = fs.existsSync(todayLog);
result.todayLogName = path.basename(todayLog);
result.todayLogContent = fs.existsSync(todayLog) ? fs.readFileSync(todayLog, "utf-8") : "";

// DEF-09 + TICKET-DREAMS-04 (Frente 4C): dispose() fecha E ZERA o singleton.
// Contrato SUPERSEDE o antigo "recall falha após dispose": o próximo acesso
// reabre o banco de forma transparente (nunca "database is closed") e os dados
// persistidos seguem legíveis.
await plugin.dispose();
result.disposeSuccess = true;
try {
  const recall = await plugin.tool.dream_recall.execute({ query: "Fato E2E DEF-05 gravado" });
  result.dbReopenedAfterDispose = true;
  result.recallAfterDisposeHasFact =
    typeof recall === "string" && recall.includes("Fato E2E DEF-05 gravado no log do dia corrente");
} catch (e) {
  result.dbReopenedAfterDispose = false;
  result.recallAfterDisposeHasFact = false;
}

console.log("E2E_RESULT:" + JSON.stringify(result));
