/**
 * TICKET-DREAMS-06 (Frente A) — Camada de persistência transacional e
 * triagem léxica (Jaccard >= 15%) do `DreamsDB`.
 *
 * Suíte determinística SDET — SEM mocks: SQLite real (bun:sqlite) em banco
 * HERMÉTICO temporário sob /tmp (nunca o ~/.config/opencode/dreams de
 * produção) e segunda conexão REAL para materializar estados adversariais.
 *
 * Cenários cobertos:
 *   1. Limiar de 15%: Jaccard < 0.15 ⇒ nenhum candidato; >= 0.15 ⇒ candidato
 *      devolvido, ORDENADO por similaridade DECRESCENTE.
 *   2. ISOLAMENTO ESTRITO DE ESCOPO: 'agent:reviewer' jamais reconcilia com
 *      'collective' ou 'agent:architect' — mesmo com 100% de similaridade léxica.
 *   3. `reinforceMemory`: confirmações +1 (teto 10), score +0.5 (teto 5.0),
 *      last_reinforced = now.
 *   4. `supersedeMemory`: remoção FÍSICA da diretriz revogada, diretriz nova
 *      presente, ZERO registros órfãos e índice FTS5 consistente.
 *   5. `mergeMemories`: score = min(5.0, max(score_A, score_B) + 0.5),
 *      confirmations = max(confirmations_A, confirmations_B) + 1, id
 *      redundante DELETADO, FTS5 reindexado.
 *   6. ATOMICIDADE: falha simulada NO MEIO do merge (trigger real que aborta
 *      o UPDATE) ⇒ ROLLBACK TOTAL (fato, score, confirmações e FTS5 intactos;
 *      o candidato NÃO é expurgado).
 *   7. REDAÇÃO: `redactSecrets` idempotente em supersede/merge/reinforce.
 *
 * Nota de atomicidade (Cenário 6): a falha é induzida por um TRIGGER SQLite
 * REAL (`RAISE(ABORT)`) criado numa segunda conexão ao MESMO arquivo — não é
 * mock nem stub: é o próprio motor do banco recusando a escrita no meio da
 * transação, exatamente como um disco cheio ou uma constraint violada.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import {
  DreamsDB,
  ReconciliationError,
  RECONCILIATION_SIMILARITY_THRESHOLD,
  jaccardSimilarity,
  tokenizeFact,
} from "../src/core/db";
import { redactSecrets } from "../src/core/security";

// ---------------------------------------------------------------------------
// Fixtures léxicas — sobreposições CALCULADAS, não chutadas.
// ---------------------------------------------------------------------------

/** Fato âncora (12 tokens). */
const FACT_A = "usar sempre o modelo gemini para tarefas de sintese cognitiva no dreams";
/** Par de alta sobreposição com FACT_A (Jaccard ≈ 0.294) — acima de 15%. */
const FACT_B = "modelo gemini deve ser preferido em sintese cognitiva do dreams";
/** Par de baixa sobreposição com FACT_A (Jaccard ≈ 0.111) — abaixo de 15%. */
const FACT_C = "implantar balanceador de carga no cluster kubernetes de producao";

const JACCARD_AB = jaccardSimilarity(tokenizeFact(FACT_A), tokenizeFact(FACT_B));
const JACCARD_AC = jaccardSimilarity(tokenizeFact(FACT_A), tokenizeFact(FACT_C));

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_06a_"));
const DB_PATH = path.join(TEST_DIR, "reconciliation.db");

/** Credencial sintética (nunca real) — formato exato do padrão OpenAI. */
const FAKE_KEY = "sk-proj-abc12345678901234567890";

let db: DreamsDB;

/** Abre uma segunda conexão REAL ao mesmo arquivo (estado adversarial). */
function openRaw(dbPath: string = DB_PATH): Database {
  const raw = new Database(dbPath);
  raw.exec("PRAGMA busy_timeout = 5000;");
  return raw;
}

/**
 * Executa SQL real na instância SQLite subjacente do `DreamsDB`.
 *
 * Usado para INJETAR sentinelas temporais determinísticas: em runners de CI
 * muito rápidos, `insertMemory` seguido de `mergeMemories` pode cair no MESMO
 * milissegundo, e `last_reinforced` do registro base ficaria idêntico ao do
 * merge — tornando a asserção de avanço temporal um flake dependente da
 * velocidade da máquina. Fixar o carimbo original num instante anterior
 * remove a dependência do relógio real.
 */
function rawRun(target: DreamsDB, sql: string, params: any[] = []): void {
  (target as any).db.run(sql, params);
}

beforeAll(() => {
  db = new DreamsDB(DB_PATH);
});

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---------------------------------------------------------------------------
// Cenário 0 — Sanidade da calibração léxica (a suíte depende dela).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 0: calibração da sobreposição léxica", () => {
  test("0.1: os fixtures ficam dos dois lados do limiar de 15%", () => {
    expect(RECONCILIATION_SIMILARITY_THRESHOLD).toBe(0.15);
    expect(JACCARD_AB).toBeGreaterThanOrEqual(RECONCILIATION_SIMILARITY_THRESHOLD);
    expect(JACCARD_AB).toBeLessThan(0.8); // abaixo da equivalência do insertMemory
    expect(JACCARD_AC).toBeLessThan(RECONCILIATION_SIMILARITY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Cenário 1 — Limiar de 15% na triagem léxica.
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 1: triagem Jaccard >= 15%", () => {
  const scope = "collective";

  test("1.1: Jaccard >= 15% devolve o candidato do MESMO escopo", () => {
    const id = db.insertMemory(scope, FACT_A, "learning");
    const candidates = db.findReconciliationCandidates(scope, FACT_B);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.some((c) => c.id === id)).toBe(true);
  });

  test("1.2: Jaccard < 15% devolve lista VAZIA (nada a reconciliar)", () => {
    const candidates = db.findReconciliationCandidates(scope, FACT_C);
    expect(candidates).toEqual([]);
  });

  test("1.3: o limiar é PARAMETRIZÁVEL e o default é 15%", () => {
    // Com um limiar mais permissivo, o par de baixa sobreposição entra.
    const loose = db.findReconciliationCandidates(scope, FACT_C, 0.1);
    expect(loose.length).toBeGreaterThanOrEqual(1);
    // Com um limiar mais restritivo, o par de alta sobreposição sai.
    const strict = db.findReconciliationCandidates(scope, FACT_B, 0.9);
    expect(strict).toEqual([]);
  });

  test("1.4: candidatos ordenados por Jaccard DECRESCENTE", () => {
    const dbOrdered = new DreamsDB(path.join(TEST_DIR, "ordering.db"));
    try {
      // Três âncoras no MESMO escopo e com METADADOS IDÊNTTICOS (mesma
      // categoria/score/confirmações) — assim a ordem só pode ser decidida
      // pela similaridade Jaccard, nunca por um desempate de score ou id.
      //   FACT_B (idêntico)  → Jaccard 1.000
      //   "modelo gemini sintese cognitiva" → Jaccard 0.400
      //   FACT_A             → Jaccard 0.294
      dbOrdered.insertMemory("collective", FACT_A, "learning");
      dbOrdered.insertMemory("collective", FACT_B, "learning");
      dbOrdered.insertMemory("collective", "modelo gemini sintese cognitiva", "learning");

      const candidates = dbOrdered.findReconciliationCandidates("collective", FACT_B);
      expect(candidates.length).toBe(3);
      // Precondição: score e confirmações iguais nos três candidatos.
      expect(new Set(candidates.map((c) => c.score)).size).toBe(1);
      expect(new Set(candidates.map((c) => c.confirmations)).size).toBe(1);

      const similarities = candidates.map((c) =>
        jaccardSimilarity(tokenizeFact(FACT_B), tokenizeFact(c.fact))
      );
      // Contrato central: ordenação estritamente não-crescente.
      for (let i = 1; i < similarities.length; i++) {
        expect(similarities[i]!).toBeLessThanOrEqual(similarities[i - 1]!);
      }
      expect(candidates.map((c) => c.fact)).toEqual([
        FACT_B,
        "modelo gemini sintese cognitiva",
        FACT_A,
      ]);
      expect(similarities[0]).toBeCloseTo(1, 10);
    } finally {
      dbOrdered.close();
    }
  });

  test("1.5: fato vazio/sem tokens não produz candidatos (nunca lança)", () => {
    expect(db.findReconciliationCandidates(scope, "")).toEqual([]);
    expect(db.findReconciliationCandidates(scope, "   ")).toEqual([]);
    expect(db.findReconciliationCandidates(scope, "!!! ???")).toEqual([]);
    expect(db.findReconciliationCandidates("", FACT_A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cenário 2 — ISOLAMENTO ESTRITO DE ESCOPO (invariante central do ticket).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 2: isolamento estrito de escopo", () => {
  const SCOPES_DB_PATH = path.join(TEST_DIR, "scopes.db");
  const dbScoped = new DreamsDB(SCOPES_DB_PATH);
  const FACT_IDENTICAL = "regra fundamental do deploy exige revisao humana antes de publicar";

  beforeAll(() => {
    // Estado ADVERSARIAL materializado via segunda conexão REAL: o mesmo
    // texto EXATO (100% de similaridade léxica) em 'collective' e
    // 'agent:architect'. A API pública (insertMemory) promove/reforça entre
    // escopos por hierarquia cross-scope (TICKET-DREAMS-04) — mas a camada
    // de reconciliação precisa ser IMUNE mesmo que esse estado exista no
    // banco (importação de backup, migração, etc.).
    const raw = openRaw(SCOPES_DB_PATH);
    try {
      const now = new Date().toISOString();
      for (const targetScope of ["collective", "agent:architect"]) {
        raw.run(
          `INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
           VALUES (?, ?, 'decision', 2.0, 1.0, 0, 1, ?, ?)`,
          [targetScope, FACT_IDENTICAL, now, now]
        );
      }
    } finally {
      raw.close();
    }
  });

  afterAll(() => {
    dbScoped.close();
  });

  test("2.1: o texto idêntico existe em 'collective' E em 'agent:architect'", () => {
    const rows = dbScoped.getAllMemories().filter((m) => m.fact === FACT_IDENTICAL);
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toEqual(["agent:architect", "collective"]);
  });

  test("2.2: 'agent:reviewer' NUNCA recebe candidatos de 'collective' nem de 'agent:architect'", () => {
    const candidates = dbScoped.findReconciliationCandidates("agent:reviewer", FACT_IDENTICAL);
    expect(candidates).toEqual([]);
  });

  test("2.3: cada escopo devolve SOMENTE os candidatos do PRÓPRIO escopo", () => {
    const collective = dbScoped.findReconciliationCandidates("collective", FACT_IDENTICAL);
    expect(collective.length).toBe(1);
    expect(collective[0]!.scope).toBe("collective");

    const architect = dbScoped.findReconciliationCandidates("agent:architect", FACT_IDENTICAL);
    expect(architect.length).toBe(1);
    expect(architect[0]!.scope).toBe("agent:architect");

    const reviewer = dbScoped.findReconciliationCandidates("agent:reviewer", FACT_IDENTICAL);
    expect(reviewer.every((c) => c.scope === "agent:reviewer")).toBe(true);
  });

  test("2.4: a fusão NUNCA expurga registro de outro escopo", () => {
    const architectId = dbScoped.getAllMemories().find(
      (m) => m.scope === "agent:architect" && m.fact === FACT_IDENTICAL
    )!.id!;
    const collectiveId = dbScoped.getAllMemories().find(
      (m) => m.scope === "collective" && m.fact === FACT_IDENTICAL
    )!.id!;

    // Fusão INDESMENTIDA: o alvo é de 'collective', o candidato é de 'agent:architect'.
    // O registro de 'agent:architect' NÃO pode ser tocado (isolamento).
    dbScoped.mergeMemories(
      collectiveId,
      { fact: FACT_IDENTICAL, category: "decision", scope: "agent:architect" },
      "regra fundamental do deploy exige revisao humana e aprovacao do lead"
    );

    expect(dbScoped.getMemoryById(architectId)).toBeDefined();
    expect(dbScoped.getMemoryById(architectId)!.scope).toBe("agent:architect");
    expect(dbScoped.getMemoryById(architectId)!.fact).toBe(FACT_IDENTICAL);
    expect(dbScoped.getMemoryById(collectiveId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cenário 3 — `reinforceMemory` (bônus limitado).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 3: reinforceMemory", () => {
  const dbReinforce = new DreamsDB(path.join(TEST_DIR, "reinforce.db"));

  afterAll(() => {
    dbReinforce.close();
  });

  test("3.1: confirmações +1 e score +0.5, com last_reinforced = now", () => {
    const id = dbReinforce.insertMemory("collective", "regra de reprodutibilidade local", "decision");
    const before = dbReinforce.getMemoryById(id)!;
    const stamp = "2030-01-02T03:04:05.000Z";

    dbReinforce.reinforceMemory(before, stamp);

    const after = dbReinforce.getMemoryById(id)!;
    expect(after.confirmations).toBe(before.confirmations + 1);
    expect(after.score).toBeCloseTo(before.score + 0.5, 10);
    expect(after.last_reinforced).toBe(stamp);
  });

  test("3.2: tetos canônicos — confirmações no máximo 10 e score no máximo 5.0", () => {
    const id = dbReinforce.insertMemory("agent:reviewer", "preferencia maxima de titulo", "preference", 5.0, 0.1);
    const record = dbReinforce.getMemoryById(id)!;

    for (let i = 0; i < 15; i++) {
      dbReinforce.reinforceMemory(dbReinforce.getMemoryById(id)!);
    }

    const after = dbReinforce.getMemoryById(id)!;
    expect(after.confirmations).toBe(DreamsDB.MAX_CONFIRMATIONS);
    expect(after.confirmations).toBe(10);
    expect(after.score).toBe(DreamsDB.MAX_SCORE);
    expect(after.score).toBe(5.0);
    expect(record.confirmations).toBe(1);
  });

  test("3.3: 'now' ausente usa o instante corrente (ISO-8601)", () => {
    const id = dbReinforce.insertMemory("collective", "fato com now implicito", "learning");
    const before = Date.now();
    dbReinforce.reinforceMemory(dbReinforce.getMemoryById(id)!);
    const after = dbReinforce.getMemoryById(id)!;
    const parsed = Date.parse(after.last_reinforced);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before - 2000);
  });
});

// ---------------------------------------------------------------------------
// Cenário 4 — `supersedeMemory` (remoção física da diretriz revogada).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 4: supersedeMemory", () => {
  const dbSupersede = new DreamsDB(path.join(TEST_DIR, "supersede.db"));
  const OLD_FACT = "publicar deploys somente as tercas feiras as manhas";
  const NEW_FACT = "publicar deploys somente as quartas feiras as manhas";

  afterAll(() => {
    dbSupersede.close();
  });

  test("4.1: a diretriz revogada é removida FISICAMENTE e a nova entra no lugar", () => {
    const oldId = dbSupersede.insertMemory("collective", OLD_FACT, "decision");
    expect(dbSupersede.getMemoryById(oldId)).toBeDefined();

    const newId = dbSupersede.supersedeMemory(oldId, NEW_FACT, "decision", "collective");

    // A diretriz antiga NÃO existe mais — nem o id, nem o texto.
    expect(dbSupersede.getMemoryById(oldId)).toBeNull();
    expect(dbSupersede.getAllMemories().some((m) => m.fact === OLD_FACT)).toBe(false);

    // A diretriz nova existe e é a única do escopo.
    const created = dbSupersede.getMemoryById(newId);
    expect(created).toBeDefined();
    expect(created!.fact).toBe(NEW_FACT);
    expect(created!.scope).toBe("collective");
    expect(created!.category).toBe("decision");
    expect(dbSupersede.getAllMemories().filter((m) => m.scope === "collective").length).toBe(1);
  });

  test("4.2: o índice FTS5 é REINDEXADO (fato novo encontrado, fato antigo não)", () => {
    const found = dbSupersede.recall("quartas feiras manhas", "collective");
    expect(found.some((r) => r.fact === NEW_FACT)).toBe(true);
    expect(found.some((r) => r.fact === OLD_FACT)).toBe(false);
  });

  test("4.3: os metadados de relevância são HERDADOS e last_reinforced é atualizado", () => {
    const oldId = dbSupersede.insertMemory("collective", "usar cache local para evitar roundtrip", "preference");
    // Instante FIXO para o reforço: garante que o carimbo da revogação
    // (instante corrente) seja observavelmente diferente do herdado.
    const stamp = "2026-01-01T01:01:01.000Z";
    dbSupersede.reinforceMemory(dbSupersede.getMemoryById(oldId)!, stamp);
    const before = dbSupersede.getMemoryById(oldId)!;
    expect(before.last_reinforced).toBe(stamp);

    const newId = dbSupersede.supersedeMemory(oldId, "usar cache local com invalidacao por ttl", "preference", "collective");
    const after = dbSupersede.getMemoryById(newId)!;

    expect(after.score).toBe(before.score);
    expect(after.confirmations).toBe(before.confirmations);
    expect(after.created_at).toBe(before.created_at);
    expect(after.last_reinforced).not.toBe(stamp);
    expect(Date.parse(after.last_reinforced)).toBeGreaterThan(Date.parse(stamp));
  });

  test("4.4: revogar memória inexistente falha SEMANTICAMENTE (nada é criado)", () => {
    const before = dbSupersede.getAllMemories().length;
    expect(() => dbSupersede.supersedeMemory(999999, NEW_FACT, "decision", "collective")).toThrow(
      ReconciliationError
    );
    expect(dbSupersede.getAllMemories().length).toBe(before);
  });

  test("4.5: o fato substituto é redigido (idempotência) e o escopo é respeitado", () => {
    const oldId = dbSupersede.insertMemory("agent:reviewer", "chave de api rotacionada mensalmente", "pitfall");
    const newId = dbSupersede.supersedeMemory(
      oldId,
      `chave ${FAKE_KEY} rotacionada mensalmente`,
      "pitfall",
      "agent:reviewer"
    );
    const created = dbSupersede.getMemoryById(newId)!;
    expect(created.fact).toBe(redactSecrets(`chave ${FAKE_KEY} rotacionada mensalmente`));
    expect(created.fact).not.toContain(FAKE_KEY);
    expect(created.scope).toBe("agent:reviewer");
  });
});

// ---------------------------------------------------------------------------
// Cenário 5 — `mergeMemories` (fusão sintética com bônus).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 5: mergeMemories", () => {
  const dbMerge = new DreamsDB(path.join(TEST_DIR, "merge.db"));
  // Os DOIS fatos têm sobreposição lexical ~0.58 — abaixo de 0.80, logo o
  // `insertMemory` NÃO os colapsa (seriam o mesmo registro) e a fusão parte
  // de duas memórias realmente DISTINTAS.
  const EXISTING_FACT = "backup do banco de memorias roda todo dia as 3h";
  const CANDIDATE_FACT = "backup do banco de memorias roda semanalmente as 4h";
  const MERGED_FACT = "backup do banco de memorias roda todo dia as 3h com retencao de 30 dias";

  afterAll(() => {
    dbMerge.close();
  });

  test("5.1: score = min(5.0, max(score_A, score_B) + 0.5) e confirmations = max + 1", () => {
    // Instante FIXO para o carimbo original: garante que o `last_reinforced`
    // gravado pelo merge (instante corrente) seja observavelmente posterior,
    // independentemente da velocidade da máquina ou do runner de CI.
    const SENTINEL = "2026-01-01T00:00:00.000Z";
    const existingId = dbMerge.insertMemory("collective", EXISTING_FACT, "decision", 2.0, 0.3);
    const candidateId = dbMerge.insertMemory("collective", CANDIDATE_FACT, "decision", 3.0, 0.3);
    // Pré-condição: as duas memórias são registros DISTINTOS (sem colapso).
    expect(candidateId).not.toBe(existingId);
    rawRun(dbMerge, "UPDATE memories SET last_reinforced = ? WHERE id = ?", [SENTINEL, existingId]);
    const existing = dbMerge.getMemoryById(existingId)!;
    const candidate = dbMerge.getMemoryById(candidateId)!;
    expect(existing.score).toBe(2.0);
    expect(candidate.score).toBe(3.0);
    expect(existing.last_reinforced).toBe(SENTINEL);

    const mergedId = dbMerge.mergeMemories(
      existingId,
      { fact: candidate.fact, category: candidate.category, scope: candidate.scope, score: candidate.score, confirmations: candidate.confirmations },
      MERGED_FACT
    );

    expect(mergedId).toBe(existingId);
    const merged = dbMerge.getMemoryById(existingId)!;
    const expectedScore = Math.min(5.0, Math.max(existing.score, candidate.score) + 0.5);
    const expectedConfirmations = Math.max(existing.confirmations, candidate.confirmations) + 1;
    expect(merged.score).toBeCloseTo(expectedScore, 10);
    expect(merged.score).toBeCloseTo(3.5, 10); // max(2.0, 3.0) + 0.5
    expect(merged.confirmations).toBe(expectedConfirmations);
    expect(merged.confirmations).toBe(2); // max(1, 1) + 1
    expect(merged.fact).toBe(MERGED_FACT);
    expect(merged.last_reinforced).not.toBe(existing.last_reinforced);
    expect(merged.last_reinforced).not.toBe(SENTINEL);
    expect(Date.parse(merged.last_reinforced)).toBeGreaterThan(Date.parse(SENTINEL));
  });

  test("5.1b: o bônus de score é TETADO em 5.0 (nunca ultrapassa o teto)", () => {
    const existingId = dbMerge.insertMemory("agent:reviewer", "prioridade maxima de deploy no cluster", "preference", 4.9, 0.1);
    const candidateId = dbMerge.insertMemory("agent:reviewer", "prioridade maxima de deploy no servidor", "preference", 4.9, 0.1);
    expect(candidateId).not.toBe(existingId);

    dbMerge.mergeMemories(
      existingId,
      {
        fact: dbMerge.getMemoryById(candidateId)!.fact,
        category: "preference",
        scope: "agent:reviewer",
        score: 4.9,
        confirmations: 4,
      },
      "prioridade maxima de deploy no cluster e no servidor"
    );

    const merged = dbMerge.getMemoryById(existingId)!;
    expect(merged.score).toBe(DreamsDB.MAX_SCORE);
    expect(merged.score).toBe(5.0);
    // confirmations = max(1, 4) + 1
    expect(merged.confirmations).toBe(5);
  });

  test("5.2: o id redundante do candidato é DELETADO (sem órfãos)", () => {
    const existingId = dbMerge.insertMemory("collective", "cache de build invalida por checksum", "learning");
    const candidateId = dbMerge.insertMemory("collective", "cache de build invalida por hash do artefato", "learning");
    const totalBefore = dbMerge.getAllMemories().length;

    dbMerge.mergeMemories(
      existingId,
      {
        fact: dbMerge.getMemoryById(candidateId)!.fact,
        category: "learning",
        scope: "collective",
        score: 1.0,
        confirmations: 1,
      },
      "cache de build invalida por checksum do artefato"
    );

    expect(dbMerge.getMemoryById(candidateId)).toBeNull();
    expect(dbMerge.getAllMemories().length).toBe(totalBefore - 1);
    expect(dbMerge.getMemoryById(existingId)!.fact).toBe("cache de build invalida por checksum do artefato");
  });

  test("5.3: o índice FTS5 aponta para o fato unificado (o antigo some, o novo entra)", () => {
    const existingId = dbMerge.insertMemory("collective", "metricas de latencia sao publishadas no painel", "learning");
    const candidateId = dbMerge.insertMemory("collective", "metricas de latencia aparecem no painel interno", "learning");

    dbMerge.mergeMemories(
      existingId,
      {
        fact: dbMerge.getMemoryById(candidateId)!.fact,
        category: "learning",
        scope: "collective",
        score: 1.0,
        confirmations: 1,
      },
      "metricas de latencia sao publishadas no painel interno do time"
    );

    const hits = dbMerge.recall("metricas latencia painel", "collective").map((r) => r.fact);
    expect(hits.some((f) => f === "metricas de latencia sao publishadas no painel interno do time")).toBe(true);
    expect(hits.some((f) => f === "metricas de latencia aparecem no painel interno")).toBe(false);
  });

  test("5.4: o escopo e a categoria da memória sobrevivente são PRESERVADOS", () => {
    const existingId = dbMerge.insertMemory("agent:architect", "relatorio de incidente sai toda sexta", "pitfall");
    const candidateId = dbMerge.insertMemory("agent:architect", "relatorio de incidente sai todo dia util", "pitfall");

    dbMerge.mergeMemories(
      existingId,
      {
        fact: dbMerge.getMemoryById(candidateId)!.fact,
        category: "learning",
        scope: "agent:architect",
        score: 1.0,
        confirmations: 1,
      },
      "relatorio de incidente sai toda sexta com resumo executivo"
    );

    const merged = dbMerge.getMemoryById(existingId)!;
    expect(merged.scope).toBe("agent:architect");
    expect(merged.category).toBe("pitfall");
  });

  test("5.5: o fato unificado é redigido antes de tocar o disco", () => {
    const existingId = dbMerge.insertMemory("agent:reviewer", "segredo de build fica no cofre", "pitfall");
    const mergedId = dbMerge.mergeMemories(
      existingId,
      { fact: "segredo de build fica no cofre", category: "pitfall", scope: "agent:reviewer" },
      `segredo de build ${FAKE_KEY} fica no cofre`
    );
    const merged = dbMerge.getMemoryById(mergedId)!;
    expect(merged.fact).toBe(redactSecrets(`segredo de build ${FAKE_KEY} fica no cofre`));
    expect(merged.fact).not.toContain(FAKE_KEY);
  });

  test("5.6: fundir em memória inexistente falha SEMANTICAMENTE e não apaga o candidato", () => {
    const candidateId = dbMerge.insertMemory("collective", "candidato orfao de teste de falha", "learning");
    const before = dbMerge.getMemoryById(candidateId)!;

    expect(() =>
      dbMerge.mergeMemories(
        999999,
        { fact: before.fact, category: before.category, scope: before.scope },
        "fato unificado que nunca deve ser gravado"
      )
    ).toThrow(ReconciliationError);

    // Rollback total: o candidato segue íntegro e nenhum "fato unificado" vazou.
    expect(dbMerge.getMemoryById(candidateId)).toBeDefined();
    expect(dbMerge.getAllMemories().some((m) => m.fact === "fato unificado que nunca deve ser gravado")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cenário 6 — Atomicidade transacional (rollback total).
// ---------------------------------------------------------------------------
describe("DREAMS-06A — Cenário 6: atomicidade transacional", () => {
  const ATOMIC_DB_PATH = path.join(TEST_DIR, "atomic.db");
  const dbAtomic = new DreamsDB(ATOMIC_DB_PATH);
  const SURVIVOR_FACT = "revisao de codigo exige dois aprovadores na main";
  const CANDIDATE_FACT = "revisao de codigo exige tres aprovadores antes do merge";

  afterAll(() => {
    dbAtomic.close();
  });

  test("6.1: falha NO MEIO do merge ⇒ rollback TOTAL (nada é gravado, nada é expurgado)", () => {
    const existingId = dbAtomic.insertMemory("collective", SURVIVOR_FACT, "decision");
    const candidateId = dbAtomic.insertMemory("collective", CANDIDATE_FACT, "decision");
    const before = dbAtomic.getMemoryById(existingId)!;

    // Falha REAL do motor: trigger BEFORE UPDATE que ABORTA a transação no meio.
    const raw = openRaw(ATOMIC_DB_PATH);
    try {
      raw.exec(`
        CREATE TRIGGER fail_merge_midway BEFORE UPDATE ON memories
        WHEN OLD.id = ${existingId}
        BEGIN
          SELECT RAISE(ABORT, 'falha simulada no meio do merge');
        END;
      `);

      expect(() =>
        dbAtomic.mergeMemories(
          existingId,
          { fact: CANDIDATE_FACT, category: "decision", scope: "collective", score: 1.0, confirmations: 1 },
          "revisao de codigo exige aprovadores na main branch"
        )
      ).toThrow();
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS fail_merge_midway;");
      raw.close();
    }

    // Rollback TOTAL: a memória sobrevivente está INTACTA.
    const after = dbAtomic.getMemoryById(existingId)!;
    expect(after.fact).toBe(before.fact);
    expect(after.score).toBe(before.score);
    expect(after.confirmations).toBe(before.confirmations);
    expect(after.last_reinforced).toBe(before.last_reinforced);

    // O candidato redundante NÃO foi expurgado (o DELETE veio depois do UPDATE).
    expect(dbAtomic.getMemoryById(candidateId)).toBeDefined();
    expect(dbAtomic.getMemoryById(candidateId)!.fact).toBe(CANDIDATE_FACT);

    // E o índice FTS5 segue consistente com o conteúdo (integrity_check = ok).
    const rawCheck = openRaw(ATOMIC_DB_PATH);
    try {
      const integrity = rawCheck.query("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");
      const hits = dbAtomic.recall("aprovadores revisao", "collective").map((r) => r.fact);
      expect(hits.some((f) => f === SURVIVOR_FACT)).toBe(true);
      expect(hits.some((f) => f === CANDIDATE_FACT)).toBe(true);
    } finally {
      rawCheck.close();
    }

    // PROVA DE QUE A TRANSAÇÃO FOI REALMENTE ENCERRADA: a escrita subsequente
    // precisa ser COMMITADA e VISÍVEL de outra conexão. Se o ROLLBACK tivesse
    // sido omitido, a transação ficaria ABERTA, a escrita seguinte entraria
    // nela (pendente, invisível para fora) e esta asserção falharia.
    const probeId = dbAtomic.insertMemory("collective", "probe de commit apos falha transacional", "learning");
    const rawProbe = openRaw(ATOMIC_DB_PATH);
    try {
      const visible = rawProbe
        .query("SELECT COUNT(*) AS c FROM memories WHERE id = ?")
        .get(probeId) as { c: number };
      expect(visible.c).toBe(1);
    } finally {
      rawProbe.close();
    }
  });

  test("6.2: a transação de supersede é atômica (falha ⇒ diretriz antiga preservada)", () => {
    const oldId = dbAtomic.insertMemory("collective", "publicar em Fridays exige checklist", "decision");
    const before = dbAtomic.getMemoryById(oldId)!;

    const raw = openRaw(ATOMIC_DB_PATH);
    try {
      raw.exec(`
        CREATE TRIGGER fail_supersede_insert AFTER INSERT ON memories
        WHEN NEW.scope = 'agent:architect'
        BEGIN
          SELECT RAISE(ABORT, 'falha simulada na insercao da diretriz nova');
        END;
      `);

      expect(() =>
        dbAtomic.supersedeMemory(oldId, "publicar em sextas exige checklist", "decision", "agent:architect")
      ).toThrow();
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS fail_supersede_insert;");
      raw.close();
    }

    // A diretriz revogada continua viva: o DELETE foi desfeito pelo ROLLBACK.
    const after = dbAtomic.getMemoryById(oldId);
    expect(after).toBeDefined();
    expect(after!.fact).toBe(before.fact);
    expect(dbAtomic.getAllMemories().some((m) => m.fact === "publicar em sextas exige checklist")).toBe(false);

    // Mesma prova de encerramento da transação: a escrita seguinte é
    // commitada e visível de outra conexão.
    const probeId = dbAtomic.insertMemory("collective", "probe de commit apos falha de supersede", "learning");
    const rawProbe = openRaw(ATOMIC_DB_PATH);
    try {
      const visible = rawProbe
        .query("SELECT COUNT(*) AS c FROM memories WHERE id = ?")
        .get(probeId) as { c: number };
      expect(visible.c).toBe(1);
    } finally {
      rawProbe.close();
    }
  });
});
