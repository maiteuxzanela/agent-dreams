/**
 * TICKET-DREAMS-06-FIX — AUDITORIA SDET (Hugo) das correções do Laudo QM
 * (Portão 2 / Diana).
 *
 * Suíte INDEPENDENTE e determinística. Ela NÃO reexecuta as asserções do
 * implementador: cada bloco ataca um ângulo diferente do mesmo defeito, para
 * que a sensibilidade do teste seja comprovada por um segundo caminho.
 *
 * Blocos:
 *   A) Anti-recursão "Dreams Reconciliation" — camada SQL ANTES do LIMIT,
 *      exatidão do título (nem prefixo, nem subcadeia) e PROVA DE ACOPLAMENTO
 *      com o `--title` que o reconciliador realmente grava no opencode.db.
 *   B) Teto `MAX_CONFIRMATIONS` em `mergeMemories` — matriz aritmética exata
 *      + saturação sob fusões sucessivas (o contador NÃO pode crescer sem
 *      limite).
 *   C) Atributos canônicos da CANDIDATA no `merge` do Sono REM — E2E com
 *      binário EXTERNO real (processo filho), provando que a candidata entra
 *      com o `base_weight` da SUA categoria e com UMA confirmação.
 *   D) Sanitização open source — varredura estática determinística de TODO o
 *      repositório rastreado: zero nomes de persona privada.
 *   E) Atomicidade da persistência no `remSleep` — nenhuma escrita no acervo
 *      (nem memória, nem reconciliação, nem julgamento neural) quando a
 *      síntese é parcial.
 *
 * Anti-mock: ZERO `unittest.mock`/`jest.mock`/`sinon`/stubs de módulo. Tudo
 * aqui exercita SQLite real em /tmp, o código de produção real, subprocessos
 * reais (bash) e arquivos reais. Nenhum `sleep()` arbitrário: as esperas são
 * por estado (contadores em disco, conteúdo de arquivos).
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import {
  readRecentDialogues,
  DEFAULT_EXCLUDED_SESSION_TITLES,
} from "../src/core/session_reader";
import { DreamsDB, CATEGORY_WEIGHTS } from "../src/core/db";
import { SleepCycle, DIALOGUE_CHECKPOINT_FILENAME } from "../src/core/sleep_cycle";

// ---------------------------------------------------------------------------
// Infraestrutura hermética: TUDO sob /tmp, banco por cenário.
// ---------------------------------------------------------------------------
const TEST_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_06fix_sdet_"));
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const NOW = Date.now();
const MIN = 60 * 1000;

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Conexão REAL extra ao MESMO arquivo do banco (controle de estado). */
function openRaw(dbPath: string): Database {
  const raw = new Database(dbPath);
  raw.exec("PRAGMA busy_timeout = 5000;");
  return raw;
}

/**
 * Escreve score/confirmations EXATOS no registro — controle determinístico do
 * ponto de partida da matemática de `mergeMemories`. Não é mock: é o próprio
 * SQLite do produção, aberto por uma segunda conexão real.
 */
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

/** Executa `fn` com o ambiente controlado e RESTAURA tudo ao final. */
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

// ===========================================================================
// BLOCO A — ANTI-RECURSÃO: "Dreams Reconciliation" NUNCA vira diálogo.
// ===========================================================================

interface FixtureSession {
  id: string;
  data: unknown;
}

interface FixtureMessage {
  id: string;
  session: string;
  t: number;
  role: "user" | "assistant" | "system";
  texts: string[];
}

/** Cria um opencode.db REAL em /tmp com o DDL de produção (message/part/session). */
function buildSessionDb(
  name: string,
  sessions: FixtureSession[],
  messages: FixtureMessage[]
): string {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    time_created INTEGER,
    data TEXT
  );`);
  db.run(`CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    time_created INTEGER,
    data TEXT
  );`);
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`);
  for (const s of sessions) {
    db.run("INSERT INTO session (id, data) VALUES (?, ?)", [s.id, JSON.stringify(s.data)]);
  }
  let n = 0;
  for (const m of messages) {
    db.run(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      [m.id, m.session, m.t, JSON.stringify({ role: m.role })]
    );
    for (const t of m.texts) {
      db.run(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
        [`${m.id}_t${n++}`, m.id, m.t + n, JSON.stringify({ type: "text", text: t })]
      );
    }
  }
  db.close();
  return dbPath;
}

describe("DREAMS-06-FIX SDET — A: anti-recursão de 'Dreams Reconciliation'", () => {
  test("A.1: a exclusão acontece na CAMADA SQL, ANTES do LIMIT (o orçamento não é gasto)", () => {
    // A sessão de reconciliação é a MAIS RECENTE da janela. Se a exclusão
    // ocorresse só na revalidação JS (depois do LIMIT), ela consumiria uma
    // das vagas do orçamento e o resultado seria [c, recon] em vez de [b, c].
    const dbPath = buildSessionDb(
      "a1_limit_budget",
      [
        { id: "ses_recon", data: { title: "Dreams Reconciliation" } },
        { id: "ses_a", data: { title: "Conversa A" } },
        { id: "ses_b", data: { title: "Conversa B" } },
        { id: "ses_c", data: { title: "Conversa C" } },
      ],
      [
        { id: "m_recon", session: "ses_recon", t: NOW - 1000, role: "user", texts: ["JULGAMENTO_NEURAL_NAO_DEVE_VAZAR"] },
        { id: "m_a", session: "ses_a", t: NOW - 5000, role: "user", texts: ["dialogo legitimo A"] },
        { id: "m_b", session: "ses_b", t: NOW - 4000, role: "user", texts: ["dialogo legitimo B"] },
        { id: "m_c", session: "ses_c", t: NOW - 3000, role: "user", texts: ["dialogo legitimo C"] },
      ]
    );

    const entries = readRecentDialogues({
      dbPath,
      sinceMs: NOW - 60 * MIN,
      untilMs: NOW,
      limit: 2,
    });

    // As DUAS mensagens mais recentes entre as sessões legítimas (c e b).
    expect(entries.map((e) => e.session_id)).toEqual(["ses_b", "ses_c"]);
    // A sessão interna não aparece em NENHUMA posição (nem no texto, nem no id).
    expect(entries.some((e) => e.session_id === "ses_recon")).toBe(false);
    expect(entries.some((e) => e.text.includes("JULGAMENTO_NEURAL"))).toBe(false);
  });

  test("A.2: o título é EXATO — prefixo, sufixo e subcadeia NÃO são excluídos", () => {
    // Blindagem contra uma implementação ampla demais (ex.: LIKE '%Dreams%'):
    // sessões de usuário com nomes parecidos são material de trabalho REAL e
    // jamais podem ser descartadas.
    const dbPath = buildSessionDb(
      "a2_exact_title",
      [
        { id: "ses_exact", data: { title: "Dreams Reconciliation" } },
        { id: "ses_engine", data: { title: "Dreams Reconciliation Engine" } },
        { id: "ses_bare", data: { title: "Reconciliation" } },
        { id: "ses_dreams", data: { title: "Dreams" } },
      ],
      [
        { id: "m_exact", session: "ses_exact", t: NOW - 4000, role: "user", texts: ["CONTEUDO_INTERNO_EXATO"] },
        { id: "m_engine", session: "ses_engine", t: NOW - 3000, role: "user", texts: ["CONTEUDO_DE_ENGINE"] },
        { id: "m_bare", session: "ses_bare", t: NOW - 2000, role: "user", texts: ["CONTEUDO_DE_RECONCILIACAO"] },
        { id: "m_dreams", session: "ses_dreams", t: NOW - 1000, role: "user", texts: ["CONTEUDO_DE_DREAMS"] },
      ]
    );

    const entries = readRecentDialogues({
      dbPath,
      sinceMs: NOW - 60 * MIN,
      untilMs: NOW,
    });

    const sessions = entries.map((e) => e.session_id).sort();
    expect(sessions).toEqual(["ses_bare", "ses_dreams", "ses_engine"]);
    expect(entries.some((e) => e.text.includes("CONTEUDO_INTERNO_EXATO"))).toBe(false);
  });

  test("A.3: os DOIS títulos internos canônicos são excluídos e nada além deles", () => {
    expect(DEFAULT_EXCLUDED_SESSION_TITLES).toContain("Dreams Synthesis");
    expect(DEFAULT_EXCLUDED_SESSION_TITLES).toContain("Dreams Reconciliation");
    expect(DEFAULT_EXCLUDED_SESSION_TITLES).toHaveLength(2);

    const dbPath = buildSessionDb(
      "a3_both_titles",
      [
        { id: "ses_synth", data: { title: "Dreams Synthesis" } },
        { id: "ses_recon", data: { title: "Dreams Reconciliation" } },
        { id: "ses_ok", data: { title: "Reuniao de alinhamento" } },
      ],
      [
        { id: "m_synth", session: "ses_synth", t: NOW - 3000, role: "user", texts: ["SINTESE_NAO_VAZA"] },
        { id: "m_recon", session: "ses_recon", t: NOW - 2000, role: "user", texts: ["RECONCILIACAO_NAO_VAZA"] },
        { id: "m_ok", session: "ses_ok", t: NOW - 1000, role: "user", texts: ["REUNIAO_UTIL"] },
      ]
    );

    const entries = readRecentDialogues({
      dbPath,
      sinceMs: NOW - 60 * MIN,
      untilMs: NOW,
    });
    expect(entries.map((e) => e.session_id)).toEqual(["ses_ok"]);
    expect(entries.map((e) => e.text)).toEqual(["REUNIAO_UTIL"]);
  });

  test("A.4: ACOPLAMENTO — o título que o reconciliador GRAVA é o título EXCLUÍDO", () => {
    // Prova de fechamento do ciclo: o opencode.db recebe sessões com o
    // título que o próprio Dreams escreve (`opencode run --title ...`). Se o
    // leitor não excluísse EXATAMENTE esse título, o julgamento da noite
    // voltaria ao acervo como diálogo de usuário (auto-alimentação).
    const synthesizerSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/core/mimo_synthesizer.ts"),
      "utf-8"
    );
    expect(synthesizerSrc).toMatch(/"--title",\s*"Dreams Reconciliation"/);
    expect(synthesizerSrc).toMatch(/"--title",\s*"Dreams Synthesis"/);
    for (const title of ["Dreams Synthesis", "Dreams Reconciliation"]) {
      expect(DEFAULT_EXCLUDED_SESSION_TITLES).toContain(title);
    }
  });
});

// ===========================================================================
// BLOCO B — TETO `MAX_CONFIRMATIONS` EM `mergeMemories`.
// ===========================================================================

describe("DREAMS-06-FIX SDET — B: teto de confirmações na fusão", () => {
  test("B.1: a matriz aritmética do teto é EXATA (10,10)→10 (10,12)→10 (8,9)→10 (1,1)→2", () => {
    const cases: Array<[number, number, number]> = [
      [10, 10, 10],
      [10, 12, 10],
      [8, 9, 10],
      [1, 1, 2],
      [10, 1, 10],
      [3, 4, 5],
    ];
    for (const [existing, candidate, expected] of cases) {
      const dir = path.join(TEST_DIR, `b1_${existing}_${candidate}`);
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, "dreams.db");
      const db = new DreamsDB(dbPath);
      try {
        const id = db.insertMemory(
          "collective",
          `fato base para a fusão ${existing} ${candidate} com texto inequivoco`,
          "learning"
        );
        forceMetrics(dbPath, id, 1.0, existing);
        expect(db.getMemoryById(id)!.confirmations).toBe(existing);

        db.mergeMemories(
          id,
          {
            fact: `fato candidato ${existing} ${candidate} totalmente distinto`,
            category: "learning",
            scope: "collective",
            score: 1.0,
            confirmations: candidate,
          },
          `fato unificado ${existing} ${candidate} sintetizado pela fusao`
        );

        const merged = db.getMemoryById(id)!;
        expect(merged.confirmations).toBe(expected);
        expect(merged.confirmations).toBeLessThanOrEqual(DreamsDB.MAX_CONFIRMATIONS);
      } finally {
        db.close();
      }
    }
  });

  test("B.2: fusões sucessivas NÃO fazem o contador crescer sem limite", () => {
    const dir = path.join(TEST_DIR, "b2_saturation");
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "dreams.db");
    const db = new DreamsDB(dbPath);
    try {
      const id = db.insertMemory(
        "collective",
        "memoria sobrevivente que suffera fusoes sucessivas durante a noite",
        "learning"
      );
      expect(db.getMemoryById(id)!.confirmations).toBe(1);

      const observed: number[] = [];
      for (let i = 0; i < 20; i++) {
        db.mergeMemories(
          id,
          {
            fact: `candidato distinto numero ${i} para evitar qualquer colisao lexical`,
            category: "learning",
            scope: "collective",
            score: 1.0,
            confirmations: 1,
          },
          `texto unificado da fusao numero ${i} com a memoria sobrevivente`
        );
        const current = db.getMemoryById(id)!.confirmations;
        observed.push(current);
        // INVARIANTE: nunca acima do teto canônico, em NENHUM passo.
        expect(current).toBeLessThanOrEqual(DreamsDB.MAX_CONFIRMATIONS);
      }

      // A sequência é monotônica e SATURA no teto (1→2→…→10→10→10…).
      expect(observed).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
      ]);
      expect(observed[observed.length - 1]).toBe(DreamsDB.MAX_CONFIRMATIONS);
    } finally {
      db.close();
    }
  });

  test("B.3: o invariante canônico vale para TODA a operação de reforço/fusão", () => {
    const dir = path.join(TEST_DIR, "b3_invariant");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DreamsDB(dbPathOf(dir));
    try {
      const id = db.insertMemory(
        "collective",
        "memoria que alterna reforco e fusao para provar o teto global",
        "learning"
      );
      for (let i = 0; i < 30; i++) {
        const current = db.getMemoryById(id)!;
        db.reinforceMemory(current);
        expect(db.getMemoryById(id)!.confirmations).toBeLessThanOrEqual(
          DreamsDB.MAX_CONFIRMATIONS
        );
        db.mergeMemories(
          id,
          {
            fact: `candidato alternado ${i} com texto proprio e distinto`,
            category: "learning",
            scope: "collective",
            score: 1.0,
            confirmations: 1,
          },
          `texto unificado alternado ${i} da operacao mista`
        );
        const after = db.getMemoryById(id)!;
        expect(after.confirmations).toBeLessThanOrEqual(DreamsDB.MAX_CONFIRMATIONS);
        expect(after.score).toBeLessThanOrEqual(5.0);
        expect(after.confirmations).toBeGreaterThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });
});

/** Caminho canônico do banco dentro de um diretório de cenário. */
function dbPathOf(dir: string): string {
  return path.join(dir, "dreams.db");
}

// ===========================================================================
// BLOCO C — ATRIBUTOS CANÔNICOS DA CANDIDATA NO `merge` DO SONO REM.
// ===========================================================================

/**
 * Binário EXTERNO REAL (fixture de transporte). Não é mock: é um processo
 * bash independente que lê o prompt no stdin e escreve JSON no stdout.
 */
interface BinaryFixture {
  bin: string;
  /** Quantas vezes o binário foi invocado (contador em disco, real). */
  count: () => number;
  /** Conteúdo REAL do stdin da N-ª invocação. */
  stdin: (seq: number) => string;
}

function makeBinaryFixture(name: string, memoriesJson: string, mergedFact: string): BinaryFixture {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "memories.json"), memoriesJson, "utf-8");

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
      // Julgamento neural: um item "merge" por par, com o texto unificado.
      `  awk -v MERGED="${mergedFact}" '`,
      '    BEGIN { first = 1; printf "[" }',
      '    /^\\[par [0-9]+\\]/ { idx=$2; sub(/\\].*$/,"",idx); next }',
      '    /^candidata: / {',
      '      if (!first) printf ",";',
      '      printf "{\\"pair\\":%s,\\"action\\":\\"merge\\",\\"merged_fact\\":\\"%s\\"}", idx, MERGED;',
      "      first = 0;",
      "    }",
      '    END { printf "]" }',
      `  ' "$DIR/stdin_$N.log"`,
      "else",
      '  cat "$DIR/memories.json"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  return {
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
function makeDreamsDir(name: string, dialogue: string): string {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dialogue_pending.txt"), dialogue, "utf-8");
  return dir;
}

describe("DREAMS-06-FIX SDET — C: a candidata entra com os ATRIBUTOS DELA no merge", () => {
  test("C.1: E2E real — o score do merge usa o base_weight da CATEGORIA DA CANDIDATA", async () => {
    // Existente: 'learning' ⇒ base_weight 1.0 (score 1.0, 1 confirmação).
    const EXISTING = "observabilidade externa no painel interno do time";
    // Candidata: mesma regra lexical, mas classificada como 'decision'
    // ⇒ base_weight 2.0. Par TRIÁVEL (Jaccard >= 15%): 5 tokens em 9.
    const CANDIDATE = "observabilidade externa no painel interno do time com retencao de metricas";
    const MERGED = "observabilidade externa no painel interno do time com retencao de metricas consolidada";

    const payload = JSON.stringify([
      { scope: "collective", category: "decision", fact: CANDIDATE },
    ]);
    const fixture = makeBinaryFixture("c1_merge_candidate_weight", payload, MERGED);
    const baseDir = makeDreamsDir(
      "c1_merge_candidate_weight_dreams",
      "MANHA: observabilidade externa no painel interno do time com retencao de metricas."
    );
    const db = new DreamsDB(dbPathOf(baseDir));

    try {
      const existingId = db.insertMemory("collective", EXISTING, "learning");
      const before = db.getMemoryById(existingId)!;
      expect(before.score).toBeCloseTo(CATEGORY_WEIGHTS.learning.base_weight, 10);
      expect(before.confirmations).toBe(1);

      await withEnv({ DREAMS_OFFLINE: undefined, OPENCODE_BIN: fixture.bin }, async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // O julgamento neural REAL aconteceu (2 invocações: síntese + julgamento).
      expect(fixture.count()).toBe(2);
      expect(fixture.stdin(2)).toContain("Reconciliador Cognitivo");

      const merged = db.getMemoryById(existingId)!;
      // DISCRIMINADOR: max(score_existente=1.0, base_weight da CANDIDATA=2.0) + 0.5 = 2.5.
      //   implementação antiga (herdar existing.score) ⇒ 1.5.
      expect(merged.score).toBeCloseTo(2.5, 10);
      expect(merged.score).not.toBeCloseTo(1.5, 10);
      // A candidata entra com UMA confirmação ⇒ max(1, 1) + 1 = 2.
      expect(merged.confirmations).toBe(2);
      // O texto sintetizado é o do JUIZ; o escopo/categoria do SOBREVIVENTE
      // permanecem (a candidata é 'decision', o sobrevivente é 'learning').
      expect(merged.fact).toBe(MERGED);
      expect(merged.scope).toBe("collective");
      expect(merged.category).toBe("learning");
    } finally {
      db.close();
    }
  }, 60_000);

  test("C.2: as confirmações do sobrevivente NUNCA são reduzidas pela candidata", () => {
    // Contrato de `mergeMemories` com os ATRIBUTOS que o Sono REM passa:
    // score = base_weight da categoria da candidata, confirmations = 1.
    const dir = path.join(TEST_DIR, "c2_confirmations");
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = dbPathOf(dir);
    const db = new DreamsDB(dbPath);
    try {
      const id = db.insertMemory(
        "collective",
        "diretriz antiga com quatro confirmacoes que o sobrevivente carrega",
        "learning"
      );
      forceMetrics(dbPath, id, 1.0, 4);

      db.mergeMemories(
        id,
        {
          fact: "candidata nova com o peso canonico da sua propria categoria",
          category: "decision",
          scope: "collective",
          score: CATEGORY_WEIGHTS.decision.base_weight,
          confirmations: 1,
        },
        "diretriz nova que absorve a antiga com o texto sintetizado"
      );

      const merged = db.getMemoryById(id)!;
      // max(4, 1) + 1 = 5 — o histórico do sobrevivente é PRESERVADO.
      expect(merged.confirmations).toBe(5);
      expect(merged.confirmations).toBeGreaterThan(4);
      // min(5.0, max(1.0, 2.0) + 0.5) = 2.5 — o peso da CANDIDATA entrou.
      expect(merged.score).toBeCloseTo(2.5, 10);
    } finally {
      db.close();
    }
  });

  test("C.3: a candidata NUNCA é inserida como memória nova quando é fundida", () => {
    const dir = path.join(TEST_DIR, "c3_no_orphan");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DreamsDB(dbPathOf(dir));
    try {
      const existingId = db.insertMemory(
        "collective",
        "fato existente que será fundido com a candidata durante a noite",
        "learning"
      );
      const candidateFact = "fato candidato complementar ao existente para a fusao";
      // A candidata entra no acervo (simulando a Etapa 1) e depois é fundida.
      const candidateId = db.insertMemory("collective", candidateFact, "decision");
      expect(candidateId).not.toBe(existingId);

      db.mergeMemories(
        existingId,
        {
          fact: candidateFact,
          category: "decision",
          scope: "collective",
          score: CATEGORY_WEIGHTS.decision.base_weight,
          confirmations: 1,
        },
        "fato fundido final que substitui os dois anteriores"
      );

      const all = db.getAllMemories();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(existingId);
      expect(db.getMemoryById(candidateId)).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ===========================================================================
// BLOCO D — SANITIZAÇÃO OPEN SOURCE (nomes de persona privados).
// ===========================================================================

/**
 * Nomes de persona PRIVADOS, montados por fragmento para que o PRÓPRIO
 * arquivo de auditoria não contenha o literal — a varredura cobre o arquivo
 * de teste também, sem auto-exceção.
 */
const PRIVATE_PERSONA_TOKENS: readonly string[] = ["da" + "nte", "si" + "las"];

/** Pastas e arquivos do repositório RASTREADO (a fonte open source). */
const SCAN_DIRS = ["src", "tests", "bin", "systemd", ".github"];
const SCAN_ROOT_FILES = [
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "tsconfig.json",
  "LICENSE",
];

/** Lista recursivamente os arquivos textuais varridos pela auditoria. */
function listScannableFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) out.push(abs);
    }
  };
  for (const dir of SCAN_DIRS) {
    const full = path.join(REPO_ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  for (const file of SCAN_ROOT_FILES) {
    const abs = path.join(REPO_ROOT, file);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

describe("DREAMS-06-FIX SDET — D: sanitização open source das personas", () => {
  test("D.1: ZERO nomes de persona privados em TODO o repositório rastreado", () => {
    const files = listScannableFiles();
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      for (const token of PRIVATE_PERSONA_TOKENS) {
        const re = new RegExp(`\\b${token}\\b`, "gi");
        if (re.test(content)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} :: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("D.2: as personas públicas genéricas estão em uso nos três arquivos saneados", () => {
    const files = [
      "tests/dreams_06_rem_reconciliation.test.ts",
      "tests/dreams_06a_reconciliation_db.test.ts",
      "tests/dreams_06b_reconciliation_ai.test.ts",
    ];
    for (const file of files) {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
      expect(content).toMatch(/agent:(architect|reviewer|developer)/);
    }
  });

  test("D.3: os escopos públicos genéricos são ISOLADOS no acervo real", () => {
    const dir = path.join(TEST_DIR, "d3_public_scopes");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DreamsDB(dbPathOf(dir));
    try {
      const collectiveId = db.insertMemory(
        "collective",
        "fato coletivo compartilhado entre todas as personas do ecossistema",
        "learning"
      );
      const reviewerId = db.insertMemory(
        "agent:reviewer",
        "fato privado da persona reviewer que jamais vaza para o coletivo",
        "pitfall"
      );
      const architectId = db.insertMemory(
        "agent:architect",
        "fato privado da persona architect que jamais vaza para o coletivo",
        "decision"
      );
      expect(collectiveId).not.toBe(reviewerId);
      expect(collectiveId).not.toBe(architectId);

      const collective = db.getAllMemories().filter((m) => m.scope === "collective");
      expect(collective).toHaveLength(1);
      expect(collective[0].id).toBe(collectiveId);
      expect(collective.some((m) => m.fact.includes("reviewer"))).toBe(false);
      expect(collective.some((m) => m.fact.includes("architect"))).toBe(false);

      expect(db.getAllMemories().filter((m) => m.scope === "agent:reviewer")).toHaveLength(1);
      expect(db.getAllMemories().filter((m) => m.scope === "agent:architect")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// ===========================================================================
// BLOCO F — COERÊNCIA DOCUMENTAL (o README descreve o que o código faz).
// ===========================================================================

describe("DREAMS-06-FIX SDET — F: o README documenta a correção", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf-8");

  test("F.1: a anti-recursão documenta OS DOIS títulos internos", () => {
    expect(readme).toContain('Dreams Synthesis"');
    expect(readme).toContain('Dreams Reconciliation"');
    expect(readme).toContain("DEFAULT_EXCLUDED_SESSION_TITLES");
  });

  test("F.2: a atomicidade da persistência está documentada", () => {
    expect(readme).toMatch(/at[ôo]mica/i);
    expect(readme).toMatch(/estado parcial/i);
  });

  test("F.3: a esteira de reconciliação documenta o limiar e as 4 ações", () => {
    expect(readme).toContain("15%");
    for (const action of ["reinforce", "supersede", "merge", "independent"]) {
      expect(readme).toContain(`\`${action}\``);
    }
  });
});

// ===========================================================================
// BLOCO E — ATOMICIDADE DA PERSISTÊNCIA NO `remSleep`.
// ===========================================================================

/**
 * Binário de transporte REAL que falha a partir da N-ª invocação. Cada
 * chunk consome 1 tentativa por modelo da cascata; com 3 modelos, as
 * invocações #1 e #2 fecham os chunks 1 e 2, e a partir de #3 tudo falha
 * (o chunk 3 é adiado integralmente).
 */
function makeFailingRecorder(name: string, failFrom: number, memoriesJson: string): BinaryFixture {
  const dir = path.join(TEST_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "memories.json"), memoriesJson, "utf-8");
  const bin = path.join(dir, "opencode_recorder.sh");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `DIR="${dir}"`,
      'N=$(( $(cat "$DIR/count" 2>/dev/null || echo 0) + 1 ))',
      'printf "%s" "$N" > "$DIR/count"',
      'cat > "$DIR/stdin_$N.log"',
      `if [ "$N" -ge ${failFrom} ]; then`,
      '  echo "modelo indisponivel (fixture real)" >&2',
      "  exit 1",
      "fi",
      'cat "$DIR/memories.json"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return {
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

/** Diálogo longo e real: produz 3+ chunks de 100k caracteres. */
function buildLongDialogue(): string {
  const lines: string[] = ["MANHA_INICIO: alinhamento inicial do dia com detalhes relevantes."];
  for (let i = 0; i < 100; i++) lines.push(`manha ${i}: ${"m".repeat(900)}`);
  lines.push("TARDE_MEIO: revisao do meio da tarde com aprendizados consolidados.");
  for (let i = 0; i < 100; i++) lines.push(`tarde ${i}: ${"t".repeat(900)}`);
  lines.push("NOITE_FIM: fechamento do dia com as lecoes que merecem ser lembradas.");
  for (let i = 0; i < 40; i++) lines.push(`noite ${i}: ${"n".repeat(900)}`);
  return lines.join("\n");
}

describe("DREAMS-06-FIX SDET — E: persistência atômica no Sono REM", () => {
  test("E.1: síntese parcial ⇒ NENHUMA escrita no acervo e NENHUM julgamento neural", async () => {
    const baseDir = path.join(TEST_DIR, "e1_atomic");
    fs.mkdirSync(baseDir, { recursive: true });
    const dialogue = buildLongDialogue();
    const pendingFile = path.join(baseDir, "dialogue_pending.txt");
    fs.writeFileSync(pendingFile, dialogue);

    const distilled = "memoria destilada pelo modelo que jamais deve ser gravada no acervo";
    const recorder = makeFailingRecorder(
      "e1_recorder",
      3,
      JSON.stringify([{ scope: "collective", category: "learning", fact: distilled }])
    );

    const db = new DreamsDB(dbPathOf(baseDir));
    try {
      // Uma memória PRÉ-EXISTENTE e sua vizinha léxica: se a Etapa 2 fosse
      // despachada, ela seria tocada (reforço/fusão).
      const preExistingId = db.insertMemory(
        "collective",
        "memoria pre-existente do acervo que o ciclo nao pode alterar a toa",
        "learning"
      );
      const before = db.getMemoryById(preExistingId)!;

      await withEnv({ DREAMS_OFFLINE: undefined, OPENCODE_BIN: recorder.bin }, async () => {
        await new SleepCycle(db, { baseDir }).remSleep();
      });

      // (1) NENHUMA memória nova foi gravada — o acervo não tem estado parcial.
      const all = db.getAllMemories();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(preExistingId);
      expect(all.some((m) => m.fact.includes("jamais deve ser gravada"))).toBe(false);

      // (2) A memória pré-existente está INTOCÁVEL (score/confirmations).
      const after = db.getMemoryById(preExistingId)!;
      expect(after.score).toBeCloseTo(before.score, 10);
      expect(after.confirmations).toBe(before.confirmations);
      expect(after.last_reinforced).toBe(before.last_reinforced);

      // (3) O JULGAMENTO NEURAL NUNCA foi disparado: nenhuma invocação do
      //     binário carregou o prompt do reconciliador. Sem essa barreira, a
      //     reconciliação da noite parcial já teria sido despachada.
      expect(recorder.count()).toBeGreaterThanOrEqual(3);
      for (let seq = 1; seq <= recorder.count(); seq++) {
        expect(recorder.stdin(seq)).not.toContain("Reconciliador Cognitivo");
      }

      // (4) O handoff permanece INTACTO (byte-a-byte) para o retry integral.
      expect(fs.readFileSync(pendingFile, "utf-8")).toBe(dialogue);

      // (5) O checkpoint de síntese NÃO avançou.
      const checkpointPath = path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME);
      if (fs.existsSync(checkpointPath)) {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf-8"));
        expect(checkpoint.last_synthesized_at ?? null).toBeNull();
      }

      // (6) O relatório não anuncia memórias novas.
      const markdown = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf-8");
      expect(markdown).not.toContain("jamais deve ser gravada");
    } finally {
      db.close();
    }
  }, 120_000);
});
