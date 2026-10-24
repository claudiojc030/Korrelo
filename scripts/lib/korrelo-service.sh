#!/usr/bin/env bash
# Helper privilegiado do Korrelo: liga/desliga UM serviço do SO.
#
# POR QUE ISTO EXISTE
# A regra antiga era `NOPASSWD: systemctl enable --now *` e
# `systemctl disable --now *`. O curinga permitia habilitar/desabilitar
# QUALQUER unit como root (inclusive ssh, docker, nginx, crond), então um
# comprometimento da API virava persistência/negacão de serviço em root.
#
# Este script só aceita:
# - ação: enable | disable
# - unit: um nome da LISTA FECHADA abaixo (mesma de
#   apps/api/src/modules/system-services/domain/service-catalog.ts)
#
# Uso: korrelo-service enable|disable <unit>
set -euo pipefail

SYSTEMCTL_BIN="${KORRELO_SYSTEMCTL_BIN:-/usr/bin/systemctl}"

die() { printf 'korrelo-service: %s\n' "$*" >&2; exit 64; }

# Lista fechada (unitName do catálogo). NUNCA inclua serviços essenciais aqui
# (ssh, cron, docker, nginx, fail2ban, ufw, systemd-*, dbus, networkd, rsyslog).
ALLOWED_UNITS=(
  "avahi-daemon"
  "cups"
  "cups-browsed"
  "ModemManager"
  "bluetooth"
  "whoopsie"
  "apport"
  "multipathd"
  "packagekit"
  "accounts-daemon"
  "wpa_supplicant"
  "sysstat"
  "qemu-guest-agent"
)

[[ $# -eq 2 ]] || die "uso: korrelo-service enable|disable <unit>"
ACTION="$1"
UNIT="$2"

[[ "$ACTION" == "enable" || "$ACTION" == "disable" ]] || die "ação inválida: '${ACTION}'"
[[ "$UNIT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "nome de unit inválido"

allowed=false
for candidate in "${ALLOWED_UNITS[@]}"; do
  if [[ "$candidate" == "$UNIT" ]]; then allowed=true; break; fi
done
[[ "$allowed" == "true" ]] || die "unit não permitida: '${UNIT}'"

[[ -x "$SYSTEMCTL_BIN" ]] || die "systemctl não encontrado em ${SYSTEMCTL_BIN}"

exec "$SYSTEMCTL_BIN" "$ACTION" --now "$UNIT"
