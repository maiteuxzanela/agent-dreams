/**
 * mimo_synthesizer.ts — Destilação cognitiva de memórias via cascata de IA.
 *
 * Executa a síntese de memórias através do binário nativo do OpenCode CLI
 * em subprocesso com cascata resiliente de modelos na cota gratuita:
 *
 *   1º Alvo: `opencode/mimo-v2.6-flash-free`
 *   2º Alvo (fallback se Mimo falhar/timeout/cota): `google/antigravity-gemini-3.7-flash`
 *
 * Comando executado (TICKET-DREAMS-01A — transporte seguro de prompt):
 *   opencode run --pure --title "Dreams Synthesis" --dir /tmp --model <model>
 *
 * O prompt NÃO trafega em `argv`: ele é escrito no STDIN do subprocesso e o
 * canal é fechado (`stdin.end()`). Isso elimina dois defeitos de runtime POSIX:
 *   - E2BIG: o kernel Linux limita cada argumento de `execve` a `MAX_ARG_STRLEN`
 *     (128 KiB). 120 KB de diálogo acentuado (2 bytes/caractere em UTF-8) mais a
 *     rubrica estourava o limite e abortava a cascata inteira;
 *   - Exposição: o diálogo inteiro ficava visível em claro em `/proc/<pid>/cmdline`.
 * O teto é medido em BYTES UTF-8 reais (`Buffer.byteLength`), nunca em `.length`
 * (UTF-16). A flag `--pure` suprime plugins/sessões recursivas (anti auto-ingestão).
 *
 * Contrato de saída do modelo: EXCLUSIVAMENTE um array JSON de memórias
 *
 *   [{ "scope": "collective" | "agent:<nome>",
 *      "category": "preference" | "decision" | "pitfall" | "learning",
 *      "fact": "descrição concisa e direta da lição aprendida" }]
 *
 * Garantias desta camada:
 *  - JSON vindo com cercas markdown (```json ... ```), códigos ANSI, preâmbulo
 *    ou lixo intermediário é normalizado e parseado de forma robusta (`parseMimoMemories`).
 *  - Todo item é validado individualmente (scope/category/fact); entradas
 *    inválidas são descartadas e contabilizadas em `dropped`.
 *  - Quando nenhum modelo de IA estiver disponível (falha de todos da cascata,
 *    offline ou erro de execução), LANÇA EXCEÇÃO EXPLÍCITA sem inventar dados
 *    falsos, permitindo que o ciclo de sono preserve `dialogue_pending.txt`
 *    para uma nova tentativa futura.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { redactSecrets } from "./security";

/**
 * Resolve o caminho absoluto do executável opencode CLI com fallbacks de diretório.
 * Previne falhas sob ambientes com PATH mínimo (como systemd user services).
 */
export function resolveOpencodeBinaryPath(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".opencode/bin/opencode"),
    path.join(home, ".bun/bin/opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return explicit || process.env.OPENCODE_BIN || "opencode";
}

/** Modelo padrão principal de destilação (cota gratuita; nunca deepseek/ollama). */
export const DEFAULT_MIMO_MODEL = "opencode/mimo-v2.6-flash-free";

/** Modelo secundário de fallback na cascata de destilação (cota gratuita Antigravity). */
export const DEFAULT_FALLBACK_MODEL = "google/antigravity-gemini-3.8-flash";

/** Categorias aceitas pelo DreamsDB / dream_learn. */
export const MEMORY_CATEGORIES = [
  "preference",
  "decision",
  "pitfall",
  "learning",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Escopo aceito: `collective` ou `agent:<nome>` seguro (DEF-03). */
export type MemoryScope = "collective" | `agent:${string}`;

/** Uma memória destilada, pronta para `DreamsDB.insertMemory`. */
export interface SynthesizedMemory {
  scope: MemoryScope;
  category: MemoryCategory;
  fact: string;
}

/** Origem da síntese: modelo da cascata que executou com sucesso. */
export type SynthesisSource = "mimo" | "gemini" | "none" | string;

/** Resultado completo da síntese. */
export interface SynthesisResult {
  /** Memórias já validadas e deduplicadas — seguro para insertMemory. */
  memories: SynthesizedMemory[];
  /** Identificador amigável da fonte (`mimo`, `gemini` ou nome do modelo). */
  source: SynthesisSource;
  /** stdout bruto do subprocesso ("" quando nenhum diálogo foi passado). */
  raw: string;
  /** Causa de erro, se houver. */
  error: string | null;
  /** Itens descartados na validação (JSON válido, payload inválido). */
  dropped: number;
  /** Tamanho do prompt efetivamente enviado ao modelo (chars). */
  promptChars: number;
  /** Tamanho do prompt efetivamente enviado ao modelo (bytes UTF-8). */
  promptBytes: number;
  /** Modelo efetivamente utilizado na síntese. */
  modelUsed: string;
}

/** Opções do sintetizador. */
export interface MimoSynthesizerOptions {
  /** Modelo principal `provider/model`. Padrão: `opencode/mimo-v2.6-flash-free`. */
  model?: string;
  /** Modelo secundário `provider/model`. Padrão: `google/antigravity-gemini-3.7-flash`. */
  fallbackModel?: string;
  /** Lista completa personalizada de modelos em ordem de tentativa. */
  models?: string[];
  /** Binário do OpenCode CLI. Padrão: `OPENCODE_BIN` ou `opencode`. */
  binary?: string;
  /** Timeout do subprocesso em ms. Padrão: `DREAMS_MIMO_TIMEOUT_MS` ou 180000. */
  timeoutMs?: number;
  /** Corte máximo do diálogo injetado no prompt (chars). Padrão: 120000. */
  maxDialogueChars?: number;
  /** Teto absoluto do prompt final em BYTES UTF-8. Padrão: MAX_PROMPT_BYTES (128000). */
  maxPromptBytes?: number;
  /** Limite de memórias retornadas. Padrão: 20. */
  maxMemories?: number;
  /** Diretório de trabalho do subprocesso. Padrão: cwd atual. */
  cwd?: string;
  /** Observabilidade: recebe o erro engolido pelo fail-soft. */
  onError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Teto de payload em BYTES UTF-8 (TICKET-DREAMS-01A)
// ---------------------------------------------------------------------------

/**
 * Limite absoluto e seguro do prompt em BYTES UTF-8.
 *
 * Referência POSIX/Linux: o kernel limita cada argumento individual de `execve`
 * a `MAX_ARG_STRLEN` = 128 KiB (131.072 bytes). Adotamos 128.000 bytes como teto
 * operacional com folga, medindo o payload real — nunca `.length`, que conta
 * unidades UTF-16 e subestima textos acentuados (2 bytes por caractere).
 */
export const MAX_PROMPT_BYTES = 128_000;

/** Marcador injetado quando a cauda do diálogo substitui o início descartado. */
const OMISSION_MARKER = "[… início do dia omitido]\n\n";

/** Comprimento real do texto em bytes UTF-8 (≠ String.length, que é UTF-16). */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Trunca `text` preservando a CAUDA para caber em `maxBytes` bytes UTF-8,
 * descartando qualquer caractere multibyte partido na fronteira do corte.
 */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const tail = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  // O corte por bytes pode iniciar no meio de um code point: o decode emite
  // U+FFFD na fronteira. Removemos esses replacement chars antes de continuar.
  return tail.replace(/^\uFFFD+/, "").trimStart();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Monta o prompt de destilação cognitiva. Instruções estritas: o modelo deve
 * responder SOMENTE com o array JSON (sem prosa, sem cercas markdown).
 *
 * HARDENING (TICKET-DREAMS-04B): o diálogo é redigido por `redactSecrets`
 * antes de entrar no prompt — nenhuma credencial/segredo deve ser enviada ao
 * modelo externo. A redação é idempotente, então reaplicá-la sobre um diálogo
 * já redigido pelo chamador é inócuo.
 */
export function buildSynthesisPrompt(dialogue: string, maxMemories: number = 20): string {
  const safeDialogue = redactSecrets(dialogue);
  return [
    "Você é o Destilador Cognitivo de Memórias do ecossistema OpenCode.",
    "Analise o diálogo passado abaixo e extraia APENAS lições aprendidas com valor preditivo para o futuro.",
    "",
    "REGRAS ABSOLUTAS:",
    "1. Responda EXCLUSIVAMENTE com um array JSON válido. Nada antes, nada depois. Sem cercas markdown, sem comentários, sem explicação.",
    '2. Formato exato de cada item: {"scope": "...", "category": "...", "fact": "..."}',
    '3. "scope": "collective" para convenções gerais do ecossistema; "agent:<nome>" (nome apenas com letras, dígitos, hífen e sublinhado) para aprendizados de uma função/pessoa específica.',
    '4. "category": apenas um de "preference" | "decision" | "pitfall" | "learning".',
    '5. "fact": frase única em português, direta, entre 20 e 200 caracteres, no presente, sem IDs de sessão, caminhos temporários ou detalhes passageiros.',
    `6. Máximo ${maxMemories} memórias. Priorize correções da usuária, regras novas, armadilhas de framework e decisões arquiteturais duradouras.`,
    "7. Se não houver nenhuma lição útil, responda exatamente: []",
    "8. PROIBIDO inventar fatos que não estejam no diálogo.",
    "",
    "<dialogo>",
    safeDialogue,
    "</dialogo>",
    "",
    "Lembrete: sua ÚNICA saída é o array JSON.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing e validação (determinístico, testável sem subprocesso)
// ---------------------------------------------------------------------------

const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;
// ESC (0x1B) explícito via código hexadecimal: nenhum byte de controle no fonte.
const ANSI_ESCAPE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");
const FENCE = new RegExp("```(?:json|JSON)?\\s*([\\s\\S]*?)```", "g");

/** Remove códigos ANSI de controle embutidos na saída do CLI. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** Remove acentos/diacríticos (NFD) para comparação tolerante a grafia. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;
function deaccent(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "");
}

/** Normaliza uma categoria livre para o domínio aceito. */
function normalizeCategory(raw: unknown): MemoryCategory | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if ((MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as MemoryCategory;
  }
  // Alias comuns do modelo (pt-BR / erros de grafia) -> domínio canônico.
  const aliases: Record<string, MemoryCategory> = {
    aprendizado: "learning",
    aprendizados: "learning",
    learn: "learning",
    licao: "learning",
    licoes: "learning",
    preferencia: "preference",
    preferencias: "preference",
    decisao: "decision",
    decisoes: "decision",
    armadilha: "pitfall",
    armadilhas: "pitfall",
    pegadinha: "pitfall",
    erro: "pitfall",
    bug: "pitfall",
  };
  return aliases[deaccent(value)] ?? null;
}

/**
 * Normaliza/valida um escopo. `collective` passa; `agent:<nome>` é sanitizado
 * contra Directory Traversal (DEF-03); qualquer outra coisa vira `collective`.
 */
function normalizeScope(raw: unknown): MemoryScope {
  if (typeof raw !== "string") return "collective";
  const value = raw.trim();
  if (value === "" || value === "collective") return "collective";
  if (value.toLowerCase().startsWith("agent:")) {
    const name = value.slice("agent:".length).replace(/[^a-zA-Z0-9_-]/g, "");
    if (SAFE_AGENT_NAME.test(name)) return `agent:${name}`;
    return "collective";
  }
  // Escopo desconhecido ("global", "coletivo", ...) -> collective.
  return "collective";
}

/** Valida um item cru. Devolve `null` quando o item deve ser descartado. */
export function validateMemory(raw: unknown): SynthesizedMemory | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.fact !== "string") return null;
  // HARDENING (TICKET-DREAMS-04B): redige segredos ANTES da normalização — o
  // fato retornado aqui é o que será persistido no DreamsDB pelo REM Sleep.
  const fact = redactSecrets(candidate.fact).replace(/\s+/g, " ").trim();
  if (fact.length < 10) return null; // abaixo disso não é uma lição útil

  const category = normalizeCategory(candidate.category);
  if (!category) return null; // categoria irreconhecível -> item inválido

  return {
    scope: normalizeScope(candidate.scope),
    category,
    fact: fact.length > 300 ? fact.slice(0, 300).trimEnd() : fact,
  };
}

/** Tenta extrair um array JSON (ou `{memories:[...]}`) de um texto. Retorna null se não encontrar JSON válido. */
function tryParseJsonArrays(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  // 1) Parse direto do texto limpo.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const inner = (parsed as Record<string, unknown>).memories;
      if (Array.isArray(inner)) return inner;
    }
  } catch {
    /* segue para as heurísticas */
  }

  // 2) Cercas markdown ```json ... ``` (último bloco = resposta final).
  const fences = [...trimmed.matchAll(FENCE)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1].trim();
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const inner = (parsed as Record<string, unknown>).memories;
        if (Array.isArray(inner)) return inner;
      }
    } catch {
      /* tenta o próximo bloco */
    }
  }

  // 3) Varredura por "[" ... "]" — varre todos os limites de colchetes sem teto arbitrário.
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "[") starts.push(i);
  }
  const closes: number[] = [];
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] === "]") closes.push(i);
  }

  for (const start of starts) {
    for (const close of closes) {
      if (close <= start) break;
      try {
        const candidate = trimmed.slice(start, close + 1);
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") {
          const inner = (parsed as Record<string, unknown>).memories;
          if (Array.isArray(inner)) return inner;
        }
      } catch {
        /* tenta a próxima combinação */
      }
    }
  }

  return null;
}

/**
 * Converte a saída bruta do modelo em memórias validadas.
 */
export function parseMimoMemories(
  raw: string,
  options: { maxMemories?: number } = {}
): { memories: SynthesizedMemory[]; dropped: number; parsed: boolean } {
  const maxMemories = options.maxMemories ?? 20;
  const candidates = tryParseJsonArrays(stripAnsi(raw ?? ""));
  if (candidates === null) {
    return { memories: [], dropped: 0, parsed: false };
  }

  const memories: SynthesizedMemory[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const candidate of candidates) {
    if (memories.length >= maxMemories) {
      dropped++;
      continue;
    }
    const memory = validateMemory(candidate);
    if (!memory) {
      dropped++;
      continue;
    }
    const key = `${memory.scope}::${memory.fact.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push(memory);
  }

  return { memories, dropped, parsed: true };
}

// ---------------------------------------------------------------------------
// Subprocesso `opencode run`
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: Error | null;
}

/**
 * Executa o OpenCode CLI com timeout, kill escalonado e cap de saída.
 *
 * O prompt é entregue via STDIN (`options.stdin`): o canal é aberto como pipe,
 * recebe o payload em UTF-8 e é fechado (`end`) — nunca entra em `argv`.
 * Quando `stdin` é indefinido, o canal é `ignore` (comportamento legado).
 */
function runOpencode(
  argv: string[],
  options: { timeoutMs: number; cwd?: string; stdin?: string }
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB por stream
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const hasStdinPayload = typeof options.stdin === "string";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        stdio: [hasStdinPayload ? "pipe" : "ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error as Error,
      });
      return;
    }

    if (hasStdinPayload) {
      // EPIPE/ECONNRESET é esperado se o binário morrer antes de consumir o
      // prompt; o erro real do processo é capturado por "error"/"close".
      child.stdin?.on("error", () => {
        /* canal stdin encerrado pelo filho — erro tratado pelo spawn */
      });
      try {
        child.stdin?.end(options.stdin, "utf8");
      } catch {
        /* stdin indisponível: a falha de spawn é reportada pelos listeners */
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* processo já morreu */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* processo já morreu */
        }
      }, 5000);
    }, options.timeoutMs);

    const finish = (outcome: Omit<SpawnOutcome, "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...outcome, timedOut });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, spawnError: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Sintetizador
// ---------------------------------------------------------------------------

/**
 * Sintetiza memórias a partir de um diálogo com fallback em cascata:
 * 1º Mimo 2.6 -> 2º Gemini 3.7 Flash -> Erro se ambos falharem.
 */
export class MimoSynthesizer {
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly models: string[];
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxDialogueChars: number;
  private readonly maxPromptBytes: number;
  private readonly maxMemories: number;
  private readonly cwd: string | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(options: MimoSynthesizerOptions = {}) {
    this.model = options.model || DEFAULT_MIMO_MODEL;
    this.fallbackModel = options.fallbackModel || DEFAULT_FALLBACK_MODEL;
    this.models = options.models && options.models.length > 0 ? options.models : [];
    this.binary = resolveOpencodeBinaryPath(options.binary);
    const envTimeout = Number(process.env.DREAMS_MIMO_TIMEOUT_MS);
    const candidate =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000);
    this.timeoutMs =
      Number.isFinite(candidate) && candidate > 0 ? candidate : 180_000;
    this.maxDialogueChars = options.maxDialogueChars ?? 120_000;
    this.maxPromptBytes = options.maxPromptBytes ?? MAX_PROMPT_BYTES;
    this.maxMemories = options.maxMemories ?? 20;
    this.cwd = options.cwd;
    this.onError = options.onError;
  }

  /**
   * Monta o prompt aplicando DUPLO teto (TICKET-DREAMS-01A):
   *   1. teto em caracteres (`maxDialogueChars`) — preserva a cauda do dia;
   *   2. teto em BYTES UTF-8 (`maxPromptBytes`) — garante folga sob
   *      `MAX_ARG_STRLEN` (128 KiB) e transporte estável por stdin.
   * Como o prompt é `overhead(estático) + diálogo`, medimos o overhead com um
   * diálogo vazio e truncamos a CAUDA do diálogo pelos bytes restantes.
   */
  private buildCappedPrompt(source: string): string {
    const charCapped =
      source.length > this.maxDialogueChars
        ? OMISSION_MARKER + source.slice(-this.maxDialogueChars).trimStart()
        : source;

    let prompt = buildSynthesisPrompt(charCapped, this.maxMemories);
    if (utf8ByteLength(prompt) <= this.maxPromptBytes) return prompt;

    const overheadBytes = utf8ByteLength(buildSynthesisPrompt("", this.maxMemories));
    let budget = Math.max(
      0,
      this.maxPromptBytes - overheadBytes - utf8ByteLength(OMISSION_MARKER)
    );
    prompt = buildSynthesisPrompt(
      OMISSION_MARKER + truncateUtf8Tail(source, budget),
      this.maxMemories
    );

    // Rede de segurança: converge em no máximo algumas iterações caso o
    // overhead medido difira (nunca deve ocorrer, mas o teto é inviolável).
    let guard = 0;
    while (utf8ByteLength(prompt) > this.maxPromptBytes && budget > 0 && guard < 8) {
      const excess = utf8ByteLength(prompt) - this.maxPromptBytes;
      budget = Math.max(0, budget - excess - 1);
      prompt = buildSynthesisPrompt(
        OMISSION_MARKER + truncateUtf8Tail(source, budget),
        this.maxMemories
      );
      guard++;
    }
    return prompt;
  }

  /**
   * Executa a destilação cognitiva com cascata de modelos.
   * Lança erro explícito se nenhum modelo estiver disponível / responder com JSON válido.
   */
  async synthesize(dialogue: string): Promise<SynthesisResult> {
    const rawDialogue = (dialogue ?? "").trim();
    if (rawDialogue === "") {
      return {
        memories: [],
        source: "none",
        raw: "",
        error: null,
        dropped: 0,
        promptChars: 0,
        promptBytes: 0,
        modelUsed: "none",
      };
    }

    // HARDENING (TICKET-DREAMS-04B): redige segredos ANTES de cortar/empacotar
    // o diálogo, garantindo que nada sensível chegue ao subprocesso externo e
    // que o teto `maxDialogueChars` não seja consumido por credenciais.
    const source = redactSecrets(rawDialogue);

    if (process.env.DREAMS_OFFLINE === "1") {
      throw new Error("Nenhum modelo de IA disponível para síntese cognitiva (DREAMS_OFFLINE=1)");
    }

    // TICKET-DREAMS-01A: duplo teto (chars + bytes UTF-8 reais).
    const prompt = this.buildCappedPrompt(source);

    const modelsToTry: string[] =
      this.models.length > 0
        ? this.models
        : Array.from(new Set([this.model, this.fallbackModel].filter(Boolean)));

    const attemptErrors: string[] = [];

    for (const currentModel of modelsToTry) {
      // TICKET-DREAMS-01A: `--pure` suprime plugins/sessões recursivas e o
      // prompt vai por STDIN (nunca em `argv`, evitando E2BIG e /proc/cmdline).
      const argv = [
        this.binary,
        "run",
        "--pure",
        "--title",
        "Dreams Synthesis",
        "--dir",
        "/tmp",
        "--model",
        currentModel,
      ];
      let outcome: SpawnOutcome;
      try {
        outcome = await runOpencode(argv, {
          timeoutMs: this.timeoutMs,
          cwd: this.cwd,
          stdin: prompt,
        });
      } catch (error) {
        const msg = `falha ao spawnar ${this.binary} para ${currentModel}: ${String(error)}`;
        this.onError?.(error);
        attemptErrors.push(msg);
        continue;
      }

      if (outcome.spawnError) {
        const msg = `binário ${this.binary} indisponível para ${currentModel}: ${outcome.spawnError.message}`;
        this.onError?.(outcome.spawnError);
        attemptErrors.push(msg);
        continue;
      }

      if (outcome.timedOut) {
        const msg = `timeout de ${this.timeoutMs}ms atingido para ${currentModel}`;
        attemptErrors.push(msg);
        continue;
      }

      if (outcome.code !== 0) {
        const msg = `modelo ${currentModel} falhou com code=${outcome.code} signal=${outcome.signal}: ${outcome.stderr.slice(-300).trim()}`;
        attemptErrors.push(msg);
        continue;
      }

      const { memories, dropped, parsed } = parseMimoMemories(outcome.stdout, {
        maxMemories: this.maxMemories,
      });

      if (parsed) {
        const sourceLabel = currentModel.includes("mimo")
          ? "mimo"
          : currentModel.includes("gemini")
          ? "gemini"
          : currentModel;

        return {
          memories,
          source: sourceLabel,
          raw: outcome.stdout,
          error: null,
          dropped,
          promptChars: prompt.length,
          promptBytes: utf8ByteLength(prompt),
          modelUsed: currentModel,
        };
      }

      attemptErrors.push(
        `modelo ${currentModel} não retornou JSON de memórias parseável (stdout: ${outcome.stdout.slice(0, 200).trim()})`
      );
    }

    const finalErrorMsg = `Nenhum modelo de IA disponível para síntese cognitiva. Tentativas: ${attemptErrors.join(" | ")}`;
    const error = new Error(finalErrorMsg);
    this.onError?.(error);
    throw error;
  }
}

/**
 * Atalho funcional: `await synthesizeMemories(dialogue)`.
 */
export async function synthesizeMemories(
  dialogue: string,
  options?: MimoSynthesizerOptions
): Promise<SynthesisResult> {
  return new MimoSynthesizer(options).synthesize(dialogue);
}
