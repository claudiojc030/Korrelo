#!/usr/bin/env bash
# Helper privilegiado do Korrelo: emite/renova certificado Let's Encrypt.
#
# POR QUE ISTO EXISTE
# A regra antiga de sudoers era `NOPASSWD: certbot *`. Isso permitia
# `sudo certbot --deploy-hook '<comando>'`, que executa comando arbitrário
# como root - ou seja, qualquer comprometimento da API virava root na VPS.
#
# Este script é o ÚNICO caminho privilegiado para o certbot. Ele:
# - recebe apenas DOMÍNIOS (validados) e, opcionalmente, um e-mail;
# - NUNCA repassa flags arbitrárias (hook, --exec, --config-dir, etc.);
# - monta as opções do certbot com uma lista FIXA.
#
# Uso:
#   korrelo-certbot <dominio> [dominio...]
#   korrelo-certbot --email <email> <dominio> [dominio...]
#
# Códigos de saída: 64 = uso/validação inválida; demais = erro do certbot.
set -euo pipefail

CERTBOT_BIN="${KORRELO_CERTBOT_BIN:-/usr/bin/certbot}"
MAX_DOMAINS=10

die() { printf 'korrelo-certbot: %s\n' "$*" >&2; exit 64; }

EMAIL=""
if [[ "${1:-}" == "--email" ]]; then
  [[ $# -ge 3 ]] || die "uso: korrelo-certbot --email <email> <dominio> [dominio...]"
  EMAIL="$2"
  shift 2
  [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "e-mail inválido"
fi

[[ $# -ge 1 ]] || die "informe ao menos um domínio"
[[ $# -le $MAX_DOMAINS ]] || die "domínios demais (máximo ${MAX_DOMAINS})"
[[ -x "$CERTBOT_BIN" ]] || die "certbot não encontrado em ${CERTBOT_BIN}"

# FQDN simples: rótulos alfanuméricos/hífen, sem curinga, sem porta, sem path.
# Isso impede qualquer injeção de opção (o valor nunca começa com "-").
DOMAIN_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'

args=(--nginx)
for domain in "$@"; do
  domain="${domain,,}"
  [[ ${#domain} -le 253 ]] || die "domínio grande demais"
  [[ "$domain" =~ $DOMAIN_RE ]] || die "domínio inválido: '${domain}'"
  args+=(-d "$domain")
done

# Flags FIXAS: nada aqui vem do chamador.
args+=(--expand --agree-tos --redirect -n)
if [[ -n "$EMAIL" ]]; then
  args+=(-m "$EMAIL")
else
  args+=(--register-unsafely-without-email)
fi

exec "$CERTBOT_BIN" "${args[@]}"
