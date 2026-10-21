# Changelog

Todas as mudanças relevantes do pacote `agent-dreams` são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

O contrato de runtime do pacote é **Bun** (`engines.bun >= 1.1.0`): o código
consome `bun:sqlite` e é distribuído com as fontes TypeScript executadas
nativamente pelo Bun.

---

## [Não publicado]

> **Nota de versionamento (verificada no registry em 2026-10-21).** O identificador
> `1.0.2` **já está ocupado** no registry npm por um *stage build* publicado em
> 2026-10-19T17:30:52Z (37 arquivos, incluindo a suíte interna `tests/`).
> O registry não aceita republicação do mesmo identificador: o corte de release do
> conjunto de mudanças abaixo exige **bump para `1.0.3`** (ou despublicação prévia
> de `1.0.2`). O `package.json` deste repositório está em `1.0.2` e o workflow de
> publicação (`publish.yml`) bloqueia releases cujo *tag* não coincida com a versão
> declarada — o bump deve ser feito de forma coordenada entre `package.json`, *tag*
> de release e `CHANGELOG.md`.

---

## [1.0.2] — 2026-10-21

Corte de release focado em **empacotamento**, **contrato de runtime**, **portabilidade
de sistema** e **cadeia de suprimentos**. Nenhuma alteração de schema de dados ou de
comportamento do ciclo cognitivo.

### Distribuição e empacotamento (npm)

- **Adicionado** — permissões POSIX estritas (`0o700` no diretório e `0o600` nos arquivos SQLite `dreams.db`, `-wal` e `-shm`) e isolamento de lockfile seguro.
- **Adicionado** — esteira determinística de migrações via `PRAGMA user_version` em `src/core/db.ts` e validação preventiva de compatibilidade em `src/core/session_reader.ts`.
- **Adicionado** — campo `files` no `package.json`, restringindo o conteúdo publicado a
  `bin/`, `src/`, `systemd/`, `scripts/`, `README.md` e `LICENSE`. A suíte interna de
  testes, os fixtures e os workflows de CI **não** são mais distribuídos.
- **Adicionado** — campo `engines.bun: ">=1.1.0"`, declarando formalmente o contrato de
  runtime (antes implícito apenas pelo shebang `#!/usr/bin/env bun`).
- **Adicionado** — `LICENSE` (MIT, Copyright (c) 2026 Maiteux Zanela) versionado na raiz.
  O campo `license: "MIT"` do manifesto passa a ter o arquivo físico correspondente.
- **Adicionado** — `.npmignore` como defesa em profundidade para o campo `files`
  (exclui `tests/`, `.github/`, artefatos de runtime local: `*.log`, `*.db`, `*.db-wal`,
  `*.db-shm`).
- **Removido** — `bin/dreams-mcp.js`, duplicata morta do executável (diferia apenas no
  prefixo das mensagens de log). `agent-dreams` e `dreams-mcp` passam a mapear para o
  **mesmo** arquivo, `./bin/agent-dreams.js`.
- **Impacto medido no tarball** (verificado com `npm pack --dry-run` contra o tarball
  publicado): de **37 para 18 arquivos**; de **559.182 para 221.820 bytes**
  descompactados (**−60 %**); **19 arquivos** de `tests/` deixam de vazar para o
  registry; `LICENSE` e as *units* `systemd/` passam a ser distribuídos.

### Contrato de runtime (`bunx`)

- **Alterado** — o comando canônico de execução do servidor MCP passa a ser
  **`bunx agent-dreams`**. `dreams-mcp` permanece como alias legado do mesmo
  executável, preservando compatibilidade com configurações MCP existentes.
- **Corrigido** — toda orientação obsoleta de `npx -y agent-dreams` / `npx agent-dreams`
  no `README.md` (Claude Desktop, Cursor, Windsurf e seção dual-entrypoint) foi
  substituída por `bunx agent-dreams`. A promessa do README agora corresponde ao
  comportamento real do pacote.
- **Documentado** — suporte explícito a **Bun** e não-suporte a Node.js puro: o pacote
  depende de `bun:sqlite` e é distribuído com fontes TypeScript que o Bun executa
  nativamente. Executar via `npx` resultava em falha de módulo/SyntaxError.

### Portabilidade dos scripts de sistema (systemd)

- **Adicionado** — *units* versionadas no repositório: `systemd/agent-dreams.service` e
  `systemd/agent-dreams.timer`, com nomenclatura canônica `agent-dreams` (o nome
  legado `opencode-dreams` foi eliminado). O *timer* agenda o ciclo diário às
  `03:30` com `Persistent=true`; o serviço roda com `NoNewPrivileges=true` e
  `DREAMS_NONINTERACTIVE=1`.
- **Adicionado** — *placeholder* `__AGENT_DREAMS_DIR__` nas *units*, substituído na
  instalação pelo diretório real do pacote: nenhum caminho absoluto fica fixado no
  artefato distribuído.
- **Corrigido** — `bin/dreams-consolidate.sh` deixa de fixar caminhos absolutos da
  máquina de desenvolvimento: o diretório de instalação é resolvido dinamicamente a
  partir da localização do próprio script, permitindo execução por qualquer usuário e
  a partir de qualquer prefixo. *Overrides* explícitos (`DREAMS_PLUGIN_DIR`,
  `DREAMS_CLI_PATH`, `DREAMS_LOG_FILE`, `DREAMS_LOCK_FILE`) cobrem instalações
  atípicas.
- **Corrigido** — caminhos de estado passam a respeitar o padrão **XDG**
  (`$XDG_STATE_HOME` para o log, `$XDG_RUNTIME_DIR` para o *lock*), em vez de
  posições fixas no `$HOME` ou em `/tmp` compartilhado entre usuários.
- **Corrigido** — a checagem de conectividade deixa de depender de **ICMP**
  (`ping 1.1.1.1` / `8.8.8.8`, com espera de até 60 s), que falha em redes corporativas
  que bloqueiam ICMP e vaza telemetria de rede. O wrapper passa a usar uma sonda HTTP
  de curta duração (`curl` → `wget`, *timeout* de 3 s, *fallback* `1.1.1.1` →
  `8.8.8.8`), com comportamento *fail-open* quando não há cliente HTTP disponível — o
  próprio REM Sleep decide, devolvendo `EX_TEMPFAIL` (75) se a IA for inalcançável.
- **Corrigido** — `bin/enable-systemd.sh` passa a instalar e habilitar as *units*
  versionadas em `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`, com substituição do
  *placeholder* pelo diretório real de instalação, permitindo a instalação limpa fora
  da máquina de origem.
- **Alterado** — renomeações canônicas de resíduos do nome legado
  (`opencode-plugin-dreams` / `opencode-dreams`): log do ciclo
  `~/.local/state/opencode-dreams.log` → `~/.local/state/agent-dreams.log`; *lock*
  `/tmp/opencode-dreams.lock` → `${XDG_RUNTIME_DIR:-/tmp}/agent-dreams.lock`; título do
  alerta desktop `OpenCode Dreams` → `Agent Dreams`.
- **Adicionado** — *overrides* de ambiente para operação em instalações atípicas:
  `DREAMS_PLUGIN_DIR`, `DREAMS_CLI_PATH`, `DREAMS_LOG_FILE`, `DREAMS_LOCK_FILE` e o
  orçamento de tolerância a boot `DREAMS_NET_MAX_ATTEMPTS` (padrão `20`) /
  `DREAMS_NET_RETRY_DELAY` (padrão `3` s).

### Segurança

- **Mantido e endurecido** — a redação determinística de segredos (`redactSecrets`) é
  aplicada em três costuras de defesa em profundidade: (1) antes do envio do diálogo a
  um modelo externo, (2) antes da persistência no log JSONL diário, (3) na inserção no
  SQLite. A função é *fail-safe* (nunca lança) e idempotente.
- **Cobertura de padrões** — chaves OpenAI (`sk-…`), Google (`AIza…`), GitHub
  (`gh[pousr]_…`, `github_pat_…`), tokens `Bearer`, JWT (`eyJ….….…`) e atribuições
  genéricas do tipo `chave=valor`.
- **Mantido** — proteção contra execuções concorrentes do ciclo de consolidação por
  *lock* exclusivo (`flock -n`), com liberação do descritor e remoção de temporários em
  qualquer encerramento (saída normal, `SIGINT`, `SIGTERM`, `SIGHUP`). O arquivo de
  *lock* passa a residir em `$XDG_RUNTIME_DIR` (escopo por usuário), com *fallback*
  para `/tmp`, evitando colisões entre usuários da mesma máquina.
- **Mantido** — a síntese REM nunca grava dados fabricados: sem modelo de IA
  disponível, ou em modo `DREAMS_OFFLINE=1`, o desfecho é um erro explícito com o
  *handoff* (`dialogue_pending.txt`) preservado no disco para reprocessamento.

### CI/CD e cadeia de suprimentos

- **Adicionado** — `.github/workflows/ci.yml`: esteira hermética disparada em `push`
  (branches `main`/`master`) e `pull_request`, com as etapas
  `bun install --frozen-lockfile` → `bun run typecheck` → `DREAMS_OFFLINE=1 bun test` →
  `npm pack --dry-run`.
- **Adicionado** — **guarda de integridade do tarball**, executada em **ambos os
  caminhos de publicação**: no `ci.yml` (push/PR) e no `publish.yml` (release). A
  publicação é abortada se qualquer artefato de teste, fixture, workflow de CI ou
  arquivo de runtime local (`*.log`, `*.db`, `*.db-wal`, `*.db-shm`) estiver presente no
  pacote, ou se o tarball sair vazio. O gate de release não depende do `ci.yml`:
  `push.branches` não casa *pushes* de *tag*, de modo que a checagem está no próprio
  workflow que publica.
- **Adicionado** — `actions/setup-node@v4` nos dois workflows: o runtime da guarda
  (`node -e`) passa a ser declarado explicitamente, sem depender do Node ambiente da
  imagem do runner.
- **Alterado** — versão do Bun **travada** em `1.4.2` nos dois workflows (antes
  `bun-version: latest`), alinhada ao ambiente de homologação e às definições de tipo
  `bun-types`/`@types/bun` `^1.4.2`. O pin é a fonte única da verdade do runtime de CI.
- **Corrigido** — a suíte determinística passa a rodar em modo **offline**
  (`DREAMS_OFFLINE=1`) no pipeline, eliminando tentativas espúrias de conexão a
  provedores de IA externos durante CI e release.
- **Alterado** — `.github/workflows/publish.yml` publica com
  `npm publish --access public --provenance`, gerando o atestado de proveniência
  verificável no registry (requer a permissão `id-token: write`, já configurada).
- **Adicionado** — verificação de coerência entre o *tag* da release e a versão
  declarada no `package.json` antes da publicação (ignora *tags* que não sejam semver
  puro, para não bloquear convenções de *tag* alternativas).

### Documentação

- **Adicionado** — este `CHANGELOG.md`.
- **Alterado** — `README.md` harmonizado: seções de instalação e de configuração para
  Claude Desktop, Cursor e Windsurf passam a refletir o contrato Bun e os comandos
  canônicos (`bunx agent-dreams`); referências a caminhos legados foram removidas; o
  texto passa a ser estritamente técnico, sem menções obsoletas.

---

## [1.0.1] — 2026-10-19

Publicação incremental da linha `1.0.x` sobre a mesma árvore de fontes já publicada em
`1.0.0` (mesmo formato de tarball: 37 entradas, com a suíte interna de testes ainda
distribuída). Mantém o dual-entrypoint — plugin nativo OpenCode e servidor MCP
universal — e a linha de *hardening* de memória: redação de segredos, *dual-write*
síncrono SQLite, pesos e decaimento categóricos, ingestão integral em *chunks* e
remoção atômica de memórias (`forget`) com regeneração imediata das projeções em disco.

## [1.0.0] — 2026-10-19

Primeira publicação pública do pacote `agent-dreams`: ciclo cognitivo tri-fásico
(*Light Sleep* → *REM Sleep* → *Deep Sleep*), ferramentas de vigília `dream_learn` e
`dream_recall`, e o *dual-entrypoint* (plugin OpenCode + servidor MCP universal sobre
*stdio*).
