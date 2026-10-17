// Fixture E2E do TICKET-DREAMS-07 (Frente B) — SEM mocks.
// Prova, em runtime real (subprocesso + HOME isolado), o contrato de
// isolamento de path do singleton `getDB` de src/index.ts:
//   1. getDB(pathA) abre a conexão A (lazy);
//   2. getDB(pathA) repetido REUSA a mesma instância;
//   3. getDB(pathB) explicito e diferente FECHA A e reabre em B — instância
//      distinta e SEM os dados de A (bancos isolados);
//   4. getDB(pathB) repetido reusa B;
//   5. getDB(pathA) de volta reabre A numa NOVA instância (a antiga foi
//      fechada) e os dados persistidos em A continuam legíveis;
//   6. closeDB() zera o singleton (isDBInitialized()===false).
//
// Caminhos são passados por argv para não tocar o DB de produção.
import { getDB, closeDB, isDBInitialized } from "../../src/index";
import fs from "fs";

const pathA = process.argv[2];
const pathB = process.argv[3];
const result: Record<string, unknown> = {};

result.initializedBefore = isDBInitialized();

const a1 = getDB(pathA);
result.initializedWithA = isDBInitialized();
const aId = a1.insertMemory("collective", "Fato persistido exclusivamente no banco A", "decision");

// 2. Mesmo path → mesma instância (singleton por path).
const a2 = getDB(pathA);
result.reusesA = a1 === a2;

// 3. Path diferente → fecha A, reabre em B, dados isolados.
const b1 = getDB(pathB);
result.switchedToB = b1 !== a1;
result.bEmpty = b1.getAllMemories().length === 0;
result.fileAExists = fs.existsSync(pathA);
result.fileBExists = fs.existsSync(pathB);

// 4. Mesmo path B → reusa.
const b2 = getDB(pathB);
result.reusesB = b1 === b2;

// 5. Volta para A → nova instância (a anterior foi fechada), dados persistem.
const a3 = getDB(pathA);
result.reopenedA = a3 !== a1;
result.factAVisible = a3.getAllMemories().some((m) => m.id === aId && m.fact.includes("banco A"));

// 6. closeDB zera o singleton.
closeDB();
result.initializedAfterClose = isDBInitialized();

console.log("GETDB_RESULT:" + JSON.stringify(result));
