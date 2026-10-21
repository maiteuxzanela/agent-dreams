#!/bin/bash
# Instala e ativa o timer systemd user do agent-dreams a partir das units
# versionadas em <PLUGIN_DIR>/systemd/ (TICKET-DREAMS-03).
#
# Portabilidade: o diretório do plugin é resolvido dinamicamente a partir da
# localização deste script (`dirname "$(readlink -f "$0")"`), sem nenhum caminho
# absoluto do autor. As units são copiadas para
# "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/" com o placeholder
# __AGENT_DREAMS_DIR__ substituído pelo diretório real de instalação.
#
# Uso: bin/enable-systemd.sh
# Variáveis: DREAMS_PLUGIN_DIR (override do diretório do plugin),
#            XDG_CONFIG_HOME    (base do systemd user; default ~/.config).
set -euo pipefail

SELF="${BASH_SOURCE[0]:-$0}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$SELF" >/dev/null 2>&1; then
    SELF="$(readlink -f "$SELF")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
PLUGIN_DIR="${DREAMS_PLUGIN_DIR:-$(dirname "$SCRIPT_DIR")}"
SYSTEMD_SRC_DIR="$PLUGIN_DIR/systemd"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS="agent-dreams.service agent-dreams.timer"

echo "=== Ativação do Agent Dreams Systemd Timer ==="

if [ ! -d "$SYSTEMD_SRC_DIR" ]; then
    echo "Erro: diretório de units não encontrado em $SYSTEMD_SRC_DIR" >&2
    exit 1
fi

mkdir -p "$USER_UNIT_DIR"

# 1/5. Instalar as units versionadas, substituindo o placeholder dinâmico.
echo "[1/5] Instalando units em $USER_UNIT_DIR..."
for unit in $UNITS; do
    src="$SYSTEMD_SRC_DIR/$unit"
    dst="$USER_UNIT_DIR/$unit"
    if [ ! -f "$src" ]; then
        echo "Erro: unit ausente em $src" >&2
        exit 1
    fi
    sed "s|__AGENT_DREAMS_DIR__|$PLUGIN_DIR|g" "$src" > "$dst"
    echo "      - $unit"
done

# 2/5. Recarregar daemons do systemd user.
echo "[2/5] Executando systemctl --user daemon-reload..."
systemctl --user daemon-reload

# 3/5. Habilitar e iniciar o timer.
echo "[3/5] Habilitando e iniciando agent-dreams.timer..."
systemctl --user enable agent-dreams.timer
systemctl --user restart agent-dreams.timer

# 4/5. Validar se o timer está ativo.
echo "[4/5] Verificando status do timer..."
systemctl --user is-active --quiet agent-dreams.timer && echo "Timer ATIVO com sucesso!" || (echo "Erro: Timer inativo!" && exit 1)

# 5/5. Listar próximos disparos.
echo "[5/5] Listando agendamentos..."
systemctl --user list-timers agent-dreams.timer

echo "=== Configuração Concluída com Sucesso! ==="
