/**
 * security.ts — Redação determinística de segredos/credenciais (TICKET-DREAMS-04B).
 *
 * Utilitário PURO e FAIL-SAFE de sanitização. Mascara os padrões de credencial
 * mais comuns antes que qualquer conteúdo sensível:
 *   1. seja enviado a um terceiro/modelo externo (`MimoSynthesizer` → `opencode run`);
 *   2. seja persistido como memória no DreamsDB.
 *
 * Padrões cobertos (ordem de aplicação importa — específicos antes dos genéricos):
 *   - PEM:     `-----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----`
 *                                                → `***REDACTED***`
 *   - URL:     `https?://user:password@host`     → `https://***REDACTED***:***REDACTED***@host`
 *   - AWS ID:  `AKIA[0-9A-Z]{16}`                → `AKIA***REDACTED***`
 *   - AWS sec: `aws_secret_access_key=<40 chars>` → `aws_secret_access_key=***REDACTED***`
 *   - Stripe:  `sk_live_[0-9a-zA-Z]{24,}`        → `sk_live_***REDACTED***`
 *   - Stripe:  `rk_live_[0-9a-zA-Z]{24,}`        → `rk_live_***REDACTED***`
 *   - Slack:   `xox[bpas]-[0-9a-zA-Z-]{10,}`     → `xoxb-***REDACTED***`
 *   - OpenAI:  `sk-[a-zA-Z0-9_-]{20,}`           → `sk-***REDACTED***`
 *   - Google:  `AIza[0-9A-Za-z_-]{35,}`          → `AIza***REDACTED***`
 *   - GitHub:  `gh[pousr]_...` / `github_pat_...`→ `gh-***REDACTED***`
 *   - Bearer:  `Bearer\s+[A-Za-z0-9_\-\.]{15,}`  → `Bearer ***REDACTED***`
 *   - JWT:     `eyJ.<base64url>.<base64url>.*`   → `***REDACTED_JWT***`
 *   - AWS sec isolado: run de 40 chars base64    → `***REDACTED***`
 *   - Atribuições comuns: `password|secret|api_key|token|github_token|...=valor`
 *                                                → `chave=***REDACTED***`
 *
 * Garantias contratuais:
 *  - NUNCA lança exceção (qualquer entrada não-string devolve `""`).
 *  - IDEMPOTENTE: aplicar `redactSecrets` sobre texto já redigido não altera nada.
 *  - Sem estado global mutável: os `RegExp` são globais mas só usados via
 *    `String.prototype.replace`/`test` (que reseta `lastIndex` a cada chamada).
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
 * informativo do provedor (`sk-`, `AIza`, `AKIA`, `sk_live_`, `xoxb-`).
 */
const SECRET_RULES: readonly SecretRule[] = [
  // ---------------------------------------------------------------------
  // (1) Bloco de chave privada PEM — MULTI-LINHA.
  //     Fica PRIMEIRO de tudo: o corpo base64 do bloco pode conter runs de
  //     40+ chars que casariam com a regra de token isolado (item 12).
  //     Cobre RSA/EC/OPENSSH/DSA/PGP PRIVATE KEY (+ sufixo opcional " BLOCK").
  // ---------------------------------------------------------------------
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: REDACTED_PLACEHOLDER,
  },
  // ---------------------------------------------------------------------
  // (2) Credenciais embutidas em URL — `https?://user:password@host`.
  //     Mascara USUÁRIO e SENHA, preservando esquema e host.
  //     O grupo da SENDA é guloso e admite `@`: o backtracking ancora no ÚLTIMO
  //     `@` antes do caminho (que é o delimitador real da authority), de modo
  //     que senhas com `@` não percent-encoded (`p@ss`) são mascaradas por
  //     inteiro. O lookahead `(?!\*{3})` impede que uma URL JÁ redigida seja
  //     reprocessada (idempotência + `containsSecret` não acusa o placeholder).
  // ---------------------------------------------------------------------
  {
    name: "url-embedded-credentials",
    pattern: /(https?:\/\/)(?!\*{3})([^\/\s:@]+):([^\/\s?#]+)@/g,
    replacement: (_match: string, scheme: string) =>
      `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  },
  // ---------------------------------------------------------------------
  // (3) AWS Access Key ID — `AKIA` + 16 chars [0-9A-Z].
  //     (Também existem prefixos ASIA/AROA/AIDA/AGPA/ANPA/ANVA; AKIA é o
  //     canônico e o único coberto por contrato.)
  // ---------------------------------------------------------------------
  {
    name: "aws-access-key-id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: `AKIA${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (4) AWS Secret Access Key (40 chars base64) EM ATRIBUIÇÃO.
  //     A regra genérica de atribuição NÃO pega `aws_secret_access_key=` porque
  //     `\bsecret\b` não casa dentro de `aws_secret_access_key` (underscore é
  //     caractere de palavra). Por isso existe uma regra dedicada.
  // ---------------------------------------------------------------------
  {
    name: "aws-secret-access-key-assignment",
    pattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret[_-]?key|secret[_-]?access[_-]?key)\b(\s*[:=]\s*)(["']?)(?!\*{3})([A-Za-z0-9/+=]{40})\3/gi,
    replacement: (_match: string, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}${REDACTED_PLACEHOLDER}${quote}`,
  },
  // ---------------------------------------------------------------------
  // (5) Stripe — chaves live (secret key `sk_live_` e restricted key `rk_live_`).
  // ---------------------------------------------------------------------
  {
    name: "stripe-live-key",
    pattern: /\b(sk_live_|rk_live_)[0-9a-zA-Z]{24,}/g,
    replacement: (_match: string, prefix: string) => `${prefix}${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (6) Slack — tokens de app (`xoxa`), bot (`xoxb`), workspace (`xoxp`),
  //     incoming-webhook (`xoxi`) e refresh (`xoxr`).
  // ---------------------------------------------------------------------
  {
    name: "slack-token",
    pattern: /\b(xox[bpas])-[0-9a-zA-Z-]{10,}/g,
    replacement: (_match: string, prefix: string) => `${prefix}-${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (7) OpenAI — `sk-` + 20+ chars.
  // ---------------------------------------------------------------------
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    replacement: `sk-${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (8) Google — `AIza` + 35+ chars.
  // ---------------------------------------------------------------------
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}/g,
    replacement: `AIza${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (9) Bearer token (case-insensitive).
  // ---------------------------------------------------------------------
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9_.\-]{15,}/gi,
    replacement: `Bearer ${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (10) JWT — header.payload.signature.
  // ---------------------------------------------------------------------
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED_JWT_PLACEHOLDER,
  },
  // ---------------------------------------------------------------------
  // (11) GitHub — classic (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) e
  //      fine-grained (`github_pat_`).
  // ---------------------------------------------------------------------
  {
    name: "github-token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replacement: `gh-${REDACTED_PLACEHOLDER}`,
  },
  // ---------------------------------------------------------------------
  // (12) AWS Secret Access Key ISOLADA — run de exatamente 40 chars do
  //      alfabeto base64 (A-Za-z0-9+/=), fora de qualquer atribuição.
  //      Lookarounds (e não `\b`) porque `/` e `=` NÃO são caracteres de
  //      palavra: `\b` falharia em tokens terminados em `=`.
  //      O `_` NÃO entra no alfabeto (base64 padrão, não base64url) — assim
  //      tokens GitHub (`ghp_...`) não colidem com esta regra.
  // ---------------------------------------------------------------------
  {
    name: "aws-secret-access-key-isolated",
    pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    replacement: REDACTED_PLACEHOLDER,
  },
  // ---------------------------------------------------------------------
  // (13) Atribuições genéricas — `chave=valor` / `chave: valor`.
  //      `(?!\*{3})` — nunca re-redige um placeholder já injetado por regra
  //      específica anterior (sk-***/AIza***/AKIA***/gh-***/Bearer ***/
  //      ***REDACTED_JWT***/***REDACTED***), preservando a idempotência.
  // ---------------------------------------------------------------------
  {
    name: "secret-assignment",
    pattern:
      /\b(password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer[_-]?token|github[_-]?token|token|private[_-]?key)\b(\s*[:=]\s*)(["']?)(?!\*{3})([^\s"'<>,;]{6,})\3/gi,
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
