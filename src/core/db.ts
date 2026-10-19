import { Database } from "bun:sqlite";
import { redactSecrets } from "./security";
import path from "path";
import os from "os";
import fs from "fs";

export interface MemoryRecord {
  id?: number;
  scope: string; // 'collective' or 'agent:<name>'
  fact: string;
  category: "learning" | "decision" | "pitfall" | "preference";
  score: number;
  decay_weight: number;
  recall_count: number;
  confirmations: number;
  last_reinforced: string;
  created_at: string;
}

export type MemoryCategory = "learning" | "decision" | "pitfall" | "preference";

/**
 * TICKET-DREAMS-03B — Pesos canônicos por categoria de memória.
 *
 * `base_weight`  → viés de prioridade/retensão: preferências e decisões
 *                  nascem com score maior que aprendizados triviais.
 * `decay_weight` → multiplicador da taxa de decaimento temporal aplicada em
 *                  `SleepCycle.deepSleep()`. Quanto MENOR, mais lenta é a
 *                  meia-vida (memória mais resistente ao esquecimento).
 *
 * Meia-vida aproximada com o lambda padrão (0,05/dia):
 *   preference ~140d | decision ~46d | pitfall ~28d | learning ~14d
 */
export const CATEGORY_WEIGHTS: Record<
  MemoryCategory,
  { base_weight: number; decay_weight: number }
> = {
  preference: { base_weight: 2.5, decay_weight: 0.1 },
  decision: { base_weight: 2.0, decay_weight: 0.3 },
  pitfall: { base_weight: 1.8, decay_weight: 0.5 },
  learning: { base_weight: 1.0, decay_weight: 1.0 },
};

/**
 * TICKET-DREAMS-04 (Frente 4A) — Limiar de similaridade léxica (Jaccard) para
 * considerar dois fatos "semanticamente equivalentes".
 *
 * Calibração: 0,80 exige sobreposição substancial de tokens normalizados, mas
 * ainda tolera reordenação, pontuação e acentos (que colapsam para os mesmos
 * tokens). Fatos que diferem apenas no "sujeito/objeto" final (ex.:
 * `Sessão finalizada no diretório /tmp/def10_repeticao` vs
 * `... /tmp/def10_teto`, Jaccard ≈ 0,75) NÃO são fundidos — evita falso
 * positivo que apagaria a distinção semântica.
 */
export const FACT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Normaliza um fato para comparação: minúsculas, remoção de diacríticos
 * (NFD) e de toda pontuação, colapsando espaços. Determinística e pura.
 *
 * @example
 *   normalizeFactText("Inferência, (c/d) & Motor!") // => "inferencia c d motor"
 */
export function normalizeFactText(fact: string): string {
  if (typeof fact !== "string") return "";
  return fact
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokeniza um fato normalizado em um conjunto de termos (sem repetição). */
export function tokenizeFact(fact: string): Set<string> {
  const normalized = normalizeFactText(fact);
  if (!normalized) return new Set<string>();
  return new Set(normalized.split(" ").filter((t) => t.length > 0));
}

/**
 * Similaridade de Jaccard entre dois conjuntos de tokens:
 * `|A ∩ B| / |A ∪ B|`, em `[0, 1]`. Conjuntos vazios ⇒ 0.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class DreamsDB {
  // DEF-10: limites de reforço — eventos triviais repetitivos (ex.: session.idle)
  // não podem inflar score/confirmations indefinidamente.
  static readonly MAX_CONFIRMATIONS = 10;
  static readonly MAX_SCORE = 5.0;

  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(os.homedir(), ".config/opencode/dreams/dreams.db");
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(finalPath);
    this.init();
  }

  private init() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT NOT NULL,
        score REAL DEFAULT 1.0,
        decay_weight REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0,
        confirmations INTEGER DEFAULT 1,
        last_reinforced TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureFtsTable();

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;
    `);
  }

  /**
   * TICKET-DREAMS-03 (Frente A) — Tokenizer com folding de diacríticos.
   *
   * Cria `memories_fts` com `tokenize='unicode61 remove_diacritics 2'`, de modo
   * que "inferência" e "inferencia" (com/sem acento) tokenizem para a MESMA
   * representação e casem de forma idêntica tanto no índice quanto na query.
   *
   * Migração idempotente: um DB pré-existente criado sem `remove_diacritics`
   * mantém o DDL antigo no `sqlite_master` (o `CREATE VIRTUAL TABLE IF NOT
   * EXISTS` nunca o alteraria). Detectamos essa configuração legada e
   * reconstruímos a tabela virtual + `rebuild` do índice a partir do conteúdo
   * de `memories` (a FTS é derivada; nenhum dado de memória é perdido).
   */
  private ensureFtsTable() {
    const existing = this.db.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
    ).get();

    const legacyTokenizer =
      !!existing?.sql && !/remove_diacritics/i.test(existing.sql);

    if (legacyTokenizer) {
      this.db.exec("DROP TABLE IF EXISTS memories_fts;");
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact,
        category,
        content='memories',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    if (legacyTokenizer) {
      // Repopula o índice externo a partir da tabela de conteúdo.
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
    }
  }

  /**
   * Insere (ou reforça) uma memória com deduplicação semântica e hierarquia
   * cross-scope (TICKET-DREAMS-04, Frente 4A).
   *
   * Ordem de decisão:
   *  1. Dedup EXATO no MESMO escopo (comportamento histórico, DEF-10).
   *  2. Dedup SEMÂNTICO no MESMO escopo (FTS5 + Jaccard ≥ `FACT_SIMILARITY_THRESHOLD`).
   *  3. Promoção Persona ➔ Coletivo: um fato inserido em `collective` que já
   *     existe em `agent:<nome>` é PROMOVIDO para `collective` (herdando score
   *     e confirmações acumulados) e as cópias individuais equivalentes são
   *     removidas — evita que o agente receba a mesma memória duas vezes.
   *  4. Herança Coletivo ➔ Persona: uma inserção direcionada a `agent:<nome>`
   *     cujo fato equivalente já está em `collective` reforça o registro
   *     coletivo (confirmations + 1, last_reinforced = now) sem criar cópia.
   *  5. Nenhum equivalente → novo registro.
   *
   * `options.reinforce === false` (eventos triviais de ciclo de vida, DEF-10)
   * desliga a inflação de score/confirmations, mas NUNCA cria clones: a
   * deduplicação (exata, semântica e cross-scope) continua valendo.
   */
  public insertMemory(
    scope: string,
    fact: string,
    category: MemoryCategory,
    // TICKET-DREAMS-03B: defaults canônicos por categoria quando o chamador não
    // fornece score/decay_weight (ex.: remSleep insere só com os 3 primeiros).
    score: number = CATEGORY_WEIGHTS[category]?.base_weight ?? 1.0,
    decay_weight: number = CATEGORY_WEIGHTS[category]?.decay_weight ?? 1.0,
    options: { reinforce?: boolean } = {}
  ): number {
    // DEFESA EM PROFUNDIDADE (TICKET-DREAMS-06): mesmo que o chamador
    // (tool `dream_learn`, remSleep, etc.) já tenha redigido, o seam de
    // persistência reaplica `redactSecrets` de forma idempotente. Garante que
    // NENHUM credencial (sk-, AIza, Bearer, JWT, password=...) alcance o
    // SQLite, independentemente do caminho de chamada.
    const sanitizedFact = redactSecrets(fact);
    const now = new Date().toISOString();
    const shouldReinforce = options.reinforce !== false;

    // 1. Duplicata EXATA no mesmo escopo (comportamento histórico).
    const existing = this.db.query<MemoryRecord, [string, string]>(
      "SELECT * FROM memories WHERE scope = ? AND fact = ?"
    ).get(scope, sanitizedFact);

    if (existing && existing.id) {
      // DEF-10: reforço opcional e SEMPRE limitado. `reinforce: false`
      // (eventos triviais de ciclo de vida) mantém o registro intacto.
      if (shouldReinforce) {
        this.reinforceMemory(existing, now);
      }
      // Promoção: o mesmo fato já no coletivo torna a cópia de persona obsoleta.
      if (scope === "collective") {
        this.removeSimilarPersonas(sanitizedFact);
      }
      return existing.id;
    }

    // 2. Duplicata SEMÂNTICA no mesmo escopo (FTS5 + Jaccard).
    const semanticSameScope = this.findSimilarMemory(sanitizedFact, { scope });
    if (semanticSameScope && semanticSameScope.id) {
      if (shouldReinforce) {
        this.reinforceMemory(semanticSameScope, now);
      }
      if (scope === "collective") {
        this.removeSimilarPersonas(sanitizedFact);
      }
      return semanticSameScope.id;
    }

    // 3. Hierarquia cross-scope.
    if (scope === "collective") {
      // 3a. Promoção Persona ➔ Coletivo.
      const personaMatches = this.findSimilarPersonas(sanitizedFact);
      const promoted = personaMatches[0];
      if (promoted && typeof promoted.id === "number") {
        const promotedId = promoted.id;
        // Promove o registro individual para 'collective' herdando, sem
        // reinventar, o score e as confirmações já acumulados.
        this.db.run("UPDATE memories SET scope = 'collective' WHERE id = ?", [promotedId]);
        // TICKET-DREAMS-07B: a promoção Persona ➔ Coletivo também CONFIRMA a
        // memória — incrementa `confirmations + 1` (teto MAX_CONFIRMATIONS),
        // aplica o bônus de score (+0.5, teto MAX_SCORE) e atualiza
        // `last_reinforced = now`, respeitando `reinforce: false`.
        if (shouldReinforce) {
          this.reinforceMemory(promoted, now);
        }
        // Arranca as demais cópias equivalentes (evita dupla injeção no prompt).
        for (const dup of personaMatches.slice(1)) {
          if (typeof dup.id === "number") this.deleteMemory(dup.id);
        }
        return promotedId;
      }
    } else if (scope.startsWith("agent:")) {
      // 3b. Herança Coletivo ➔ Persona: reforça o coletivo, não clona.
      const collectiveEquivalent = this.findSimilarMemory(sanitizedFact, { scope: "collective" });
      if (collectiveEquivalent && collectiveEquivalent.id) {
        if (shouldReinforce) {
          this.reinforceMemory(collectiveEquivalent, now);
        }
        return collectiveEquivalent.id;
      }
    }

    // 4. Nenhum equivalente — cria um novo registro.
    const query = this.db.query(
      `INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`
    );
    const result = query.run(scope, sanitizedFact, category, score, decay_weight, now, now);
    return Number(result.lastInsertRowid);
  }

  /**
   * Reforço limitado e canônico (DEF-10): `confirmations + 1` (teto
   * `MAX_CONFIRMATIONS`), `score + 0.5` (teto `MAX_SCORE`) e
   * `last_reinforced = now`.
   */
  private reinforceMemory(existing: MemoryRecord, now: string): void {
    if (typeof existing.id !== "number") return;
    const confirmations = Math.min(existing.confirmations + 1, DreamsDB.MAX_CONFIRMATIONS);
    const nextScore = Math.min(existing.score + 0.5, DreamsDB.MAX_SCORE);
    this.db.run(
      "UPDATE memories SET score = ?, confirmations = ?, last_reinforced = ? WHERE id = ?",
      [nextScore, confirmations, now, existing.id]
    );
  }

  /**
   * Busca o registro mais similar a `fact` dentro de um escopo EXATO via FTS5
   * (OR dos tokens) + Jaccard ≥ `FACT_SIMILARITY_THRESHOLD`.
   *
   * A query FTS5 é montada com OR de termos entre aspas — nunca com os
   * operadores do usuário — e o filtro fino de similaridade é aplicado em JS
   * sobre os candidatos retornados. Devolve `null` se não houver equivalente.
   */
  private findSimilarMemory(fact: string, options: { scope?: string } = {}): MemoryRecord | null {
    const target = tokenizeFact(fact);
    if (target.size === 0) return null;

    const ftsQuery = this.buildOrFtsQuery(target);
    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.id = f.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: any[] = [ftsQuery];

    if (options.scope) {
      sql += " AND m.scope = ?";
      params.push(options.scope);
    }
    sql += " LIMIT 200";

    const candidates = this.db.query<MemoryRecord, any[]>(sql).all(...params);

    let best: MemoryRecord | null = null;
    let bestSimilarity = 0;
    for (const candidate of candidates) {
      const similarity = jaccardSimilarity(target, tokenizeFact(candidate.fact));
      if (similarity >= FACT_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        best = candidate;
        bestSimilarity = similarity;
      }
    }
    return best;
  }

  /**
   * Todos os registros de persona (`agent:*`) semanticamente equivalentes a
   * `fact`, ordenados por score (e confirmações) decrescentes — o primeiro é o
   * candidato natural à promoção para `collective`.
   */
  private findSimilarPersonas(fact: string): MemoryRecord[] {
    const target = tokenizeFact(fact);
    if (target.size === 0) return [];

    const ftsQuery = this.buildOrFtsQuery(target);
    const candidates = this.db.query<MemoryRecord, any[]>(
      `SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.scope LIKE 'agent:%'
       LIMIT 200`
    ).all(ftsQuery);

    return candidates
      .filter((c) => jaccardSimilarity(target, tokenizeFact(c.fact)) >= FACT_SIMILARITY_THRESHOLD)
      .sort(
        (a, b) =>
          (b.score ?? 0) - (a.score ?? 0) ||
          (b.confirmations ?? 0) - (a.confirmations ?? 0)
      );
  }

  /** Remove as cópias de persona equivalentes a `fact`; devolve os ids removidos. */
  private removeSimilarPersonas(fact: string): number[] {
    const duplicates = this.findSimilarPersonas(fact);
    const removed: number[] = [];
    for (const dup of duplicates) {
      if (dup.id) {
        this.deleteMemory(dup.id);
        removed.push(dup.id);
      }
    }
    return removed;
  }

  /** Constrói uma query FTS5 literal (`"tok" OR "tok" ...`) a partir de tokens. */
  private buildOrFtsQuery(tokens: Set<string>): string {
    return [...tokens].map((token) => `"${token}"`).join(" OR ");
  }

  public recall(queryText: string, scope?: string, category?: string, limit: number = 5): MemoryRecord[] {
    // TICKET-DREAMS-03 (Frente A): higieniza a query ANTES do MATCH FTS5.
    // Identificadores como 'agent:developer' ou hífens ('ensemble-room') seriam
    // interpretados como operador de coluna/negação pelo FTS5 e lançariam erro
    // de sintaxe, forçando (ou piorando) o fallback. O sanitizador converte a
    // query crua em termos literais e seguros.
    const ftsQuery = sanitizeFts5Query(queryText);

    // Sem tokens aproveitáveis não há o que casar no FTS5 (MATCH '' é inválido);
    // segue direto para o fallback LIKE, preservando o comportamento histórico.
    if (ftsQuery) {
      let sql = `
        SELECT m.* FROM memories m
        JOIN memories_fts f ON m.id = f.rowid
        WHERE memories_fts MATCH ?
      `;
      const params: any[] = [ftsQuery];

      if (scope) {
        sql += " AND m.scope = ?";
        params.push(scope);
      }
      if (category) {
        sql += " AND m.category = ?";
        params.push(category);
      }

      sql += " ORDER BY rank, m.score DESC LIMIT ?";
      params.push(limit);

      try {
        const records = this.db.query<MemoryRecord, any[]>(sql).all(...params);
        return this.touchRecall(records);
      } catch {
        // Fallback para LIKE se, ainda assim, a query FTS for rejeitada.
      }
    }

    return this.likeRecall(queryText, scope, category, limit);
  }

  /**
   * Fallback resiliente: busca literal por substring via LIKE. Acionado quando
   * a query sanitizada não produz tokens válidos ou quando o MATCH FTS5 falha.
   */
  private likeRecall(queryText: string, scope?: string, category?: string, limit: number = 5): MemoryRecord[] {
    let fallbackSql = "SELECT * FROM memories WHERE fact LIKE ?";
    const fallbackParams: any[] = [`%${queryText}%`];
    if (scope) {
      fallbackSql += " AND scope = ?";
      fallbackParams.push(scope);
    }
    if (category) {
      fallbackSql += " AND category = ?";
      fallbackParams.push(category);
    }
    fallbackSql += " ORDER BY score DESC LIMIT ?";
    fallbackParams.push(limit);
    const records = this.db.query<MemoryRecord, any[]>(fallbackSql).all(...fallbackParams);
    return this.touchRecall(records);
  }

  /** Incrementa recall_count e atualiza last_reinforced das memórias retornadas. */
  private touchRecall(records: MemoryRecord[]): MemoryRecord[] {
    const now = new Date().toISOString();
    for (const rec of records) {
      if (rec.id) {
        this.db.run(
          "UPDATE memories SET recall_count = recall_count + 1, last_reinforced = ? WHERE id = ?",
          [now, rec.id]
        );
        rec.recall_count = (rec.recall_count || 0) + 1;
        rec.last_reinforced = now;
      }
    }
    return records;
  }

  public getMemoriesByScope(scope: string, limit: number = 5): MemoryRecord[] {
    return this.db.query<MemoryRecord, [string, number]>(
      "SELECT * FROM memories WHERE scope = ? ORDER BY score DESC, last_reinforced DESC LIMIT ?"
    ).all(scope, limit);
  }

  public getAllMemories(): MemoryRecord[] {
    return this.db.query<MemoryRecord, []>("SELECT * FROM memories").all();
  }

  public updateMemoryScore(id: number, score: number) {
    this.db.run("UPDATE memories SET score = ? WHERE id = ?", [score, id]);
  }

  public deleteMemory(id: number) {
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
  }

  /**
   * TICKET-DREAMS-04 (Frente 4A) — Listagem para curadoria manual.
   *
   * Complementa `deleteMemory(id)` (poda cirúrgica por id) e
   * `getMemoriesByScope(scope, limit)` (top-N de um escopo). Aqui a listagem é
   * filtrável por escopo E categoria, sem limite obrigatório, ordenada por
   * `score DESC, last_reinforced DESC` — formato natural para inspeção/curation.
   *
   * Todos os filtros são parametrizados (`?`), jamais interpolados.
   */
  public listMemories(
    options: { scope?: string; category?: MemoryCategory; limit?: number } = {}
  ): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const clauses: string[] = [];
    const params: any[] = [];

    if (options.scope) {
      clauses.push("scope = ?");
      params.push(options.scope);
    }
    if (options.category) {
      clauses.push("category = ?");
      params.push(options.category);
    }
    if (clauses.length > 0) {
      sql += " WHERE " + clauses.join(" AND ");
    }

    sql += " ORDER BY score DESC, last_reinforced DESC";

    if (typeof options.limit === "number" && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    return this.db.query<MemoryRecord, any[]>(sql).all(...params);
  }

  public close() {
    this.db.close();
  }
}

/**
 * TICKET-DREAMS-03 (Frente A) — Sanitizador de query para SQLite FTS5.
 *
 * O dialeto MATCH do FTS5 interpreta muitos caracteres como sintaxe: `:` (filtro
 * de coluna, ex.: `agent:developer`), `-` (negação, ex.: `ensemble-room`), `*`
 * (prefixo), `"` (frase), `AND/OR/NOT`, parênteses, `^`, `.`, etc. Identificadores
 * legítimos de memória — escopos `agent:<nome>`, nomes com hífen como
 * `ensemble-room` ou `open-tool` — disparam `fts5: syntax error` e derrubam a
 * busca no fallback LIKE.
 *
 * Estratégia: extrai apenas os tokens alfanuméricos Unicode (`\p{L}`/`\p{N}`),
 * descartando toda a pontuação/operadores, e reconstrói a query como uma
 * conjunção implícita (AND) de termos literais entre aspas duplas. As aspas
 * garantem que cada termo seja tratado como string literal — nunca como
 * operador ou nome de coluna — e o tokenizer `unicode61 remove_diacritics 2`
 * cuida da equivalência acento/no-acento. Query sem tokens aproveitáveis
 * retorna `""`; o chamador (`recall`) então recorre ao fallback LIKE.
 *
 * @example
 *   sanitizeFts5Query("agent:developer")   // => '"agent" "developer"'
 *   sanitizeFts5Query("ensemble-room") // => '"ensemble" "room"'
 *   sanitizeFts5Query('AST "parser"')  // => '"AST" "parser"'
 *   sanitizeFts5Query("(c/d) * &")     // => '"c" "d"'
 *   sanitizeFts5Query("***")           // => ''
 */
export function sanitizeFts5Query(query: string): string {
  if (!query || typeof query !== "string") return "";
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}
