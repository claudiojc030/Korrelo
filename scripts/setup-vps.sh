#!/usr/bin/env bash
# Bootstrap de uma VPS Ubuntu limpa para rodar o ForgeDesk (Core via PM2 nativo,
# projetos gerenciados via Docker). Rode a partir da raiz do repo já clonado na VPS:
#   git clone <seu-fork-ou-repo> forgedesk && cd forgedesk && bash scripts/setup-vps.sh
set -euo pipefail

log() { echo -e "\n\033[1;32m==> $1\033[0m"; }

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

log "Instalando dependências do monorepo"
npm install

log "Buildando os pacotes"
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api
npm run build --workspace=apps/web

log "Verificando .env da API"
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET}#" apps/api/.env
  echo "apps/api/.env criado com JWT_SECRET gerado automaticamente."
  echo "IMPORTANTE: edite apps/api/.env agora e preencha GITHUB_APP_* e FORGEDESK_WEB_URL"
  echo "(FORGEDESK_WEB_URL deve ser http://SEU_IP:3000) antes de continuar."
  read -rp "Pressione ENTER depois de editar apps/api/.env para continuar..."
else
  echo "apps/api/.env já existe — não mexi nele."
fi

log "Verificando .env da Web"
if [ ! -f apps/web/.env ]; then
  cp apps/web/.env.example apps/web/.env
  echo "apps/web/.env criado a partir do exemplo."
  echo "IMPORTANTE: edite apps/web/.env e defina NEXT_PUBLIC_API_URL=http://SEU_IP:3001"
  echo "antes de continuar — esse valor fica gravado no build e não pode ser trocado depois só reiniciando."
  read -rp "Pressione ENTER depois de editar apps/web/.env para continuar..."
  log "Rebuildando a Web com a URL correta"
  npm run build --workspace=apps/web
else
  echo "apps/web/.env já existe — não mexi nele."
fi

log "Rodando migrations do banco (produção, não-interativo)"
(cd apps/api && npx prisma migrate deploy)

log "Configurando firewall (ufw)"
sudo ufw allow OpenSSH
sudo ufw allow 3000/tcp   # Web
sudo ufw allow 3001/tcp   # API
sudo ufw --force enable

log "Subindo o Core via PM2"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

log "Pronto! Acesse http://$(curl -s ifconfig.me):3000 pra criar a conta de admin."
echo "Lembre-se de atualizar as URLs do GitHub App (Homepage/Callback) pra apontar pro IP/domínio desta VPS."
