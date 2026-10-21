import fs from "fs";
import path from "path";
import os from "os";
import { DreamsDB, MemoryRecord, CATEGORY_WEIGHTS, DREAMS_DIR_MODE, DREAMS_FILE_MODE } from "./db";
import {
  readRecentDialogues,
  buildDialogueSummary,
  chunkDialogueText,
} from "./session_reader";
import {
  synthesizeMemories,
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

/**
 * Descarta explicitamente o erro de uma operação best-effort.
 *
 * Espelha o helper de `db.ts`: NENHUM `catch` deste módulo fica VAZIO — o
 * bloco sempre declara a intenção ("isto é um best-effort deliberado") em vez
 * de engolir a falha em silêncio. Usada só onde a falha NÃO pode derrubar o
 * ciclo de sono (`chmod` em filesystem hostil, owner divergente, read-only).
 */
function ignoreError(error: unknown): void {
  void error;
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
      if (!fs.existsSync(dir)) {
        // TICKET-DREAMS-07 (defesa em profundidade POSIX): os diretórios do
        // ciclo de sono são `0o700` — só o dono entra. Sem isso, os artefatos
        // gerados aqui (`dialogue_pending.txt`, projeções `.md`, `log_*.jsonl`)
        // nasceriam legíveis por QUALQUER usuário da máquina.
        fs.mkdirSync(dir, { recursive: true, mode: DREAMS_DIR_MODE });
      }
      // O `mode` só vale na CRIAÇÃO: um diretório pré-existente (criado antes
      // deste hardening, ou pelo `DreamsDB`) manteria a máscara antiga. O
      // `chmod` best-effort fecha essa janela sem derrubar o ciclo.
      this.enforceDirMode(dir);
    });
  }

  /**
   * Garante `0o700` no diretório. Best-effort: filesystems que rejeitam o
   * `chmod` (read-only, owner divergente) não derrubam o ciclo de sono.
   */
  private enforceDirMode(dir: string): void {
    try {
      fs.chmodSync(dir, DREAMS_DIR_MODE);
    } catch (error) {
      ignoreError(error);
    }
  }

  /**
   * Garante `0o600` num artefato do ciclo. Best-effort pela mesma razão de
   * `enforceDirMode`.
   *
   * O `mode` passado na criação é aplicado pelo SO apenas quando o arquivo
   * NÃO existe; para um artefato herdado (criado antes do hardening), este
   * `chmod` é o que fecha a janela de leitura por outros usuários.
   */
  private enforceFileMode(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, DREAMS_FILE_MODE);
      }
    } catch (error) {
      ignoreError(error);
    }
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
              // TICKET-DREAMS-07 (Frente B):
              //  (1) os parâmetros score/decay_weight NÃO são fixados em 1.0/1.0 —
              //      passa-se `undefined` para que o insertMemory herde
              //      COMPULSORIAMENTE os pesos canônicos de CATEGORY_WEIGHTS[category]
              //      (preference 2.5/0.1, decision 2.0/0.3, pitfall 1.8/0.5, learning 1.0/1.0);
              //  (2) `reinforce` exige não-trivial E fato AINDA NÃO sincronizado ao
              //      SQLite na vigília. Um record já persistido (`synced_to_db: true`)
              //      nasceu com 1 confirmação e receberia indevidamente uma SEGUNDA
              //      confirmação na madrugada da primeira noite.
              this.db.insertMemory(record.scope, record.fact, category, undefined, undefined, {
                reinforce: !isTrivial && !record.synced_to_db
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

      const entries = readRecentDialogues({
        dbPath: this.sessionDbPath,
        ...(sinceMs !== undefined ? { sinceMs } : { hours: this.dialogueHours }),
        includeReasoning: false, // reasoning domina o volume e infla token
        onError: (error) => console.error("[Light Sleep] session_reader:", error),
      });
      // TICKET-DREAMS-08 (Frente 8A): handoff COMPLETO (sem truncamento e sem
      // omissão do início do dia). O particionamento em chunks seguros agora é
      // responsabilidade do REM Sleep (`remSleep` → `chunkDialogueText`).
      const summary = buildDialogueSummary(entries);

      const existing = this.readPendingRaw();
      if (summary.trim() === "") {
        console.log(
          "[Light Sleep] Nenhum diálogo novo capturado; handoff pendente preservado."
        );
      } else {
        const merged = this.mergeDialogue(existing, summary, capturedAt.toISOString());
        // TICKET-DREAMS-07: o handoff contém o diálogo bruto do dia — é um
        // artefato sensível e nasce `0o600` (só o dono lê/escreve).
        fs.writeFileSync(this.dialogueFile, merged, { mode: DREAMS_FILE_MODE });
        this.enforceFileMode(this.dialogueFile);
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
   * temporal.
   *
   * TICKET-DREAMS-08 (Frente 8A): o truncamento por `MAX_PROMPT_BYTES` foi
   * REMOVIDO. Ele preservava apenas a cauda e descartava silenciosamente as
   * conversas do início do dia — exatamente a perda que este ticket elimina.
   * O teto do prompt continua inviolável, mas agora é honrado POR CHUNK no REM
   * Sleep (`chunkDialogueText` particiona o handoff antes de sintetizar), e o
   * arquivo de handoff acumula o dia inteiro até ser consumido com sucesso.
   */
  private mergeDialogue(existing: string, incoming: string, capturedIso: string): string {
    const prev = existing.trim();
    const next = incoming.trim();
    if (prev === "") return next;
    if (next === "") return prev;
    return `${prev}${dialogueAccumulationSeparator(capturedIso)}${next}`;
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
      // TICKET-DREAMS-08 (Frente 8A): leitura COMPLETA (sem truncamento) — o
      // particionamento em chunks é feito pelo próprio remSleep.
      const sinceMs = this.checkpointMs("synthesized");
      const entries = readRecentDialogues({
        dbPath: this.sessionDbPath,
        ...(sinceMs !== undefined ? { sinceMs } : { hours: this.dialogueHours }),
        includeReasoning: false,
        onError: (error) => console.error("[REM Sleep] session_reader:", error),
      });
      return buildDialogueSummary(entries);
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
      // TICKET-DREAMS-07: artefato de estado do handoff — `0o600`.
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: DREAMS_FILE_MODE });
      fs.renameSync(tmp, this.checkpointFile);
      this.enforceFileMode(this.checkpointFile);
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
   * REM Sleep: síntese cognitiva via cascata de IA (`opencode run`),
   * inserção das memórias destiladas no DreamsDB e geração do DREAMS.md.
   *
   * Fluxo:
   *  1. consome o diálogo do Light Sleep (`dialogue_pending.txt`);
   *  2. PARTICIONA o diálogo em chunks sequenciais seguros (`chunkDialogueText`);
   *  3. `synthesizeMemories(chunk)` para CADA chunk, agregando as memórias;
   *  4. `db.insertMemory(scope, fact, category)` para cada memória destilada;
   *  5. escreve DREAMS.md e atualiza as projeções (COLLECTIVE/personas);
   *  6. limpa o handoff apenas se TODOS os chunks tiverem sido sintetizados.
   *
   * TICKET-DREAMS-08 (Frente 8A): a ingestão é INTEGRAL. Dias com >120.000
   * caracteres são fatiados em múltiplos chunks (manhã, tarde e noite) e cada
   * bloco é submetido ao sintetizador — nenhuma conversa é descartada pelo
   * truncamento invertido `[… início do dia omitido]`. Uma falha em QUALQUER
   * chunk adia a consolidação inteira: o handoff permanece 100% íntegro e o
   * checkpoint de síntese NÃO avança (sem amnésia parcial, sem dados falsos).
   *
   * Resiliência e anti-mock: sem IA disponível, o ciclo preserva
   * `dialogue_pending.txt` intacto para o próximo ciclo tentar novamente,
   * sem gravar memórias falsas ou dados inventados.
   */
  public async remSleep() {
    console.log("[REM Sleep] Synthesizing memories...");

    const dialogue = this.loadPendingDialogue();
    const chunks = chunkDialogueText(dialogue);
    const newMemories: SynthesizedMemory[] = [];
    const sources: SynthesisSource[] = [];
    let synthError: string | null = null;
    let synthesisSucceeded = false;

    if (chunks.length === 0) {
      console.log("[REM Sleep] Sem diálogo recente; usando memórias existentes.");
      synthesisSucceeded = true;
    } else {
      console.log(
        `[REM Sleep] Diálogo particionado em ${chunks.length} chunk(s) sequenciais ` +
          `(${utf8ByteLength(dialogue)} bytes no total).`
      );

      let completed = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const result = await synthesizeMemories(chunk, {
            onError: (error) => console.error("[REM Sleep] MimoSynthesizer:", error),
          });
          sources.push(result.source);
          if (result.error) synthError = result.error;
          for (const mem of result.memories) {
            this.db.insertMemory(mem.scope, mem.fact, mem.category);
            newMemories.push(mem);
          }
          completed++;
          console.log(
            `[REM Sleep] Chunk ${i + 1}/${chunks.length} (${result.source}): ` +
              `${result.memories.length} memória(s) inserida(s)` +
              `${result.dropped > 0 ? `, ${result.dropped} descartada(s)` : ""}` +
              `${result.error ? ` — ${result.error}` : ""}.`
          );
        } catch (error) {
          // Síntese adiada por indisponibilidade de IA: preserva o handoff
          // INTEGRAL (nenhum chunk é descartado) e não grava dados falsos.
          synthError = error instanceof Error ? error.message : String(error);
          console.warn(
            `[REM Sleep] Síntese adiada no chunk ${i + 1}/${chunks.length} por ` +
              `indisponibilidade de modelo: ${synthError}`
          );
          break;
        }
      }

      // Só há sucesso quando TODOS os chunks foram processados: um único chunk
      // adiado mantém o pendente e o checkpoint de síntese intactos para uma
      // próxima tentativa integral.
      synthesisSucceeded = completed === chunks.length;
    }

    // Fonte reportada: a do último chunk concluído (ou "none" sem diálogo).
    const source: SynthesisSource = sources.length > 0 ? sources[sources.length - 1] : "none";

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

  /**
   * Escrita ATÔMICA POSIX de uma projeção markdown.
   *
   * TICKET-DREAMS-09 (Frente A): leitores concorrentes (injeção no system
   * prompt, `dream_recall`, leitura humana) JAMAIS podem observar um arquivo
   * vazio ou parcialmente escrito. O padrão é o clássico *write-temp +
   * rename(2)*: o conteúdo é gravado num arquivo temporário no MESMO diretório
   * (mesmo filesystem ⇒ `rename` é atômico) e só então movido por cima do
   * destino. `rename(2)` substitui o alvo de forma indivisível: ou o leitor vê
   * a versão antiga inteira, ou a nova inteira — nunca um `size 0`.
   *
   * O `fsync` antes do rename garante que os bytes estejam no disco antes de o
   * nome ser trocado (durabilidade), e o `unlink` de fallback limpa o
   * temporário se algo falhar no meio do caminho (sem deixar lixo no diretório).
   *
   * Fail-soft NÃO se aplica aqui: a exceção propaga para o chamador decidir
   * (o ciclo Dreams é resiliente a nível de `runConsolidation`).
   */
  private writeFileAtomicSync(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    // Nome temporário único: PID + timestamp + sufixo aleatório evitam colisão
    // entre escritas concorrentes (processos distintos ou ciclos sobrepostos).
    const tmpPath = path.join(
      dir,
      `${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    );
    const data = Buffer.from(content, "utf8");
    let fd: number | null = null;
    try {
      // TICKET-DREAMS-07: as projeções de memória (`COLLECTIVE_MEMORY.md` e
      // `personas/<agente>.md`) nascem `0o600` — antes usavam `0o644`, o que
      // expunha a memória consolidada do ecossistema a outros usuários da
      // máquina. O `chmod` pós-rename cobre artefatos herdados.
      fd = fs.openSync(tmpPath, "w", DREAMS_FILE_MODE);
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, filePath);
      this.enforceFileMode(filePath);
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* fd já fechado / inválido */
        }
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* temporário inexistente ou já renomeado */
      }
      throw error;
    }
  }

  /**
   * TICKET-DREAMS-09 (Frente A): projeção em disco das memórias consolidadas.
   *
   * PÚBLICO por contrato: além de fechar o `deepSleep()` (pós-poda), pode ser
   * disparado diretamente pelo CLI e por outros chamadores que precisem
   * materializar `COLLECTIVE_MEMORY.md` e `personas/*.md` sob demanda, sem
   * esperar o ciclo noturno. Toda escrita é atômica (write-temp + rename),
   * garantindo que nenhum leitor concorrente encontre arquivo vazio (size 0).
   */
  public updateProjections() {
    // 1. Collective memory (top 20 items mais relevantes por score)
    const collective = this.db.getMemoriesByScope("collective", 20);
    let colContent = "<!-- COLLECTIVE MEMORY INJECTION (DO NOT EDIT) -->\n";
    collective.forEach(m => {
      colContent += `- [${m.category.toUpperCase()}] ${m.fact}\n`;
    });
    this.writeFileAtomicSync(path.join(this.collectiveDir, "COLLECTIVE_MEMORY.md"), colContent);

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
      this.writeFileAtomicSync(path.join(this.personasDir, `${agent}.md`), pContent);
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
