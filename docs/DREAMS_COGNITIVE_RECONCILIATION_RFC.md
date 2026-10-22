# RFC: Reconciliação Cognitiva em Duas Etapas para o Dreams (Sono REM)
> **Autoridade:** Fundadora e Engenheira **Maiteux Zanela**  
> **Arquiteto:** Orquestrador de Runtime & Sistemas (Lead)  
> **Status:** 📐 Proposta Técnica Formalizada (RFC & Diretrizes Canônicas)  
> **Data:** 21 de Outubro de 2026  
> **Módulo-Alvo:** `opencode-plugin-dreams` (`src/core/sleep_cycle.ts`, `src/core/db.ts`, `src/core/mimo_synthesizer.ts`)

---

## 1. Contexto e Motivação do Problema

O ecossistema **Dreams Memory Core** acumulou **mais de 960 memórias em menos de 20 dias de operação**, com o Sono REM gerando entre 30 e 160 novas memórias em uma única madrugada. 

Uma auditoria empírica realizada em 21/10/2026 revelou duas falhas estruturais críticas no ciclo de consolidação:
1. **Taxa Nula de Reforço Noturno (0,0%):** De todas as memórias registradas por agentes em vigília (`dream_learn`), nenhuma recebeu reforço real no sono noturno.
2. **A Barreira Estática do Jaccard 80%:** O corte de similaridade léxica fixado em `0.80` no `DreamsDB.insertMemory` é matematicamente inalcançável para redações humanas vs. saídas de modelos de linguagem (a maior similaridade observada entre paráfrases reais foi de 70%).
3. **Hiper-Inflação de Entropia e Amnésia de Longo Prazo:** Por não consolidar nem podar ativamente, o Sono REM sintetiza paráfrases ligeiramente diferentes de regras existentes e as insere como novas entradas (`confirmations: 1`). Essas memórias recentes empurram decisões fundacionais de arquitetura e preferências da Fundadora para fora do Top 20 injetado nos agentes.

---

## 2. A Solução: Pipeline de Reconciliação Cognitiva em Duas Etapas

Em vez de depender de limiares matemáticos rígidos de Jaccard ou de sobrecarregar o LLM com dezenas de milhares de comparações cegas, adota-se um **filtro de atenção léxico barato em CPU combinado com julgamento neural semântico**.

```
[ Nova Memória Destilada no REM ]
              │
              ▼
   ┌────────────────────────────────────────────────────────┐
   │ ETAPA 1: Filtro de Atenção Léxico (CPU Rápida)         │
   │ Varredura FTS5 + Jaccard de Tokens                     │
   │ Limiar de Atenção: Jaccard ≥ 15% (sem stopword filter) │
   └────────────────────────────────────────────────────────┘
              │
      ┌───────┴────────────────────────┐
      │ Jaccard < 15%                  │ Jaccard ≥ 15% (Candidatos Correlacionados)
      ▼                                ▼
┌──────────────────────┐      ┌─────────────────────────────────────────────────────┐
│ INSERÇÃO DIRETA      │      │ ETAPA 2: Julgamento Neural Cognitivo (Mimo 2.6/LLM) │
│ (Fato novo sem       │      │ Classificação em lote (15-20 pares por prompt)      │
│  concorrência)       │      │ Escolha entre as 4 Ações Canônicas                  │
└──────────────────────┘      └─────────────────────────────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┬──────────────────────┐
              ▼                        ▼                        ▼                      ▼
        [ REINFORCE ]            [ SUPERSEDE ]              [ MERGE ]            [ INDEPENDENT ]
```

---

## 3. O Filtro de Atenção (Etapa 1 — CPU)

A fórmula de Jaccard opera puramente como **funil de triagem** para a IA:
$$J(A, B) = \frac{|A \cap B|}{|A \cup B|}$$

* **Normalização:** Conversão para minúsculas, remoção de acentos/diacríticos e pontuações, tokenização por whitespace.
* **Stopwords Preservadas:** A remoção de conectivos é dispensada por determinação da Fundadora, garantindo fidelidade de contexto na sintaxe em linguagem natural.
* **Calibração do Limiar de Corte:**
  * $\ge 20\%$: Captura apenas paráfrases diretas e contradições fortes (736 pares no banco).
  * $\ge 18\%$: Captura expansões de governança e lições multi-agente (1.148 pares no banco).
  * $\ge 15\%$: **Ponto ótimo de sensibilidade.** Captura nuances arquiteturais complementares, diferenças assimétricas de extensão de texto e edge cases de runtime (3.219 pares no banco).

---

## 4. O Catálogo das Quatro Ações Fundamentais (Etapa 2 — LLM)

Quando um par de memórias atinge $J(A, B) \ge 15\%$, o modelo neural (Mimo 2.6 Flash / cascata de resiliência) deve analisar o par e executar **obrigatoriamente uma das 4 ações**:

### A. REINFORCE (Reforço / Absorção)
* **Gatilho:** Ambas as memórias expressam rigorosamente a **mesma ideia ou lição**, apenas com redação, extensão ou sinônimos diferentes.
* **Mecânica no Banco:**
  * O registro canônico mais antigo/preciso tem suas confirmações incrementadas (`confirmations + 1`, teto 10).
  * Aplica-se o bônus de pontuação (`score + 0.5`, teto 5.0).
  * Atualiza-se `last_reinforced = now`.
  * A nova memória ou paráfrase redundante é descartada/absorvida sem criar duplicata.
* **Exemplo Real:**
  * *Memória A (ID 646):* "Constantes de caminho resolvidas no boot de módulos de autenticação vazam credenciais reais..."
  * *Memória B (ID 672):* "Constantes de caminho avaliadas no import-time vazam diretórios do host em testes..."
  * *Ação:* `REINFORCE`. Apenas uma entrada sobrevive, com score elevado.

### B. SUPERSEDE (Substituição / Revogação Temporal)
* **Gatilho:** As memórias representam **ideias contraditórias**, atualização de diretriz ou **revogação explícita de uma regra anterior** pela Fundadora.
* **Mecânica no Banco:**
  * A memória antiga/revogada é imediatamente deletada da tabela ativa (`DELETE FROM memories WHERE id = target_id`) ou movida para arquivamento histórico.
  * A nova memória assume a titularidade no banco com os pesos da categoria e data atual.
* **Exemplo Real:**
  * *Memória A (ID 456):* "...Diana com cadeia: 1º Argon -> 2º opencode-go/glm-5.3-flash -> 3º Gemini 3.8..."
  * *Memória B (ID 823):* "...A cadeia canônica da Diana no teste deve refletir estritamente a política sem GLM..."
  * *Ação:* `SUPERSEDE` (B revoga A). A memória A (que permitia GLM) é expurgada; a memória B prevalece.

### C. MERGE (Fusão Complementar / Síntese)
* **Gatilho:** As memórias tratam do **mesmo componente, ticket ou subsistema**, mas trazem **lições e descobertas distintas que se complementam**. Manter separadas dispersa o conhecimento; apagar uma perderia detalhes técnicos vitais.
* **Mecânica no Banco:**
  * O LLM sintetiza uma **declaração única e unificada** que agrega os detalhes de ambas (`merged_fact`).
  * **Pontuação com Bônus de Reforço:** Como a memória nova do dia confirma e aprofunda o tema existente, ela sofre reforço além da alteração. Portanto, herda o maior score acrescido do bônus canônico de reforço:  
    `score = min(5.0, max(score_A, score_B) + 0.5)`
  * **Confirmações:** `confirmations = min(10, max(conf_A, conf_B) + 1)`.
  * A data `last_reinforced` é atualizada para o momento da fusão (`CURRENT_TIMESTAMP`).
  * O ID alvo (`target_id`) é atualizado com o texto fundido e os novos valores, e o ID absorvido (`absorbed_id`) é removido da tabela ativa.
* **Exemplo Real:**
  * *Memória A (ID 356, Jaccard 18.4%):* "TICKET-HARNESS-26 estabelece a esteira de entrega em dois portões: Portão 1 commit local nativo automático; Portão 2 reserva o git push à revisão cega da Diana..."
  * *Memória B (ID 802):* "Evolução dos Dois Portões: agent_quality_guard transferido para a Clara no Portão 1; Diana elevada a QM Global de Produto e Lançamento no Portão 2..."
  * *Ação:* `MERGE`. Funde ambas em uma regra canônica e completa dos Dois Portões, preservando o score máximo.

### D. INDEPENDENT (Adição / Manutenção Independente)
* **Gatilho:** Falso-alarme do filtro de Jaccard. As memórias compartilharam vocabulário técnico comum (ex: `opencode`, `plugin`, `modelo`, `commit`), mas tratam de **fatos, módulos ou problemas completamente independentes**.
* **Mecânica no Banco:**
  * Ambas as memórias são mantidas vivas e independentes.
  * A nova memória é inserida normalmente no SQLite sem alterar a pré-existente.
* **Exemplo Real:**
  * *Memória A (ID 651):* "Verificação de AST para eval perigoso deve restringir-se a chamadas globais..."
  * *Memória B (ID 871):* "Para testes herméticos de migração de banco sem dependência do host..."
  * *Ação:* `INDEPENDENT`. Nenhuma fusão ou alteração.

---

## 5. Contrato Estruturado de Saída para o Sono REM

O subprocesso de reconciliação noturna no `mimo_synthesizer.ts` / `sleep_cycle.ts` passará a consumir os lotes de pares correlacionados e devolver o seguinte schema JSON estrito:

```json
[
  {
    "action": "reinforce",
    "existing_id": 646,
    "candidate_id": 672,
    "reason": "Paráfrase exata da regra de vazamento de constantes de caminho no boot."
  },
  {
    "action": "supersede",
    "superseded_id": 456,
    "keeper_id": 823,
    "reason": "A proibição de GLM revoga a cadeia antiga da Diana que continha o modelo GLM."
  },
  {
    "action": "merge",
    "target_id": 356,
    "absorbed_id": 802,
    "merged_fact": "Arquitetura canônica dos Dois Portões de Qualidade (TICKET-HARNESS-26): o Portão 1 é operado pela Clara via agent_quality_guard com commit local nativo automático; o Portão 2 é reservado à Diana como Quality Manager de Produto para autorização do git push em lote.",
    "reason": "Memórias complementares detalhando a divisão operacional e a governança dos Dois Portões."
  },
  {
    "action": "independent",
    "existing_id": 651,
    "candidate_id": 871,
    "reason": "Fatos desconexos (AST eval vs migração hermética de SQLite)."
  }
]
```

---

## 6. Projeção de Benefícios para o Ecossistema

1. **Estabilização da Entropia:** O banco de memórias deixa de inflar centenas de registros por semana, reduzindo o acervo para um conjunto denso e altamente relevante.
2. **Imunidade à Perda do Top 20:** Conhecimentos estáveis recebem reforços e fusões contínuas, mantendo seu score elevado e assegurando sua injeção prioritária no contexto dos agentes.
3. **Resolução Definitiva de Regras Obsoletas:** Fim do conflito de diretrizes antigas e novas competindo no system prompt.
4. **Eficiência FinOps Extrema:** O Jaccard elimina 95% do volume desnecessário em CPU antes que qualquer token seja enviado ao LLM, operando confortavelmente na cota gratuita de modelos como Mimo 2.6 Flash.
