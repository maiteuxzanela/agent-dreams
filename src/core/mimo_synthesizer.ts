/**
 * mimo_synthesizer.ts — Destilação cognitiva de memórias via cascata de IA.
 *
 * Executa a síntese de memórias através do binário nativo do OpenCode CLI
 * em subprocesso com cascata resiliente de modelos na cota gratuita:
 *
 *   1º Alvo: `google/antigravity-gemini-3.8-flash` (cota gratuita Antigravity)
 *   2º Alvo (fallback se Gemini falhar/timeout/cota): `opencode/mimo-v2.6-flash-free`
 *   3º Alvo (último degrau): `opencode-go/deepseek-v4.1-flash` (cota opencode-go)
 *
 * Comando executado (TICKET-DREAMS-01A — transporte seguro de prompt):
 *   opencode run --title "Dreams Synthesis" --dir /tmp --model <model>
 *
 * O prompt NÃO trafega em `argv`: ele é escrito no STDIN do subprocesso e o
 * canal é fechado (`stdin.end()`). Isso elimina dois defeitos de runtime POSIX:
 *   - E2BIG: o kernel Linux limita cada argumento de `execve` a `MAX_ARG_STRLEN`
 *     (128 KiB). 120 KB de diálogo acentuado (2 bytes/caractere em UTF-8) mais a
 *     rubrica estourava o limite e abortava a cascata inteira;
 *   - Exposição: o diálogo inteiro ficava visível em claro em `/proc/<pid>/cmdline`.
 * O teto é medido em BYTES UTF-8 reais (`Buffer.byteLength`), nunca em `.length`
 * (UTF-16). A flag `--pure` NÃO é usada: ela desativa o plugin de autenticação
 * `@cortexkit/opencode-antigravity-auth` e bloqueia o provedor
 * `google/antigravity`, inviabilizando o alvo primário. A blindagem contra
 * auto-ingestão é feita por `excludeSessionTitles` na camada SQL.
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

/**
 * Modelo padrão principal de destilação.
 *
 * Prioridade da cota gratuita Antigravity do operador (`google/antigravity-gemini-3.8-flash`)
 * porque o Mimo está sem cota. Nunca deepseek/ollama.
 */
export const DEFAULT_MIMO_MODEL = "google/antigravity-gemini-3.8-flash";

/** Modelo secundário de fallback na cascata de destilação (cota gratuita Mimo). */
export const DEFAULT_FALLBACK_MODEL = "opencode/mimo-v2.6-flash-free";

/**
 * Modelo terciário de fallback na cascata de destilação.
 *
 * Último degrau de resiliência: usa a cota `opencode-go` do operador
 * (`opencode-go/deepseek-v4.1-flash`) apenas quando as opções gratuitas
 * (Antigravity/Mimo) falharem ou esgotarem cota.
 */
export const DEFAULT_TERTIARY_MODEL = "opencode-go/deepseek-v4.1-flash";

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
  /** Modelo principal `provider/model`. Padrão: `google/antigravity-gemini-3.8-flash`. */
  model?: string;
  /** Modelo secundário `provider/model`. Padrão: `opencode/mimo-v2.6-flash-free`. */
  fallbackModel?: string;
  /** Modelo terciário `provider/model`. Padrão: `opencode-go/deepseek-v4.1-flash`. */
  tertiaryModel?: string;
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
// TICKET-DREAMS-06 (Frente B) — Classificador neural de reconciliação
// ---------------------------------------------------------------------------

/**
 * As 4 ações de reconciliação reconhecidas pelo classificador neural.
 *
 * A taxonomia é FECHADA por contrato: qualquer rótulo fora desta lista é
 * inválido e o par correspondente é descartado (nada é aplicado ao banco).
 */
export const RECONCILIATION_ACTIONS = [
  "reinforce",
  "supersede",
  "merge",
  "independent",
] as const;

export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

/**
 * Um par de reconciliação: a memória JÁ EXISTENTE no banco e o fato
 * CANDIDATO destilado da vigília.
 *
 * `index` é a chave de correlação da resposta do modelo (o par é sempre do
 * MESMO escopo — o isolamento entre personas é garantido pelo chamador, que
 * só monta pares de uma mesma triagem de escopo).
 */
export interface ReconciliationPair {
  /** Índice do par no lote (0-based). */
  index: number;
  /** Id da memória já existente no banco. */
  existingId: number;
  scope: string;
  existingFact: string;
  candidateFact: string;
  candidateCategory: MemoryCategory;
  /** Agrupa os pares que envolvem o MESMO fato candidato (chave estável). */
  candidateKey: string;
}

/** Decisão do classificador para um par. */
export interface ReconciliationDecision {
  action: ReconciliationAction;
  pairIndex: number;
  existingId: number;
  /** Texto unificado — presente apenas na ação `merge`. */
  mergedFact?: string;
}

/** Resultado do julgamento neural em lote. */
export interface ReconciliationBatchResult {
  /** Decisões válidas (um por par, no máximo). */
  decisions: ReconciliationDecision[];
  /** Pares ignorados por JSON malformado, rótulo inválido ou `merged_fact` ausente. */
  dropped: number;
  /** Houve JSON parseável na resposta do modelo? */
  parsed: boolean;
  /** Origem do julgamento (`none` no fallback determinístico). */
  source: SynthesisSource;
  /** Causa da degradação para o fallback determinístico (null em operação normal). */
  error: string | null;
  promptChars: number;
  promptBytes: number;
  modelUsed: string;
}

/** Normaliza o rótulo da ação; devolve null para qualquer valor fora da taxonomia. */
function normalizeReconciliationAction(raw: unknown): ReconciliationAction | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  for (const action of RECONCILIATION_ACTIONS) {
    if (action === value) return action;
  }
  return null;
}

/**
 * Monta o prompt de JULGAMENTO DE RECONCILIAÇÃO.
 *
 * O modelo recebe os pares (existente x candidata) e devolve UM item por par
 * com exatamente uma das 4 ações. Em `merge` ele obrigatoriamente produz o
 * `merged_fact` — a síntese concisa e densa que次第rá o banco.
 *
 * HARDENING (TICKET-DREAMS-04B): os fatos são redigidos por `redactSecrets`
 * antes de entrar no prompt — nenhuma credencial (o texto da candidata pode
 * vir freshly destilado do diálogo) é enviada ao modelo externo. A redação é
 * idempotente, então reaplicá-la é inócuo.
 */
export function buildReconciliationPrompt(pairs: ReconciliationPair[]): string {
  const lines: string[] = [];
  lines.push("Você é o Reconciliador Cognitivo do ecossistema OpenCode.");
  lines.push("Classifique cada par (memória existente x memória candidata) em EXATAMENTE uma das 4 ações.");
  lines.push("");
  lines.push("AÇÕES (taxonomia fechada — escolha exatamente uma):");
  lines.push(
    '- "reinforce": a candidata é uma PARÁFRASE da diretriz existente (mesma regra, outras palavras). A existente é absorvida e reforçada.'
  );
  lines.push(
    '- "supersede": a candidata REVOGA explicitamente a diretriz existente (a nova regra substitui a antiga, que deixa de valer).'
  );
  lines.push(
    '- "merge": a candidata COMPLEMENTA a existente (mesmo tema, informação adicional). Produza "merged_fact": a síntese concisa e densa dos dois fatos.'
  );
  lines.push(
    '- "independent": falso positivo de vocabulário — os dois fatos são distintos. Ambos permanecem independentes.'
  );
  lines.push("");
  lines.push("REGRAS ABSOLUTAS:");
  lines.push(
    "1. Responda EXCLUSIVAMENTE com um array JSON válido. Nada antes, nada depois. Sem cercas markdown, sem comentários."
  );
  lines.push(
    '2. Formato exato de cada item: {"pair": <índice do par>, "action": "<ação>"}. Em "merge" acrescente "merged_fact": "<texto único>".'
  );
  lines.push("3. Responda UM item por par, usando o índice do par. Não invente índices.");
  lines.push('4. "merged_fact" é OBRIGATÓRIO em "merge" e PROIBIDO nas demais ações.');
  lines.push(
    "5. Em caso de dúvida entre reinforce e merge, escolha merge APENAS se a candidata acrescenta informação que a existente não tem."
  );
  lines.push("6. PROIBIDO inventar fatos que não estejam no par.");
  lines.push("");
  lines.push("<pares>");
  for (const pair of pairs) {
    lines.push(`[par ${pair.index}] escopo=${pair.scope}`);
    lines.push(`existente: ${redactSecrets(pair.existingFact)}`);
    lines.push(`candidata: ${redactSecrets(pair.candidateFact)}`);
    lines.push("");
  }
  lines.push("</pares>");
  lines.push("");
  lines.push("Lembrete: sua ÚNICA saída é o array JSON.");
  return lines.join("\n");
}

/**
 * Converte a saída bruta do modelo em decisões de reconciliação VALIDADAS.
 *
 * Resiliência (contrato do ticket): pares malformados ou inválidos são
 * IGNORADOS (contados em `dropped`) — nunca Applied ao banco. Um par sem
 * decisão válida é tratado pelo despachante como `independent` (o fato
 * candidato é inserido como memória nova), o que garante que NENHUMA memória
 * destilada se perca por uma resposta ruim do modelo.
 */
export function parseReconciliationDecisions(
  raw: string,
  pairs: ReconciliationPair[]
): { decisions: ReconciliationDecision[]; dropped: number; parsed: boolean } {
  const candidates = tryParseJsonArrays(stripAnsi(raw ?? ""));
  if (candidates === null) {
    return { decisions: [], dropped: 0, parsed: false };
  }

  const byIndex = new Map<number, ReconciliationPair>();
  for (const pair of pairs) byIndex.set(pair.index, pair);

  const decisions: ReconciliationDecision[] = [];
  const decided = new Set<number>();
  let dropped = 0;

  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      dropped++;
      continue;
    }
    const item = candidate as Record<string, unknown>;

    // Correlação com o par: aceita "pair" (índice) ou "existing_id".
    let pair: ReconciliationPair | undefined;
    const rawPair = item.pair;
    if (typeof rawPair === "number" && Number.isInteger(rawPair)) {
      pair = byIndex.get(rawPair);
    } else if (typeof rawPair === "string" && /^\d+$/.test(rawPair.trim())) {
      pair = byIndex.get(Number(rawPair.trim()));
    }
    if (!pair && typeof item.existing_id === "number") {
      pair = pairs.find((p) => p.existingId === item.existing_id);
    }
    if (!pair) {
      dropped++; // par inexistente ou índice fora do lote
      continue;
    }
    if (decided.has(pair.index)) {
      dropped++; // decisão duplicada para o mesmo par
      continue;
    }

    const action = normalizeReconciliationAction(item.action);
    if (!action) {
      dropped++; // rótulo fora da taxonomia
      continue;
    }

    if (action === "merge") {
      const mergedFact =
        typeof item.merged_fact === "string"
          ? redactSecrets(item.merged_fact).replace(/\s+/g, " ").trim()
          : "";
      if (mergedFact.length < 10) {
        dropped++; // merge sem texto unificado utilizável
        continue;
      }
      decided.add(pair.index);
      decisions.push({
        action,
        pairIndex: pair.index,
        existingId: pair.existingId,
        mergedFact,
      });
      continue;
    }

    decided.add(pair.index);
    decisions.push({ action, pairIndex: pair.index, existingId: pair.existingId });
  }

  return { decisions, dropped, parsed: true };
}

/**
 * Fallback DETERMÍSTICO: todos os candidatos são tratados como `independent`.
 *
 * Usado quando a IA está indisponível ou `DREAMS_OFFLINE=1`. Nenhuma memória
 * é absorvida, revogada ou fundida — os dois lados permanecem independentes e
 * o sono REM NÃO é interrompido.
 */
export function independentFallbackDecisions(pairs: ReconciliationPair[]): ReconciliationDecision[] {
  return pairs.map((pair) => ({
    action: "independent" as ReconciliationAction,
    pairIndex: pair.index,
    existingId: pair.existingId,
  }));
}


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
 * 1º Gemini 3.8 Flash (Antigravity) -> 2º Mimo 2.6 Flash (free) ->
 * 3º `opencode-go/deepseek-v4.1-flash` -> Erro se todos falharem.
 */
export class MimoSynthesizer {
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly tertiaryModel: string;
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
    this.tertiaryModel = options.tertiaryModel || DEFAULT_TERTIARY_MODEL;
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
   * Cascata de modelos a tentar, na ordem de preferência.
   *
   * Compartilhada pela síntese de memórias e pelo julgamento de reconciliação:
   * a política de fallback é a mesma nos dois caminhos.
   */
  private modelChain(): string[] {
    if (this.models.length > 0) return this.models;
    return Array.from(
      new Set([this.model, this.fallbackModel, this.tertiaryModel].filter(Boolean))
    );
  }

  /**
   * Monta o prompt de reconciliação respeitando o teto de BYTES UTF-8.
   *
   * Pares que não cabem são EXCLUÍDOS do lote enviado ao modelo — eles ficam
   * sem decisão e, portanto, são tratados como `independent` pelo despachante
   * (nenhuma memória se perde).
   */
  private buildCappedReconciliationPrompt(
    pairs: ReconciliationPair[]
  ): { prompt: string; included: ReconciliationPair[] } {
    let included = pairs;
    let prompt = buildReconciliationPrompt(included);
    while (utf8ByteLength(prompt) > this.maxPromptBytes && included.length > 1) {
      included = included.slice(0, included.length - 1);
      prompt = buildReconciliationPrompt(included);
    }
    return { prompt, included };
  }

  /**
   * TICKET-DREAMS-06 (Frente B) — Julgamento neural de reconciliação em LOTE.
   *
   * Diferença crucial para o `synthesize()`: este método NUNCA lança. Na
   * indisponibilidade de IA (ou com `DREAMS_OFFLINE=1`) ele degrada para o
   * FALLBACK DETERMÍSTICO — todos os candidatos viram `independent` — para
   * que o Sono REM nunca seja interrompido por uma falha de modelo.
   */
  async reconcile(pairs: ReconciliationPair[]): Promise<ReconciliationBatchResult> {
    const empty: ReconciliationBatchResult = {
      decisions: [],
      dropped: 0,
      parsed: false,
      source: "none",
      error: null,
      promptChars: 0,
      promptBytes: 0,
      modelUsed: "none",
    };

    if (pairs.length === 0) return empty;

    // Fallback determinístico imediato: modo offline.
    if (process.env.DREAMS_OFFLINE === "1") {
      return {
        ...empty,
        decisions: independentFallbackDecisions(pairs),
        error: "DREAMS_OFFLINE=1 — julgamento neural indisponível; fallback determinístico (independent).",
      };
    }

    const { prompt, included } = this.buildCappedReconciliationPrompt(pairs);
    if (included.length === 0) {
      return {
        ...empty,
        decisions: independentFallbackDecisions(pairs),
        error: "prompt de reconciliação acima do teto de bytes; fallback determinístico (independent).",
      };
    }

    const promptBytes = utf8ByteLength(prompt);
    const attemptErrors: string[] = [];

    for (const currentModel of this.modelChain()) {
      const argv = [
        this.binary,
        "run",
        "--title",
        "Dreams Reconciliation",
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
        attemptErrors.push(`timeout de ${this.timeoutMs}ms atingido para ${currentModel}`);
        continue;
      }

      if (outcome.code !== 0) {
        attemptErrors.push(
          `modelo ${currentModel} falhou com code=${outcome.code} signal=${outcome.signal}: ${outcome.stderr.slice(-300).trim()}`
        );
        continue;
      }

      const { decisions, dropped, parsed } = parseReconciliationDecisions(
        outcome.stdout,
        included
      );

      if (parsed) {
        const sourceLabel = currentModel.includes("mimo")
          ? "mimo"
          : currentModel.includes("gemini")
          ? "gemini"
          : currentModel;
        // Pares que não couberam no lote ficam sem decisão ⇒ `independent`.
        const decided = new Set(decisions.map((d) => d.pairIndex));
        for (const pair of pairs) {
          if (!decided.has(pair.index)) {
            decisions.push({
              action: "independent",
              pairIndex: pair.index,
              existingId: pair.existingId,
            });
          }
        }
        return {
          decisions,
          dropped: dropped + (pairs.length - included.length),
          parsed: true,
          source: sourceLabel,
          error: null,
          promptChars: prompt.length,
          promptBytes,
          modelUsed: currentModel,
        };
      }

      attemptErrors.push(
        `modelo ${currentModel} não retornou JSON de reconciliação parseável (stdout: ${outcome.stdout.slice(0, 200).trim()})`
      );
    }

    // Nenhum modelo entregou JSON utilizável ⇒ fallback determinístico.
    const error = `Julgamento neural de reconciliação indisponível. Tentativas: ${attemptErrors.join(" | ")}`;
    this.onError?.(new Error(error));
    return {
      ...empty,
      decisions: independentFallbackDecisions(pairs),
      error,
      dropped: pairs.length,
    };
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

    const modelsToTry: string[] = this.modelChain();

    const attemptErrors: string[] = [];

    for (const currentModel of modelsToTry) {
      // TICKET-DREAMS-01A: o prompt vai por STDIN (nunca em `argv`, evitando
      // E2BIG e /proc/cmdline). SEM `--pure`: a flag desativa o plugin
      // @cortexkit/opencode-antigravity-auth e bloqueia o provedor
      // google/antigravity. A auto-ingestão já é blindada por
      // `excludeSessionTitles` na camada SQL.
      const argv = [
        this.binary,
        "run",
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

/**
 * TICKET-DREAMS-06 (Frente B) — Atalho funcional do julgamento neural em
 * LOTE: `await reconcileMemoriesBatch(pairs)`.
 *
 * NUNCA lança: na indisponibilidade de IA (ou com `DREAMS_OFFLINE=1`) devolve
 * o fallback determinístico (todos os candidatos como `independent`).
 */
export async function reconcileMemoriesBatch(
  pairs: ReconciliationPair[],
  options?: MimoSynthesizerOptions
): Promise<ReconciliationBatchResult> {
  return new MimoSynthesizer(options).reconcile(pairs);
}
