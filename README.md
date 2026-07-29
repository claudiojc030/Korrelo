# ForgeDesk

Web OS pra gerenciar uma VPS sem precisar de SSH/CLI. Importe repositórios do
GitHub, implante com um clique, gerencie bancos de dados, cron jobs, domínios
e monitore tudo pelo navegador.

- **Core** (`apps/api` + `apps/web`) roda direto na VPS via [PM2](https://pm2.keymetrics.io/), sem privilégio de root.
- **Projetos hospedados** rodam em containers Docker isolados, cada um com seu próprio banco (opcional), domínio e cron.
- Autenticação com 2FA (TOTP), refresh tokens rotativos e sessões revogáveis.

## Antes de começar

- Uma VPS Ubuntu 22.04+ limpa, com acesso SSH por chave (não por senha).
- Pelo menos **1 GB de RAM** (2 GB+ recomendado se for hospedar mais de 1-2 projetos, já que cada container consome memória própria, além do Core).
- Um domínio (opcional). Dá pra acessar só pelo IP, mas com domínio o ForgeDesk consegue emitir HTTPS automático (Let's Encrypt) pra si mesmo e pra cada projeto implantado.

## 1. Suba o repositório na VPS

```bash
ssh seu-usuario@SEU_IP
git clone https://github.com/SEU_USUARIO/ForgeDesk.git forgedesk
cd forgedesk
bash scripts/setup-vps.sh
```

O script `setup-vps.sh` faz tudo sozinho: atualiza o sistema, cria swap (se a
RAM for pequena), instala Node 20, Docker, PM2, nginx, certbot, configura
firewall (ufw), hardening de SSH (fail2ban + desativa login por senha, **só**
se detectar uma chave já cadastrada), desativa serviços de SO desnecessários,
builda o Core, roda as migrations, sobe tudo via PM2 e agenda backup diário.

Em dois momentos ele **para e pede informação sua**:

1. **Domínio (opcional)**: deixe em branco pra acessar só pelo IP.
2. **GitHub App**: abre o `apps/api/.env` pra você preencher e pausa
   esperando você terminar. Veja como cadastrar abaixo.

## 2. Cadastrando o GitHub App

O GitHub App é o que permite o ForgeDesk listar seus repositórios e receber
webhook de push (deploy automático). Sem ele, dá pra usar tudo o resto do
ForgeDesk normalmente, só a importação/auto-deploy via GitHub fica indisponível.

1. Acesse **github.com/settings/apps/new** (conta pessoal) ou
   `github.com/organizations/SUA_ORG/settings/apps/new` (organização).
2. Preencha:
   - **GitHub App name**: qualquer nome único (ex: `forgedesk-seu-usuario`).
   - **Homepage URL**: a URL do seu ForgeDesk (`https://SEU_DOMINIO` ou `http://SEU_IP:3000`).
   - **Callback URL**: mesma URL acima.
   - **Webhook → Active**: marque, e em **Webhook URL** coloque
     `https://SEU_DOMINIO/api/github/webhook` (ou `http://SEU_IP:3001/github/webhook` sem domínio).
   - **Webhook secret**: gere um valor aleatório qualquer e anote, vai virar `GITHUB_APP_WEBHOOK_SECRET`.
   - **Permissions → Repository permissions**: `Contents: Read-only` (é o que libera o evento `Push` abaixo; `Metadata: Read-only` já vem marcado sozinho).
   - **Subscribe to events**: marque `Push` (só aparece depois de marcar a permissão de Contents acima).
   - **Where can this GitHub App be installed?**: "Only on this account" é suficiente.
3. Crie o App. Na página dele:
   - Anote o **App ID** (topo da página) → `GITHUB_APP_ID`.
   - Anote o **slug** (aparece na URL, ex: `forgedesk-seu-usuario`) → `GITHUB_APP_SLUG`.
   - Em **Private keys**, clique **Generate a private key**. Isso baixa um arquivo `.pem`.
4. Instale o App na sua conta/organização (botão **Install App**), autorizando os repositórios que quiser gerenciar pelo ForgeDesk (ou todos).
5. No `apps/api/.env` que o script deixou aberto, preencha:
   ```
   GITHUB_APP_SLUG=forgedesk-seu-usuario
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----"
   GITHUB_APP_WEBHOOK_SECRET=o-segredo-que-voce-gerou
   ```
   O conteúdo do `.pem` precisa virar **uma linha só**, com `\n` no lugar de
   cada quebra de linha real. Forma rápida de gerar isso:
   ```bash
   awk 'BEGIN{ORS="\\n"} {print}' caminho/para/sua-chave.pem
   ```
6. Salve o arquivo e volte pro terminal onde `setup-vps.sh` está esperando, e aperte ENTER pra continuar.

## 3. Acessando o ForgeDesk

Ao final do script, ele mostra a URL de acesso:

- **Com domínio**: `https://SEU_DOMINIO`
- **Sem domínio**: `http://SEU_IP:3000`

Abra essa URL no navegador. Como ainda não existe nenhuma conta, você cai
direto na tela de criação da conta de administrador (e-mail + senha). Essa é
a **única conta** que existe no ForgeDesk hoje (single-admin), então guarde bem
essa senha.

**Recomendado logo de cara**: entre em **Segurança** e ative o 2FA (TOTP).
Leva 1 minuto e evita que uma senha vazada seja suficiente pra alguém entrar.

A partir daí:
- **Projetos** → "Importar do GitHub" (se configurou o App) ou crie manualmente com a URL do repositório.
- Cada projeto tem abas próprias: Resumo, Variáveis de Ambiente, Banco de Dados, Terminal, Logs, Arquivos, Cron, Configurações.
- **Dashboard** mostra CPU/memória/disco do servidor (com histórico) e consumo por projeto.
- `Ctrl+K` (ou `Cmd+K` no Mac) abre uma busca rápida pra navegar entre páginas e projetos.

## Atualizando o ForgeDesk

```bash
cd forgedesk
git pull
npm install
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api
npm run build --workspace=apps/web
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
(cd apps/api && npx prisma migrate deploy)
pm2 restart ecosystem.config.js
```

## Backup

Configurado automaticamente pelo `setup-vps.sh`: todo dia às 3h, roda
`scripts/backup.sh` (banco do Core + bancos gerenciados por projeto) e guarda
os últimos 7 dias em `~/forgedesk-backups`. Pra rodar na mão:

```bash
bash scripts/backup.sh
```

Configurável via `apps/api/.env` (`BACKUP_DIR`, `BACKUP_RETENTION_DAYS`,
`BACKUP_ALERT_NTFY_TOPIC` pra ser avisado no celular se falhar,
`BACKUP_RCLONE_REMOTE` pra copiar pra fora da VPS, ex: Google Drive).

## Solução de problemas

```bash
pm2 status                    # os dois processos (forgedesk-api, forgedesk-web) devem estar "online"
pm2 logs forgedesk-api        # logs da API em tempo real
pm2 logs forgedesk-web        # logs do frontend
pm2 restart ecosystem.config.js
```

- **Não consigo acessar pela URL**: confira `sudo ufw status` (portas 80/443 e 3000/3001 devem estar liberadas) e `pm2 status`.
- **Deploy automático via push não funciona**: confira se o `GITHUB_APP_WEBHOOK_SECRET` no `apps/api/.env` bate exatamente com o das settings do GitHub App, e se a Webhook URL lá aponta pro seu domínio/IP correto.
- **Erro de banco após atualizar**: rode `cd apps/api && npx prisma migrate deploy` de novo.

## Desenvolvimento local

```bash
npm install
npm run build --workspace=packages/shared-types
npm run dev:api    # apps/api em modo watch (porta 3001)
npm run dev:web    # apps/web em modo dev (porta 3000)
```

Copie `apps/api/.env.example` → `apps/api/.env` e `apps/web/.env.example` →
`apps/web/.env` antes de rodar (SQLite local, sem precisar de Docker pro banco
do Core, só os projetos gerenciados usam Docker).

Rodar os testes:

```bash
npm run test --workspace=apps/api
```
