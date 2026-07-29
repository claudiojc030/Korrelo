#!/usr/bin/env bash
# Bootstrap de uma VPS Ubuntu limpa para rodar o Korrelo (Core via PM2 nativo,
# projetos gerenciados via Docker). Rode a partir da raiz do repo já clonado na VPS:
#   git clone <seu-fork-ou-repo> korrelo && cd korrelo && bash scripts/setup-vps.sh
set -euo pipefail

log() { echo -e "\n\033[1;32m==> $1\033[0m"; }
warn() { echo -e "\033[1;33m[aviso] $1\033[0m"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Não rode como root. Rode como um usuário normal com sudo (evita rodar o Core como root)." >&2
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
  echo "Swap já existe ou RAM > 8GB, pulando."
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

# --- nginx + certbot (sempre, mesmo sem domínio pro Korrelo em si) --------
# Isso é o motor de reverse-proxy + TLS que os PROJETOS implantados pelo
# Korrelo vão usar quando você anexar um domínio a cada um deles (aba
# Resumo → Domínio personalizado). O Korrelo continua acessível pelo IP
# puro nas portas 3000/3001 independente disso.
log "Instalando nginx + certbot"
sudo apt-get install -y nginx certbot python3-certbot-nginx

log "Instalando sqlite3 (usado no backup do banco Core)"
sudo apt-get install -y sqlite3

log "Preparando diretório de sites por projeto"
KORRELO_SITES_DIR=/etc/nginx/korrelo-sites
sudo mkdir -p "$KORRELO_SITES_DIR"
sudo chown "$USER":"$USER" "$KORRELO_SITES_DIR"
if ! grep -q "korrelo-sites" /etc/nginx/nginx.conf; then
  sudo sed -i "/include \/etc\/nginx\/conf.d\/\*.conf;/a\\	include ${KORRELO_SITES_DIR}/*.conf;" /etc/nginx/nginx.conf
  sudo nginx -t
  sudo systemctl reload nginx
  echo "nginx.conf atualizado pra incluir ${KORRELO_SITES_DIR}/*.conf"
else
  echo "nginx.conf já inclui korrelo-sites, pulando."
fi

log "Configurando sudo restrito (nginx, certbot, enable/disable de serviço)"
# O Core roda como usuário sem privilégio de propósito. Essas linhas são a
# ÚNICA elevação que ele ganha: recarregar o nginx, rodar o certbot (domínio
# de projeto), e ligar/desligar serviços do SO (aba "Serviços do sistema" no
# Korrelo). O certbot precisa de argumentos livres (*) porque cada emissão
# passa domínio/e-mail diferentes; "enable/disable --now *" também aceita
# qualquer nome de serviço no sudoers. Quem realmente restringe QUAL serviço
# pode ser tocado é a lista fechada em
# apps/api/src/modules/system-services/domain/service-catalog.ts, não esta
# regra (ela só garante que a AÇÃO fica limitada a enable/disable).
SYSTEMCTL_BIN=$(command -v systemctl)
CERTBOT_BIN=$(command -v certbot)
SUDOERS_TMP=$(mktemp)
echo "$USER ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} reload nginx, ${CERTBOT_BIN} *, ${SYSTEMCTL_BIN} enable --now *, ${SYSTEMCTL_BIN} disable --now *" > "$SUDOERS_TMP"
if sudo visudo -c -f "$SUDOERS_TMP" > /dev/null 2>&1; then
  sudo install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/korrelo
  echo "Regra criada em /etc/sudoers.d/korrelo."
else
  echo "Regra de sudoers gerada é inválida, abortando sem tocar em /etc/sudoers.d." >&2
  rm -f "$SUDOERS_TMP"
  exit 1
fi
rm -f "$SUDOERS_TMP"

log "Instalando dependências do monorepo"
npm install

log "Buildando pacotes compartilhados e a API"
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api

# --- Domínio do Korrelo em si (opcional) ---------------------------------
# Isso é só pra você acessar o painel do Korrelo por um domínio em vez do
# IP puro. Totalmente opcional, o resto do script funciona sem isso.
DOMAIN=""
LETSENCRYPT_EMAIL=""
PUBLIC_IP=$(curl -s ifconfig.me || echo "SEU_IP")

log "Domínio do próprio Korrelo (opcional)"
# Quando o script roda via 'curl | bash', o stdin já está ocupado com o
# próprio conteúdo do script, então 'read' precisa vir do /dev/tty pra
# pegar o que o usuário digita no terminal em vez de corromper o script.
if [ -r /dev/tty ]; then
  read -rp "Domínio pra acessar o painel do Korrelo? (deixe em branco pra usar só http://${PUBLIC_IP}:3000): " DOMAIN < /dev/tty
else
  echo "Sem terminal interativo disponível, seguindo sem domínio (só http://${PUBLIC_IP}:3000)."
  DOMAIN=""
fi
if [ -n "$DOMAIN" ]; then
  read -rp "E-mail pra avisos de renovação do Let's Encrypt: " LETSENCRYPT_EMAIL < /dev/tty
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
  ENV_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET}#" apps/api/.env
  sed -i "s#^ENV_ENCRYPTION_KEY=.*#ENV_ENCRYPTION_KEY=${ENV_ENCRYPTION_KEY}#" apps/api/.env
  sed -i "s#^KORRELO_WEB_URL=.*#KORRELO_WEB_URL=${BASE_WEB_URL}#" apps/api/.env
  sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=${BASE_WEB_URL}#" apps/api/.env
  echo "apps/api/.env criado. JWT_SECRET, ENV_ENCRYPTION_KEY, KORRELO_WEB_URL e CORS_ORIGINS preenchidos automaticamente."
  echo "GitHub ainda não conectado, e tudo bem: no dashboard do Korrelo, em \"Primeiros passos\","
  echo "tem um botão \"Criar GitHub App automaticamente\" que cuida disso sem precisar editar nada aqui."
else
  echo "apps/api/.env já existe, não mexi nele."
fi

log "Configurando .env da Web"
if [ ! -f apps/web/.env ]; then
  cp apps/web/.env.example apps/web/.env
  sed -i "s#^NEXT_PUBLIC_API_URL=.*#NEXT_PUBLIC_API_URL=${BASE_API_URL}#" apps/web/.env
  echo "apps/web/.env criado com NEXT_PUBLIC_API_URL=${BASE_API_URL}."
else
  echo "apps/web/.env já existe, não mexi nele."
fi

log "Buildando a Web"
npm run build --workspace=apps/web

# next.config.js usa output: "standalone". O build gera um server.js enxuto
# em .next/standalone (só as dependências realmente usadas), mas não copia
# os assets estáticos e a pasta public sozinho (é assim que o Next.js
# funciona, não é opcional). Sem isso o server sobe mas serve CSS/JS/fontes
# como 404. Rodar de novo é seguro (sobrescreve).
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
if [ -d apps/web/public ]; then
  cp -r apps/web/public apps/web/.next/standalone/apps/web/public
fi

log "Rodando migrations do banco (produção, não-interativo)"
(cd apps/api && npx prisma migrate deploy)

log "Configurando firewall (ufw)"
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"  # 80/443, pros domínios dos projetos e/ou do Korrelo
sudo ufw allow 3000/tcp      # Web do Korrelo direto pelo IP
sudo ufw allow 3001/tcp      # API do Korrelo direto pelo IP
sudo ufw --force enable

log "Hardening de acesso SSH"
AUTHORIZED_KEYS="$HOME/.ssh/authorized_keys"
if [ -s "$AUTHORIZED_KEYS" ]; then
  log "Instalando fail2ban"
  sudo apt-get install -y fail2ban
  sudo tee /etc/fail2ban/jail.local > /dev/null <<'JAILCONF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
JAILCONF
  sudo systemctl enable --now fail2ban
  sudo systemctl restart fail2ban

  log "Desabilitando login por senha no SSH (você já tem chave em authorized_keys)"
  SSHD_CONFIG=/etc/ssh/sshd_config
  SSHD_CONFIG_TMP=$(mktemp)
  sudo cp "$SSHD_CONFIG" "$SSHD_CONFIG_TMP"
  sudo sed -i \
    -e 's/^#\?PasswordAuthentication[[:space:]].*/PasswordAuthentication no/' \
    -e 's/^#\?PermitRootLogin[[:space:]].*/PermitRootLogin no/' \
    -e 's/^#\?ChallengeResponseAuthentication[[:space:]].*/ChallengeResponseAuthentication no/' \
    "$SSHD_CONFIG_TMP"
  grep -q '^PasswordAuthentication' "$SSHD_CONFIG_TMP" || echo "PasswordAuthentication no" | sudo tee -a "$SSHD_CONFIG_TMP" > /dev/null
  grep -q '^PermitRootLogin' "$SSHD_CONFIG_TMP" || echo "PermitRootLogin no" | sudo tee -a "$SSHD_CONFIG_TMP" > /dev/null

  if sudo sshd -t -f "$SSHD_CONFIG_TMP"; then
    sudo cp "$SSHD_CONFIG_TMP" "$SSHD_CONFIG"
    sudo systemctl restart ssh
    echo "SSH agora só aceita chave (login root e por senha desabilitados). fail2ban ativo."
    warn "Antes de fechar este terminal, abra OUTRO terminal e confirme que ainda consegue entrar via SSH com sua chave."
  else
    warn "Config de sshd_config gerada ficou inválida, não mexi no arquivo real por segurança. Rode este bloco manualmente depois."
  fi
  rm -f "$SSHD_CONFIG_TMP"
else
  warn "Nenhuma chave encontrada em ${AUTHORIZED_KEYS}, pulando hardening de SSH pra não te trancar fora."
  warn "Adicione sua chave pública lá e rode este script de novo (ou só essa etapa manualmente)."
fi

log "Desativando serviços de SO desnecessários pra uma VPS rodando só o Korrelo"
# Nada aqui é desinstalado (reversível, sem risco de quebrar dependência de
# pacote), só parado e desabilitado. snapd fica de fora de propósito: mexer
# nele tem risco de efeito colateral desproporcional ao pouco de RAM que
# libera numa VPS pequena.
UNNECESSARY_SERVICES=(avahi-daemon cups cups-browsed ModemManager bluetooth)
DISABLED_SERVICES=()
for svc in "${UNNECESSARY_SERVICES[@]}"; do
  if systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "${svc}.service"; then
    sudo systemctl disable --now "${svc}" > /dev/null 2>&1 || true
    DISABLED_SERVICES+=("$svc")
  fi
done
if [ "${#DISABLED_SERVICES[@]}" -gt 0 ]; then
  echo "Desativados: ${DISABLED_SERVICES[*]}"
else
  echo "Nenhum desses serviços estava presente nesta imagem, nada pra desativar."
fi

log "Subindo o Core via PM2"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

log "Configurando backup automático diário"
# Backup do banco Core + bancos gerenciados por projeto (Postgres/MongoDB
# sempre; Redis só se marcado como persistente). Guarda os últimos 7 dias por
# padrão em ~/korrelo-backups (BACKUP_RETENTION_DAYS e BACKUP_DIR
# configuráveis via apps/api/.env se quiser mudar).
REPO_DIR="$(pwd)"
BACKUP_LOG="$HOME/korrelo-backups/backup.log"
mkdir -p "$(dirname "$BACKUP_LOG")"
BACKUP_CRON_LINE="0 3 * * * cd ${REPO_DIR} && bash scripts/backup.sh >> ${BACKUP_LOG} 2>&1"
(crontab -l 2>/dev/null | grep -v "scripts/backup.sh"; echo "$BACKUP_CRON_LINE") | crontab -
echo "Backup agendado todo dia às 3h. Rode manualmente com: bash scripts/backup.sh"

log "Alerta de falha de backup (opcional)"
if [ -r /dev/tty ]; then
  read -rp "Tópico do ntfy.sh pra avisar se o backup falhar? (deixe em branco pra pular, ex: korrelo-backup-$(whoami)-$(hostname)): " NTFY_TOPIC < /dev/tty
else
  NTFY_TOPIC=""
fi
if [ -n "$NTFY_TOPIC" ]; then
  if ! grep -q "^BACKUP_ALERT_NTFY_TOPIC=" apps/api/.env 2>/dev/null; then
    echo "BACKUP_ALERT_NTFY_TOPIC=${NTFY_TOPIC}" >> apps/api/.env
  else
    sed -i "s#^BACKUP_ALERT_NTFY_TOPIC=.*#BACKUP_ALERT_NTFY_TOPIC=${NTFY_TOPIC}#" apps/api/.env
  fi
  echo "Configurado. Instale o app ntfy (ntfy.sh) no celular e inscreva-se no tópico '${NTFY_TOPIC}' pra receber o aviso."
else
  echo "Pulado. Se o backup diário falhar, só vai aparecer no log (${BACKUP_LOG})."
fi

log "Backup externo: Google Drive via rclone (opcional)"
if [ -r /dev/tty ]; then
  read -rp "Quer copiar os backups pro seu Google Drive também? [s/N]: " SETUP_RCLONE < /dev/tty
else
  SETUP_RCLONE=""
fi
if [[ "$SETUP_RCLONE" =~ ^[sS] ]]; then
  if ! command -v rclone &> /dev/null; then
    curl -fsSL https://rclone.org/install.sh | sudo bash
  else
    echo "rclone já instalado."
  fi
  echo "Agora vamos configurar o remote 'gdrive'. O rclone vai te dar um link:"
  echo "abra ele em QUALQUER navegador (seu celular/notebook, não precisa ser aqui na VPS),"
  echo "autorize com sua conta Google, e cole o código de volta aqui quando pedir."
  rclone config create gdrive drive scope drive.file || warn "Configuração do rclone não concluída, rode 'rclone config' manualmente depois."
  if ! grep -q "^BACKUP_RCLONE_REMOTE=" apps/api/.env 2>/dev/null; then
    echo "BACKUP_RCLONE_REMOTE=gdrive" >> apps/api/.env
  else
    sed -i "s#^BACKUP_RCLONE_REMOTE=.*#BACKUP_RCLONE_REMOTE=gdrive#" apps/api/.env
  fi
  echo "Backups agora também são copiados pra uma pasta 'korrelo-backups' no seu Google Drive."
else
  echo "Pulado. Pra ligar depois: instale o rclone, rode 'rclone config' criando um remote"
  echo "chamado 'gdrive' (ou outro nome), e adicione BACKUP_RCLONE_REMOTE=<nome> em apps/api/.env."
fi

if [ -n "$DOMAIN" ]; then
  log "Configurando site + TLS do Korrelo (${DOMAIN})"
  NGINX_SITE=/etc/nginx/sites-available/korrelo
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

  sudo ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/korrelo
  [ -f /etc/nginx/sites-enabled/default ] && sudo rm /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl reload nginx

  log "Emitindo certificado TLS do Korrelo (Let's Encrypt)"
  # --nginx edita o server block acima pra 443 + redirect automaticamente.
  # certbot já instala o timer de renovação automática (systemd), não precisa de cron.
  sudo certbot --nginx -d "$DOMAIN" -m "$LETSENCRYPT_EMAIL" --agree-tos --redirect -n

  log "Pronto! Acesse https://${DOMAIN} pra criar a conta de admin."
else
  log "Pronto! Acesse http://${PUBLIC_IP}:3000 pra criar a conta de admin."
fi
echo "Pra domínio de PROJETOS implantados: use a aba Resumo → Domínio personalizado, dentro do próprio Korrelo."
if [ -n "$DOMAIN" ]; then
  echo "Lembre-se de atualizar as URLs do GitHub App (Homepage/Callback) pra apontar pra ${BASE_WEB_URL}."
fi
