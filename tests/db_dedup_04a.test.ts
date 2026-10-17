/**
 * TICKET-DREAMS-04 — Frente 4A
 * Suíte determinística (SDET / Hugo) para deduplicação semântica, reforço de
 * escopo cruzado, listagem filtrada e helper de similaridade em src/core/db.ts.
 *
 * Regras: SEM mocks — SQLite real (bun:sqlite) em diretório temporário isolado.
 * Nenhum acesso a ~/.config/opencode/dreams (DB de produção).
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DreamsDB,
  FACT_SIMILARITY_THRESHOLD,
  normalizeFactText,
  tokenizeFact,
  jaccardSimilarity,
} from "../src/core/db";

// ---------------------------------------------------------------------------
// Harness: um DB real e isolado por teste, com limpeza determinística (WAL).
// ---------------------------------------------------------------------------
const live: { db: DreamsDB; dir: string }[] = [];

function makeDb(): DreamsDB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_dedup_04a_"));
  const db = new DreamsDB(path.join(dir, "dreams.db"));
  live.push({ db, dir });
  return db;
}

/** Executa SQL real na instância subjacente (para injetar sentinelas temporais). */
function rawRun(db: DreamsDB, sql: string, params: any[] = []): void {
  (db as any).db.run(sql, params);
}
function oneRow<T>(db: DreamsDB, sql: string, params: any[] = []): T {
  return (db as any).db.query(sql).get(...params) as T;
}

const OLD = "2000-01-01T00:00:00.000Z";

afterEach(() => {
  while (live.length > 0) {
    const { db, dir } = live.pop()!;
    try {
      db.close(); // fecha antes do rm: evita ENOTEMPTY do WAL (-wal/-shm)
    } catch {
      /* idempotente */
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Helpers puros exportados (contrato público da Frente 4A)
// ---------------------------------------------------------------------------
describe("[4A] helpers determinísticos de similaridade", () => {
  test("FACT_SIMILARITY_THRESHOLD está calibrado em 0.80", () => {
    expect(FACT_SIMILARITY_THRESHOLD).toBe(0.8);
  });

  test("normalizeFactText colapsa acentos, caixa e pontuação", () => {
    expect(normalizeFactText("Inferência, (c/d) & Laya!")).toBe("inferencia c d laya");
    expect(normalizeFactText("  LAYA   RLCD  ")).toBe("laya rlcd");
    expect(normalizeFactText("")).toBe("");
    // Entradas não-string são rejeitadas de forma pura (nunca lançam).
    expect(normalizeFactText(42 as unknown as string)).toBe("");
  });

  test("tokenizeFact produz conjunto único (Set) sem termos vazios", () => {
    const tokens = tokenizeFact("Laya, Laya! RLCD");
    expect([...tokens].sort()).toEqual(["laya", "rlcd"]);
    expect(tokenizeFact("").size).toBe(0);
    expect(tokenizeFact("...---!!!").size).toBe(0);
  });

  test("jaccardSimilarity: idêntico=1, disjunto=0, vazio=0 e parcial fracionário", () => {
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["a", "b", "c"]))).toBe(1);
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccardSimilarity(new Set(["a", "b", "c", "d"]), new Set(["a", "b", "x", "y"]))).toBeCloseTo(1 / 3, 10);
  });
});

// ---------------------------------------------------------------------------
// 1. Deduplicação semântica no MESMO escopo
// ---------------------------------------------------------------------------
describe("[4A] dedup semântica same-scope", () => {
  test("fatos equivalentes (reordenação/acentos/pontuação) fundem na mesma linha e reforçam", () => {
    const db = makeDb();
    const id1 = db.insertMemory("collective", "Inferência local usa Laya RLCD", "learning");
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, id1]);

    const id2 = db.insertMemory("collective", "laya RLCD usa inferencia local!", "learning");

    // Mesma linha (sem clone).
    expect(id2).toBe(id1);
    expect(db.getAllMemories().length).toBe(1);

    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [id1]);
    expect(row.confirmations).toBe(2); // 1 → reforço
    expect(row.score).toBe(1.5); // 1.0 + 0.5
    // last_reinforced foi atualizado (deixou a sentinela antiga).
    expect(row.last_reinforced).not.toBe(OLD);
    expect(new Date(row.last_reinforced).getTime()).toBeGreaterThan(new Date(OLD).getTime());
  });

  test("limiar é inclusivo: Jaccard exatamente 0.80 funde (>= threshold)", () => {
    const db = makeDb();
    // A = 5 tokens, B = 4 tokens ⊂ A  ⇒ |A∩B|/|A∪B| = 4/5 = 0.80
    const a = "alpha beta gamma delta epsilon";
    const b = "alpha beta gamma delta";
    expect(jaccardSimilarity(tokenizeFact(a), tokenizeFact(b))).toBe(0.8);

    const id1 = db.insertMemory("collective", a, "learning");
    const id2 = db.insertMemory("collective", b, "learning");
    expect(id2).toBe(id1);
    expect(db.getAllMemories().length).toBe(1);
  });

  test("ANTI-FALSO-POSITIVO: Jaccard 0.75 (< 0.80) NÃO funde fatos distintos", () => {
    const db = makeDb();
    const f1 = "Sessão finalizada no diretório /tmp/def10_repeticao";
    const f2 = "Sessão finalizada no diretório /tmp/def10_teto";

    const ratio = jaccardSimilarity(tokenizeFact(f1), tokenizeFact(f2));
    expect(ratio).toBeCloseTo(0.75, 10);
    expect(ratio).toBeLessThan(FACT_SIMILARITY_THRESHOLD);

    const id1 = db.insertMemory("collective", f1, "learning");
    const id2 = db.insertMemory("collective", f2, "learning");

    expect(id2).not.toBe(id1);
    const facts = db.getAllMemories().map((m) => m.fact).sort();
    expect(facts).toEqual([f1, f2].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Hierarquia de escopo cruzado
// ---------------------------------------------------------------------------
describe("[4A] promoção Persona ➔ Coletivo", () => {
  test("promove a melhor cópia de persona REFORÇANDO score/confirmações (+0.5/+1) e expurga clones", () => {
    const db = makeDb();
    const xId = db.insertMemory("agent:x", "Laya RLCD usa inferencia local", "decision", 2.0, 0.3);
    const zId = db.insertMemory("agent:z", "inferencia local usa Laya RLCD", "decision", 1.0, 0.3);
    expect(xId).not.toBe(zId);
    // Sentinela temporal para provar que a promoção TAMBÉM atualiza last_reinforced (DREAMS-07B).
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, xId]);

    const cId = db.insertMemory("collective", "Usa Laya RLCD inferencia local!", "decision");

    // A linha de maior score (agent:x) é promovida; agent:z é expurgada.
    expect(cId).toBe(xId);
    const all = db.getAllMemories();
    expect(all.length).toBe(1);
    expect(all[0].scope).toBe("collective");
    expect(all[0].id).toBe(xId);
    // TICKET-DREAMS-07B: a promoção CONFIRMA a memória (score +0.5, +1 confirmação).
    expect(all[0].score).toBe(2.5);
    expect(all[0].confirmations).toBe(2);
    expect(all[0].last_reinforced).not.toBe(OLD);
    expect(new Date(all[0].last_reinforced).getTime()).toBeGreaterThan(new Date(OLD).getTime());

    expect(db.listMemories({ scope: "agent:x" }).length).toBe(0);
    expect(db.listMemories({ scope: "agent:z" }).length).toBe(0);
    expect(db.listMemories({ scope: "collective" }).length).toBe(1);
  });

  test("promoção com reinforce=false preserva score/confirmações e last_reinforced (sem inflação)", () => {
    const db = makeDb();
    const xId = db.insertMemory("agent:x", "Laya RLCD usa inferencia local", "decision", 2.0, 0.3);
    db.insertMemory("agent:z", "inferencia local usa Laya RLCD", "decision", 1.0, 0.3);
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, xId]);

    const cId = db.insertMemory("collective", "Usa Laya RLCD inferencia local!", "decision", undefined, undefined, {
      reinforce: false,
    });

    expect(cId).toBe(xId);
    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [xId]);
    expect(row.scope).toBe("collective");
    expect(row.score).toBe(2.0); // herdado sem inflação
    expect(row.confirmations).toBe(1);
    expect(row.last_reinforced).toBe(OLD); // NÃO atualizado
  });
});

describe("[4A] herança Coletivo ➔ Persona", () => {
  test("inserção em agent:y equivalente ao coletivo reforça o global e não cria cópia", () => {
    const db = makeDb();
    const cId = db.insertMemory("collective", "Mapa de plugins exige contrato estavel", "decision", 3.0, 0.3);
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, cId]);

    const yId = db.insertMemory("agent:y", "Contrato estavel: mapa de plugins exige", "decision");

    expect(yId).toBe(cId); // devolve o id coletivo
    expect(db.getAllMemories().length).toBe(1);
    expect(db.listMemories({ scope: "agent:y" }).length).toBe(0);

    const collective = db.listMemories({ scope: "collective" });
    expect(collective.length).toBe(1);
    expect(collective[0].confirmations).toBe(2); // +1 no global
    expect(collective[0].score).toBe(3.5); // 3.0 + 0.5
    expect(collective[0].last_reinforced).not.toBe(OLD);
    expect(new Date(collective[0].last_reinforced).getTime()).toBeGreaterThan(new Date(OLD).getTime());
  });

  test("personas distintas NÃO se fundem entre si (estratégia é escopo-local)", () => {
    const db = makeDb();
    const fact = "isolamento de escopo entre personas distintas";
    const aId = db.insertMemory("agent:a", fact, "learning");
    const bId = db.insertMemory("agent:b", fact, "learning");
    expect(bId).not.toBe(aId);
    expect(db.listMemories({ scope: "agent:a" }).length).toBe(1);
    expect(db.listMemories({ scope: "agent:b" }).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DEF-10: options.reinforce === false
// ---------------------------------------------------------------------------
describe("[4A] DEF-10 reinforce=false", () => {
  test("duplicata exata com reinforce=false não infla e deixa last_reinforced intacto", () => {
    const db = makeDb();
    const fact = "Evento trivial do ciclo de vida do agente";
    const id1 = db.insertMemory("collective", fact, "learning");
    rawRun(db, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [OLD, id1]);

    const id2 = db.insertMemory("collective", fact, "learning", 1.0, 1.0, { reinforce: false });

    expect(id2).toBe(id1); // dedup exata continua valendo (sem clone)
    expect(db.getAllMemories().length).toBe(1);
    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [id1]);
    expect(row.confirmations).toBe(1); // intocado
    expect(row.score).toBe(1.0); // intocado
    expect(row.last_reinforced).toBe(OLD); // NÃO atualizado
  });

  test("equivalente semântico com reinforce=false deduplica sem inflar (sem clone)", () => {
    const db = makeDb();
    const id1 = db.insertMemory("collective", "evento trivial do ciclo de vida do agente", "learning");

    // Mesmo conjunto de tokens (reordenado) ⇒ Jaccard 0.875 ≥ 0.80.
    const id2 = db.insertMemory("collective", "Do agente, o ciclo de vida evento trivial!", "learning", 1.0, 1.0, {
      reinforce: false,
    });

    expect(id2).toBe(id1);
    expect(db.getAllMemories().length).toBe(1);
    const row = oneRow<any>(db, "SELECT * FROM memories WHERE id = ?", [id1]);
    expect(row.confirmations).toBe(1);
    expect(row.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// listMemories / deleteMemory — curadoria (API nova da Frente 4A)
// ---------------------------------------------------------------------------
describe("[4A] listMemories e deleteMemory (curadoria)", () => {
  function seed(db: DreamsDB) {
    db.insertMemory("collective", "Fato coletivo de aprendizado", "learning", 1.0);
    db.insertMemory("collective", "Decisao coletiva de arquitetura", "decision", 2.0);
    db.insertMemory("agent:a", "Preferencia pessoal do agente a", "preference", 2.5);
    db.insertMemory("agent:b", "Armadilha do agente b", "pitfall", 1.8);
  }

  test("filtra por escopo, categoria, ambos e respeita limit/ordenação", () => {
    const db = makeDb();
    seed(db);

    expect(db.listMemories().length).toBe(4);
    expect(db.listMemories({ scope: "collective" }).length).toBe(2);
    expect(db.listMemories({ category: "learning" }).length).toBe(1);
    expect(db.listMemories({ scope: "agent:a", category: "preference" }).length).toBe(1);
    expect(db.listMemories({ scope: "agent:a", category: "pitfall" }).length).toBe(0);
    expect(db.listMemories({ limit: 2 }).length).toBe(2);
    // Ordenação por score DESC.
    expect(db.listMemories()[0].scope).toBe("agent:a");
    expect(db.listMemories()[0].score).toBe(2.5);
  });

  test("deleteMemory poda cirurgicamente por id", () => {
    const db = makeDb();
    const id = db.insertMemory("collective", "Fato a ser podado manualmente", "learning");
    expect(db.getAllMemories().length).toBe(1);
    db.deleteMemory(id);
    expect(db.getAllMemories().length).toBe(0);
  });

  test("filtros são parametrizados (scope hostil não injeta SQL nem corrompe a tabela)", () => {
    const db = makeDb();
    const evil = "agent:x'; DROP TABLE memories;--";
    db.insertMemory(evil, "Fato hostil de injecao", "learning");

    const hits = db.listMemories({ scope: evil });
    expect(hits.length).toBe(1);
    expect(hits[0].scope).toBe(evil);
    // Tabela permanece íntegra.
    expect(db.getAllMemories().length).toBe(1);
  });
});
