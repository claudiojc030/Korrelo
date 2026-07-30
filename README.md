[🇺🇸 English](README.en.md) | 🇧🇷 Português

# Korrelo

Web OS pra gerenciar uma VPS sem precisar de SSH/CLI. Importe repositórios do
GitHub, implante com um clique, gerencie bancos de dados, cron jobs, domínios
e monitore tudo pelo navegador.

- **Core** (`apps/api` + `apps/web`) roda direto na VPS via [PM2](https://pm2.keymetrics.io/), sem privilégio de root.
- **Projetos hospedados** rodam em containers Docker isolados, cada um com seu próprio banco (opcional), domínio e cron.
- Autenticação com 2FA (TOTP), refresh tokens rotativos e sessões revogáveis.

## Antes de começar

- Uma VPS Ubuntu 22.04+ limpa, com acesso SSH por chave (não por senha).
- Pelo menos **1 GB de RAM** (2 GB+ recomendado se for hospedar mais de 1-2 projetos, já que cada container consome memória própria, além do Core).
- Um domínio (opcional). Dá pra acessar só pelo IP, mas com domínio o Korrelo consegue emitir HTTPS automático (Let's Encrypt) pra si mesmo e pra cada projeto implantado.

## 1. Instale na VPS

```bash
ssh seu-usuario@SEU_IP
curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh | bash
```

Prefere revisar o script antes de rodar (recomendado se você não confia cegamente
em `curl | bash`)? Baixe e leia primeiro:

```bash
curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

Ou clone na mão, sem o instalador:

```bash
git clone https://github.com/claudiojc030/Korrelo.git korrelo
cd korrelo
bash scripts/setup-vps.sh
```

Qualquer um dos três caminhos acima termina rodando o `setup-vps.sh`, que faz
tudo sozinho: atualiza o sistema, cria swap (se a
RAM for pequena), instala Node 20, Docker, PM2, nginx, certbot, configura
firewall (ufw), hardening de SSH (fail2ban + desativa login por senha, **só**
se detectar uma chave já cadastrada), desativa serviços de SO desnecessários,
builda o Core, roda as migrations, sobe tudo via PM2 e agenda backup diário.

Em dois momentos ele **para e pede informação sua**:

1. **Domínio (opcional)**: deixe em branco pra acessar só pelo IP.
2. **GitHub App**: pode deixar pra depois, sem problema, veja abaixo.

## 2. Conectando o GitHub

O GitHub App é o que permite o Korrelo listar seus repositórios e receber
webhook de push (deploy automático). Sem ele, dá pra usar tudo o resto do
Korrelo normalmente, só a importação/auto-deploy via GitHub fica indisponível.
Não precisa configurar isso durante o `setup-vps.sh`, só apertar ENTER pra
seguir sem domínio e cuidar disso depois, com calma.

**Jeito fácil (recomendado)**: no dashboard do Korrelo, em "Primeiros passos",
clique em **"Criar GitHub App automaticamente"**. Isso te leva direto pro
GitHub com nome, permissões e webhook já preenchidos (fluxo de "manifest" do
GitHub), você só confirma a criação, o Korrelo recebe as credenciais de
volta sozinho (App ID, chave privada, webhook secret) e já te leva pra tela
de instalar o App nos repositórios que quiser. Sem copiar nada na mão.

**Jeito manual** (se preferir controlar cada campo):

1. Acesse **github.com/settings/apps/new** (conta pessoal) ou
   `github.com/organizations/SUA_ORG/settings/apps/new` (organização).
2. Preencha:
   - **GitHub App name**: qualquer nome único (ex: `korrelo-seu-usuario`).
   - **Homepage URL**: a URL do seu Korrelo (`https://SEU_DOMINIO` ou `http://SEU_IP:3000`).
   - **Callback URL**: mesma URL acima.
   - **Setup URL (optional)**: marque "Redirect on update" e coloque
     `https://SEU_DOMINIO/api/github/callback` (ou `http://SEU_IP:3001/github/callback` sem domínio).
     Sem isso o GitHub não te manda de volta pro Korrelo depois de instalar o App.
   - **Webhook → Active**: marque, e em **Webhook URL** coloque
     `https://SEU_DOMINIO/api/github/webhook` (ou `http://SEU_IP:3001/github/webhook` sem domínio).
   - **Webhook secret**: gere um valor aleatório qualquer e anote, vai virar `GITHUB_APP_WEBHOOK_SECRET`.
   - **Permissions → Repository permissions**: `Contents: Read-only` (é o que libera o evento `Push` abaixo; `Metadata: Read-only` já vem marcado sozinho).
   - **Subscribe to events**: marque `Push` (só aparece depois de marcar a permissão de Contents acima).
   - **Where can this GitHub App be installed?**: "Only on this account" é suficiente.
3. Crie o App. Na página dele:
   - Anote o **App ID** (topo da página) → `GITHUB_APP_ID`.
   - Anote o **slug** (aparece na URL, ex: `korrelo-seu-usuario`) → `GITHUB_APP_SLUG`.
   - Em **Private keys**, clique **Generate a private key**. Isso baixa um arquivo `.pem`.
4. Instale o App na sua conta/organização (botão **Install App**), autorizando os repositórios que quiser gerenciar pelo Korrelo (ou todos).
5. No `apps/api/.env`, preencha:
   ```
   GITHUB_APP_SLUG=korrelo-seu-usuario
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----"
   GITHUB_APP_WEBHOOK_SECRET=o-segredo-que-voce-gerou
   ```
   O conteúdo do `.pem` precisa virar **uma linha só**, com `\n` no lugar de
   cada quebra de linha real. Forma rápida de gerar isso:
   ```bash
   awk 'BEGIN{ORS="\\n"} {print}' caminho/para/sua-chave.pem
   ```
6. Reinicie a API pra ela reler o arquivo: `pm2 restart korrelo-api`.

## 3. Acessando o Korrelo

Ao final do script, ele mostra a URL de acesso:

- **Com domínio**: `https://SEU_DOMINIO`
- **Sem domínio**: `http://SEU_IP:3000`

Abra essa URL no navegador. Como ainda não existe nenhuma conta, você cai
direto na tela de criação da conta de administrador (usuário + senha). Essa é
a **única conta** que existe no Korrelo hoje (single-admin), então guarde bem
essa senha.

**Recomendado logo de cara**: entre em **Segurança** e ative o 2FA (TOTP).
Leva 1 minuto e evita que uma senha vazada seja suficiente pra alguém entrar.

A partir daí:
- **Projetos** → "Importar do GitHub" (se configurou o App) ou crie manualmente com a URL do repositório.
- Cada projeto tem abas próprias: Resumo, Variáveis de Ambiente, Banco de Dados, Terminal, Logs, Arquivos, Cron, Configurações.
- **Dashboard** mostra CPU/memória/disco do servidor (com histórico) e consumo por projeto.
- `Ctrl+K` (ou `Cmd+K` no Mac) abre uma busca rápida pra navegar entre páginas e projetos.

## Atualizando o Korrelo

**Jeito fácil**: quando houver uma atualização disponível, aparece um aviso
no dashboard com o botão **"Atualizar agora"**, que roda tudo sozinho (com
barra de progresso e log em tempo real) e reinicia o painel no final.

**Jeito manual** (via SSH, ex. pra rodar antes de o botão existir na sua instalação):

```bash
cd korrelo
git pull
npm install
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api
npm run build --workspace=apps/web
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
(cd apps/api && npx prisma migrate deploy)
pm2 restart ecosystem.config.js
```

## Segurança

- **Login em duas etapas (2FA)**: ative em Segurança → Autenticação em duas
  etapas. Recomendado ligar assim que criar a conta.
- **Variáveis de ambiente de projeto** ficam cifradas em repouso no banco
  (AES-256-GCM, chave própria por instalação). Se alguma variável foi gravada
  antes de existir cifra, o Korrelo cifra ela sozinho na próxima vez que for lida.
- **JWT_SECRET e ENV_ENCRYPTION_KEY** são gerados automaticamente na primeira
  instalação (`setup-vps.sh`) e, como rede de segurança extra, a própria API
  gera um valor novo sozinha se algum dos dois estiver faltando quando ela
  inicia, nunca fica sem essas chaves por esquecimento.
- **Conectar o GitHub** (manual ou automático) é protegido contra links
  forjados: o Korrelo só completa esse fluxo se ele foi iniciado pela sua
  própria sessão logada, então não dá pra alguém te enganar clicando num link
  pra sequestrar sua integração com o GitHub.

## Backup

Configurado automaticamente pelo `setup-vps.sh`: todo dia às 3h, roda
`scripts/backup.sh` (banco do Core + bancos gerenciados por projeto) e guarda
os últimos 7 dias em `~/korrelo-backups`. Pra rodar na mão:

```bash
bash scripts/backup.sh
```

Configurável via `apps/api/.env` (`BACKUP_DIR`, `BACKUP_RETENTION_DAYS`,
`BACKUP_ALERT_NTFY_TOPIC` pra ser avisado no celular se falhar,
`BACKUP_RCLONE_REMOTE` pra copiar pra fora da VPS, ex: Google Drive).

## Solução de problemas

```bash
pm2 status                    # os dois processos (korrelo-api, korrelo-web) devem estar "online"
pm2 logs korrelo-api        # logs da API em tempo real
pm2 logs korrelo-web        # logs do frontend
pm2 restart ecosystem.config.js
```

- **Não consigo acessar pela URL**: confira `sudo ufw status` (portas 80/443 e 3000/3001 devem estar liberadas) e `pm2 status`.
- **Deploy automático via push não funciona**: confira se o `GITHUB_APP_WEBHOOK_SECRET` no `apps/api/.env` bate exatamente com o das settings do GitHub App, e se a Webhook URL lá aponta pro seu domínio/IP correto.
- **Erro de banco após atualizar**: rode `cd apps/api && npx prisma migrate deploy` de novo.

## Testar localmente (sem VPS)

O jeito "de verdade" de usar o Korrelo é numa VPS (seção 1 acima), mas dá pra
rodar tudo na sua própria máquina (**Windows, Mac ou Linux**) em modo de
desenvolvimento, só pra conhecer a interface antes de decidir hospedar numa
VPS.

**Pré-requisitos:**
- [Node.js 20+](https://nodejs.org)
- Git
- Docker Desktop (opcional, só necessário se você quiser testar o deploy de
  um projeto de verdade; pra só navegar pela interface do Korrelo não
  precisa)

**Passo a passo:**

1. Clone o repositório:
   ```bash
   git clone https://github.com/SEU_USUARIO/Korrelo.git korrelo
   cd korrelo
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Copie os arquivos de ambiente:
   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env
   ```
   Abra `apps/api/.env` e preencha `JWT_SECRET` e `ENV_ENCRYPTION_KEY` com
   valores aleatórios (funciona igual no Windows, Mac ou Linux, é só rodar no
   terminal onde o Node.js estiver disponível):
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENV_ENCRYPTION_KEY
   ```
4. Rode as migrations (SQLite local, não precisa instalar Postgres nem Docker
   pro banco do Core):
   ```bash
   npm run build --workspace=packages/shared-types
   cd apps/api && npx prisma migrate dev && cd ../..
   ```
5. Suba os dois processos, cada um no seu terminal:
   ```bash
   npm run dev:api    # apps/api em modo watch (porta 3001)
   npm run dev:web    # apps/web em modo dev (porta 3000)
   ```
6. Acesse **http://localhost:3000** e crie a conta de administrador.

Nesse modo o GitHub App e o backup automático não ficam configurados (isso é
coisa do `setup-vps.sh`), mas dá pra navegar por tudo, criar projetos
manualmente com a URL de um repositório, e ver o dashboard funcionando. Pra
testar o deploy de um projeto de verdade, o Docker precisa estar rodando.

Rodar os testes:

```bash
npm run test --workspace=apps/api
```

## Licença

[PolyForm Internal Use License 1.0.0](LICENSE): pode usar, modificar e rodar
livremente na sua própria VPS ou dentro da sua empresa. O que não pode é
distribuir o software ou oferecer um produto/serviço pra terceiros cujo valor
vem dele (ex: revender, ou hospedar como serviço pago).
