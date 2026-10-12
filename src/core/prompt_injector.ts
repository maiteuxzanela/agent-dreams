/**
 * prompt_injector.ts — Injeção fail-safe de memórias Dreams no system prompt.
 *
 * Monta um bloco Markdown ("## Dreams Consolidated Memories") a partir de:
 *   1. `dreamsDir/collective/COLLECTIVE_MEMORY.md`  (memória coletiva)
 *   2. `dreamsDir/personas/<agentName>.md`          (memória da persona)
 *
 * O nome da persona vem da sessão corrente — resolvido via SDK client
 * (`client.session.get` / `client.session.messages`) e, em último caso,
 * via SQLite do OpenCode aberto em SOMENTE LEITURA (`session.agent` →
 * `session_v2.agent` → `message.data.$.agent`).
 *
 * Garantias contratuais:
 *  - ANTI-DUMPING: cada arquivo é limitado a `MAX_MEMORY_LINES` (150) linhas
 *    e `MAX_MEMORY_CHARS` (~2000 tokens); o corte é gracioso e sempre
 *    acompanha um aviso legível no próprio bloco.
 *  - FAIL-SAFE ABSOLUTO: nenhuma função deste módulo lança exceção.
 *    `wrapSystemPromptInjection` retorna `null` em QUALQUER erro — o system
 *    prompt do usuário segue intacto (o chat nunca quebra por causa da Dreams).
 *  - Retorno `null` = "nada para injetar" (nunca string vazia).
 */
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";

/** Máximo de linhas por arquivo de memória injetado (anti-dumping). */
export const MAX_MEMORY_LINES = 150;

/** Teto aproximado de tokens por arquivo de memória injetado. */
export const MAX_MEMORY_TOKENS = 2000;

/** Razão chars/token usada para converter o teto de tokens em caracteres. */
export const CHARS_PER_TOKEN = 4;

/** Teto absoluto em caracteres (~2000 tokens × 4 chars/token). */
export const MAX_MEMORY_CHARS = MAX_MEMORY_TOKENS * CHARS_PER_TOKEN;

/** Marcador textual do aviso de truncamento (assertável em testes). */
export const ANTI_DUMP_NOTICE_MARKER = "Dreams anti-dumping: memória truncada";

/** Cabeçalho do bloco injetado no `output.system`. */
export const INJECTION_HEADER = "## Dreams Consolidated Memories";

/** Subcabeçalho da seção coletiva. */
export const COLLECTIVE_SECTION_HEADER = "### Memória Coletiva";

/** Prefixo do subcabeçalho da seção de persona (fecha com `)`). */
export const PERSONA_SECTION_HEADER_PREFIX = "### Memória da Persona ("; 

/**
 * Formato do nome de agente aceito como caminho de persona.
 * Bloqueia separadores de caminho e traversão (`../`, `/`, `\`).
 */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Limite de leitura física em disco (arquivos patológicos de dezenas de MB). */
const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;

/** Tabelas consultadas (whitelist fixa — nomes NUNCA vêm do usuário). */
const AGENT_TABLES = ["session", "session_v2"] as const;

/** Raiz padrão das memórias Dreams. */
export function defaultDreamsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "dreams");
}

/** Caminho padrão do banco de sessões do OpenCode (read-only). */
export function defaultSessionDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Resultado da aplicação do teto anti-dumping. */
export interface AntiDumpResult {
  /** Conteúdo final (com aviso anexado quando `truncated`). */
  text: string;
  /** `true` quando o conteúdo foi cortado. */
  truncated: boolean;
}

/**
 * Aplica o teto anti-dumping a um conteúdo bruto.
 *
 * Regras (nesta ordem):
 *  1. no máximo `MAX_MEMORY_LINES` linhas;
 *  2. no máximo `MAX_MEMORY_CHARS` caracteres (corte em quebra de linha);
 *  3. quando houve corte, anexa um aviso explicitando o quanto foi exibido.
 *
 * Nunca lança exceção: conteúdo não-string vira `""`.
 */
export function applyAntiDumpLimit(content: string): AntiDumpResult {
  if (typeof content !== "string" || content.length === 0) {
    return { text: "", truncated: false };
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const allLines = normalized.split("\n");
  let truncated = false;

  let lines = allLines;
  if (lines.length > MAX_MEMORY_LINES) {
    lines = lines.slice(0, MAX_MEMORY_LINES);
    truncated = true;
  }

  let text = lines.join("\n");
  if (text.length > MAX_MEMORY_CHARS) {
    const slice = text.slice(0, MAX_MEMORY_CHARS);
    const lastBreak = slice.lastIndexOf("\n");
    text = slice.slice(0, lastBreak > 0 ? lastBreak : slice.length);
    truncated = true;
  }

  text = text.trim();
  if (!truncated) return { text, truncated: false };
  if (!text) return { text: "", truncated: true };

  const shownLines = text.split("\n").length;
  const notice =
    `> ⚠️ ${ANTI_DUMP_NOTICE_MARKER}: exibindo ${shownLines} de ${allLines.length} ` +
    `linhas (teto de ${MAX_MEMORY_LINES} linhas / ~${MAX_MEMORY_TOKENS} tokens).`;
  return { text: `${text}\n\n${notice}`, truncated: true };
}

/**
 * Lê um arquivo de memória com fail-soft e teto anti-dumping.
 *
 * @returns Conteúdo truncado, ou `null` se o arquivo não existir, for um
 *          diretório, estiver vazio/branco ou a leitura falhar.
 */
function readMemoryFile(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;

    let raw: string;
    if (stat.size > MAX_FILE_READ_BYTES) {
      // Defesa contra arquivo patológico: lê só o prefixo necessário.
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_FILE_READ_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_READ_BYTES, 0);
        raw = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(filePath, "utf8");
    }

    if (!raw || !raw.trim()) return null;
    const { text } = applyAntiDumpLimit(raw);
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Lê a memória coletiva consolidada (`collective/COLLECTIVE_MEMORY.md`).
 *
 * @param dreamsDir Raiz das memórias Dreams (ex.: `~/.config/opencode/dreams`).
 * @returns Conteúdo (limitado a 150 linhas / ~2000 tokens) ou `null`.
 */
export function readCollectiveMemory(dreamsDir: string): string | null {
  try {
    if (typeof dreamsDir !== "string" || !dreamsDir.trim()) return null;
    const filePath = path.join(dreamsDir, "collective", "COLLECTIVE_MEMORY.md");
    return readMemoryFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Lê a memória de uma persona (`personas/<agentName>.md`).
 *
 * O `agentName` é validado contra `AGENT_NAME_RE` antes de virar caminho:
 * nomes com `/`, `\` ou iniciados por `.` (traversação) retornam `null`.
 *
 * @returns Conteúdo (limitado a 150 linhas / ~2000 tokens) ou `null`.
 */
export function readPersonaMemory(dreamsDir: string, agentName: string): string | null {
  try {
    if (typeof dreamsDir !== "string" || !dreamsDir.trim()) return null;
    if (!isValidAgentName(agentName)) return null;
    const filePath = path.join(dreamsDir, "personas", `${agentName}.md`);
    return readMemoryFile(filePath);
  } catch {
    return null;
  }
}

/** Valida se `agentName` é seguro para compor um caminho de arquivo. */
function isValidAgentName(agentName: unknown): agentName is string {
  return typeof agentName === "string" && AGENT_NAME_RE.test(agentName);
}

/**
 * Normaliza um nome de agente vindo de fonte externa (DB/SDK).
 *
 * Aceita formatos como `dante`, `agent:dante`, `opencode/dante`; descarta
 * vazios, não-strings e nomes que não passam em `AGENT_NAME_RE`.
 */
function normalizeAgent(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const afterSlash = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  const bare = afterSlash.replace(/^agent:/i, "").trim();
  if (!bare) return null;

  return isValidAgentName(bare) ? bare : null;
}

/** Desembrulha formatos de resposta do SDK (`{ data }` ou objeto direto). */
function unwrap(value: any): any {
  if (value && typeof value === "object" && "data" in value && value.data !== undefined) {
    return value.data;
  }
  return value;
}

/** Extrai `agent` de um payload (sessão/mensagem) em qualquer formato comum. */
function pickAgent(value: any): string | null {
  const payload = unwrap(value);
  if (!payload || typeof payload !== "object") return null;

  const candidates: unknown[] = [
    payload.agent,
    payload.metadata?.agent,
    payload.info?.agent,
    payload.properties?.info?.agent,
  ];
  for (const candidate of candidates) {
    const agent = normalizeAgent(candidate);
    if (agent) return agent;
  }
  return null;
}

/**
 * Varre a lista de mensagens da mais recente para a mais antiga e retorna o
 * primeiro `agent` explícito (tipicamente `UserMessage.agent`).
 *
 * ATENÇÃO: `AssistantMessage.mode` (`build`/`plan`/`explore`) NÃO é usado —
 * mode é o modo de operação, não o nome da persona.
 */
function pickAgentFromMessages(value: any): string | null {
  const payload = unwrap(value);
  const list: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload?.info)
        ? payload.info
        : [];
  if (list.length === 0) return null;

  for (let i = list.length - 1; i >= 0; i--) {
    const agent = pickAgent(list[i]);
    if (agent) return agent;
  }
  return null;
}

/**
 * Tenta resolver o agente pela API do SDK (cliente HTTP do daemon).
 *
 * Ordem: `client.session.get` → `client.session.messages`.
 * Qualquer erro é engolido (fail-soft) e a tentativa seguinte é usada.
 */
async function readAgentViaClient(sessionID: string, client: any): Promise<string | null> {
  if (!client || typeof client !== "object") return null;
  const sessionApi = client.session ?? client;

  try {
    if (typeof sessionApi?.get === "function") {
      const response = await sessionApi.get({ path: { id: sessionID } });
      const agent = pickAgent(response);
      if (agent) return agent;
    }
  } catch {
    /* fail-soft: segue para messages */
  }

  try {
    if (typeof sessionApi?.messages === "function") {
      const response = await sessionApi.messages({ path: { id: sessionID } });
      const agent = pickAgentFromMessages(response);
      if (agent) return agent;
    }
  } catch {
    /* fail-soft: o chamador tenta o SQLite */
  }

  return null;
}

/**
 * Lê o agente da sessão direto do SQLite do OpenCode em modo SOMENTE LEITURA.
 *
 * Prioridade: `session.agent` → `session_v2.agent` → `message.data.$.agent`
 * (mensagem mais recente da sessão). Tabelas vindo de whitelist fixa; todos
 * os valores passam por `?` posicionado (sem interpolação de SQL).
 *
 * Nunca lança: banco ausente/bloqueado/corrompido → `null`.
 */
function readAgentViaDb(sessionID: string, dbPath?: string): string | null {
  const finalPath = dbPath || defaultSessionDbPath();
  if (!finalPath || !fs.existsSync(finalPath)) return null;

  let db: Database | null = null;
  try {
    db = new Database(finalPath, { readonly: true });

    for (const table of AGENT_TABLES) {
      try {
        const row = db
          .query<{ agent: unknown }, [string]>(`SELECT agent FROM \`${table}\` WHERE id = ?`)
          .get(sessionID);
        const agent = normalizeAgent(row?.agent);
        if (agent) return agent;
      } catch {
        /* tabela inexistente neste schema → tenta a próxima */
      }
    }

    try {
      const rows = db
        .query<{ agent: unknown }, [string]>(
          `SELECT json_extract(data, '$.agent') AS agent
             FROM message
            WHERE session_id = ? AND json_valid(data)
            ORDER BY time_created DESC
            LIMIT 50`
        )
        .all(sessionID);
      for (const row of rows) {
        const agent = normalizeAgent(row?.agent);
        if (agent) return agent;
      }
    } catch {
      /* schema inesperado → fail-soft */
    }

    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* já fechado / nunca aberto */
    }
  }
}

/**
 * Identifica o nome do agente associado à sessão corrente.
 *
 * Estratégia (cada etapa é isolada por try/catch):
 *   1. SDK client — `session.get` e depois `session.messages`;
 *   2. SQLite read-only — `session.agent`, `session_v2.agent` e por fim
 *      `message.data.$.agent` da sessão.
 *
 * @param sessionID ID da sessão (`ses_...`); `undefined` → `null`.
 * @param client    Cliente SDK do OpenCode (pode ser ausente/`null`).
 * @param dbPath    Caminho alternativo do SQLite (padrão: opencode.db).
 * @returns Nome do agente normalizado ou `null` quando não resolvido.
 *          NUNCA lança exceção.
 */
export async function resolveSessionAgent(
  sessionID: string | undefined,
  client: any,
  dbPath?: string
): Promise<string | null> {
  try {
    if (typeof sessionID !== "string") return null;
    const id = sessionID.trim();
    if (!id) return null;

    try {
      const fromClient = await readAgentViaClient(id, client);
      if (fromClient) return fromClient;
    } catch {
      /* fail-soft: tenta SQLite */
    }

    try {
      const fromDb = readAgentViaDb(id, dbPath);
      if (fromDb) return fromDb;
    } catch {
      /* fail-soft: devolve null */
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Monta o bloco Markdown de injeção a partir das memórias disponíveis.
 *
 * - `agentName` com persona inexistente/ausente → só a seção coletiva;
 * - `agentName === null` → só a seção coletiva;
 * - nenhuma memória encontrada → `null`.
 *
 * Nunca lança exceção.
 */
export function buildSystemPromptInjection(
  dreamsDir: string,
  agentName: string | null
): string | null {
  try {
    if (typeof dreamsDir !== "string" || !dreamsDir.trim()) return null;

    const collective = readCollectiveMemory(dreamsDir);
    const persona = agentName ? readPersonaMemory(dreamsDir, agentName) : null;
    if (!collective && !persona) return null;

    const sections: string[] = [INJECTION_HEADER];
    if (collective) {
      sections.push(COLLECTIVE_SECTION_HEADER, "", collective);
    }
    if (persona) {
      sections.push(`${PERSONA_SECTION_HEADER_PREFIX}${agentName})`, "", persona);
    }

    const block = sections.join("\n").trim();
    return block ? block : null;
  } catch {
    return null;
  }
}

/**
 * Orquestrador da injeção: resolve o agente da sessão e monta o bloco.
 *
 * CONTRATO: `Promise<string | null>` — `null` significa "nada para injetar"
 * (sem memórias, sessão indeterminada ou qualquer erro interno). Esta função
 * NUNCA rejeita a promise; o try/catch externo é apenas defesa em profundidade.
 */
export async function wrapSystemPromptInjection(
  dreamsDir: string,
  sessionID: string | undefined,
  client: any
): Promise<string | null> {
  try {
    if (typeof dreamsDir !== "string" || !dreamsDir.trim()) return null;

    const agentName = await resolveSessionAgent(sessionID, client);
    return buildSystemPromptInjection(dreamsDir, agentName);
  } catch {
    return null;
  }
}
