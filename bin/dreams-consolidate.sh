#!/bin/bash
# Wrapper para o consolidador diário de memórias (opencode-plugin-dreams)
# Garantias de execução: Checagem de conectividade ISOLADA para a LLM remota,
# proteção de hardware, alerta em falha/adiamento e logging isolado com rotação.
#
# DEF-07: Light Sleep e Deep Sleep são rotinas 100% locais e rodam SEMPRE,
# mesmo sem internet. A verificação de ping só decide se a chamada remota da
# LLM no REM Sleep roda online ou em modo offline local (DREAMS_OFFLINE=1).
#
# C5 (TICKET-DREAMS-02): o CLI devolve códigos de saída semânticos; o wrapper
# propaga e alerta a usuária — 0 = íntegro, 1 = falha fatal, 75 = EX_TEMPFAIL
# (síntese REM adiada por IA/cota/rede indisponível, retry no próximo ciclo).
#
# TICKET-DREAMS-05 (Frente 5B): blindagem operacional POSIX —
#   * modo estrito `set -euo pipefail`;
#   * lock exclusivo (`flock -n`) contra execuções concorrentes (timer systemd
#     vs. execução manual), com saída imediata e informativa no log;
#   * trap de saída para liberar o descritor de lock e remover temporários em
#     qualquer encerramento (exit normal, SIGINT, SIGTERM, SIGHUP).
#
# TICKET-DREAMS-02: o lockfile deixa de ser um caminho fixo e passa a ser
# RESOLVIDO DINAMICAMENTE na ordem `DREAMS_LOCK_FILE` →
# `${XDG_RUNTIME_DIR:-/run/user/<uid>}/opencode-dreams.lock` (só se o diretório
# existir e for gravável) → `/tmp/opencode-dreams-<uid>.lock` (fallback seguro,
# por-UID) → `$HOME/.local/state/opencode-dreams.lock` (degrade). Detalhes e
# proteção contra symlink/ownership/hard-link em `resolve_lock_file`.
#
# BLINDAGEM DO LOCKFILE (Portão 2 — decisão (B) MITIGAR):
#   C1  O guard de validação exige `nlink == 1` no path existente: um alias
#       plantado por HARD LINK (nlink > 1) é a variante PRÉ-PLANTADA do mesmo
#       ataque do symlink (o `[ -L ]` não pega, e o owner do inode É o da
#       vítima). Lockfile legítimo tem nlink == 1 ⇒ sem falso positivo.
#   C2  O lockfile é aberto READ-ONLY (`<`, nunca `>`): a primitiva de PERDA
#       DE DADOS desaparece em TODAS as variantes (symlink, hard link e
#       corrida) — o alvo do atacante pode ser ABERTO, nunca TRUNCADO.
#   C3  O path é REIVINDICADO atomicamente antes de abrir
#       (`set -C; : > path`): nunca escreve através de symlink (falha se o
#       destino já existir, inclusive como symlink DANGLING) e, em diretório
#       sticky, a posse do arquivo (ownership) torna a substituição por um
#       terceiro impossível — a CORRIDA colapsa por PROPRIEDADE, não por timing.
#   C4  O residual remanescente está registrado ABAIXO, no próprio artefato.
#   C5  As regressões que provam C1/C2/C3 vivem em tests/dreams_sec_02*.
#
# RISCO RESIDUAL (registrado no artefato, não só no card) — separado do
# pré-plantado, que é FECHADO:
#   * A corrida de ESCRITA/TRUNCAGEM está FECHADA pela C2 (abertura read-only)
#     em QUALQUER variante (symlink, hard link ou corrida): o alvo do atacante
#     pode ser ABERTO, nunca TRUNCADO.
#   * A corrida de SUBSTITUIÇÃO do path está fechada pela PROPRIEDADE do
#     arquivo (owner == nós) combinada com o STICKY BIT do diretório do lock —
#     propriedade do SO, não do código.
#   * PREMISSA DO SO A REGISTRAR: o diretório resolvido precisa ser sticky.
#     `/tmp` é 1777 (verificado). Num diretório world-writable SEM sticky,
#     outro usuário pode remover o nosso lockfile ⇒ a abertura read-only
#     seguiria um symlink plantado ⇒ SEQUESTRO DE LOCK, SEM perda de dados
#     (C2) e detectável pela camada pós-abertura (R3). Hardening futuro
#     candidato (não exigido agora): verificar o sticky bit do diretório
#     resolvido e degradar se ausente.
#   * LIMITAÇÃO HONESTA DA SUÍTE: o /tmp do sandbox bwrap é um tmpfs criado
#     com `--tmpfs /tmp` ⇒ modo drwxr-xr-x, SEM sticky, e tudo roda com o
#     mesmo uid ⇒ a suíte NÃO prova a proteção do sticky bit. Ela prova os
#     GUARDS; a propriedade do sticky é premissa de SO e consta do texto de
#     risco como tal — não como invariante testada.
#   * Custo comportamental da regra nlink: um lockfile que ganhou alias por
#     hard link (backup com `cp -al`, snapshot btrfs) tem nlink > 1 ⇒ é
#     rejeitado ⇒ o script DEGRADA para outro tier. Conservador, não quebra
#     o consolidador.
#   * TIER 1 (override do operador) e TIER 2 (runtime dir 0700) pulam o guard
#     C1 POR DESIGN (decisão do operador / diretório privado): nesses tiers a
#     barreira contra alias é a PÓS-abertura (R3), não a preventiva — sem
#     dano, porque a abertura é read-only.
#

# Modo defensivo estrito: aborta em erro, variável não definida e falha de pipe.
set -euo pipefail

LOG_FILE="$HOME/.local/state/opencode-dreams.log"
LOG_MAX_BYTES=5242880 # 5 MiB — teto antes da rotação para "${LOG_FILE}.1"
LOCK_FD=""
DREAMS_TMP=""

# TICKET-DREAMS-02 — Resolução DINÂMICA e segura do lockfile do ciclo.
#
# Ordem de precedência (a mais específica vence):
#
#   1. DREAMS_LOCK_FILE
#      Override explícito do operador (ex.: testes isolados, execução manual com
#      um lock dedicado). SEMPRE tem a maior precedência e não passa pela
#      validação de ownership — é uma decisão consciente, não um default.
#
#   2. ${XDG_RUNTIME_DIR:-/run/user/<uid>}/opencode-dreams.lock
#      Diretório de runtime do usuário (criado pelo systemd/PAM com modo 0700):
#      nenhum outro usuário pode listar, ler ou PRÉ-PLANTAR (symlink) o lock.
#      Só é usado se o diretório EXISTIR e for GRAVÁVEL.
#
#   3. /tmp/opencode-dreams-<uid>.lock
#      Fallback para quando não há runtime dir utilizável. O nome é POR-UID:
#      nunca o caminho compartilhado `/tmp/opencode-dreams.lock`, que permitiria
#      a um atacante local pré-plantar um symlink e sequestrar a escrita.
#
# TIER 3.5 — Proteção contra sequestro do lockfile (Zero Trust):
#      Se o alvo JÁ EXISTE e NÃO é um arquivo regular do próprio usuário
#      (symlink plantado por terceiro — DANGLING ou não — ou arquivo de outro
#      UID), o script NUNCA escreve nele: degrada para o diretório PRIVADO do
#      próprio usuário ($HOME/.local/state) e registra o downgrade no log.
#      O destino do degrade é TAMBÉM validado; se o home privado for hostil,
#      o script ABORTA (fail-closed) em vez de seguir o link.
#      NOTA DE ORDEM: o teste de symlink PRECEDE o de existência, porque
#      `[ -e ]` segue symlinks e leria um symlink DANGLING como "inexistente".

# UID efetivo do processo (o bash define UID; o fallback cobre shells sem ele).
dreams_uid() {
    printf '%s' "${UID:-$(id -u)}"
}

# Motivo pelo qual um path foi rejeitado como lockfile (para o log).
# Preenchido por `lock_path_is_safe`; vazio quando o path é aceito.
LOCK_REJECT_REASON=""

# Verdadeiro quando `path` pode ser usado como lockfile sem risco de
# sequestro: inexistente (será criado por nós), ou regular file do próprio UID
# SEM alias (nlink == 1).
lock_path_is_safe() {
    local path="$1"
    LOCK_REJECT_REASON=""
    # ORDEM CRÍTICA — o teste de symlink PRECEDE o de existência.
    # `[ -e ]` SEGUE symlinks: um symlink DANGLING (alvo inexistente) é lido
    # por `-e` como "inexistente". Se `-e` fosse testado primeiro, o link
    # dangling seria classificado como seguro e a abertura SEGUIRIA o link.
    if [ -L "$path" ]; then
        LOCK_REJECT_REASON="symlink"
        return 1 # symlink (dangling ou não): NUNCA seguir
    fi
    if [ ! -e "$path" ]; then
        return 0
    fi
    if [ ! -f "$path" ]; then
        LOCK_REJECT_REASON="nao-regular"
        return 1 # precisa ser arquivo regular (nada de dir/fifo/device)
    fi
    local owner
    owner="$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null || echo "")"
    if [ -z "$owner" ] || [ "$owner" != "$(dreams_uid)" ]; then
        LOCK_REJECT_REASON="owner-alheio"
        return 1 # pertence a outro usuário
    fi
    # C1 — nlink == 1: um alias plantado por HARD LINK tem nlink > 1 e é a
    # variante PRÉ-PLANTADA do mesmo ataque do symlink — o `[ -L ]` não pega
    # (é arquivo regular) e o owner PASSA (o inode é o do arquivo da vítima).
    # Lockfile legítimo tem nlink == 1 ⇒ sem falso positivo.
    local links
    links="$(stat -c '%h' "$path" 2>/dev/null || stat -f '%h' "$path" 2>/dev/null || echo "")"
    if [ -z "$links" ] || [ "$links" != "1" ]; then
        LOCK_REJECT_REASON="alias-hardlink(nlink=${links:-indeterminado})"
        return 1 # alias plantado (ou nlink indeterminado ⇒ conservador)
    fi
    return 0
}

# C3 — reivindicação ATÔMICA do path do lockfile.
# `set -C` (noclobber) faz o `>` usar O_CREAT|O_EXCL: falha se o destino JÁ
# existir — inclusive se for um symlink (inclusive DANGLING) — e NUNCA escreve
# através de um link. Devolve 0 se o arquivo foi criado por NÓS (e portanto é
# nosso por ownership, com nlink == 1), 1 se o path já existia.
claim_lock_path() {
    local path="$1"
    mkdir -p "$(dirname "$path")" 2>/dev/null || true
    ( set -C; : > "$path" ) 2>/dev/null
}

# Adquire um candidato como lockfile: reivindica (C3) e, se já existia, valida
# (guard completo + C1). Devolve 0 quando o candidato é seguro e utilizável.
acquire_lock_candidate() {
    local candidate="$1"
    if claim_lock_path "$candidate"; then
        return 0 # criado por nós: seguro por construção (ownership + nlink=1)
    fi
    # A reivindicação FALHOU. Distingue os dois casos, indistinguíveis pelo
    # exit code: "já existe" (benigno) de "diretório sem escrita" (ERRO DE
    # AMBIENTE). Sem esta distinção, um diretório sem escrita é lido pelo
    # operador como "lock ocupado" — e o ciclo para com diagnóstico errado.
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
        # O path EXISTE (como arquivo regular ou como symlink): a falha é por
        # existência, não por falta de permissão.
        if lock_path_is_safe "$candidate"; then
            log_lockfile_claim_existing
            return 0
        fi
        return 1 # rejeitado pelo guard (motivo em LOCK_REJECT_REASON)
    fi
    # O path NÃO existe e a reivindicação falhou ⇒ o diretório não é gravável.
    LOCK_REJECT_REASON="diretorio-sem-escrita"
    return 1
}

# Verificação PÓS-ABERTURA (belt-and-braces para diretório world-writable SEM
# sticky, onde a posse não impede a substituição). É DETECTIVA: roda DEPOIS da
# abertura — por isso a ausência de truncamento (C2) é o que garante que aqui
# só se perde o MUTEX, nunca os dados.
#   0 = o fd aponta para o path esperado (e o alvo não tem alias)
#   1 = DIVERGÊNCIA (o fd aponta para outro path, ou o alvo tem nlink > 1)
#   2 = NÃO VERIFICÁVEL (sem /proc, ou path inacessível) — o caller deve
#       PULAR com warning, NUNCA abortar por não-computável.
verify_lock_fd_target() {
    local fd="$1" path="$2" dir base phys expected real links
    dir="$(dirname "$path")"
    base="$(basename "$path")"
    phys=""
    # `cd -P`/`pwd -P` (FÍSICO): o kernel reporta o path FÍSICO do fd, então
    # `pwd` lógico divergiria sempre que um ancestral do path for symlink
    # (falso positivo que abortaria o consolidador).
    if [ -d "$dir" ]; then
        phys="$(cd -P "$dir" 2>/dev/null && pwd -P)" || phys=""
    fi
    [ -n "$phys" ] || return 2
    expected="${phys}/${base}"
    real="$(readlink "/proc/self/fd/${fd}" 2>/dev/null || true)"
    [ -n "$real" ] || return 2
    # `-L` é load-bearing: sem ele o `stat` reporta o nlink do PRÓPRIO symlink
    # do /proc (sempre 1) e a checagem do alias fica inerte.
    links="$(stat -L -c '%h' "/proc/self/fd/${fd}" 2>/dev/null || stat -L -f '%h' "/proc/self/fd/${fd}" 2>/dev/null || true)"
    [ -n "$links" ] || return 2
    if [ "$real" != "$expected" ]; then
        return 1
    fi
    if [ "$links" != "1" ]; then
        return 1
    fi
    return 0
}

# Resolve o path do lockfile conforme a precedência documentada acima.
# Imprime o path escolhido e devolve 0; devolve 1 (sem imprimir) quando
# NENHUM alvo seguro existe — o caller então ABORTA (fail-closed).
resolve_lock_file() {
    local uid xdg candidate

    # TIER 1 — override explícito do operador (advisory: sem validação de
    # ownership). O path é REIVINDICADO atomicamente (C3) para existir sem
    # truncar nada e sem seguir symlink.
    if [ -n "${DREAMS_LOCK_FILE:-}" ]; then
        claim_lock_path "$DREAMS_LOCK_FILE" || true
        printf '%s' "$DREAMS_LOCK_FILE"
        return 0
    fi

    uid="$(dreams_uid)"

    # TIER 2 — runtime dir do usuário (0700): privado e não-pre-plantável
    # (advisory: sem checagem de symlink — só o dono planta lá).
    xdg="${XDG_RUNTIME_DIR:-/run/user/${uid}}"
    if [ -d "$xdg" ] && [ -w "$xdg" ]; then
        candidate="${xdg}/opencode-dreams.lock"
        claim_lock_path "$candidate" || true
        printf '%s' "$candidate"
        return 0
    fi

    # TIER 3 — fallback em /tmp, nome por-UID.
    candidate="/tmp/opencode-dreams-${uid}.lock"
    if acquire_lock_candidate "$candidate"; then
        printf '%s' "$candidate"
        return 0
    fi
    log_lockfile_rejected "TIER 3" "$candidate"

    # TIER 3.5 — alvo inseguro em /tmp: degrada para o diretório privado do
    # próprio usuário em vez de usar um alvo hostil. O PRÓPRIO destino do
    # degrade também é validado; se o home privado for hostil, o script ABORTA
    # (fail-closed) em vez de seguir o link.
    candidate="$HOME/.local/state/opencode-dreams.lock"
    if acquire_lock_candidate "$candidate"; then
        printf '%s' "$candidate"
        return 0
    fi
    log_lockfile_rejected "TIER 3.5" "$candidate"

    return 1 # nenhum alvo seguro — o caller aborta sem escrever
}

# Registra no log o motivo de um tier ter sido rejeitado (visibilidade: sem
# isto, "o lock às vezes muda de lugar" seria um mistério para o operador).
log_lockfile_rejected() {
    local tier="$1" path="$2"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lockfile $tier rejeitado ($path): motivo=${LOCK_REJECT_REASON:-desconhecido}. Degradando." >> "$LOG_FILE"
}

# A reivindicação O_EXCL falhou mas o path EXISTE como arquivo regular nosso:
# caso BENIGNO (o lockfile de uma execução anterior) — o lock vai ser tomado.
# O path NÃO é logado aqui de propósito: a linha precisa ser greppável sem
# carregar um path de /tmp (que quebraria asserções de ausência de path).
log_lockfile_claim_existing() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lockfile: reivindicação falhou (lockfile já existe) → validando." >> "$LOG_FILE"
}

# O diretório do log é criado ANTES da resolução do lockfile: a degradação
# (motivo do tier rejeitado) precisa poder ser registrada.
mkdir -p "$(dirname "$LOG_FILE")"

# `if !` protege o `set -e`: a resolução falha apenas quando não há alvo seguro.
if ! LOCK_FILE="$(resolve_lock_file)"; then
    LOCK_FILE=""
fi

# Path do CLI a ser executado (precisa existir antes da rotação delegada abaixo).
PLUGIN_DIR="$HOME/.config/opencode/plugins/opencode-plugin-dreams"
CLI_PATH="$PLUGIN_DIR/src/cli.ts"

export PATH="$HOME/.opencode/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# 0. Trap de limpeza (TICKET-DREAMS-05 / Frente 5B): fecha o descritor do lock
#    (liberando o flock) e remove temporários em QUALQUER encerramento — saída
#    normal ou por sinal. É registrado ANTES de tomar o lock para que um sinal
#    durante a própria janela de aquisição ainda libere recursos. Não chama
#    `exit`: o bash preserva o código de saída original.
cleanup() {
    if [ -n "$LOCK_FD" ]; then
        eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
    fi
    if [ -n "$DREAMS_TMP" ]; then
        rm -f "$DREAMS_TMP" 2>/dev/null || true
    fi
}
trap cleanup EXIT
# Sinais reentram pelo trap EXIT depois de fixar o código 128+n.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# 0.1 Proteção contra concorrência (TICKET-DREAMS-05 / Frente 5B): lock exclusivo
#     e não-bloqueante adquirido ANTES de qualquer subprocesso (nem a rotação de
#     log é disparada pela instância perdedora). Se outra instância (timer systemd
#     ou execução manual) já detém o lock, encerramos imediatamente SEM tocar em
#     estado — evita handoff duplicado no banco e duplicação de execuções.
#     Saída 0: é um skip benigno, não uma falha do ciclo.
#     Se `flock` não existir no sistema, avisamos e seguimos sem proteção
#     (fail-soft: nunca bloqueamos a consolidação por ausência de utilitário).
if command -v flock >/dev/null 2>&1; then
    # Fail-closed: sem nenhum alvo de lockfile SEGURO (o home privado também
    # hostil, ex.: symlink plantado), o script ABORTA em vez de escrever
    # através de um link. Nunca há escrita em alvo não validado.
    if [ -z "$LOCK_FILE" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: nenhum alvo de lockfile seguro (symlink detectado até no diretório privado). Abortando SEM escrever." >> "$LOG_FILE"
        exit 1
    fi
    mkdir -p "$(dirname "$LOCK_FILE")"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lockfile resolvido: $LOCK_FILE" >> "$LOG_FILE"
    # C2 — abertura READ-ONLY: o lockfile NUNCA é truncado. O `>` (write) permitiria
    # que um alvo escolhido pelo atacante (symlink ou hard link) fosse apagado
    # — perda de dados da vítima. Com `<` o alvo pode ser ABERTO, nunca zerado.
    # O read-only não cria o arquivo: se ele sumir entre a reivindicação (C3) e
    # a abertura, o script aborta com mensagem clara em vez de dies sujo do
    # `set -e` (em diretório sticky isso é impossível — o arquivo é nosso).
    if ! : <"$LOCK_FILE" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: lockfile $LOCK_FILE não pôde ser aberto para leitura. Abortando SEM escrever." >> "$LOG_FILE"
        exit 1
    fi
    exec {LOCK_FD}<"$LOCK_FILE"
    if ! flock -n "$LOCK_FD"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Outra instância de consolidação já está em execução (lock $LOCK_FILE ocupado). Encerrando sem alterar estado." >> "$LOG_FILE"
        exit 0
    fi
    # R3 (belt-and-braces, DETECTIVO): confirma que o fd adquirido aponta para o
    # path reivindicado e que o alvo não tem alias. Só é relevante em diretório
    # world-writable SEM sticky (lá a posse não impede a substituição); como a
    # abertura é READ-ONLY, uma divergência aqui custa o MUTEX, nunca os dados.
    # "Não verificável" (sem /proc, path inacessível) => PULA com warning,
    # NUNCA aborta por não-computável.
    lock_verify_rc=0
    verify_lock_fd_target "$LOCK_FD" "$LOCK_FILE" || lock_verify_rc=$?
    if [ "$lock_verify_rc" -eq 1 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERRO: divergência anti-TOCTOU no lockfile $LOCK_FILE (fd não aponta para o path reivindicado, ou o alvo tem alias). Abortando SEM escrever." >> "$LOG_FILE"
        exit 1
    fi
    if [ "$lock_verify_rc" -eq 2 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] AVISO: verificação anti-TOCTOU do lockfile não verificável (sem /proc ou path inacessível). Seguindo com o lock." >> "$LOG_FILE"
    fi
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Aviso: 'flock' indisponível; prosseguindo SEM proteção de concorrência." >> "$LOG_FILE"
fi

# 0.2 Rotação básica de log (C5): executada ANTES de abrir o arquivo para append.
#     A política (teto de 5MB, destino `.log.1`) é única e vive no helper TS
#     `rotateLogIfNeeded`, acionado via subcomando `rotate-log` para não duplicar
#     a regra em bash. Fail-soft: se a rotação falhar, o log apenas cresce.
if [ -f "$CLI_PATH" ]; then
    bun run "$CLI_PATH" rotate-log "$LOG_FILE" "$LOG_MAX_BYTES" >/dev/null 2>&1 || true
fi

exec >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando consolidação diária de memórias (opencode-dreams)..."
if [ -n "$LOCK_FD" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Lock exclusivo adquirido ($LOCK_FILE, fd=$LOCK_FD)."
fi

if [ ! -f "$CLI_PATH" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Erro: CLI não encontrado em $CLI_PATH"
    exit 1
fi

# 1. Checagem de conectividade com tolerância de boot (até 60s resilientes)
# Loop de até 20 tentativas com sleep 3s testando 1.1.1.1 e fallback para 8.8.8.8.
# Garante tempo para negociação DHCP/rede no boot sem travar o ciclo local.
ONLINE=0
MAX_ATTEMPTS=20
RETRY_DELAY=3

for attempt in $(seq 1 $MAX_ATTEMPTS); do
    if ping -c 1 -W 2 1.1.1.1 > /dev/null 2>&1 || ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1; then
        ONLINE=1
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Conectividade OK na tentativa $attempt/$MAX_ATTEMPTS. Prosseguindo..."
        break
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rede indisponível (tentativa $attempt/$MAX_ATTEMPTS). Aguardando ${RETRY_DELAY}s (negociação DHCP/link)..."
        sleep "$RETRY_DELAY"
    fi
done

if [ "$ONLINE" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Aviso: Sem internet após tolerância de 60s (${MAX_ATTEMPTS} tentativas). Rotinas locais (Light/Deep Sleep) seguem normalmente; apenas a LLM remota do REM Sleep roda em modo offline (DREAMS_OFFLINE=1)."
fi
export ONLINE

# 2. Blindagem de Recursos de Hardware (CPU/GPU)
# Asseguramos que não há rotas para modelos locais setando a variável de ambiente.
# Qualquer chamada para o REM Sleep (síntese) deverá usar exclusivamente modelos de nuvem.
export OLLAMA_HOST="127.0.0.1:99999" # Invalida fallback acidental para Ollama
export CUDA_VISIBLE_DEVICES=""       # Oculta dispositivos GPU do processo caso algum subprocesso tente inferência local.
export FORBID_LOCAL_INFERENCE="true"

# 3. Execução por etapas com agregação semântica de exit code (C5).
#    Prioridade: falha fatal (1) > adiamento transitório (75) > sucesso (0).
EXIT_CODE=0
track_exit() {
    local rc=$1
    [ "$rc" -eq 0 ] && return 0
    if [ "$rc" -eq 75 ]; then
        # EX_TEMPFAIL: transitório — só rebaixa se ainda não houve falha fatal.
        [ "$EXIT_CODE" -ne 1 ] && EXIT_CODE=75
    else
        EXIT_CODE=1
    fi
    return 0
}

# Executa uma etapa do CLI SEM abortar o script sob `set -e` (o código de erro é
# capturado manualmente) e agrega o desfecho semântico via track_exit.
# Retorna sempre 0: o veredito final vive em EXIT_CODE.
run_step() {
    local rc=0
    "$@" || rc=$?
    track_exit "$rc"
    return 0
}

# Etapa 1/3: Light Sleep (local — sempre executa)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH light..."
run_step bun run "$CLI_PATH" light

# Etapa 2/3: REM Sleep — LLM remota apenas com internet; sem internet, modo offline local
if [ "$ONLINE" -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH rem (LLM remota)..."
    run_step bun run "$CLI_PATH" rem
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH rem em MODO OFFLINE (sem LLM remota)..."
    DREAMS_OFFLINE=1 run_step bun run "$CLI_PATH" rem
fi

# Etapa 3/3: Deep Sleep (local — sempre executa)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH deep..."
run_step bun run "$CLI_PATH" deep

# 4. Alerta à usuária e registro do desfecho (C5).
alert_user() {
    local msg=$1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ALERTA: $msg"
    # Best-effort: notifica a sessão gráfica quando disponível; nunca falha o ciclo.
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u normal "OpenCode Dreams" "$msg" 2>/dev/null || true
    fi
}

if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Consolidação concluída com sucesso."
elif [ "$EXIT_CODE" -eq 75 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Consolidação ADIADA (exit 75/EX_TEMPFAIL): síntese REM não concluída por IA/cota/rede indisponível. Diálogo preservado; nova tentativa no próximo ciclo."
    alert_user "Consolidação de memórias adiada (modelo de IA indisponível). Será retentada no próximo ciclo."
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FALHA FATAL na consolidação (exit $EXIT_CODE). Verifique $LOG_FILE."
    alert_user "FALHA na consolidação de memórias. Verifique $LOG_FILE."
fi

exit "$EXIT_CODE"
