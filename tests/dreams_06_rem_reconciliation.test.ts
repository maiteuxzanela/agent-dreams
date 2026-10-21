/**
 * TICKET-DREAMS-06 — Suíte determinística SDET (independente) do Sono REM
 * reconciliador: triagem léxica, isolamento de escopo, atomicidade
 * transacional, bônus de score e julgamento neural das 4 ações.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ANTI-MOCK (política do Pool Global): esta suíte NÃO usa `mock.module`,
 * `spyOn`, stubs de módulo ou fixtures falsas de framework. Tudo o que é
 * exercitado aqui é o sistema real:
 *   - `bun:sqlite` REAL (arquivo em disco sob /tmp, nunca o banco de produção);
 *   - SEGUNDA CONEXÃO REAL ao MESMO arquivo, para induzir falhas do MOTOR
 *     (trigger `RAISE(ABORT)`) e observar o estado committed de fora;
 *   - BINÁRIO EXTERNO REAL (script executável apontado por `OPENCODE_BIN`),
 *     que recebe o prompt no stdin e devolve JSON no stdout — é o mesmo seam
 *     de transporte já usado pelo resto do projeto, apenas com o conteúdo do
 *     prompt decido pelo próprio binário (sem mock de módulo).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTA SUÍTE EXISTE (é ORTogonal às suítes do implementador):
 *   A. LIMIAR EXATO: o contrato do ticket é "Jaccard >= 15%". As suítes
 *      existentes usam pares de 0.294/0.111 — folga larga. Aqui os pares são
 *      calibrados para 0.150000 EXATO (3/20) e 0.142857 (3/21), travando o
 *      limite INCLUSIVO (`>=`) do contrato.
 *   B. ISOLAMENTO SOB PRESSÃO MÁXIMA: o mesmo texto (Jaccard = 1.0) em três
 *      escopos simultâneos. Só o filtro de escopo pode impedir o cruzamento.
 *   C. ATOMICIDADE DEPOIS DO DELETE: o teste de supersede aborta a INSERÇÃO
 *      (o DELETE já tinha acontecido) — sem transação, a diretriz antiga seria
 *      PERDIDA. É o discriminador que prova o `BEGIN IMMEDIATE`.
 *   D. MATEMÁTICA DO BÔNUS: tabela com (score_A, score_B) e
 *      (confirmations_A, confirmations_B) — incluindo o caso em que o
 *      CANDIDATO tem score/confirmações MAIORES que o existente (onde um
 *      `max` trocado por um `existing` passa despercebido).
 *   E. JULGAMENTO NEURAL POR CONTEÚDO: o binário fixture decide a ação de
 *      cada par pelo TEXTO da candidata (marcadores), não por índice — o teste
 *      não depende da ordem de emparelhamento.
 *   F. OFFLINE: o binário NUNCA é invocado e o handoff permanece íntegro.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import {
  DreamsDB,
  RECONCILIATION_SIMILARITY_THRESHOLD,
  jaccardSimilarity,
  tokenizeFact,
  type MemoryRecord,
} from "../src/core/db";
import {
  parseReconciliationDecisions,
  reconcileMemoriesBatch,
  independentFallbackDecisions,
  type ReconciliationPair,
} from "../src/core/mimo_synthesizer";
import { SleepCycle } from "../src/core/sleep_cycle";

// ---------------------------------------------------------------------------
// Infraestrutura hermética: TUDO sob /tmp, banco por cenário.
// ---------------------------------------------------------------------------
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_06_rem_"));

/** Conexão REAL extra ao MESMO arquivo do banco (estado adversarial). */
function openRaw(dbPath: string): Database {
  const raw = new Database(dbPath);
  raw.exec("PRAGMA busy_timeout = 5000;");
  return raw;
}

/** Escreve score/confirmations EXATOS (controle determinístico da matemática). */
function forceMetrics(dbPath: string, id: number, score: number, confirmations: number): void {
  const raw = openRaw(dbPath);
  try {
    raw.run("UPDATE memories SET score = ?, confirmations = ? WHERE id = ?", [
      score,
      confirmations,
      id,
    ]);
  } finally {
    raw.close();
  }
}

/** Executa `fn` com o ambiente controlado, restaurando tudo ao final. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Binário EXTERNO REAL (fixture de transporte). Não é mock: é um processo
// independente que lê o prompt no stdin e escreve JSON no stdout.
// ---------------------------------------------------------------------------
interface BinaryFixture {
  dir: string;
  bin: string;
  /** Quantas vezes o binário foi invocado (contador em disco, real). */
  count: () => number;
  /** Conteúdo REAL do stdin da N-ª invocação (prova de que houve transporte). */
  stdin: (seq: number) => string;
}

/**
 * Cria o fixture. `reconMode`:
 *   - "normal"  → decide a ação de cada par pelo marcador textual da candidata;
 *   - "invalid" → devolve lixo (não-JSON) no julgamento ⇒ fallback determinístico.
 */
function makeBinaryFixture(name: string, memoriesJson: string, reconMode: "normal" | "invalid"): BinaryFixture {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const memoriesFile = path.join(dir, "memories.json");
  fs.writeFileSync(memoriesFile, memoriesJson, "utf-8");
  if (reconMode === "invalid") {
    fs.writeFileSync(path.join(dir, "recon_mode"), "invalid", "utf-8");
  }

  const bin = path.join(dir, "opencode_fixture.sh");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `DIR="${dir}"`,
      'N=$(( $(cat "$DIR/count" 2>/dev/null || echo 0) + 1 ))',
      'printf "%s" "$N" > "$DIR/count"',
      'cat > "$DIR/stdin_$N.log"',
      'if grep -q "Reconciliador Cognitivo" "$DIR/stdin_$N.log"; then',
      '  if [ -f "$DIR/recon_mode" ]; then',
      '    printf "isto nao e um json valido para o reconciliador"',
      "  else",
      "    printf '['",
      "    awk '",
      "      BEGIN { first = 1 }",
      '      /^\\[par [0-9]+\\]/ { idx=$2; sub(/\\].*$/,"",idx); next }',
      '      /^candidata: / {',
      '        fact=$0; sub(/^candidata: /,"",fact);',
      '        action="independent"; merged="";',
      '        if (index(fact,"ACAO REINFORCE")>0) action="reinforce";',
      '        else if (index(fact,"ACAO SUPERSEDE")>0) action="supersede";',
      '        else if (index(fact,"ACAO MERGE")>0) { action="merge"; merged="latencia painel interno metricas e observabilidade externa consolidada"; }',
      '        else if (index(fact,"ACAO INDEPENDENT")>0) action="independent";',
      '        item="{\\"pair\\":" idx ",\\"action\\":\\"" action "\\"}";',
      '        if (merged!="") item="{\\"pair\\":" idx ",\\"action\\":\\"" action "\\",\\"merged_fact\\":\\"" merged "\\"}";',
      '        if (!first) printf ",";',
      '        printf "%s", item;',
      '        first=0;',
      "      }",
      "    ' \"$DIR/stdin_$N.log\"",
      "    printf ']'",
      "  fi",
      "else",
      '  cat "$DIR/memories.json"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  return {
    dir,
    bin,
    count: () => {
      try {
        return Number(fs.readFileSync(path.join(dir, "count"), "utf-8"));
      } catch {
        return 0;
      }
    },
    stdin: (seq: number) => {
      const file = path.join(dir, `stdin_${seq}.log`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    },
  };
}

/** Cria um "dreams dir" isolado com o handoff Light→REM pendente. */
function makeDreamsDir(name: string): string {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dialogue_pending.txt"), "MANHA: sessao de trabalho da manha.", "utf-8");
  return dir;
}

// ===========================================================================
// CENÁRIO A — TRIAGEM LÉXICA: o limiar de 15% é INCLUSIVO e exato.
// ===========================================================================

/** Âncora com 13 tokens distintos. */
const ANCHOR_13 =
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
/** 3 tokens compartilhados + 7 novos = 10 tokens ⇒ Jaccard = 3/20 = 0.15 EXATO. */
const EXACT_15 = "alpha bravo charlie november oscar papa quebec romeo sierra tango";
/** 3 tokens compartilhados + 8 novos = 11 tokens ⇒ Jaccard = 3/21 = 0.142857. */
const BELOW_15 = "alpha bravo charlie november oscar papa quebec romeo sierra tango uniform";

const J_EXACT = jaccardSimilarity(tokenizeFact(ANCHOR_13), tokenizeFact(EXACT_15));
const J_BELOW = jaccardSimilarity(tokenizeFact(ANCHOR_13), tokenizeFact(BELOW_15));

describe("DREAMS-06 SDET — A: triagem léxica (limiar de 15% inclusivo e exato)", () => {
  const dbPath = path.join(TEST_DIR, "triage.db");
  const db = new DreamsDB(dbPath);
  let anchorId = 0;

  beforeAll(() => {
    anchorId = db.insertMemory("collective", ANCHOR_13, "learning");
  });

  afterAll(() => {
    db.close();
  });

  test("A.0: calibração — os dois pares ficam em lados OPOSTOS do limiar, sem folga", () => {
    // 0.15 EXATO (bit a bit igual ao literal 0.15 do contrato).
    expect(J_EXACT).toBe(0.15);
    expect(J_EXACT === 0.15).toBe(true);
    expect(J_EXACT).toBeGreaterThanOrEqual(RECONCILIATION_SIMILARITY_THRESHOLD);
    // Logo abaixo: 3/21 = 0.142857.
    expect(J_BELOW).toBeLessThan(RECONCILIATION_SIMILARITY_THRESHOLD);
    expect(J_BELOW).toBeCloseTo(3 / 21, 12);
    // O default público é exatamente 15%.
    expect(RECONCILIATION_SIMILARITY_THRESHOLD).toBe(0.15);
  });

  test("A.1: Jaccard EXATAMENTE 0.15 ⇒ o par É candidatado (>= é inclusivo)", () => {
    const candidates = db.findReconciliationCandidates("collective", EXACT_15);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.id).toBe(anchorId);
    expect(candidates[0]!.fact).toBe(ANCHOR_13);
  });

  test("A.2: Jaccard 0.142857 (imediatamente abaixo) ⇒ NENHUM candidato", () => {
    const candidates = db.findReconciliationCandidates("collective", BELOW_15);
    expect(candidates).toHaveLength(0);
  });

  test("A.3: o corte é determinístico e reproduzível (duas triagens ⇒ mesmo resultado)", () => {
    const first = db.findReconciliationCandidates("collective", EXACT_15).map((c) => c.id);
    const second = db.findReconciliationCandidates("collective", EXACT_15).map((c) => c.id);
    expect(first).toEqual(second);
    expect(first).toEqual([anchorId]);
  });

  test("A.4: o limiar é PARAMETRIZÁVEL — um limiar maior exclui o par de 0.15", () => {
    expect(db.findReconciliationCandidates("collective", EXACT_15, 0.16)).toHaveLength(0);
    expect(db.findReconciliationCandidates("collective", EXACT_15, 0.15)).toHaveLength(1);
    // Limiares absurdos são normalizados, não derrubam a triagem.
    expect(() => db.findReconciliationCandidates("collective", EXACT_15, 5)).not.toThrow();
    expect(() => db.findReconciliationCandidates("collective", EXACT_15, -1)).not.toThrow();
  });
});

// ===========================================================================
// CENÁRIO B — ISOLAMENTO ESTRITO DE ESCOPO (mesmo texto em 3 escopos).
// ===========================================================================

describe("DREAMS-06 SDET — B: isolamento ESTRITO de escopo", () => {
  const dbPath = path.join(TEST_DIR, "scopes.db");
  const db = new DreamsDB(dbPath);
  /** Texto IDÊNTICO nos três escopos ⇒ Jaccard = 1.0 (pressão máxima). */
  const SHARED = "protocolo de escala do cluster de producao exige duas liberacoes";
  let collectiveId = 0;
  let agentAId = 0;
  let agentBId = 0;

  beforeAll(() => {
    const insertDirect = (scope: string, fact: string) => {
      const now = new Date().toISOString();
      const res = (db as any).db
        .query(
          "INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at) VALUES (?, ?, 'decision', 1.0, 1.0, 0, 1, ?, ?)"
        )
        .run(scope, fact, now, now);
      return Number(res.lastInsertRowid);
    };
    collectiveId = insertDirect("collective", SHARED);
    agentAId = insertDirect("agent:a", SHARED);
    agentBId = insertDirect("agent:b", SHARED);
  });

  afterAll(() => {
    db.close();
  });

  test("B.1: cada escopo devolve SOMENTE o próprio registro (Jaccard = 1.0 entre eles)", () => {
    const forCollective = db.findReconciliationCandidates("collective", SHARED);
    const forAgentA = db.findReconciliationCandidates("agent:a", SHARED);
    const forAgentB = db.findReconciliationCandidates("agent:b", SHARED);

    // SENTINELA POSITIVA: cada escopo VÊ o seu próprio registro.
    expect(forCollective.map((c) => c.id)).toEqual([collectiveId]);
    expect(forAgentA.map((c) => c.id)).toEqual([agentAId]);
    expect(forAgentB.map((c) => c.id)).toEqual([agentBId]);
  });

  test("B.2: 'collective' NUNCA reconcilia com 'agent:*' e 'agent:a' NUNCA cruza com 'agent:b'", () => {
    const collectiveIds = db.findReconciliationCandidates("collective", SHARED).map((c) => c.id);
    const agentAIds = db.findReconciliationCandidates("agent:a", SHARED).map((c) => c.id);
    const agentBIds = db.findReconciliationCandidates("agent:b", SHARED).map((c) => c.id);

    expect(collectiveIds).not.toContain(agentAId);
    expect(collectiveIds).not.toContain(agentBId);
    expect(agentAIds).not.toContain(collectiveId);
    expect(agentAIds).not.toContain(agentBId);
    expect(agentBIds).not.toContain(collectiveId);
    expect(agentBIds).not.toContain(agentAId);
  });

  test("B.3: a fusão com candidato de OUTRO escopo NÃO expurga nem altera o registro alheio", () => {
    const before = db.getMemoryById(agentBId)!;
    const survivor = db.getMemoryById(collectiveId)!;

    // O candidato declarado é de 'agent:b' — escopo diferente do sobrevivente.
    const returned = db.mergeMemories(
      collectiveId,
      { fact: SHARED, category: "decision", scope: "agent:b", score: 1.0, confirmations: 1 },
      "protocolo de escala do cluster exige duas liberacoes e um registro"
    );
    expect(returned).toBe(collectiveId);

    // O registro de 'agent:b' INTACTO (não foi expurgado).
    const after = db.getMemoryById(agentBId)!;
    expect(after.fact).toBe(before.fact);
    expect(after.score).toBe(before.score);
    expect(after.confirmations).toBe(before.confirmations);
    expect(after.scope).toBe("agent:b");

    // O sobrevivente foi atualizado (a fusão happened) mas MANTENEU o escopo.
    const survivorAfter = db.getMemoryById(collectiveId)!;
    expect(survivorAfter.scope).toBe("collective");
    expect(survivorAfter.fact).toBe("protocolo de escala do cluster exige duas liberacoes e um registro");
    expect(survivor.score).toBeLessThan(survivorAfter.score); // bônus aplicado
  });

  test("B.4: a revogação grava no escopo pedido — nunca no escopo de outra persona", () => {
    const personaFact = "revogacao alvo de persona para prova de escopo";
    const personaId = db.insertMemory("agent:c", personaFact, "decision");
    const collectiveBefore = db.getAllMemories().filter((m) => m.scope === "collective").length;

    const newId = db.supersedeMemory(personaId, "revogacao substituta de persona", "decision", "agent:c");

    expect(db.getMemoryById(personaId)).toBeNull();
    const created = db.getMemoryById(newId)!;
    expect(created.scope).toBe("agent:c");
    expect(created.fact).toBe("revogacao substituta de persona");
    // Nenhum registro novo no coletivo.
    expect(db.getAllMemories().filter((m) => m.scope === "collective")).toHaveLength(collectiveBefore);
  });
});

// ===========================================================================
// CENÁRIO C — ATOMICIDADE TRANSACIONAL (falha REAL do motor SQLite).
// ===========================================================================

describe("DREAMS-06 SDET — C: atomicidade transacional (merge/supersede/reinforce)", () => {
  const dbPath = path.join(TEST_DIR, "atomic.db");
  const db = new DreamsDB(dbPath);

  const SURVIVOR = "revisao de codigo exige dois aprovadores na main";
  const CANDIDATE = "revisao de codigo exige tres aprovadores antes do merge";

  afterAll(() => {
    db.close();
  });

  test("C.1: merge com falha REAL NO MEIO ⇒ rollback TOTAL (nada gravado, nada expurgado)", () => {
    const survivorId = db.insertMemory("collective", SURVIVOR, "decision");
    const candidateId = db.insertMemory("collective", CANDIDATE, "decision");
    const before = db.getMemoryById(survivorId)!;

    // Falha REAL do motor: trigger BEFORE UPDATE que ABORTA a transação.
    const raw = openRaw(dbPath);
    try {
      raw.exec(`
        CREATE TRIGGER fail_merge_midway BEFORE UPDATE ON memories
        WHEN OLD.id = ${survivorId}
        BEGIN
          SELECT RAISE(ABORT, 'falha simulada no meio do merge');
        END;
      `);

      expect(() =>
        db.mergeMemories(
          survivorId,
          { fact: CANDIDATE, category: "decision", scope: "collective", score: 1.0, confirmations: 1 },
          "revisao de codigo exige aprovadores na main branch"
        )
      ).toThrow();
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS fail_merge_midway;");
      raw.close();
    }

    const after = db.getMemoryById(survivorId)!;
    expect(after.fact).toBe(before.fact);
    expect(after.score).toBe(before.score);
    expect(after.confirmations).toBe(before.confirmations);
    expect(after.last_reinforced).toBe(before.last_reinforced);

    // DISCRIMINADOR-CHAVE: o redundante NÃO foi expurgado (o DELETE vinha
    // depois do UPDATE abortado — sem transação ele seria efetivado).
    const candidate = db.getMemoryById(candidateId);
    expect(candidate).not.toBeNull();
    expect(candidate!.fact).toBe(CANDIDATE);

    // O índice FTS5 permanece consistente com o conteúdo.
    const hits = db.recall("revisao codigo aprovadores", "collective").map((r) => r.fact);
    expect(hits).toContain(SURVIVOR);
    expect(hits).toContain(CANDIDATE);

    // A TRANSAÇÃO FOI ENCERRADA: a escrita subsequente é COMMITADA e visível
    // de OUTRA conexão (se o ROLLBACK tivesse sido omitido, a transação ficaria
    // aberta e esta escrita ficaria pendente/invisível).
    const probeId = db.insertMemory("collective", "probe de commit apos falha transacional", "learning");
    const probeConn = openRaw(dbPath);
    try {
      const visible = probeConn
        .query("SELECT COUNT(*) AS c FROM memories WHERE id = ?")
        .get(probeId) as { c: number };
      expect(visible.c).toBe(1);
      const integrity = probeConn.query("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");
    } finally {
      probeConn.close();
    }
  });

  test("C.2: supersede com falha NA INSERÇÃO ⇒ o DELETE anterior é revertido (a diretriz NÃO se perde)", () => {
    const oldFact = "publicar em sextas exige checklist de qualidade aprovado";
    const oldId = db.insertMemory("collective", oldFact, "decision");
    const before = db.getMemoryById(oldId)!;

    // A falha vem DEPOIS do DELETE: o trigger aborta a INSERÇÃO do fato novo.
    const raw = openRaw(dbPath);
    try {
      raw.exec(`
        CREATE TRIGGER fail_supersede_insert BEFORE INSERT ON memories
        WHEN NEW.fact LIKE '%FLAGX%'
        BEGIN
          SELECT RAISE(ABORT, 'falha simulada na insercao do fato substituto');
        END;
      `);

      expect(() =>
        db.supersedeMemory(oldId, "fato substituto com FLAGX no texto", "decision", "collective")
      ).toThrow();
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS fail_supersede_insert;");
      raw.close();
    }

    // DISCRIMINADOR-CHAVE: a diretriz revogada NÃO pode ter sumido — o DELETE
    // que precedeu a falha precisa ter sido desfeito pelo ROLLBACK.
    const after = db.getMemoryById(oldId);
    expect(after).not.toBeNull();
    expect(after!.fact).toBe(oldFact);
    expect(after!.score).toBe(before.score);
    expect(after!.confirmations).toBe(before.confirmations);
    expect(after!.created_at).toBe(before.created_at);

    // O fato substituto NÃO foi gravado.
    expect(db.getAllMemories().some((m) => m.fact.includes("FLAGX"))).toBe(false);

    // O índice FTS5 ainda aponta para a diretriz original.
    const hits = db.recall("publicar sextas checklist", "collective").map((r) => r.fact);
    expect(hits).toContain(oldFact);
  });

  test("C.3: reinforce com falha REAL ⇒ NENHUMA métrica é alterada", () => {
    const fact = "rotina de backup noturno roda sem intervencao humana";
    const id = db.insertMemory("collective", fact, "learning");
    const before = db.getMemoryById(id)!;

    const raw = openRaw(dbPath);
    try {
      raw.exec(`
        CREATE TRIGGER fail_reinforce BEFORE UPDATE ON memories
        WHEN OLD.id = ${id}
        BEGIN
          SELECT RAISE(ABORT, 'falha simulada no reforco');
        END;
      `);

      expect(() => db.reinforceMemory(before)).toThrow();
    } finally {
      raw.exec("DROP TRIGGER IF EXISTS fail_reinforce;");
      raw.close();
    }

    const after = db.getMemoryById(id)!;
    expect(after.score).toBe(before.score);
    expect(after.confirmations).toBe(before.confirmations);
    expect(after.last_reinforced).toBe(before.last_reinforced);
  });

  test("C.4: a transação é RE-ENTRANTE — uma escrita aninhada participa da externa", () => {
    // `runExclusiveTransaction` é reentrante: abrir BEGIN aninhado seria erro
    // do SQLite ("cannot start a transaction within a transaction").
    const id = db.insertMemory("collective", "memoria para reforco aninhado real", "learning");
    const record = db.getMemoryById(id)!;
    expect(() => {
      db.reinforceMemory(record);
      db.reinforceMemory(db.getMemoryById(id)!);
    }).not.toThrow();
    const after = db.getMemoryById(id)!;
    expect(after.confirmations).toBe(record.confirmations + 2);
  });
});

// ===========================================================================
// CENÁRIO D — BÔNUS DE SCORE E UNIFICAÇÃO DE CONFIRMAÇÕES no mergeMemories.
// ===========================================================================

describe("DREAMS-06 SDET — D: bônus de score e unificação de confirmações", () => {
  const dbPath = path.join(TEST_DIR, "merge_math.db");
  const db = new DreamsDB(dbPath);
  let counter = 0;

  afterAll(() => {
    db.close();
  });

  /** Insere um par survivor/candidate controlado e funde. */
  function mergeWith(
    existingScore: number,
    existingConfirmations: number,
    candidateScore: number,
    candidateConfirmations: number
  ): MemoryRecord {
    counter++;
    const survivorFact = `sobrevivente matematico caso ${counter} com marca unica xyz`;
    const candidateFact = `candidato matematico caso ${counter} com marca unica xyz`;
    const survivorId = db.insertMemory("collective", survivorFact, "decision");
    const candidateId = db.insertMemory("collective", candidateFact, "decision");
    forceMetrics(dbPath, survivorId, existingScore, existingConfirmations);
    forceMetrics(dbPath, candidateId, candidateScore, candidateConfirmations);

    const merged = db.mergeMemories(
      survivorId,
      {
        fact: candidateFact,
        category: "decision",
        scope: "collective",
        score: candidateScore,
        confirmations: candidateConfirmations,
      },
      `fato unificado matematico caso ${counter} com marca unica xyz`
    );
    expect(merged).toBe(survivorId);
    return db.getMemoryById(survivorId)!;
  }

  test("D.1: score = min(5.0, max(score_A, score_B) + 0.5) — tabela completa", () => {
    // A soma usa o MAIOR entre os dois lados (o bônus é o do mais relevante).
    expect(mergeWith(1.0, 1, 1.0, 1).score).toBeCloseTo(1.5, 10);
    expect(mergeWith(2.0, 1, 1.0, 1).score).toBeCloseTo(2.5, 10);
    expect(mergeWith(1.0, 1, 3.0, 1).score).toBeCloseTo(3.5, 10);
    expect(mergeWith(3.0, 1, 2.0, 1).score).toBeCloseTo(3.5, 10);
  });

  test("D.2: o bônus é TETADO em 5.0 (nunca ultrapassa o teto canônico)", () => {
    expect(mergeWith(4.8, 1, 1.0, 1).score).toBeCloseTo(5.0, 10);
    expect(mergeWith(5.0, 1, 5.0, 1).score).toBeCloseTo(5.0, 10);
    expect(mergeWith(1.0, 1, 9.0, 1).score).toBeCloseTo(5.0, 10);
  });

  test("D.3: confirmations = max(confirmations_A, confirmations_B) + 1", () => {
    expect(mergeWith(1.0, 1, 1.0, 1).confirmations).toBe(2);
    expect(mergeWith(1.0, 3, 1.0, 1).confirmations).toBe(4);
    expect(mergeWith(1.0, 1, 1.0, 5).confirmations).toBe(6);
    expect(mergeWith(1.0, 4, 1.0, 7).confirmations).toBe(8);
  });

  test("D.4: as confirmações também são TETADAS em 10 (MAX_CONFIRMATIONS)", () => {
    // TICKET-DREAMS-06-FIX (BLOQUEANTE 2): o caso DISCRIMINADOR é o par já
    // saturado. Antes do teto, max(10, 10) + 1 = 11 (e crescia sem limite a
    // cada nova fusão); agora satura EXATAMENTE no teto canônico.
    expect(mergeWith(1.0, 10, 1.0, 10).confirmations).toBe(10);
    expect(mergeWith(1.0, 10, 1.0, 12).confirmations).toBe(10);
    // Abaixo do teto o +1 continua valendo (o teto não congela o contador).
    expect(mergeWith(1.0, 8, 1.0, 9).confirmations).toBe(10);
    expect(mergeWith(1.0, 1, 1.0, 1).confirmations).toBe(2);
  });

  test("D.5: a fusão preserva o escopo e a categoria do SOBREVIVENTE", () => {
    counter++;
    const survivorFact = `sobrevivente de escopo caso ${counter} marca unica xyz`;
    const candidateFact = `candidato de escopo caso ${counter} marca unica xyz`;
    const survivorId = db.insertMemory("agent:zeta", survivorFact, "preference");
    db.insertMemory("agent:zeta", candidateFact, "pitfall");

    db.mergeMemories(
      survivorId,
      { fact: candidateFact, category: "pitfall", scope: "agent:zeta", score: 1.0, confirmations: 1 },
      `fato unificado de escopo caso ${counter} marca unica xyz`
    );

    const after = db.getMemoryById(survivorId)!;
    expect(after.scope).toBe("agent:zeta");
    expect(after.category).toBe("preference");
    expect(after.fact).toContain("fato unificado de escopo");
  });
});

// ===========================================================================
// CENÁRIO E — JULGAMENTO NEURAL DAS 4 AÇÕES (binário EXTERNO real, E2E).
// ===========================================================================

/** Memórias existentes (acervo prévio) — vocabulários DISJUNTOS entre si. */
const E_REIN = "backup postgres noturno as 3h";
const E_SUP = "relatorio semanal sexta gestor";
const E_MRG = "latencia painel interno metricas";
const E_IND = "balanceador eletroneico fazenda remota";

/** Candidatas destiladas — cada uma com marcador de ação para o fixture. */
const C_REIN = "backup postgres noturno as 3h ACAO REINFORCE";
const C_SUP = "relatorio semanal segunda gestor ACAO SUPERSEDE";
const C_MRG = "latencia painel interno metricas ACAO MERGE";
const C_IND = "balanceador eletroneico fazenda remota ACAO INDEPENDENT";

const MERGED_FACT = "latencia painel interno metricas e observabilidade externa consolidada";

const SYNTH_PAYLOAD = JSON.stringify([
  { scope: "collective", category: "learning", fact: C_REIN },
  { scope: "collective", category: "decision", fact: C_SUP },
  { scope: "collective", category: "learning", fact: C_MRG },
  { scope: "agent:reviewer", category: "pitfall", fact: C_IND },
]);

describe("DREAMS-06 SDET — E: julgamento neural das 4 ações no Sono REM", () => {
  let fixture: BinaryFixture;
  let baseDir: string;
  let db: DreamsDB;
  let eReinId = 0;
  let eSupId = 0;
  let eMrgId = 0;
  let eIndId = 0;

  beforeAll(() => {
    fixture = makeBinaryFixture("e2e_actions", SYNTH_PAYLOAD, "normal");
    baseDir = makeDreamsDir("e2e_actions_dreams");
    db = new DreamsDB(path.join(baseDir, "dreams.db"));

    // Acervo prévio (API pública), já escopado.
    eReinId = db.insertMemory("collective", E_REIN, "learning");
    eSupId = db.insertMemory("collective", E_SUP, "decision");
    eMrgId = db.insertMemory("collective", E_MRG, "learning");
    eIndId = db.insertMemory("agent:reviewer", E_IND, "pitfall");
  });

  afterAll(() => {
    db.close();
  });

  test("E.1: as 4 ações são julgadas em UM lote e aplicadas transacionalmente", async () => {
    await withEnv({ DREAMS_OFFLINE: undefined, OPENCODE_BIN: fixture.bin }, async () => {
      await new SleepCycle(db, { baseDir }).remSleep();
    });

    // 2 invocações reais: 1 síntese + 1 LOTE de reconciliação.
    expect(fixture.count()).toBe(2);
    const reconPrompt = fixture.stdin(2);
    expect(reconPrompt).toContain("Reconciliador Cognitivo");
    // O prompt REAL transportado carrega os 4 pares (um por candidata).
    expect(reconPrompt.match(/\[par \d+\]/g)?.length).toBe(4);

    // --- REINFORCE: a existente absorve a candidata (score +0.5, conf +1).
    const reinforced = db.getMemoryById(eReinId)!;
    expect(reinforced.fact).toBe(E_REIN);
    expect(reinforced.score).toBeCloseTo(1.5, 10);
    expect(reinforced.confirmations).toBe(2);
    // A candidata absorvida NÃO vira memória nova.
    expect(db.getAllMemories().some((m) => m.fact === C_REIN)).toBe(false);

    // --- SUPERSEDE: a diretriz revogada é removida FISICAMENTE e a nova entra.
    expect(db.getMemoryById(eSupId)).toBeNull();
    const collectiveScope = db.getAllMemories().filter((m) => m.scope === "collective");
    const replacement = collectiveScope.find((m) => m.fact === C_SUP);
    expect(replacement).toBeDefined();
    expect(replacement!.scope).toBe("collective");
    // Metadados de relevância herdados da diretriz revogada (score de 'decision').
    expect(replacement!.score).toBeCloseTo(2.0, 10);
    expect(replacement!.confirmations).toBe(1);

    // --- MERGE: texto unificado + bônus + expurgo do redundante.
    const merged = db.getMemoryById(eMrgId)!;
    expect(merged.fact).toBe(MERGED_FACT);
    expect(merged.score).toBeCloseTo(1.5, 10);
    expect(merged.confirmations).toBe(2);
    expect(db.getAllMemories().some((m) => m.fact === C_MRG)).toBe(false);
    // O FTS5 aponta para o texto unificado.
    expect(db.recall("observabilidade externa", "collective").map((r) => r.fact)).toContain(MERGED_FACT);

    // --- INDEPENDENT: os dois lados permanecem, no MESMO escopo.
    const personaRows = db.getAllMemories().filter((m) => m.scope === "agent:reviewer");
    expect(personaRows).toHaveLength(2);
    const original = personaRows.find((m) => m.fact === E_IND)!;
    const inserted = personaRows.find((m) => m.fact === C_IND)!;
    expect(original).toBeDefined();
    expect(inserted).toBeDefined();
    // A existente NÃO foi tocada (falso positivo lexical ⇒ nada muda).
    expect(original.score).toBeCloseTo(1.8, 10);
    expect(original.confirmations).toBe(1);
    // ISOLAMENTO: a candidata de persona NUNCA entra no coletivo.
    expect(db.getAllMemories().some((m) => m.scope === "collective" && m.fact.includes("balanceador"))).toBe(false);

    // --- O relatório DREAMS.md reflete as reconciliações efetuadas.
    const markdown = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf-8");
    expect(markdown).toContain("## Reconciliações cognitivas");
    expect(markdown).toContain("`reinforce`");
    expect(markdown).toContain("`supersede`");
    expect(markdown).toContain("`merge`");
    expect(markdown).toContain("`independent`");
    expect(markdown).toContain(MERGED_FACT);
  }, 60_000);

  test("E.2: as 4 ações NUNCA tocam memória de outro escopo", async () => {
    // O acervo anterior já provou o isolamento por escopo; aqui verificamos
    // que o RELATÓRIO também é escopado (nenhuma linha de 'agent:reviewer'
    // aparece como 'collective' e vice-versa).
    const markdown = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf-8");
    const section = markdown.split("## Reconciliações cognitivas")[1] ?? "";
    for (const line of section.split("\n")) {
      if (!line.startsWith("- `")) continue;
      const scope = line.split("—")[1]?.trim() ?? "";
      if (scope.startsWith("agent:")) {
        expect(line).not.toContain("— collective —");
      }
    }
    // O coletivo NUNCA contém o texto da persona.
    expect(db.getAllMemories().some((m) => m.scope === "collective" && m.fact.includes("fazenda"))).toBe(false);
  });
});

describe("DREAMS-06 SDET — E3: resposta INVÁLIDA do modelo ⇒ fallback determinístico", () => {
  test("E.3: JSON quebrado ⇒ TODOS os candidatos viram 'independent' (nenhuma memória perdida)", async () => {
    const fixture = makeBinaryFixture("e2e_invalid", SYNTH_PAYLOAD, "invalid");
    const baseDir = makeDreamsDir("e2e_invalid_dreams");
    const db = new DreamsDB(path.join(baseDir, "dreams.db"));

    const existingIds = [
      db.insertMemory("collective", E_REIN, "learning"),
      db.insertMemory("collective", E_SUP, "decision"),
      db.insertMemory("collective", E_MRG, "learning"),
      db.insertMemory("agent:reviewer", E_IND, "pitfall"),
    ];
    const before = existingIds.map((id) => db.getMemoryById(id)!);

    try {
      await withEnv({ DREAMS_OFFLINE: undefined, OPENCODE_BIN: fixture.bin }, async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // O julgamento foi realmente tentado (e falhou).
      expect(fixture.count()).toBeGreaterThanOrEqual(2);

      // NENHUMA memória destilada se perde: as 4 candidatas foram inseridas.
      const facts = db.getAllMemories().map((m) => m.fact);
      expect(facts).toContain(C_REIN);
      expect(facts).toContain(C_SUP);
      expect(facts).toContain(C_MRG);
      expect(facts).toContain(C_IND);

      // E as memórias EXISTENTES não foram absorvidas nem alteradas.
      existingIds.forEach((id, index) => {
        const after = db.getMemoryById(id)!;
        expect(after).not.toBeNull();
        expect(after.fact).toBe(before[index]!.fact);
        expect(after.score).toBe(before[index]!.score);
        expect(after.confirmations).toBe(before[index]!.confirmations);
      });

      // O escopo é respeitado: a candidata de persona entrou na persona.
      const personaFacts = db.getAllMemories().filter((m) => m.scope === "agent:reviewer").map((m) => m.fact);
      expect(personaFacts).toContain(C_IND);
      expect(db.getAllMemories().some((m) => m.scope === "collective" && m.fact.includes("balanceador"))).toBe(false);
    } finally {
      db.close();
    }
  }, 60_000);
});

// ===========================================================================
// CENÁRIO F — MODO OFFLINE / RESILIÊNCIA (DREAMS_OFFLINE=1).
// ===========================================================================

describe("DREAMS-06 SDET — F: modo offline e resiliência do ciclo de sono", () => {
  test("F.1: DREAMS_OFFLINE=1 ⇒ o julgamento degrada para 'independent' e NÃO chama o binário", async () => {
    const fixture = makeBinaryFixture("offline_bin", SYNTH_PAYLOAD, "normal");
    const pair: ReconciliationPair = {
      index: 0,
      existingId: 42,
      scope: "collective",
      existingFact: E_REIN,
      candidateFact: C_REIN,
      candidateCategory: "learning",
      candidateKey: "m0",
    };

    const result = await withEnv({ DREAMS_OFFLINE: "1", OPENCODE_BIN: fixture.bin }, async () =>
      reconcileMemoriesBatch([pair], { binary: fixture.bin })
    );

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe("independent");
    expect(result.error).toBeTruthy();
    expect(result.parsed).toBe(false);
    expect(result.source).toBe("none");
    // NENHUMA chamada ao binário (o fallback é LOCAL e determinístico).
    expect(fixture.count()).toBe(0);
  });

  test("F.2: o fallback determinístico marca TODOS os pares como 'independent'", () => {
    const pairs: ReconciliationPair[] = [0, 1, 2].map((i) => ({
      index: i,
      existingId: 10 + i,
      scope: "collective",
      existingFact: `existente ${i}`,
      candidateFact: `candidata ${i}`,
      candidateCategory: "learning",
      candidateKey: `m${i}`,
    }));
    const decisions = independentFallbackDecisions(pairs);
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.action === "independent")).toBe(true);
    expect(decisions.map((d) => d.pairIndex)).toEqual([0, 1, 2]);
  });

  test("F.3: com DREAMS_OFFLINE=1 o ciclo REM NÃO QUEBRA (handoff íntegro, zero binário)", async () => {
    const fixture = makeBinaryFixture("offline_rem", SYNTH_PAYLOAD, "normal");
    const baseDir = makeDreamsDir("offline_rem_dreams");
    const pending = path.join(baseDir, "dialogue_pending.txt");
    const pendingBefore = fs.readFileSync(pending, "utf-8");
    const db = new DreamsDB(path.join(baseDir, "dreams.db"));

    try {
      await withEnv({ DREAMS_OFFLINE: "1", OPENCODE_BIN: fixture.bin }, async () => {
        // NÃO pode lançar: o sono REM é resiliente.
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // Nenhum spawn de binário.
      expect(fixture.count()).toBe(0);
      // O handoff Light→REM permanece 100% íntegro (byte-idêntico).
      expect(fs.existsSync(pending)).toBe(true);
      expect(fs.readFileSync(pending, "utf-8")).toBe(pendingBefore);
      // O relatório do ciclo é produzido mesmo offline.
      expect(fs.existsSync(path.join(baseDir, "DREAMS.md"))).toBe(true);
      // NENHUMA memória falsa foi gravada.
      expect(db.getAllMemories()).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 60_000);

  test("F.4: o parser REJEITA rótulos fora da taxonomia (decisão NÃO é aplicada)", () => {
    const pair: ReconciliationPair = {
      index: 0,
      existingId: 7,
      scope: "collective",
      existingFact: E_REIN,
      candidateFact: C_REIN,
      candidateCategory: "learning",
      candidateKey: "m0",
    };
    const parsed = parseReconciliationDecisions(
      JSON.stringify([{ pair: 0, action: "reconciliar_tudo" }]),
      [pair]
    );
    expect(parsed.parsed).toBe(true);
    expect(parsed.decisions).toHaveLength(0);
    expect(parsed.dropped).toBe(1);

    // Um par válido convivendo com um inválido: só o válido é decidido.
    const mixed = parseReconciliationDecisions(
      JSON.stringify([
        { pair: 0, action: "reinforce" },
        { pair: 1, action: "fundir" },
      ]),
      [pair, { ...pair, index: 1, existingId: 8 }]
    );
    expect(mixed.decisions).toHaveLength(1);
    expect(mixed.decisions[0]!.action).toBe("reinforce");
    expect(mixed.dropped).toBe(1);
  });
});

// ===========================================================================
// CENÁRIO G — CORREÇÃO DO SCORE DA CANDIDATA NO DESPACHO DE `merge`.
// ===========================================================================

describe("DREAMS-06 SDET — G: a candidata entra com o peso da SUA categoria", () => {
  test("G.1: merge NÃO herda o score da existente — usa CATEGORY_WEIGHTS da candidata", async () => {
    // Existente: categoria 'learning' (base_weight 1.0, 1 confirmação).
    const EXISTING = "painel de metricas internas do time";
    // Candidata: MESMA regra lexical, mas classificada como 'preference' (2.5).
    const CANDIDATE = "painel de metricas internas do time ACAO MERGE";
    const payload = JSON.stringify([
      { scope: "collective", category: "preference", fact: CANDIDATE },
    ]);
    const fixture = makeBinaryFixture("merge_candidate_weight", payload, "normal");
    const baseDir = makeDreamsDir("merge_candidate_weight_dreams");
    const db = new DreamsDB(path.join(baseDir, "dreams.db"));

    try {
      const existingId = db.insertMemory("collective", EXISTING, "learning");
      const before = db.getMemoryById(existingId)!;
      expect(before.score).toBeCloseTo(1.0, 10);
      expect(before.confirmations).toBe(1);

      await withEnv({ DREAMS_OFFLINE: undefined, OPENCODE_BIN: fixture.bin }, async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      const merged = db.getMemoryById(existingId)!;
      // DISCRIMINADOR: a candidata vale o base_weight da SUA categoria (2.5).
      //   nova regra  → min(5.0, max(1.0, 2.5) + 0.5) = 3.0
      //   herança     → min(5.0, max(1.0, 1.0) + 0.5) = 1.5  (aqui: 1.5)
      expect(merged.score).toBeCloseTo(3.0, 10);
      expect(merged.score).not.toBeCloseTo(1.5, 10);
      // A candidata entra com UMA confirmação (recém-destilada).
      expect(merged.confirmations).toBe(2);
      // A fusão sintetiza o TEXTO: categoria/escopo do sobrevivente preservados.
      expect(merged.category).toBe("learning");
      expect(merged.scope).toBe("collective");
      expect(merged.fact).toBe(
        "latencia painel interno metricas e observabilidade externa consolidada"
      );
    } finally {
      db.close();
    }
  }, 60_000);
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
