/**
 * security.ts — Redação determinística de segredos/credenciais (TICKET-DREAMS-04B).
 *
 * Utilitário PURO e FAIL-SAFE de sanitização. Mascara os padrões de credencial
 * mais comuns antes que qualquer conteúdo sensível:
 *   1. seja enviado a um terceiro/modelo externo (`MimoSynthesizer` → `opencode run`);
 *   2. seja persistido como memória no DreamsDB.
 *
 * Padrões cobertos (ordem de aplicação importa — específicos antes dos genéricos):
 *   - OpenAI:  `sk-[a-zA-Z0-9_-]{20,}`                 → `sk-***REDACTED***`
 *   - Google:  `AIza[0-9A-Za-z_-]{35,}`                → `AIza***REDACTED***`
 *   - Bearer:  `Bearer\s+[A-Za-z0-9_\-\.]{15,}`        → `Bearer ***REDACTED***`
 *   - JWT:     `eyJ.<base64url>.<base64url>.*`          → `***REDACTED_JWT***`
 *   - Atribuições comuns: `password|secret|api_key|token|...=valor` → `chave=***REDACTED***`
 *
 * Garantias contratuais:
 *  - NUNCA lança exceção (qualquer entrada não-string devolve `""`).
 *  - IDEMPOTENTE: aplicar `redactSecrets` sobre texto já redigido não altera nada.
 *  - Sem estado global mutável: os `RegExp` são globais mas só usados via
 *    `String.prototype.replace`, que reseta `lastIndex` a cada chamada.
 */

/** Placeholder canônico injetado no lugar de um segredo mascarado. */
export const REDACTED_PLACEHOLDER = "***REDACTED***";

/** Placeholder específico para tokens JWT (header.payload.signature). */
export const REDACTED_JWT_PLACEHOLDER = "***REDACTED_JWT***";

/** Uma regra de redação: regex global + substituição (string ou função). */
interface SecretRule {
  /** Rótulo legível para diagnóstico/testes. */
  readonly name: string;
  /** Padrão global (flag `g` obrigatória). */
  readonly pattern: RegExp;
  /** String de troca ou função `replace` (recebe o match e os grupos). */
  readonly replacement: string | ((substring: string, ...args: any[]) => string);
}

/**
 * Regras aplicadas em sequência. As específicas (prefixos de provedor) vêm
 * antes das genéricas (atribuição chave=valor) para preservar o prefixo
 * informativo do provedor (`sk-`, `AIza`, `Bearer`).
 */
const SECRET_RULES: readonly SecretRule[] = [
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    replacement: `sk-${REDACTED_PLACEHOLDER}`,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}/g,
    replacement: `AIza${REDACTED_PLACEHOLDER}`,
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9_.\-]{15,}/gi,
    replacement: `Bearer ${REDACTED_PLACEHOLDER}`,
  },
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED_JWT_PLACEHOLDER,
  },
  {
    name: "secret-assignment",
    pattern:
      /\b(password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer[_-]?token|private[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"'<>,;]{6,})\3/gi,
    replacement: (_match: string, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}${REDACTED_PLACEHOLDER}${quote}`,
  },
];

/**
 * Mascara segredos/credenciais comuns em um texto livre.
 *
 * @param text Conteúdo a sanitizar (tipicamente um diálogo, um fato destilado
 *             ou um trecho de memória).
 * @returns O texto com todos os padrões sensíveis substituídos pelos
 *          placeholders de redação. Entradas não-string devolvem `""`.
 *          NUNCA lança exceção.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let output = text;
  try {
    for (const rule of SECRET_RULES) {
      output = output.replace(rule.pattern, rule.replacement as any);
    }
  } catch {
    // Fail-safe: em qualquer falha inesperada devolve o melhor esforço obtido.
    return output;
  }
  return output;
}

/**
 * Indica se um texto ainda contém algum padrão de credencial conhecido.
 *
 * Usado como asserção de defesa em profundidade nos seams de I/O. NUNCA lança.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  try {
    for (const rule of SECRET_RULES) {
      // `test` com flag global é stateful: restaura lastIndex em seguida.
      const matched = rule.pattern.test(text);
      rule.pattern.lastIndex = 0;
      if (matched) return true;
    }
  } catch {
    return false;
  }
  return false;
}
