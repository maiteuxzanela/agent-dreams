import fs from "fs";
import path from "path";
import os from "os";
import { DreamsDB, MemoryRecord, CATEGORY_WEIGHTS } from "./db";
import { readRecentDialogueSummary } from "./session_reader";
import {
  synthesizeMemories,
  MAX_PROMPT_BYTES,
  truncateUtf8Tail,
  utf8ByteLength,
  type SynthesisSource,
  type SynthesizedMemory,
} from "./mimo_synthesizer";

// Diretório base padrão (produção). Testes injetam um baseDir isolado via options.
const DEFAULT_DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");

// Eventos triviais de ciclo de vida: repetições não devem reforçar score (DEF-10).
const TRIVIAL_EVENT_TYPES = new Set(["session.idle", "session.deleted", "session.compacted"]);

// Nomes de agente aceitos em escopos `agent:<nome>` — bloqueia Directory Traversal (DEF-03).
const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Nome do arquivo de checkpoint durável do handoff Light↔REM (Frente 2A/C3).
 * Fica ao lado de `dialogue_pending.txt` no dreams dir.
 */
export const DIALOGUE_CHECKPOINT_FILENAME = "dialogue_checkpoint.json";

/**
 * Estado durável do handoff de diálogo entre o Light Sleep e o REM Sleep.
 * - `last_capture_at`: ISO da última captura no Light Sleep. Avança SEMPRE
 *   (mesmo quando a síntese falha) e serve de fronteira de leitura para não
 *   re-acumular o mesmo diálogo.
 * - `last_synthesized_at`: ISO da última síntese REM concluída com SUCESSO.
 *   Só avança quando a síntese é comprovadamente íntegra (synthesisSucceeded).
 */
export interface DialogueCheckpoint {
  last_capture_at: string | null;
  last_synthesized_at: string | null;
}

/** Separador temporal entre blocos de diálogo acumulados de ciclos distintos. */
function dialogueAccumulationSeparator(iso: string): string {
  return `\n\n===== [Dreams] diálogo acumulado em ${iso} =====\n\n`;
}

/** Opções do ciclo de sono (todas opcionais; padrão = produção). */
export interface SleepCycleOptions {
  /** Diretório base isolado para testes (dreams dir). */
  baseDir?: string;
  /** Caminho do SQLite de sessões lido pelo Light Sleep.
   *  Padrão: `~/.local/share/opencode/opencode.db`. */
  sessionDbPath?: string;
  /** Captura o diálogo recente no lightSleep. Padrão: true. */
  captureDialogue?: boolean;
  /** Janela de horas retroativas do diálogo. Padrão: 24. */
  dialogueHours?: number;
}

export class SleepCycle {
  private db: DreamsDB;
  private lambda: number = 0.05; // Decay rate
  private threshold: number = 0.5;
  private dreamsDir: string;
  private dailyDir: string;
  private collectiveDir: string;
  private personasDir: string;
  /** Arquivo de handoff Light -> REM com o resumo do diálogo recente. */
  private dialogueFile: string;
  /** Checkpoint durável das fronteiras temporais do handoff (Frente 2A/C3). */
  private checkpointFile: string;
  private sessionDbPath: string | undefined;
  private captureDialogue: boolean;
  private dialogueHours: number;

  constructor(db: DreamsDB, options?: SleepCycleOptions) {
    this.db = db;
    this.dreamsDir = options?.baseDir ? path.resolve(options.baseDir) : DEFAULT_DREAMS_DIR;
    this.dailyDir = path.join(this.dreamsDir, "daily");
    this.collectiveDir = path.join(this.dreamsDir, "collective");
    this.personasDir = path.join(this.dreamsDir, "personas");
    this.dialogueFile = path.join(this.dreamsDir, "dialogue_pending.txt");
    this.checkpointFile = path.join(this.dreamsDir, DIALOGUE_CHECKPOINT_FILENAME);
    this.sessionDbPath = options?.sessionDbPath;
    this.captureDialogue = options?.captureDialogue ?? true;
    this.dialogueHours = options?.dialogueHours ?? 24;
    this.ensureDirs();
  }

  private ensureDirs() {
    [this.dreamsDir, this.dailyDir, this.collectiveDir, this.personasDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  /**
   * Light Sleep: Ingest daily raw logs, deduplicate lexically.
   * Accepts records without explicit category: session.idle and session.compacted
   * fall back to category="learning" so they are not discarded.
   */
  public async lightSleep() {
    console.log("[Light Sleep] Starting ingestion of daily logs...");
    const files = fs.readdirSync(this.dailyDir).filter(f => f.endsWith(".jsonl"));
    let ingested = 0;

    for (const file of files) {
      const filePath = path.join(this.dailyDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim() !== "");
      
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          // Fallback: session.idle e session.compacted sem categoria explícita
          // recebem category="learning" para não serem descartados.
          if (record.fact && record.scope) {
            const category = record.category
              || (["session.idle", "session.compacted"].includes(record.type) ? "learning"
              : undefined);
            if (category) {
              // DEF-10: eventos triviais de ciclo de vida repetidos não reforçam score.
              const isTrivial = TRIVIAL_EVENT_TYPES.has(record.type);
              this.db.insertMemory(record.scope, record.fact, category, 1.0, 1.0, {
                reinforce: !isTrivial
              });
              ingested++;
            }
          }
        } catch (e) {
          console.error(`[Light Sleep] Failed to parse log line in ${file}`);
        }
      }
      // Archive or delete daily file after ingestion
      fs.renameSync(filePath, filePath + ".processed");
    }
    // TTL de 3 dias: varre DAILY_DIR e apaga arquivos .processed ou .jsonl
    // cuja mtime tenha mais que 3 dias.
    this.expireOldDailyFiles();

    // Captura do diálogo real das últimas 24h no opencode.db (somente texto,
    // sem raciocínio) para a destilação cognitiva do REM Sleep. Fail-soft:
    // banco ausente/corrompido -> resumo vazio, o ciclo local não quebra.
    this.captureRecentDialogue();

    console.log(`[Light Sleep] Ingested ${ingested} new facts.`);
  }

  /**
   * Lê o diálogo recente (`session_reader`) e o persiste em
   * `dialogue_pending.txt` como handoff para o REM Sleep — necessário porque
   * o wrapper `bin/dreams-consolidate.sh` roda light/rem em processos separados.
   *
   * Frente 2A (C3) — CHECKPOINT CUMULATIVO: este método NUNCA sobrescreve um
   * handoff não consumido. Se já existir `dialogue_pending.txt` (síntese
   * adiada/falha anterior), o novo diálogo é CONCATENADO com um separador
   * temporal. Para não duplicar a janela, lê apenas o diálogo surgido DEPOIS
   * da última captura (`last_capture_at`) e nunca toca `last_synthesized_at`
   * (fronteira de sucesso — só o REM a avança).
   */
  private captureRecentDialogue() {
    if (!this.captureDialogue) return;
    const capturedAt = new Date();
    try {
      // Fronteira de leitura: diálogo estritamente posterior à última captura.
      // Sem checkpoint (upgrade/instalação) mas com pendente em disco, usa a
      // mtime do próprio pendente para não re-acumular o que já foi capturado.
      let sinceMs = this.checkpointMs("capture");
      if (sinceMs === undefined && fs.existsSync(this.dialogueFile)) {
        try {
          sinceMs = fs.statSync(this.dialogueFile).mtimeMs;
        } catch {
          /* stat indisponível: cai para a janela padrão em horas */
        }
      }
      if (sinceMs !== undefined && sinceMs > capturedAt.getTime()) {
        sinceMs = undefined; // relógio retrocedeu: cai para a janela em horas
      }

      const summary = readRecentDialogueSummary({
        dbPath: this.sessionDbPath,
        ...(sinceMs !== undefined ? { sinceMs } : { hours: this.dialogueHours }),
        includeReasoning: false, // reasoning domina o volume e infla token
        onError: (error) => console.error("[Light Sleep] session_reader:", error),
      });

      const existing = this.readPendingRaw();
      if (summary.trim() === "") {
        console.log(
          "[Light Sleep] Nenhum diálogo novo capturado; handoff pendente preservado."
        );
      } else {
        const merged = this.mergeDialogue(existing, summary, capturedAt.toISOString());
        fs.writeFileSync(this.dialogueFile, merged);
        console.log(
          `[Light Sleep] Handoff acumulado (${utf8ByteLength(merged)} bytes;` +
            ` ${summary.length} chars novos) para o REM Sleep.`
        );
      }

      // A fronteira de captura avança SEMPRE — inclusive sem conteúdo novo —
      // para que a próxima noite leia apenas o diálogo posterior a este ponto.
      const checkpoint = this.readCheckpoint();
      this.writeCheckpoint({
        last_capture_at: capturedAt.toISOString(),
        last_synthesized_at: checkpoint.last_synthesized_at,
      });
    } catch (error) {
      // Fail-soft: a captura de diálogo nunca derruba a ingestão de logs e
      // jamais descarta um pendente já existente.
      console.error("[Light Sleep] Falha ao capturar diálogo recente:", error);
    }
  }

  /** Lê o conteúdo cru do handoff pendente (`""` quando ausente/ilegível). */
  private readPendingRaw(): string {
    try {
      if (fs.existsSync(this.dialogueFile)) {
        return fs.readFileSync(this.dialogueFile, "utf-8");
      }
    } catch (error) {
      console.error("[Light Sleep] Falha ao ler dialogue_pending.txt:", error);
    }
    return "";
  }

  /**
   * Concatena um novo bloco de diálogo ao handoff existente com separador
   * temporal, respeitando o teto absoluto em BYTES do sintetizador
   * (`MAX_PROMPT_BYTES`) para nunca estourar o buffer do prompt.
   */
  private mergeDialogue(existing: string, incoming: string, capturedIso: string): string {
    const prev = existing.trim();
    const next = incoming.trim();
    if (prev === "") return next;
    if (next === "") return prev;
    const merged = `${prev}${dialogueAccumulationSeparator(capturedIso)}${next}`;
    if (utf8ByteLength(merged) <= MAX_PROMPT_BYTES) return merged;
    // Teto do sintetizador: preserva a CAUDA (diálogo mais recente), a mesma
    // política de `buildCappedPrompt`, para nunca exceder 128 KiB.
    console.warn(
      `[Light Sleep] Handoff acumulado excede ${MAX_PROMPT_BYTES} bytes; ` +
        "preservando a cauda mais recente."
    );
    return truncateUtf8Tail(merged, MAX_PROMPT_BYTES);
  }

  /**
   * Consome o handoff do Light Sleep; se inexistente (REM isolado), lê o
   * opencode.db diretamente. Devolve `""` quando não há diálogo.
   */
  private loadPendingDialogue(): string {
    const pending = this.readPendingRaw();
    if (pending.trim() !== "") return pending;
    if (!this.captureDialogue) return "";
    try {
      // Sem handoff em disco: lê o opencode.db diretamente, mas SOMENTE o
      // diálogo posterior à última síntese consolidada (`last_synthesized_at`),
      // evitando re-sintetizar conteúdo já processado (Frente 2A/C3).
      const sinceMs = this.checkpointMs("synthesized");
      return readRecentDialogueSummary({
        dbPath: this.sessionDbPath,
        ...(sinceMs !== undefined ? { sinceMs } : { hours: this.dialogueHours }),
        includeReasoning: false,
        onError: (error) => console.error("[REM Sleep] session_reader:", error),
      });
    } catch (error) {
      console.error("[REM Sleep] Falha ao ler diálogo direto:", error);
      return "";
    }
  }

  /** Remove o handoff após o consumo (evita re-sintetizar a mesma janela). */
  private clearPendingDialogue() {
    try {
      if (fs.existsSync(this.dialogueFile)) fs.unlinkSync(this.dialogueFile);
    } catch (error) {
      console.error("[REM Sleep] Falha ao limpar dialogue_pending.txt:", error);
    }
  }

  /** Lê o checkpoint do handoff; tolerante a ausência/corrupção do arquivo. */
  private readCheckpoint(): DialogueCheckpoint {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        const raw = JSON.parse(fs.readFileSync(this.checkpointFile, "utf-8"));
        return {
          last_capture_at:
            typeof raw?.last_capture_at === "string" ? raw.last_capture_at : null,
          last_synthesized_at:
            typeof raw?.last_synthesized_at === "string" ? raw.last_synthesized_at : null,
        };
      }
    } catch (error) {
      console.error("[Dreams] Falha ao ler dialogue_checkpoint.json:", error);
    }
    return { last_capture_at: null, last_synthesized_at: null };
  }

  /** Grava o checkpoint de forma atômica (write + rename no mesmo FS POSIX). */
  private writeCheckpoint(state: DialogueCheckpoint): void {
    try {
      const tmp = `${this.checkpointFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.checkpointFile);
    } catch (error) {
      console.error("[Dreams] Falha ao gravar dialogue_checkpoint.json:", error);
    }
  }

  /** Epoch ms da fronteira pedida (`capture` | `synthesized`) ou `undefined`. */
  private checkpointMs(which: "capture" | "synthesized"): number | undefined {
    const checkpoint = this.readCheckpoint();
    const iso =
      which === "capture" ? checkpoint.last_capture_at : checkpoint.last_synthesized_at;
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
  }

  /**
   * Consome o handoff SOMENTE após síntese REM bem-sucedida: remove o pendente
   * (para não re-sintetizar a mesma janela) e avança `last_synthesized_at`.
   * Em falha/adiamento este método NÃO é chamado — o pendente fica 100% íntegro.
   */
  private markSynthesisComplete(synthesizedAt: Date): void {
    this.clearPendingDialogue();
    const checkpoint = this.readCheckpoint();
    this.writeCheckpoint({
      last_capture_at: checkpoint.last_capture_at,
      last_synthesized_at: synthesizedAt.toISOString(),
    });
  }

  /**
   * Expunge old daily files: .processed or .jsonl older than 3 days.
   */
  private expireOldDailyFiles() {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      const entries = fs.readdirSync(this.dailyDir);
      for (const entry of entries) {
        const filePath = path.join(this.dailyDir, entry);
        const stat = fs.statSync(filePath);
        const isProcessed = entry.endsWith(".processed");
        const isJsonl = entry.endsWith(".jsonl");
        if ((isProcessed || isJsonl) && (now - stat.mtimeMs > THREE_DAYS_MS)) {
          console.log(`[Light Sleep] Expunging old file: ${entry} (mtime ${new Date(stat.mtimeMs).toISOString()})`);
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.error("[Light Sleep] Failed to expire old daily files:", e);
    }
  }

  /**
   * REM Sleep: síntese cognitiva via cascata de IA (`opencode run --pure`),
   * inserção das memórias destiladas no DreamsDB e geração do DREAMS.md.
   *
   * Fluxo:
   *  1. consome o diálogo do Light Sleep (`dialogue_pending.txt`);
   *  2. `synthesizeMemories(dialogue)` → array validado de memórias;
   *  3. `db.insertMemory(scope, fact, category)` para cada memória;
   *  4. escreve DREAMS.md e atualiza as projeções (COLLECTIVE/personas);
   *  5. limpa o handoff apenas se a síntese tiver sucesso.
   *
   * Resiliência e anti-mock: sem IA disponível, o ciclo preserva
   * `dialogue_pending.txt` intacto para o próximo ciclo tentar novamente,
   * sem gravar memórias falsas ou dados inventados.
   */
  public async remSleep() {
    console.log("[REM Sleep] Synthesizing memories...");

    const dialogue = this.loadPendingDialogue();
    let newMemories: SynthesizedMemory[] = [];
    let source: SynthesisSource = "none";
    let synthError: string | null = null;
    let synthesisSucceeded = false;

    if (dialogue.trim() !== "") {
      try {
        const result = await synthesizeMemories(dialogue, {
          onError: (error) => console.error("[REM Sleep] MimoSynthesizer:", error),
        });
        source = result.source;
        synthError = result.error;
        for (const mem of result.memories) {
          this.db.insertMemory(mem.scope, mem.fact, mem.category);
          newMemories.push(mem);
        }
        synthesisSucceeded = true;
        console.log(
          `[REM Sleep] Síntese ${source}: ${newMemories.length} memória(s) inserida(s)` +
            `${result.dropped > 0 ? `, ${result.dropped} descartada(s)` : ""}` +
            `${result.error ? ` — ${result.error}` : ""}.`
        );
      } catch (error) {
        // Síntese adiada por indisponibilidade de IA: preserva dialogue_pending.txt e não grava dados falsos
        synthError = error instanceof Error ? error.message : String(error);
        console.warn(`[REM Sleep] Síntese cognitiva adiada por indisponibilidade de modelo: ${synthError}`);
      }
    } else {
      console.log("[REM Sleep] Sem diálogo recente; usando memórias existentes.");
      synthesisSucceeded = true;
    }

    const allMemories = this.db.getAllMemories();

    // TICKET-DREAMS-02 (Frente 2B/C4): o early-return "Nenhuma memória para
    // sintetizar" foi REMOVIDO. Ele pulava a escrita do DREAMS.md e a
    // atualização das projeções; a projeção agora é responsabilidade do
    // `deepSleep` (pós-poda), que sempre roda nesta etapa.
    fs.writeFileSync(
      path.join(this.dreamsDir, "DREAMS.md"),
      this.renderDreamsMarkdown({ source, synthError, newMemories, allMemories })
    );

    // Frente 2A (C3): consome o handoff SOMENTE se a síntese foi bem-sucedida —
    // remove o pendente e avança `last_synthesized_at`. Em falha/adiamento, o
    // handoff permanece 100% íntegro para o próximo ciclo (sem amnésia).
    if (synthesisSucceeded) {
      this.markSynthesisComplete(new Date());
    }
  }

  /** Renderiza o DREAMS.md de forma determinística a partir do resultado. */
  private renderDreamsMarkdown(input: {
    source: SynthesisSource;
    synthError: string | null;
    newMemories: SynthesizedMemory[];
    allMemories: MemoryRecord[];
  }): string {
    const lines: string[] = ["# Daily Dreams Synthesis", ""];
    const statusText = input.synthError
      ? `**adiada** (${input.synthError})`
      : `**${input.source}**`;
    lines.push(
      `> Gerado em ${new Date().toISOString()} — status da síntese: ${statusText}`
    );
    lines.push(
      `> Memórias novas nesta síntese: ${input.newMemories.length} | total no banco: ${input.allMemories.length}`
    );
    lines.push("");

    if (input.newMemories.length > 0) {
      lines.push("## Memórias destiladas nesta síntese", "");
      for (const mem of input.newMemories) {
        lines.push(`- [${mem.category.toUpperCase()}] (${mem.scope}) ${mem.fact}`);
      }
      lines.push("");
    }

    const digest = [...input.allMemories]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
    if (digest.length > 0) {
      lines.push("## Top memórias por score", "");
      for (const mem of digest) {
        lines.push(`- [${mem.category.toUpperCase()}] (${mem.scope}) ${mem.fact}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Deep Sleep: Score decay calculation. Score = (Base + RecallCount + Confirmations) * exp(-lambda * delta_t)
   */
  public async deepSleep() {
    console.log("[Deep Sleep] Applying temporal decay...");
    const allMemories = this.db.getAllMemories();
    const now = new Date().getTime();
    
    for (const mem of allMemories) {
      // DEF-02: o decaimento temporal é medido a partir do último reforço
      // (fallback: created_at), não da criação — memórias reforçadas hoje
      // não podem ser arquivadas por "velhice" de criação.
      const lastTime = new Date(mem.last_reinforced || mem.created_at).getTime();
      const deltaT_days = (now - lastTime) / (1000 * 60 * 60 * 24); // delta_t in days

      // TICKET-DREAMS-03B: uso efetivo amortecido de forma SUBLINEAR (log) para
      // que repetições triviais não inflem o score linearmente; as confirmações
      // entram saturadas em 0,5 cada, com teto de 10 (MAX_CONFIRMATIONS).
      const effective_usage =
        Math.log(1 + (mem.recall_count || 0)) +
        0.5 * Math.min(mem.confirmations || 1, DreamsDB.MAX_CONFIRMATIONS);

      // Peso base e taxa de decaimento canônicos da categoria; fallback ao
      // decay_weight persistido na linha (ou 1,0) para categorias desconhecidas.
      const baseScore = CATEGORY_WEIGHTS[mem.category]?.base_weight || 1.0;
      const decayWeight =
        CATEGORY_WEIGHTS[mem.category]?.decay_weight || mem.decay_weight || 1.0;

      const newScore =
        (baseScore + effective_usage) *
        Math.exp(-this.lambda * deltaT_days * decayWeight);

      if (newScore < this.threshold && mem.id) {
         console.log(`[Deep Sleep] Archiving memory ID ${mem.id} (Score: ${newScore.toFixed(2)})`);
         this.db.deleteMemory(mem.id);
         // In a full implementation, we'd move it to an archive table. For now, delete.
      } else if (mem.id) {
         this.db.updateMemoryScore(mem.id, newScore);
      }
    }

    // TICKET-DREAMS-02 (Frente 2B/C4): a projeção DEVE refletir a tabela
    // PÓS-PODA. Como o decaimento/poda acontece aqui, `updateProjections()` é
    // invocado ao final desta etapa — nunca antes (ex.: no REM), sob pena de
    // deixar memórias fantasmas em COLLECTIVE_MEMORY.md/personas/*.md por até
    // 24h. Não toca em `dialogue_pending.txt` (preserva o handoff — C5).
    this.updateProjections();
  }

  public updateProjections() {
    // 1. Collective memory (top 20 items mais relevantes por score)
    const collective = this.db.getMemoriesByScope("collective", 20);
    let colContent = "<!-- COLLECTIVE MEMORY INJECTION (DO NOT EDIT) -->\n";
    collective.forEach(m => {
      colContent += `- [${m.category.toUpperCase()}] ${m.fact}\n`;
    });
    fs.writeFileSync(path.join(this.collectiveDir, "COLLECTIVE_MEMORY.md"), colContent);

    // 2. Persona memories
    const all = this.db.getAllMemories();
    const agents = new Set(all.filter(m => m.scope.startsWith("agent:")).map(m => m.scope.split(":")[1]));
    
    for (const agent of agents) {
      // DEF-03: sanitização anti Directory Traversal — só nomes de agente
      // seguros ([a-zA-Z0-9_-]) podem virar arquivo em PERSONAS_DIR.
      if (!agent || !SAFE_AGENT_NAME.test(agent)) {
        console.warn(`[Projections] Skipping unsafe agent name: ${JSON.stringify(agent)}`);
        continue;
      }
      const pMemories = this.db.getMemoriesByScope(`agent:${agent}`, 20);
      let pContent = `<!-- INDIVIDUAL MEMORY FOR ${agent.toUpperCase()} -->\n`;
      pMemories.forEach(m => {
        pContent += `- [${m.category.toUpperCase()}] ${m.fact}\n`;
      });
      fs.writeFileSync(path.join(this.personasDir, `${agent}.md`), pContent);
    }

    // TICKET-DREAMS-02 (Frente 2B/C4): expurgo determinístico de personas órfãs.
    this.purgeOrphanPersonaFiles();
  }

  /**
   * TICKET-DREAMS-02 (Frente 2B/C4) — Expurgo determinístico de personas órfãs.
   *
   * Varre `personas/*.md` e remove todo arquivo cujo agente NÃO possui mais
   * nenhuma memória ativa no SQLite (`count === 0` no escopo `agent:<nome>`).
   * Sem isso, um arquivo cujas memórias foram podadas pelo `deepSleep` (ou
   * promovidas para `collective` no TICKET-DREAMS-04) permaneceria sendo lido
   * e injetado indevidamente no system prompt por até 24h.
   *
   * Defesas:
   *  - só considera nomes de arquivo que passam em `SAFE_AGENT_NAME` (nunca
   *    toca em arquivos de terceiros — DEF-03: Directory Traversal bloqueado);
   *  - fail-soft: falha de I/O é registrada e ignorada, jamais derruba o ciclo.
   */
  private purgeOrphanPersonaFiles(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.personasDir);
    } catch (error) {
      console.error("[Projections] Falha ao listar personas para expurgo:", error);
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const agent = entry.slice(0, -".md".length);
      // Arquivos com nome não-canônico não são gerenciados por este projetor.
      if (!SAFE_AGENT_NAME.test(agent)) continue;

      // `count === 0` no escopo agent:<nome> ⇒ projeção órfã.
      const remaining = this.db.getMemoriesByScope(`agent:${agent}`, 1);
      if (remaining.length > 0) continue;

      try {
        fs.unlinkSync(path.join(this.personasDir, entry));
        console.log(`[Projections] Expurgando persona órfã: ${entry} (0 memórias ativas)`);
      } catch (error) {
        console.error(`[Projections] Falha ao expurgar persona órfã ${entry}:`, error);
      }
    }
  }

  public async runConsolidation() {
    await this.lightSleep();
    await this.remSleep();
    await this.deepSleep();
  }
}
