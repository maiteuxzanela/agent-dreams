/**
 * TICKET-DREAMS-08 — Suíte determinística REAL (sem mocks) da ingestão integral
 * em chunks (Card A) e do subcomando `backfill` da CLI (Card B).
 *
 * Infraestrutura 100% real:
 *  - bancos SQLite reais em /tmp, com o schema do OpenCode (`session`,
 *    `message`, `part`) e o schema do DreamsDB (criado pela classe de produção);
 *  - módulos de produção reais (`session_reader`, `sleep_cycle`, `cli`);
 *  - seam de subprocesso REAL para a síntese (`OPENCODE_BIN` aponta para um
 *    script bash que grava o stdin de cada invocação e imprime JSON de
 *    memórias) — nenhum `jest.mock`/`mock.module`/stub de módulo.
 *
 * Cobertura:
 *  A. `chunkDialogueText` / `chunkDialogues` / `buildDialogueSummary`:
 *     diálogo >120k chars → múltiplos chunks cronológicos, cada um sob os
 *     orçamentos de chars E bytes, concatenação reconstrói o texto SEM perda,
 *     nenhum prefixo `[… início do dia omitido]`, mensagens da manhã presentes.
 *  B. `remSleep` multi-chunk: cada chunk é sintetizado em sequência, as
 *     memórias de TODOS os chunks entram no DreamsDB, handoff só é limpo e
 *     `last_synthesized_at` só avança quando todos os chunks concluem. Falha
 *     mid-chunk preserva o handoff byte-a-byte e não grava dados falsos.
 *  C. `backfill`: parser (`--limit 20`, `--limit=20`, `20`), leitura de
 *     conversas reais do SQLite, escrita válida no `.jsonl` diário, limites,
 *     clamp, descarte de ruído, reasoning off, idempotência, fail-soft e e2e
 *     do CLI real com HOME isolado.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import {
  readRecentDialogues,
  chunkDialogueText,
  chunkDialogues,
  buildDialogueSummary,
  DEFAULT_MAX_CHARS_PER_CHUNK,
  DEFAULT_MAX_BYTES_PER_CHUNK,
} from "../src/core/session_reader";
import { DreamsDB } from "../src/core/db";
import { SleepCycle, DIALOGUE_CHECKPOINT_FILENAME } from "../src/core/sleep_cycle";
import {
  parseBackfillArgs,
  runBackfill,
  BACKFILL_DEFAULT_LIMIT,
  type DailyLogRecord,
} from "../src/cli";

const BASE_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_08_chunks_backfill_"));
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const NOW = Date.now();
const MIN = 60 * 1000;

afterAll(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function freshDir(name: string): string {
  const dir = path.join(BASE_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Fixtures reais do SQLite do OpenCode (schema `session`/`message`/`part`)
// ---------------------------------------------------------------------------

interface FixtureSession {
  id: string;
  title: string;
}

interface FixtureMessage {
  id: string;
  session: string;
  t: number;
  role: "user" | "assistant" | "system";
  texts?: string[];
  reasonings?: string[];
  tools?: string[];
}

/**
 * Cria um `opencode.db` real em /tmp com o schema de produção do OpenCode.
 * Mensagens/partes são gravadas em ordem cronológica; o handle é fechado antes
 * de devolver o caminho (o leitor abre em modo readonly).
 */
function buildOpenCodeDb(opts: {
  dir: string;
  sessions?: FixtureSession[];
  messages: FixtureMessage[];
}): string {
  fs.mkdirSync(opts.dir, { recursive: true });
  const dbPath = path.join(opts.dir, "opencode.db");
  const db = new Database(dbPath);

  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`);
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

  for (const s of opts.sessions ?? []) {
    db.run("INSERT INTO session (id, data) VALUES (?, ?)", [
      s.id,
      JSON.stringify({ title: s.title }),
    ]);
  }

  for (const m of opts.messages) {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      m.id,
      m.session,
      m.t,
      JSON.stringify({ role: m.role }),
    ]);
    let partSeq = 0;
    for (const text of m.texts ?? []) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_text_${partSeq++}`,
        m.id,
        m.t,
        JSON.stringify({ type: "text", text }),
      ]);
    }
    for (const text of m.reasonings ?? []) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_reason_${partSeq++}`,
        m.id,
        m.t,
        JSON.stringify({ type: "reasoning", text }),
      ]);
    }
    for (const text of m.tools ?? []) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_tool_${partSeq++}`,
        m.id,
        m.t,
        JSON.stringify({ type: "tool", text }),
      ]);
    }
  }

  db.close();
  return dbPath;
}

function readDailyRecords(logFile: string): DailyLogRecord[] {
  return fs
    .readFileSync(logFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as DailyLogRecord);
}

// ---------------------------------------------------------------------------
// A. Ingestão integral em chunks (Card 8A)
// ---------------------------------------------------------------------------

describe("DREAMS-08A — chunking integral de diálogos longos", () => {
  test("chunkDialogueText: >120k chars vira múltiplos chunks sem omitir o início do dia", () => {
    // Diálogo longo com marcadores inequívocos de manhã, tarde e noite.
    const lines: string[] = [];
    lines.push("MANHA_INICIO: primeira mensagem do dia, antes de qualquer outra.");
    for (let i = 0; i < 80; i++) {
      lines.push(`manhã linha ${i}: ${"a".repeat(900)}`);
    }
    lines.push("TARDE_MEIO: mensagem do meio da tarde.");
    for (let i = 0; i < 80; i++) {
      lines.push(`tarde linha ${i}: ${"b".repeat(900)}`);
    }
    lines.push("NOITE_FIM: última mensagem do dia.");
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(120_000);

    const chunks = chunkDialogueText(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS_PER_CHUNK);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES_PER_CHUNK
      );
      // Nenhum chunk reintroduz o truncamento invertido legado.
      expect(chunk).not.toContain("[… início do dia omitido]");
    }

    // Reconstrução EXATA: nenhum caractere perdido nas fronteiras.
    expect(chunks.join("\n")).toBe(text);

    // A conversa do início do dia NÃO foi descartada e a ordem é cronológica.
    const rebuilt = chunks.join("\n");
    expect(chunks[0]).toContain("MANHA_INICIO");
    expect(chunks[chunks.length - 1]).toContain("NOITE_FIM");
    expect(rebuilt.indexOf("MANHA_INICIO")).toBeLessThan(rebuilt.indexOf("TARDE_MEIO"));
    expect(rebuilt.indexOf("TARDE_MEIO")).toBeLessThan(rebuilt.indexOf("NOITE_FIM"));
  });

  test("chunkDialogueText: linha gigante é fatiada por bytes sem U+FFFD (multibyte seguro)", () => {
    // Uma única linha acentuada maior que o orçamento: força o caminho de
    // fatiamento por bytes (Buffer.subarray), que não pode partir code points.
    const giant = "ação ção coração — ".repeat(400); // multibyte, > 4k chars
    const chunks = chunkDialogueText(giant, {
      maxCharsPerChunk: 700,
      maxBytesPerChunk: 1000,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(700);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1000);
      expect(chunk).not.toContain("\uFFFD");
    }
    // Reconstrução integral (sem quebras de linha internas na entrada).
    expect(chunks.join("")).toBe(giant);
  });

  test("chunkDialogueText: orçamento de BYTES também limita o empacotamento de linhas curtas multibyte", () => {
    // Linhas CURTAS acentuadas: o limite de chars permitiria 5 por chunk, mas o
    // de bytes só permite 4. Garante que `fits()` valida os DOIS orçamentos no
    // caminho normal de empacotamento (não apenas no fatiamento de linha gigante).
    const lines = Array.from({ length: 12 }, (_, i) => `linha ${i} ação ação ação`);
    expect(lines[0].length).toBe(22);
    expect(Buffer.byteLength(lines[0], "utf8")).toBe(28);

    const chunks = chunkDialogueText(lines.join("\n"), {
      maxCharsPerChunk: 120,
      maxBytesPerChunk: 120,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(120);
      expect(chunk).not.toContain("\uFFFD");
    }
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  test("chunkDialogueText: entrada vazia/branca → [] e defaults canônicos", () => {
    expect(chunkDialogueText("")).toEqual([]);
    expect(chunkDialogueText("   \n\n  ")).toEqual([]);
    expect(DEFAULT_MAX_CHARS_PER_CHUNK).toBe(100_000);
    expect(DEFAULT_MAX_BYTES_PER_CHUNK).toBe(110_000);
    // Folga explícita sob MAX_PROMPT_BYTES (128.000) usada pelo sintetizador.
    expect(DEFAULT_MAX_BYTES_PER_CHUNK).toBeLessThan(128_000);
  });

  test("chunkDialogues: diálogo real do SQLite >120k chars em chunks cronológicos sem perda", () => {
    // SQLite REAL com mensagens de manhã/tarde/noite, sem truncamento
    // (`maxTextLength: 0` desliga o corte por trecho do leitor).
    const dir = freshDir("reader_long");
    const dbPath = buildOpenCodeDb({
      dir,
      sessions: [{ id: "ses_long", title: "Dia longo de trabalho" }],
      messages: [
        {
          id: "msg_manha",
          session: "ses_long",
          t: NOW - 10 * 60 * MIN,
          role: "user",
          texts: [`MANHA_INICIO ${"a".repeat(45_000)}`],
        },
        {
          id: "msg_almoco",
          session: "ses_long",
          t: NOW - 8 * 60 * MIN,
          role: "assistant",
          texts: [`ALMOCO_MEIO ${"b".repeat(45_000)}`],
        },
        {
          id: "msg_tarde",
          session: "ses_long",
          t: NOW - 4 * 60 * MIN,
          role: "user",
          texts: [`TARDE_MEIO ${"c".repeat(45_000)}`],
        },
        {
          id: "msg_noite",
          session: "ses_long",
          t: NOW - 1 * 60 * MIN,
          role: "assistant",
          texts: [`NOITE_FIM ${"d".repeat(45_000)}`],
        },
      ],
    });

    const entries = readRecentDialogues({
      dbPath,
      sinceMs: NOW - 24 * 60 * MIN,
      maxTextLength: 0, // ingestão INTEGRAL, sem corte por trecho
    });
    expect(entries.length).toBe(4);

    const full = buildDialogueSummary(entries);
    expect(full.length).toBeGreaterThan(120_000);
    expect(full).not.toContain("[… início do dia omitido]");

    const chunks = chunkDialogues(entries);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("\n")).toBe(full);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS_PER_CHUNK);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES_PER_CHUNK
      );
    }

    // A PRIMEIRA conversa do dia (que o truncamento invertido descartava)
    // está presente no primeiro chunk, e a última no último.
    expect(chunks[0]).toContain("MANHA_INICIO");
    expect(chunks[chunks.length - 1]).toContain("NOITE_FIM");
    const rebuilt = chunks.join("\n");
    expect(rebuilt.indexOf("MANHA_INICIO")).toBeLessThan(rebuilt.indexOf("ALMOCO_MEIO"));
    expect(rebuilt.indexOf("ALMOCO_MEIO")).toBeLessThan(rebuilt.indexOf("TARDE_MEIO"));
    expect(rebuilt.indexOf("TARDE_MEIO")).toBeLessThan(rebuilt.indexOf("NOITE_FIM"));
  });
});

// ---------------------------------------------------------------------------
// B. remSleep multi-chunk (seam real: OPENCODE_BIN = script bash em /tmp)
// ---------------------------------------------------------------------------

interface Recorder {
  bin: string;
  dir: string;
  stdinLog(seq: number): string;
  count(): number;
}

/**
 * Cria um binário REAL de transporte: script bash que incrementa um contador,
 * grava o stdin de cada invocação em disco e imprime uma memória JSON única.
 *
 * `failFrom` (1-based) faz TODAS as invocações a partir daquele número falharem
 * com exit 1. A falha é ancorada no Nº de invocação (e não no modelo) porque
 * cada chunk consome 1 tentativa por modelo da cascata: como os chunks 1 e 2
 * são concluídos pelo modelo primário (1 invocação cada = #1 e #2), qualquer
 * invocação `>= 3` pertence ao 3º chunk — assim o teste permanece válido seja a
 * cascata de 2 ou 3 degraus (Antigravity → Mimo → opencode-go/deepseek).
 */
function makeRecorder(name: string, failFrom?: number): Recorder {
  const dir = freshDir(name);
  const bin = path.join(dir, "opencode_recorder.sh");
  const countFile = path.join(dir, "count");
  const failGuard =
    typeof failFrom === "number" && failFrom > 0
      ? `if [ "$N" -ge ${failFrom} ]; then echo "modelo indisponível (fixture real)" >&2; exit 1; fi`
      : "";

  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `COUNT_FILE="${countFile}"`,
      'N=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))',
      'printf "%s" "$N" > "$COUNT_FILE"',
      `cat > "${dir}/stdin_$N.log"`,
      failGuard,
      `SIG=$(md5sum "${dir}/stdin_$N.log" | cut -c1-16)`,
      'H1=${SIG:0:4}; H2=${SIG:4:4}; H3=${SIG:8:4}; H4=${SIG:12:4}',
      `printf '[{"scope":"collective","fact":"Memoria do chunk %s referencia %s %s %s %s com licoes consolidadas do dia","category":"learning"}]\\n' "$N" "$H1" "$H2" "$H3" "$H4"`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  return {
    bin,
    dir,
    stdinLog: (seq: number) => path.join(dir, `stdin_${seq}.log`),
    count: () => {
      try {
        return Number(fs.readFileSync(countFile, "utf-8"));
      } catch {
        return 0;
      }
    },
  };
}

function buildLongDialogue(): string {
  const lines: string[] = ["MANHA_INICIO: conversa da manhã com detalhes importantes."];
  for (let i = 0; i < 100; i++) lines.push(`manhã ${i}: ${"m".repeat(900)}`);
  lines.push("TARDE_MEIO: decisão tomada no meio da tarde.");
  for (let i = 0; i < 100; i++) lines.push(`tarde ${i}: ${"t".repeat(900)}`);
  lines.push("NOITE_FIM: fechamento do dia com encaminhamentos.");
  for (let i = 0; i < 40; i++) lines.push(`noite ${i}: ${"n".repeat(900)}`);
  return lines.join("\n");
}

/** Executa `fn` com DREAMS_OFFLINE removido (apenas no teste) e restaura. */
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

describe("DREAMS-08A — remSleep processa cada chunk sequencialmente", () => {
  test(">120k chars → todos os chunks sintetizados e memórias de CADA chunk no DreamsDB", async () => {
    const baseDir = freshDir("rem_multi");
    const rec = makeRecorder("rem_multi_recorder");
    const dialogue = buildLongDialogue();
    expect(dialogue.length).toBeGreaterThan(120_000);

    const pendingFile = path.join(baseDir, "dialogue_pending.txt");
    fs.writeFileSync(pendingFile, dialogue);

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      process.env.OPENCODE_BIN = rec.bin;
      await withoutOffline(async () => {
        const cycle = new SleepCycle(db, { baseDir });
        await cycle.remSleep();
      });

      const expectedChunks = chunkDialogueText(dialogue).length;
      expect(expectedChunks).toBeGreaterThanOrEqual(2);

      // Cada chunk = exatamente uma invocação de SÍNTESE (o modelo primário
      // responde OK) — nenhum chunk é sintetizado duas vezes.
      //
      // TICKET-DREAMS-06 (Frente B): o Sono REM passou a fazer UMA invocação
      // EXTRA — o julgamento neural de reconciliação em LOTE — quando a
      // triagem léxica (Jaccard >= 15%) encontrou candidatos. Essa invocação é
      // o LOTE de reconciliação, jamais um chunk reaproveitado.
      const totalInvocations = rec.count();
      expect(totalInvocations).toBeGreaterThanOrEqual(expectedChunks);
      expect(totalInvocations).toBeLessThanOrEqual(expectedChunks + 1);
      if (totalInvocations > expectedChunks) {
        const extraStdin = fs.readFileSync(rec.stdinLog(expectedChunks + 1), "utf-8");
        expect(extraStdin).toContain("Reconciliador Cognitivo");
        expect(extraStdin).not.toContain("MANHA_INICIO");
      }

      // Conteúdo cronológico chegou ao transporte, sem omissão do início do dia.
      const stdins: string[] = [];
      for (let seq = 1; seq <= expectedChunks; seq++) {
        const chunkStdin = fs.readFileSync(rec.stdinLog(seq), "utf-8");
        expect(chunkStdin).not.toContain("[… início do dia omitido]");
        stdins.push(chunkStdin);
      }
      const firstStdin = stdins[0];
      expect(firstStdin).toContain("MANHA_INICIO");
      expect(firstStdin).not.toContain("NOITE_FIM");
      // Manhã, tarde e noite chegaram ao sintetizador na ordem cronológica,
      // ainda que uma fronteira de chunk caia no meio de um bloco.
      const allStdin = stdins.join("\n");
      expect(allStdin).toContain("TARDE_MEIO");
      expect(allStdin).toContain("NOITE_FIM");
      expect(allStdin.indexOf("MANHA_INICIO")).toBeLessThan(
        allStdin.indexOf("TARDE_MEIO")
      );
      expect(allStdin.indexOf("TARDE_MEIO")).toBeLessThan(allStdin.indexOf("NOITE_FIM"));

      // Memórias de TODOS os chunks foram inseridas no SQLite real.
      const facts = db.getAllMemories().map((m) => m.fact);
      for (let seq = 1; seq <= expectedChunks; seq++) {
        expect(facts.some((f) => f.includes(`Memoria do chunk ${seq} referencia`))).toBe(true);
      }

      // Sucesso integral: handoff consumido e checkpoint avançado.
      expect(fs.existsSync(pendingFile)).toBe(false);
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME), "utf-8")
      );
      expect(typeof checkpoint.last_synthesized_at).toBe("string");
      expect(Number.isNaN(Date.parse(checkpoint.last_synthesized_at))).toBe(false);
    } finally {
      db.close();
    }
  }, 120_000);

  test("falha mid-chunk: handoff preservado byte-a-byte, checkpoint não avança e nada falso é gravado", async () => {
    const baseDir = freshDir("rem_fail");
    // Chunks 1 e 2 concluem no modelo primário (invocações #1 e #2); o 3º chunk
    // passa a falhar a partir da invocação #3, para QUALQUER degrau da cascata
    // (com 3 modelos: #3, #4 e #5 falham → chunk 3 adiado integralmente).
    const rec = makeRecorder("rem_fail_recorder", 3);
    const dialogue = buildLongDialogue();
    const pendingFile = path.join(baseDir, "dialogue_pending.txt");
    fs.writeFileSync(pendingFile, dialogue);

    const db = new DreamsDB(path.join(baseDir, "dreams.db"));
    try {
      process.env.OPENCODE_BIN = rec.bin;
      await withoutOffline(async () => {
        const cycle = new SleepCycle(db, { baseDir });
        await cycle.remSleep();
      });

      const expectedChunks = chunkDialogueText(dialogue).length;
      expect(expectedChunks).toBeGreaterThanOrEqual(3);

      // Handoff INTACTO (byte-a-byte) para retry integral no próximo ciclo.
      expect(fs.readFileSync(pendingFile, "utf-8")).toBe(dialogue);

      // Checkpoint NÃO avançou (arquivo pode nem existir).
      const checkpointPath = path.join(baseDir, DIALOGUE_CHECKPOINT_FILENAME);
      if (fs.existsSync(checkpointPath)) {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf-8"));
        expect(checkpoint.last_synthesized_at).toBeNull();
      }

      // DREAMS.md sinaliza adiamento.
      const markdown = fs.readFileSync(path.join(baseDir, "DREAMS.md"), "utf-8");
      expect(markdown).toContain("**adiada**");

      // TICKET-DREAMS-06-FIX (RESSALVA DE ATOMICIDADE): a persistência é
      // ATÔMICA em relação à síntese. Nenhuma memória — nem as dos chunks 1 e
      // 2, que concluíram — é gravada quando um chunk intermediário falha.
      // Antes da correção, o acervo ficava em ESTADO PARCIAL e a mesma noite
      // era sintetizada de novo no retry (duplicação silenciosa).
      const facts = db.getAllMemories().map((m) => m.fact);
      expect(facts.some((f) => f.includes("Memoria do chunk 1 referencia"))).toBe(false);
      expect(facts.some((f) => f.includes("Memoria do chunk 2 referencia"))).toBe(false);
      expect(facts.some((f) => f.includes(`Memoria do chunk ${expectedChunks} referencia`))).toBe(
        false
      );
      // O acervo permanece exatamente como estava: vazio.
      expect(db.getAllMemories()).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C. `backfill` — parser, leitura real, escrita no `.jsonl` e fail-soft (8B)
// ---------------------------------------------------------------------------

describe("DREAMS-08B — parseBackfillArgs", () => {
  const cases: Array<{ args: string[]; expected: number; label: string }> = [
    { args: ["--limit", "20"], expected: 20, label: "--limit 20" },
    { args: ["--limit=20"], expected: 20, label: "--limit=20" },
    { args: ["20"], expected: 20, label: "20 posicional" },
    { args: [], expected: BACKFILL_DEFAULT_LIMIT, label: "default" },
    { args: ["--limit"], expected: BACKFILL_DEFAULT_LIMIT, label: "--limit sem valor" },
    { args: ["0"], expected: BACKFILL_DEFAULT_LIMIT, label: "0 inválido" },
    { args: ["-5"], expected: BACKFILL_DEFAULT_LIMIT, label: "-5 inválido" },
    { args: ["--limit=abc"], expected: BACKFILL_DEFAULT_LIMIT, label: "--limit=abc" },
    { args: ["--unknown", "x"], expected: BACKFILL_DEFAULT_LIMIT, label: "flag desconhecida" },
    { args: ["50", "--limit=5"], expected: 5, label: "último válido vence" },
    { args: ["--limit", "50", "30"], expected: 30, label: "posicional posterior vence" },
  ];

  for (const c of cases) {
    test(`${c.label} → ${c.expected}`, () => {
      expect(parseBackfillArgs(c.args)).toEqual({ limit: c.expected });
    });
  }

  test("BACKFILL_DEFAULT_LIMIT é 10", () => {
    expect(BACKFILL_DEFAULT_LIMIT).toBe(10);
  });
});

describe("DREAMS-08B — runBackfill sobre SQLite real", () => {
  const FIXED_NOW = new Date("2026-10-17T12:00:00.000Z");
  const FIXED_DATE = "2026-10-17";

  function buildQualityDb(name: string): string {
    return buildOpenCodeDb({
      dir: freshDir(name),
      sessions: [
        { id: "ses_work", title: "Sessão de trabalho" },
        { id: "ses_internal", title: "Dreams Synthesis" },
      ],
      messages: [
        {
          id: "msg_1",
          session: "ses_work",
          t: NOW - 9 * MIN,
          role: "user",
          texts: [
            "Preciso que você implemente a ingestão integral em chunks sem perder o início do dia.",
          ],
        },
        {
          id: "msg_2",
          session: "ses_work",
          t: NOW - 8 * MIN,
          role: "assistant",
          texts: ["Vou particionar o diálogo em fatias sequenciais e validar cada uma."],
          reasonings: ["RACIOCINIO_INTERNO_QUE_NAO_DEVE_APARECER no log diário"],
          tools: ["TOOL_PAYLOAD_GIGANTE_QUE_NAO_DEVE_APARECER"],
        },
        {
          id: "msg_3",
          session: "ses_work",
          t: NOW - 7 * MIN,
          role: "user",
          texts: ["ok"],
        },
        {
          id: "msg_4",
          session: "ses_work",
          t: NOW - 6 * MIN,
          role: "assistant",
          texts: [`FATO_LONGO ${"x".repeat(800)}`],
        },
        {
          id: "msg_internal",
          session: "ses_internal",
          t: NOW - 5 * MIN,
          role: "user",
          texts: ["CONTEUDO_DA_SESSAO_INTERNA_NAO_DEVE_APARECER no backfill"],
        },
        {
          id: "msg_5",
          session: "ses_work",
          t: NOW - 4 * MIN,
          role: "user",
          texts: ["Mensagem final do dia com detalhes suficientes para virar um fato útil."],
        },
      ],
    });
  }

  test("grava registros canônicos no log diário, com filtros, clamp e reasoning off", () => {
    const dbPath = buildQualityDb("backfill_quality");
    const baseDir = freshDir("backfill_quality_out");
    const result = runBackfill({ dbPath, baseDir, limit: 20, now: FIXED_NOW });

    const logFile = path.join(baseDir, "daily", `log_${FIXED_DATE}.jsonl`);
    expect(result.logFile).toBe(logFile);
    expect(fs.existsSync(logFile)).toBe(true);

    // 5 trechos lidos (a sessão interna é excluída); "ok" é ruído (<20 chars).
    expect(result.entriesRead).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(4);

    const records = readDailyRecords(logFile);
    expect(records.length).toBe(4);
    for (const record of records) {
      expect(record.type).toBe("dialogue_backfill");
      expect(record.scope).toBe("collective");
      expect(record.category).toBe("learning");
      // Timestamp ISO real da mensagem de origem (round-trip exato).
      expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    }

    const facts = records.map((r) => r.fact);
    expect(facts[0].startsWith("[user] Preciso que você implemente")).toBe(true);
    expect(facts[1].startsWith("[assistant] Vou particionar")).toBe(true);
    expect(facts[2].startsWith("[assistant] FATO_LONGO")).toBe(true);
    expect(facts[3].startsWith("[user] Mensagem final do dia")).toBe(true);

    // Clamp de 500 chars + elipse, com folga do prefixo de papel.
    expect(facts[2].endsWith(" …")).toBe(true);
    expect(facts[2].length).toBeLessThanOrEqual("[assistant] ".length + 502);

    // Ruído e defesa anti-recursão nunca aparecem.
    const joined = facts.join("\n");
    expect(joined).not.toContain("RACIOCINIO_INTERNO");
    expect(joined).not.toContain("TOOL_PAYLOAD_GIGANTE");
    expect(joined).not.toContain("CONTEUDO_DA_SESSAO_INTERNA");
  });

  test("--limit N grava até N fatos, retendo os N trechos MAIS RECENTES em ordem cronológica", () => {
    const dir = freshDir("backfill_limit");
    const messages: FixtureMessage[] = [];
    for (let i = 1; i <= 12; i++) {
      messages.push({
        id: `msg_${String(i).padStart(2, "0")}`,
        session: "ses_limit",
        t: NOW - (60 - i) * MIN,
        role: i % 2 === 0 ? "assistant" : "user",
        texts: [`FATO_ITEM_${String(i).padStart(2, "0")} conteúdo relevante do trecho.`],
      });
    }
    const dbPath = buildOpenCodeDb({
      dir,
      sessions: [{ id: "ses_limit", title: "Sessão limit" }],
      messages,
    });
    const baseDir = freshDir("backfill_limit_out");

    const result = runBackfill({ dbPath, baseDir, limit: 5, now: FIXED_NOW });
    expect(result.written).toBe(5);

    const records = readDailyRecords(result.logFile);
    expect(records.length).toBe(5);
    const facts = records.map((r) => r.fact);
    // Apenas os 5 mais recentes (08..12), sem os antigos.
    for (let i = 8; i <= 12; i++) {
      expect(facts.some((f) => f.includes(`FATO_ITEM_${String(i).padStart(2, "0")}`))).toBe(
        true
      );
    }
    for (let i = 1; i <= 7; i++) {
      expect(facts.some((f) => f.includes(`FATO_ITEM_${String(i).padStart(2, "0")}`))).toBe(
        false
      );
    }
  });

  test("idempotência: segunda execução com os mesmos fatos grava 0 e não duplica linhas", () => {
    const dbPath = buildQualityDb("backfill_idem");
    const baseDir = freshDir("backfill_idem_out");
    const first = runBackfill({ dbPath, baseDir, limit: 20, now: FIXED_NOW });
    expect(first.written).toBe(4);
    const linesAfterFirst = readDailyRecords(first.logFile).length;

    const second = runBackfill({ dbPath, baseDir, limit: 20, now: FIXED_NOW });
    expect(second.written).toBe(0);
    expect(second.entriesRead).toBe(5);
    expect(readDailyRecords(second.logFile).length).toBe(linesAfterFirst);
  });

  test("fail-soft: banco ausente, 0 byte e corrompido → {entriesRead:0, written:0} sem throw e sem criar log", () => {
    const absent = path.join(freshDir("backfill_absent"), "nao_existe.db");

    const emptyDir = freshDir("backfill_empty");
    const empty = path.join(emptyDir, "opencode.db");
    fs.writeFileSync(empty, "");

    const corruptDir = freshDir("backfill_corrupt");
    const corrupt = path.join(corruptDir, "opencode.db");
    fs.writeFileSync(corrupt, Buffer.from("isto nao e um banco sqlite valido \x00\x01\x02"));

    for (const [label, dbPath] of [
      ["ausente", absent],
      ["0 byte", empty],
      ["corrompido", corrupt],
    ] as const) {
      const baseDir = freshDir(`backfill_failsoft_out_${label.replace(/\s/g, "_")}`);
      const errors: unknown[] = [];
      let result: ReturnType<typeof runBackfill> | undefined;
      expect(() => {
        result = runBackfill({
          dbPath,
          baseDir,
          limit: 10,
          now: FIXED_NOW,
          onError: (error) => errors.push(error),
        });
      }).not.toThrow();

      expect(result!.entriesRead).toBe(0);
      expect(result!.written).toBe(0);
      expect(result!.logFile).toBe(
        path.join(baseDir, "daily", `log_${FIXED_DATE}.jsonl`)
      );
      expect(fs.existsSync(result!.logFile)).toBe(false);
    }
  });

  test("log diário só é criado quando há pelo menos 1 fato de qualidade", () => {
    const dir = freshDir("backfill_noise");
    const dbPath = buildOpenCodeDb({
      dir,
      sessions: [{ id: "ses_noise", title: "Só ruído" }],
      messages: [
        {
          id: "msg_a",
          session: "ses_noise",
          t: NOW - 3 * MIN,
          role: "user",
          texts: ["ok", "sim", "tudo certo"],
        },
      ],
    });
    const baseDir = freshDir("backfill_noise_out");

    const result = runBackfill({ dbPath, baseDir, limit: 10, now: FIXED_NOW });
    expect(result.entriesRead).toBe(1);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(result.logFile)).toBe(false);
  });

  test("e2e CLI real (HOME isolado): `backfill --limit=20` lê o SQLite e escreve o log; 2ª run é idempotente", async () => {
    const home = freshDir("backfill_cli_home");
    const sessionDbDir = path.join(home, ".local", "share", "opencode");
    const dbPath = buildOpenCodeDb({
      dir: sessionDbDir,
      sessions: [{ id: "ses_cli", title: "Sessão CLI" }],
      messages: [
        {
          id: "msg_cli_1",
          session: "ses_cli",
          t: NOW - 5 * MIN,
          role: "user",
          texts: ["Mensagem real lida do SQLite pelo subcomando backfill da CLI."],
        },
        {
          id: "msg_cli_2",
          session: "ses_cli",
          t: NOW - 4 * MIN,
          role: "assistant",
          texts: ["Resposta real do agente que também deve virar um fato de qualidade."],
        },
      ],
    });
    expect(fs.existsSync(dbPath)).toBe(true);

    const runCli = (extraArgs: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, "src/cli.ts", "backfill", ...extraArgs],
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home, DREAMS_OFFLINE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

    const first = runCli(["--limit=20"]);
    expect(first.exitCode).toBe(0);
    const firstOut = first.stdout.toString();
    expect(firstOut).toContain("Starting backfill (limit: 20)");
    expect(firstOut).toContain("entradas gravadas");

    const dreamsDir = path.join(home, ".config", "opencode", "dreams");
    const dailyDir = path.join(dreamsDir, "daily");
    const logFiles = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".jsonl"));
    expect(logFiles.length).toBe(1);
    const logFile = path.join(dailyDir, logFiles[0]);
    const records = readDailyRecords(logFile);
    expect(records.length).toBe(2);
    expect(records.every((r) => r.type === "dialogue_backfill")).toBe(true);
    expect(records.map((r) => r.fact).join("\n")).toContain("subcomando backfill da CLI");

    const second = runCli(["--limit=20"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("Nenhum fato novo");
    expect(readDailyRecords(logFile).length).toBe(2);
  }, 60_000);
});
