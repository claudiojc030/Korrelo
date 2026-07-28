#!/usr/bin/env bash
# Bootstrap de uma VPS Ubuntu limpa para rodar o ForgeDesk (Core via PM2 nativo,
# projetos gerenciados via Docker). Rode a partir da raiz do repo já clonado na VPS:
#   git clone <seu-fork-ou-repo> forgedesk && cd forgedesk && bash scripts/setup-vps.sh
set -euo pipefail

log() { echo -e "\n\033[1;32m==> $1\033[0m"; }
warn() { echo -e "\033[1;33m[aviso] $1\033[0m"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Não rode como root — rode como um usuário normal com sudo (evita rodar o Core como root)." >&2
  exit 1
fi

log "Atualizando pacotes do sistema"
sudo apt-get update -y
sudo apt-get upgrade -y

log "Configurando swap (rede de segurança em VPS com pouca RAM)"
TOTAL_MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ ! -f /swapfile ] && [ "$TOTAL_MEM_MB" -le 8192 ]; then
  SWAP_SIZE_GB=2
  sudo fallocate -l ${SWAP_SIZE_GB}G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf > /dev/null
  sudo sysctl -p > /dev/null
  echo "Swap de ${SWAP_SIZE_GB}G criado."
else
  echo "Swap já existe ou RAM > 8GB — pulando."
fi

log "Instalando Node.js 20"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node já instalado: $(node -v)"
fi

log "Instalando Docker"
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Docker instalado. Você precisa fazer logout/login (ou 'newgrp docker') pra usar sem sudo."
else
  echo "Docker já instalado: $(docker --version)"
fi

log "Instalando PM2"
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
else
  echo "PM2 já instalado."
fi

# --- nginx + certbot (sempre, mesmo sem domínio pro ForgeDesk em si) --------
# Isso é o motor de reverse-proxy + TLS que os PROJETOS implantados pelo
# ForgeDesk vão usar quando você anexar um domínio a cada um deles (aba
# Resumo → Domínio personalizado). O ForgeDesk continua acessível pelo IP
# puro nas portas 3000/3001 independente disso.
log "Instalando nginx + certbot"
sudo apt-get install -y nginx certbot python3-certbot-nginx

log "Preparando diretório de sites por projeto"
FORGEDESK_SITES_DIR=/etc/nginx/forgedesk-sites
sudo mkdir -p "$FORGEDESK_SITES_DIR"
sudo chown "$USER":"$USER" "$FORGEDESK_SITES_DIR"
if ! grep -q "forgedesk-sites" /etc/nginx/nginx.conf; then
  sudo sed -i "/include \/etc\/nginx\/conf.d\/\*.conf;/a\\	include ${FORGEDESK_SITES_DIR}/*.conf;" /etc/nginx/nginx.conf
  sudo nginx -t
  sudo systemctl reload nginx
  echo "nginx.conf atualizado pra incluir ${FORGEDESK_SITES_DIR}/*.conf"
else
  echo "nginx.conf já inclui forgedesk-sites — pulando."
fi

log "Configurando sudo restrito (só reload do nginx + certbot)"
# O Core roda como usuário sem privilégio de propósito. Essas duas linhas são
# a ÚNICA elevação que ele ganha — nada além de recarregar o nginx e rodar o
# certbot (usado quando um domínio é anexado a um projeto pela API). O
# certbot precisa de argumentos livres (*) porque cada emissão passa domínio/
# e-mail diferentes; ainda assim ele só sabe emitir/renovar certificado, não
# dá acesso geral de root.
SYSTEMCTL_BIN=$(command -v systemctl)
CERTBOT_BIN=$(command -v certbot)
SUDOERS_TMP=$(mktemp)
echo "$USER ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} reload nginx, ${CERTBOT_BIN} *" > "$SUDOERS_TMP"
if sudo visudo -c -f "$SUDOERS_TMP" > /dev/null 2>&1; then
  sudo install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/forgedesk
  echo "Regra criada em /etc/sudoers.d/forgedesk."
else
  echo "Regra de sudoers gerada é inválida — abortando sem tocar em /etc/sudoers.d." >&2
  rm -f "$SUDOERS_TMP"
  exit 1
fi
rm -f "$SUDOERS_TMP"

log "Instalando dependências do monorepo"
npm install

log "Buildando pacotes compartilhados e a API"
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api

# --- Domínio do ForgeDesk em si (opcional) ---------------------------------
# Isso é só pra você acessar o painel do ForgeDesk por um domínio em vez do
# IP puro — totalmente opcional, o resto do script funciona sem isso.
DOMAIN=""
LETSENCRYPT_EMAIL=""
PUBLIC_IP=$(curl -s ifconfig.me || echo "SEU_IP")

log "Domínio do próprio ForgeDesk (opcional)"
read -rp "Domínio pra acessar o painel do ForgeDesk? (deixe em branco pra usar só http://${PUBLIC_IP}:3000): " DOMAIN
if [ -n "$DOMAIN" ]; then
  read -rp "E-mail pra avisos de renovação do Let's Encrypt: " LETSENCRYPT_EMAIL
  BASE_WEB_URL="https://${DOMAIN}"
  BASE_API_URL="https://${DOMAIN}/api"
else
  BASE_WEB_URL="http://${PUBLIC_IP}:3000"
  BASE_API_URL="http://${PUBLIC_IP}:3001"
fi

log "Configurando .env da API"
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET}#" apps/api/.env
  sed -i "s#^FORGEDESK_WEB_URL=.*#FORGEDESK_WEB_URL=${BASE_WEB_URL}#" apps/api/.env
  sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=${BASE_WEB_URL}#" apps/api/.env
  echo "apps/api/.env criado — JWT_SECRET, FORGEDESK_WEB_URL e CORS_ORIGINS preenchidos automaticamente."
  echo "IMPORTANTE: falta preencher GITHUB_APP_SLUG, GITHUB_APP_ID e GITHUB_APP_PRIVATE_KEY em apps/api/.env"
  echo "(veja as instruções de cadastro do GitHub App no README) antes de continuar."
  read -rp "Pressione ENTER depois de editar apps/api/.env para continuar..."
else
  echo "apps/api/.env já existe — não mexi nele."
fi

log "Configurando .env da Web"
if [ ! -f apps/web/.env ]; then
  cp apps/web/.env.example apps/web/.env
  sed -i "s#^NEXT_PUBLIC_API_URL=.*#NEXT_PUBLIC_API_URL=${BASE_API_URL}#" apps/web/.env
  echo "apps/web/.env criado com NEXT_PUBLIC_API_URL=${BASE_API_URL}."
else
  echo "apps/web/.env já existe — não mexi nele."
fi

log "Buildando a Web"
npm run build --workspace=apps/web

log "Rodando migrations do banco (produção, não-interativo)"
(cd apps/api && npx prisma migrate deploy)

log "Configurando firewall (ufw)"
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"  # 80/443 — pros domínios dos projetos e/ou do ForgeDesk
sudo ufw allow 3000/tcp      # Web do ForgeDesk direto pelo IP
sudo ufw allow 3001/tcp      # API do ForgeDesk direto pelo IP
sudo ufw --force enable

log "Subindo o Core via PM2"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

if [ -n "$DOMAIN" ]; then
  log "Configurando site + TLS do ForgeDesk (${DOMAIN})"
  NGINX_SITE=/etc/nginx/sites-available/forgedesk
  sudo tee "$NGINX_SITE" > /dev/null <<NGINXCONF
server {
  listen 80;
  server_name ${DOMAIN};

  location /socket.io/ {
    proxy_pass http://127.0.0.1:3001/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3001/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINXCONF

  sudo ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/forgedesk
  [ -f /etc/nginx/sites-enabled/default ] && sudo rm /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl reload nginx

  log "Emitindo certificado TLS do ForgeDesk (Let's Encrypt)"
  # --nginx edita o server block acima pra 443 + redirect automaticamente.
  # certbot já instala o timer de renovação automática (systemd), não precisa de cron.
  sudo certbot --nginx -d "$DOMAIN" -m "$LETSENCRYPT_EMAIL" --agree-tos --redirect -n

  log "Pronto! Acesse https://${DOMAIN} pra criar a conta de admin."
else
  log "Pronto! Acesse http://${PUBLIC_IP}:3000 pra criar a conta de admin."
fi
echo "Pra domínio de PROJETOS implantados: use a aba Resumo → Domínio personalizado, dentro do próprio ForgeDesk."
if [ -n "$DOMAIN" ]; then
  echo "Lembre-se de atualizar as URLs do GitHub App (Homepage/Callback) pra apontar pra ${BASE_WEB_URL}."
fi
