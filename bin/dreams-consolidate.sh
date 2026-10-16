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

# Modo defensivo estrito: aborta em erro, variável não definida e falha de pipe.
set -euo pipefail

LOG_FILE="$HOME/.local/state/opencode-dreams.log"
LOG_MAX_BYTES=5242880 # 5 MiB — teto antes da rotação para "${LOG_FILE}.1"
# Lock exclusivo global do ciclo de consolidação. O caminho pode ser sobrescrito
# via DREAMS_LOCK_FILE (útil em testes isolados); o default é o canônico.
LOCK_FILE="${DREAMS_LOCK_FILE:-/tmp/opencode-dreams.lock}"
LOCK_FD=""
DREAMS_TMP=""

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

mkdir -p "$(dirname "$LOG_FILE")"

# 0.1 Proteção contra concorrência (TICKET-DREAMS-05 / Frente 5B): lock exclusivo
#     e não-bloqueante adquirido ANTES de qualquer subprocesso (nem a rotação de
#     log é disparada pela instância perdedora). Se outra instância (timer systemd
#     ou execução manual) já detém o lock, encerramos imediatamente SEM tocar em
#     estado — evita handoff duplicado no banco e duplicação de execuções.
#     Saída 0: é um skip benigno, não uma falha do ciclo.
#     Se `flock` não existir no sistema, avisamos e seguimos sem proteção
#     (fail-soft: nunca bloqueamos a consolidação por ausência de utilitário).
if command -v flock >/dev/null 2>&1; then
    mkdir -p "$(dirname "$LOCK_FILE")"
    exec {LOCK_FD}>"$LOCK_FILE"
    if ! flock -n "$LOCK_FD"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Outra instância de consolidação já está em execução (lock $LOCK_FILE ocupado). Encerrando sem alterar estado." >> "$LOG_FILE"
        exit 0
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
export CUDA_VISIBLE_DEVICES=""       # Oculta a GTX 1050 Ti Pascal do processo de script caso use Python acidentalmente.
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
