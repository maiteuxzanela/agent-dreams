/**
 * TICKET-DREAMS-06 (Frente B) — Classificador neural de 4 ações e esteira de
 * reconciliação no Sono REM.
 *
 * Suíte determinística SDET — SEM mocks:
 *   - SQLite real (bun:sqlite) em banco hermético sob /tmp;
 *   - "modelo de IA" = binário REAL (script bash) apontado por OPENCODE_BIN,
 *     que grava cada stdin em disco e devolve JSON conforme o prompt recebido
 *     (mesmo padrão de fixture já usado em `dreams_08_chunks_backfill`).
 *
 * Cenários:
 *   1. Prompt de reconciliação: contém as 4 ações, os pares e NENHUM segredo.
 *   2. Parser resiliente: JSON válido, cercas markdown, rótulo inválido,
 *      `merge` sem `merged_fact`, índice inexistente, decisão duplicada.
 *   3. Fallback determinístico: `DREAMS_OFFLINE=1` e binário indisponível
 *      ⇒ TODOS os candidatos viram `independent`, sem exceção e sem travar.
 *   4. Sono REM ponta a ponta:
 *      4.1 Jaccard < 15% ⇒ inserção direta, SEM nenhuma chamada de IA extra;
 *      4.2 Jaccard >= 15% ⇒ lote neural e despacho das 4 ações;
 *      4.3 isolamento de escopo: `agent:silas` nunca reconcilia com `collective`;
 *      4.4 DREAMS.md reflete as reconciliações efetuadas.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DreamsDB } from "../src/core/db";
import { SleepCycle, DIALOGUE_CHECKPOINT_FILENAME } from "../src/core/sleep_cycle";
import {
  buildReconciliationPrompt,
  parseReconciliationDecisions,
  independentFallbackDecisions,
  reconcileMemoriesBatch,
  RECONCILIATION_ACTIONS,
  type ReconciliationPair,
} from "../src/core/mimo_synthesizer";
import { redactSecrets } from "../src/core/security";

// ---------------------------------------------------------------------------
// Fixtures léxicas — pares de sobreposição ~0.5 e memórias isoladas (~0.05).
// ---------------------------------------------------------------------------
const E1 = "backup do banco de memorias roda todo dia as 3h"; // collective
const M1 = "backup do banco de memorias roda semanalmente as 4h"; // collective (J≈0.58)
const E2 = "metricas de latencia sao publishadas no painel interno"; // collective
const M2 = "metricas de latencia aparecem no painel de operacoes"; // collective (J≈0.50)
const E3 = "relatorio de incidente sai toda sexta para o gestor"; // agent:silas
const M3 = "relatorio de incidente sai todo dia util para o gestor"; // agent:silas (J≈0.58)
const M4 = "implantar balanceador eletroneico na fazenda remota"; // isolado (J=0)
const M5 = "assinar contrato anual com a seguradora"; // isolado (J=0)

const FAKE_KEY = "sk-proj-abc12345678901234567890";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dreams_06b_"));

// ---------------------------------------------------------------------------
// Binário REAL de transporte (fixture) — sem mock, sem stub de módulo.
// ---------------------------------------------------------------------------
interface Fixture {
  dir: string;
  bin: string;
  count: () => number;
  stdin: (seq: number) => string;
  writeMemories: (payload: string) => void;
  writeReconciliation: (payload: string) => void;
}

function makeFixture(name: string, memories: string, reconciliation: string): Fixture {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const memoriesFile = path.join(dir, "memories.json");
  const reconFile = path.join(dir, "reconciliation.json");
  const countFile = path.join(dir, "count");
  fs.writeFileSync(memoriesFile, memories, "utf-8");
  fs.writeFileSync(reconFile, reconciliation, "utf-8");

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
      '  cat "$DIR/reconciliation.json"',
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
        return Number(fs.readFileSync(countFile, "utf-8"));
      } catch {
        return 0;
      }
    },
    stdin: (seq: number) => {
      const file = path.join(dir, `stdin_${seq}.log`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    },
    writeMemories: (payload: string) => fs.writeFileSync(memoriesFile, payload, "utf-8"),
    writeReconciliation: (payload: string) => fs.writeFileSync(reconFile, payload, "utf-8"),
  };
}

/** Executa `fn` com DREAMS_OFFLINE removido e restaura o ambiente ao final. */
async function withoutOffline<T>(fn: () => Promise<T>): Promise<T> {
  const prevOffline = process.env.DREAMS_OFFLINE;
  const prevBin = process.env.OPENCODE_BIN;
  delete process.env.DREAMS_OFFLINE;
  try {
    return await fn();
  } finally {
    if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
    else process.env.DREAMS_OFFLINE = prevOffline;
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
  }
}

function makePair(index: number, overrides: Partial<ReconciliationPair> = {}): ReconciliationPair {
  return {
    index,
    existingId: 100 + index,
    scope: "collective",
    existingFact: E1,
    candidateFact: M1,
    candidateCategory: "learning",
    candidateKey: `m${index}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cenário 1 — Prompt de reconciliação.
// ---------------------------------------------------------------------------
describe("DREAMS-06B — Cenário 1: prompt de reconciliação", () => {
  test("1.1: o prompt declara as 4 ações e lista os pares", () => {
    const prompt = buildReconciliationPrompt([makePair(0)]);
    for (const action of RECONCILIATION_ACTIONS) {
      expect(prompt).toContain(`"${action}"`);
    }
    expect(prompt).toContain("[par 0]");
    expect(prompt).toContain(E1);
    expect(prompt).toContain(M1);
    expect(prompt).toContain("merged_fact");
  });

  test("1.2: o prompt NUNCA carrega segredo (redação antes do modelo externo)", () => {
    const pair = makePair(0, { candidateFact: `chave ${FAKE_KEY} do servidor` });
    const prompt = buildReconciliationPrompt([pair]);
    expect(prompt).not.toContain(FAKE_KEY);
    expect(prompt).toContain(redactSecrets(`chave ${FAKE_KEY} do servidor`));
  });
});

// ---------------------------------------------------------------------------
// Cenário 2 — Parser resiliente.
// ---------------------------------------------------------------------------
describe("DREAMS-06B — Cenário 2: parser resiliente", () => {
  const pairs = [makePair(0), makePair(1), makePair(2)];

  test("2.1: JSON válido ⇒ decisões tipadas", () => {
    const raw = JSON.stringify([
      { pair: 0, action: "reinforce" },
      { pair: 1, action: "merge", merged_fact: "fato unificado do par um" },
      { pair: 2, action: "independent" },
    ]);
    const { decisions, dropped, parsed } = parseReconciliationDecisions(raw, pairs);
    expect(parsed).toBe(true);
    expect(dropped).toBe(0);
    expect(decisions).toHaveLength(3);
    expect(decisions[0]!.action).toBe("reinforce");
    expect(decisions[1]!.action).toBe("merge");
    expect(decisions[1]!.mergedFact).toBe("fato unificado do par um");
    expect(decisions[2]!.action).toBe("independent");
  });

  test("2.2: cercas markdown são aceitas", () => {
    const raw = "```json\n" + JSON.stringify([{ pair: 0, action: "reinforce" }]) + "\n```";
    const { decisions, parsed } = parseReconciliationDecisions(raw, pairs);
    expect(parsed).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("reinforce");
  });

  test("2.3: rótulo fora da taxonomia é DESCARTADO", () => {
    const raw = JSON.stringify([
      { pair: 0, action: "absorve_tudo" },
      { pair: 1, action: "reinforce" },
    ]);
    const { decisions, dropped } = parseReconciliationDecisions(raw, pairs);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.pairIndex).toBe(1);
    expect(dropped).toBe(1);
  });

  test("2.4: 'merge' sem merged_fact utilizável é DESCARTADO", () => {
    const raw = JSON.stringify([
      { pair: 0, action: "merge" },
      { pair: 1, action: "merge", merged_fact: "curto" },
      { pair: 2, action: "merge", merged_fact: "texto unificado suficientemente denso" },
    ]);
    const { decisions, dropped } = parseReconciliationDecisions(raw, pairs);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.pairIndex).toBe(2);
    expect(dropped).toBe(2);
  });

  test("2.5: índice inexistente é DESCARTADO", () => {
    const raw = JSON.stringify([
      { pair: 99, action: "reinforce" },
      { pair: 0, action: "reinforce" },
    ]);
    const { decisions, dropped } = parseReconciliationDecisions(raw, pairs);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.pairIndex).toBe(0);
    expect(dropped).toBe(1);
  });

  test("2.6: decisão duplicada para o mesmo par é ignorada (a primeira vence)", () => {
    const raw = JSON.stringify([
      { pair: 0, action: "reinforce" },
      { pair: 0, action: "merge", merged_fact: "segunda decisao para o mesmo par" },
    ]);
    const { decisions, dropped } = parseReconciliationDecisions(raw, pairs);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("reinforce");
    expect(dropped).toBe(1);
  });

  test("2.7: JSON inválido ⇒ parsed=false e NENHUMA decisão", () => {
    const { decisions, dropped, parsed } = parseReconciliationDecisions("isto não é JSON", pairs);
    expect(parsed).toBe(false);
    expect(decisions).toEqual([]);
    expect(dropped).toBe(0);
  });

  test("2.8: o merged_fact é redigido antes de tocar o banco", () => {
    const raw = JSON.stringify([
      { pair: 0, action: "merge", merged_fact: `fato com chave ${FAKE_KEY} embutida` },
    ]);
    const { decisions } = parseReconciliationDecisions(raw, pairs);
    expect(decisions[0]!.mergedFact).not.toContain(FAKE_KEY);
    expect(decisions[0]!.mergedFact).toContain(redactSecrets(`fato com chave ${FAKE_KEY} embutida`));
  });

  test("2.9: o fallback determinístico marca TODOS os pares como 'independent'", () => {
    const decisions = independentFallbackDecisions(pairs);
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.action === "independent")).toBe(true);
    expect(decisions.map((d) => d.pairIndex)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Cenário 3 — Resiliência / modo offline.
// ---------------------------------------------------------------------------
describe("DREAMS-06B — Cenário 3: fallback determinístico", () => {
  test("3.1: DREAMS_OFFLINE=1 ⇒ todos 'independent', sem exceção e sem chamada de rede", async () => {
    const prev = process.env.DREAMS_OFFLINE;
    process.env.DREAMS_OFFLINE = "1";
    try {
      const result = await reconcileMemoriesBatch([makePair(0), makePair(1)]);
      expect(result.decisions).toHaveLength(2);
      expect(result.decisions.every((d) => d.action === "independent")).toBe(true);
      expect(result.parsed).toBe(false);
      expect(result.error).toContain("DREAMS_OFFLINE");
    } finally {
      if (prev === undefined) delete process.env.DREAMS_OFFLINE;
      else process.env.DREAMS_OFFLINE = prev;
    }
  });

  test("3.2: modelo indisponível ⇒ fallback determinístico (NUNCA lança)", async () => {
    // Binário REAL que falha (exit 1) em toda invocação — simula a
    // indisponibilidade do modelo sem rede e sem mock.
    const failDir = path.join(TEST_DIR, "falha");
    fs.mkdirSync(failDir, { recursive: true });
    const failBin = path.join(failDir, "opencode_falho.sh");
    fs.writeFileSync(
      failBin,
      ['#!/usr/bin/env bash', 'echo "modelo indisponível (fixture real)" >&2', "exit 1", ""].join("\n"),
      { mode: 0o755 }
    );

    const prevBin = process.env.OPENCODE_BIN;
    const prevOffline = process.env.DREAMS_OFFLINE;
    delete process.env.DREAMS_OFFLINE;
    process.env.OPENCODE_BIN = failBin;
    try {
      const result = await reconcileMemoriesBatch([makePair(0)]);
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.action).toBe("independent");
      expect(result.parsed).toBe(false);
      expect(result.error).toContain("indisponível");
    } finally {
      if (prevBin === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = prevBin;
      if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
      else process.env.DREAMS_OFFLINE = prevOffline;
    }
  });

  test("3.3: lote vazio ⇒ resultado vazio, sem chamada alguma", async () => {
    const result = await reconcileMemoriesBatch([]);
    expect(result.decisions).toEqual([]);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cenário 4 — Sono REM ponta a ponta.
// ---------------------------------------------------------------------------
describe("DREAMS-06B — Cenário 4: esteira de reconciliação no Sono REM", () => {
  let prevBin: string | undefined;
  let prevOffline: string | undefined;

  beforeEach(() => {
    prevBin = process.env.OPENCODE_BIN;
    prevOffline = process.env.DREAMS_OFFLINE;
  });

  afterEach(() => {
    if (prevBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prevBin;
    if (prevOffline === undefined) delete process.env.DREAMS_OFFLINE;
    else process.env.DREAMS_OFFLINE = prevOffline;
  });

  test("4.1: Jaccard < 15% ⇒ inserção direta, SEM chamada extra de IA", async () => {
    const fixture = makeFixture(
      "autonomo",
      JSON.stringify([
        { scope: "collective", category: "learning", fact: M4 },
        { scope: "collective", category: "decision", fact: M5 },
      ]),
      "[]"
    );
    const baseDir = path.join(TEST_DIR, "autonomo_dreams");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "MANHA: conversa da manha.");

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      process.env.OPENCODE_BIN = fixture.bin;
      await withoutOffline(async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // UMA invocação (a síntese do único chunk) — nenhuma chamada de
      // reconciliação (não havia par com Jaccard >= 15%).
      expect(fixture.count()).toBe(1);
      expect(fixture.stdin(1)).not.toContain("Reconciliador Cognitivo");

      const facts = db.getAllMemories().map((m) => m.fact);
      expect(facts.some((f) => f.includes("balanceador eletroneico"))).toBe(true);
      expect(facts.some((f) => f.includes("assinar contrato anual"))).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  test("4.2: Jaccard >= 15% ⇒ lote neural + despacho das 4 ações transacionais", async () => {
    const memories = JSON.stringify([
      { scope: "collective", category: "learning", fact: M1 },
      { scope: "collective", category: "learning", fact: M2 },
      { scope: "agent:silas", category: "decision", fact: M3 },
      { scope: "collective", category: "learning", fact: M4 },
    ]);
    const reconciliation = JSON.stringify([
      { pair: 0, action: "reinforce" },
      { pair: 1, action: "merge", merged_fact: "metricas de latencia sao publishadas no painel interno e de operacoes" },
      { pair: 2, action: "supersede" },
    ]);
    const fixture = makeFixture("acoes", memories, reconciliation);
    const baseDir = path.join(TEST_DIR, "acoes_dreams");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "MANHA: conversa da manha.");

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      // Acervo pré-existente (as memórias que as memórias destiladas viram a
      // parameter) — inseridas pela API pública.
      const e1Id = db.insertMemory("collective", E1, "learning", 2.0, 1.0);
      const e2Id = db.insertMemory("collective", E2, "learning", 2.0, 1.0);
      const e3Id = db.insertMemory("agent:silas", E3, "decision", 2.0, 1.0);

      process.env.OPENCODE_BIN = fixture.bin;
      await withoutOffline(async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // 2 invocações: 1 síntese + 1 LOTE de reconciliação.
      expect(fixture.count()).toBe(2);
      const reconStdin = fixture.stdin(2);
      expect(reconStdin).toContain("Reconciliador Cognitivo");
      expect(reconStdin).toContain("escopo=collective");
      expect(reconStdin).toContain("escopo=agent:silas");

      // --- ação REINFORCE: a existente absorve a candidata (score +0.5, conf +1).
      const e1 = db.getMemoryById(e1Id)!;
      expect(e1.fact).toBe(E1); // texto intacto
      expect(e1.confirmations).toBe(2);
      expect(e1.score).toBeCloseTo(2.5, 10);
      expect(db.getAllMemories().some((m) => m.fact === M1)).toBe(false); // absorvida

      // --- ação MERGE: texto unificado + bônus + expurgo do id redundante.
      const e2 = db.getMemoryById(e2Id)!;
      expect(e2.fact).toBe("metricas de latencia sao publishadas no painel interno e de operacoes");
      expect(e2.score).toBeCloseTo(2.5, 10); // min(5, max(2.0, 1.0) + 0.5)
      expect(e2.confirmations).toBe(2); // max(1, 1) + 1
      expect(db.getAllMemories().some((m) => m.fact === M2)).toBe(false); // absorvida

      // --- ação SUPERSEDE: a diretriz revogada é removida FISICAMENTE.
      expect(db.getMemoryById(e3Id)).toBeNull();
      const silas = db.getAllMemories().filter((m) => m.scope === "agent:silas");
      expect(silas).toHaveLength(1);
      expect(silas[0]!.fact).toBe(M3);

      // --- Jaccard < 15%: inserção direta, sem passar pelo julgamento.
      expect(db.getAllMemories().some((m) => m.fact.includes("balanceador eletroneico"))).toBe(true);

      // --- ISOLAMENTO DE ESCOPO: M3 (agent:silas) jamais tocou o coletivo.
      const collective = db.getAllMemories().filter((m) => m.scope === "collective");
      expect(collective.some((m) => m.fact.includes("relatorio de incidente"))).toBe(false);
      expect(collective.some((m) => m.fact === E3)).toBe(false);
    } finally {
      db.close();
    }
  }, 60_000);

  test("4.3: falha da IA no julgamento ⇒ fallback 'independent' (nenhuma memória perdida)", async () => {
    const memories = JSON.stringify([
      { scope: "collective", category: "learning", fact: M1 },
      { scope: "collective", category: "learning", fact: M4 },
    ]);
    // Resposta INVÁLIDA do modelo: nenhum par é decidido.
    const fixture = makeFixture("fallback", memories, "resposta sem json util");
    const baseDir = path.join(TEST_DIR, "fallback_dreams");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "MANHA: conversa da manha.");

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      const e1Id = db.insertMemory("collective", E1, "learning", 2.0, 1.0);
      process.env.OPENCODE_BIN = fixture.bin;
      await withoutOffline(async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // O par sem decisão degrada para `independent`: a candidata entra como
      // memória nova e a existente NÃO é alterada.
      const e1 = db.getMemoryById(e1Id)!;
      expect(e1.fact).toBe(E1);
      expect(e1.confirmations).toBe(1);
      expect(e1.score).toBeCloseTo(2.0, 10);
      const facts = db.getAllMemories().map((m) => m.fact);
      expect(facts.some((f) => f === M1)).toBe(true);
      expect(facts.some((f) => f.includes("balanceador eletroneico"))).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  test("4.5: candidato 'independent' de persona entra NA SUA persona (nunca no coletivo)", async () => {
    const memories = JSON.stringify([
      { scope: "agent:silas", category: "decision", fact: M3 },
    ]);
    const reconciliation = JSON.stringify([{ pair: 0, action: "independent" }]);
    const fixture = makeFixture("persona", memories, reconciliation);
    const baseDir = path.join(TEST_DIR, "persona_dreams");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "MANHA: conversa da manha.");

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      db.insertMemory("agent:silas", E3, "decision", 2.0, 1.0);
      process.env.OPENCODE_BIN = fixture.bin;
      await withoutOffline(async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // A candidata independente entra na SUA persona...
      const silas = db.getAllMemories().filter((m) => m.scope === "agent:silas");
      expect(silas.some((m) => m.fact === M3)).toBe(true);
      expect(silas.some((m) => m.fact === E3)).toBe(true); // a existente permanece
      // ...e NUNCA vaza para o coletivo.
      const collective = db.getAllMemories().filter((m) => m.scope === "collective");
      expect(collective.some((m) => m.fact === M3)).toBe(false);
      expect(collective).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 60_000);

  test("4.4: o DREAMS.md reflete as reconciliações efetuadas", async () => {
    const memories = JSON.stringify([
      { scope: "collective", category: "learning", fact: M1 },
      { scope: "collective", category: "learning", fact: M4 },
    ]);
    const reconciliation = JSON.stringify([{ pair: 0, action: "reinforce" }]);
    const fixture = makeFixture("relatorio", memories, reconciliation);
    const baseDir = path.join(TEST_DIR, "relatorio_dreams");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "dialogue_pending.txt"), "MANHA: conversa da manha.");

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      db.insertMemory("collective", E1, "learning", 2.0, 1.0);
      process.env.OPENCODE_BIN = fixture.bin;
      await withoutOffline(async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      const markdown = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf-8");
      expect(markdown).toContain("## Reconciliações cognitivas");
      expect(markdown).toContain("reinforce");
      expect(markdown).toContain("collective");
      // O handoff foi consumido e o checkpoint avançou (sucesso integral).
      expect(fs.existsSync(path.join(baseDir, "dialogue_pending.txt"))).toBe(false);
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME), "utf-8")
      );
      expect(typeof checkpoint.last_synthesized_at).toBe("string");
    } finally {
      db.close();
    }
  }, 60_000);
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
