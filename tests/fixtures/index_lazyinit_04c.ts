// Fixture E2E da Frente 4C (sem mocks): prova, em runtime com HOME isolado em
// /tmp, o contrato de LAZY INIT / SINGLETON de src/index.ts:
//   1. importar o módulo NÃO abre o banco nem cria arquivo;
//   2. o primeiro acesso abre sob demanda;
//   3. dispose/closeDB fecha E ZERA o singleton;
//   4. o acesso seguinte no MESMO processo reabre transparente (sem
//      "database is closed") e os dados persistidos seguem legíveis;
//   5. closeDB() é idempotente.
import { getDB, closeDB, isDBInitialized } from "../../src/index";
import fs from "fs";
import os from "os";
import path from "path";

const result: Record<string, unknown> = {};
const defaultDbPath = path.join(os.homedir(), ".config", "opencode", "dreams", "dreams.db");

// 1. Importar o módulo não abre o banco.
result.initializedAfterImport = isDBInitialized();
result.dbFileExistsAfterImport = fs.existsSync(defaultDbPath);

// 2. Primeiro acesso abre sob demanda.
const db1 = getDB();
result.initializedAfterFirstAccess = isDBInitialized();
result.dbFileExistsAfterFirstAccess = fs.existsSync(defaultDbPath);

// 3. Persiste uma memória (dual-write real no SQLite).
result.insertedId = db1.insertMemory(
  "collective",
  "Fato persistido pela suíte lazy-init 4C",
  "learning"
);

// 4. dispose/closeDB fecha E zera o singleton.
closeDB();
result.initializedAfterClose = isDBInitialized();

// 5. Reabertura transparente no MESMO processo.
try {
  const db2 = getDB();
  result.reopenedTransparently = isDBInitialized();
  const rows = db2.recall("persistido lazy init");
  result.factReadableAfterReopen = rows.some(
    (r) => r.fact === "Fato persistido pela suíte lazy-init 4C"
  );
} catch (e) {
  result.reopenedTransparently = false;
  result.factReadableAfterReopen = false;
  result.reopenError = String(e);
}

// 6. closeDB idempotente.
closeDB();
closeDB();
result.initializedAfterSecondClose = isDBInitialized();

console.log("LAZY_RESULT:" + JSON.stringify(result));
