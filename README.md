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

A maioria das VPS (Hostinger, DigitalOcean, etc.) só te dá acesso como `root`
por padrão. O instalador **recusa rodar como root** de propósito (roda o Core
sem privilégio, por segurança), então antes de tudo crie um usuário comum com
sudo:

```bash
ssh root@SEU_IP
adduser seu-usuario
usermod -aG sudo seu-usuario
exit
```

Aí conecta de novo já com esse usuário e roda o instalador:

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

## Domínio personalizado por projeto

Cada projeto implantado pode ter seu próprio domínio (ex: `pingzen.com.br`),
com HTTPS automático. Passo a passo:

1. **Fora do Korrelo**: no painel do lugar onde você registrou o domínio
   (Registro.br, GoDaddy, Namecheap, Cloudflare etc.), crie um registro **A**
   apontando o domínio (ou subdomínio, ex: `app.pingzen.com.br`) pro **IP
   público da sua VPS**.
2. Espere o DNS propagar (geralmente minutos, pode levar algumas horas
   dependendo do provedor).
3. **No Korrelo**: abra o projeto → aba **Resumo** → card "Domínio
   personalizado" → digite o domínio → clique em **Anexar**.
4. Pronto. O Korrelo configura o nginx e emite o certificado TLS (Let's
   Encrypt) sozinho, automaticamente.

Se o certificado falhar (geralmente porque o DNS ainda não propagou), o
Korrelo desfaz a configuração e mostra o erro, sem deixar nada quebrado. Só
tentar anexar de novo depois que o DNS já resolver pro IP da VPS.

## Como o deploy funciona (fila global, memória e rollback)

O Korrelo foi feito pra rodar numa VPS pequena (1 vCPU / 4 GB), então o
deploy tem regras pra não derrubar o que já está no ar:

- **Fila global**: só acontece **um deploy por vez** na VPS inteira. Os
  outros ficam na fila (a ordem é FIFO). O estado da fila fica no banco do
  Core, então um reinício da API não perde deploy nenhum.
- **Antes de buildar**, o Korrelo confere memória livre, swap, disco e se o
  Docker está respondendo. Sem folga, o deploy volta pra fila e espera (a
  produção não é tocada).
- **Orçamento de memória**: app, banco e container de teste dividem a mesma
  fatia da RAM disponível (depois das reservas do host, do Core e do
  Docker). Nenhum container recebe "quase toda a RAM" da VPS. Dá pra
  ajustar pelas variáveis de ambiente no `apps/api/.env` (veja o
  `.env.example`).
- **Instância de teste**: o deploy builda e sobe uma instância de teste com
  a imagem tagueada pelo commit. Só depois que ela responde é que a
  produção é trocada. A instância de teste é temporária: não reinicia
  sozinha e é removida no fim (inclusive se o deploy falhar).
- **Rollback**: se a versão nova não responder em produção, o Korrelo volta
  pra imagem anterior (que continua no servidor) e registra o deploy como
  revertido. Rollback é de **aplicação**: volume e banco não são tocados.
  Se o deploy tiver um migration incompatível, o rollback pode não ser
  suficiente - nesse caso o painel avisa.
- **Deploy falho não derruba a aplicação**: o estado da aplicação (rodando
  ou não) é separado do estado do último deploy. Cron, backup e terminal
  continuam funcionando enquanto a versão antiga está no ar.

Os deploys ficam registrados na aba "Deploys" de cada projeto, e a fila
pode ser inspecionada em `/deploy-jobs` (e os contadores em
`/deploy-jobs/stats`).

### Projetos que já estão rodando (grandfathering)

Atualizar o Korrelo **não** muda nada nos containers que já existem:

- o limite de memória, a imagem, a política de restart, as redes, as portas
  e os volumes do container de produção são preservados;
- o Korrelo apenas **lê** o estado atual do Docker (no boot) e registra no
  banco do Core o que encontrou (limite, imagem, restart policy, redes,
  portas) — é metadado, nada é aplicado no Docker;
- um projeto que já roda **nunca** tem a memória diminished sozinha: mesmo
  que a fórmula nova calcule um limite menor, o que vale é o limite
  observado. Diminuir o limite de uma aplicação no ar exige confirmação
  explícita nas Configurações do projeto;
- o budget de banco é **total por projeto** e dividido entre os bancos
  (Postgres + Redis não recebem o budget inteiro cada um), mas um banco que
  já roda mantém o limite que tem;
- nenhum deploy é disparado na atualização: jobs que estavam na fila antes
  do restart ficam **pausados** (retome em `/deploy-jobs/:id/resume`).

Para conferir o que mudaria na sua VPS **sem aplicar nada**:

```bash
curl -s https://SEU_DOMINIO/api/deploy-jobs/dry-run | jq
```

A saída mostra, por projeto, o limite atual, o limite que a fórmula nova
calcularia, o limite efetivo (o que valeria), os limites dos bancos, se
existe divergência entre o Core e o Docker e se um deploy seria possível
agora (e por quê não).

### O deploy nunca para a produção para compilar

O fluxo do deploy é sempre:

```
CURRENT continua atendendo
  ↓ preflight (RAM, disco, Docker, builds ativos)
  ↓ espera o host ficar seguro (cooldown)
  ↓ build do CANDIDATO (imagem versionada por commit)
  ↓ container de TESTE (staging) em rede/porta separadas
  ↓ health do CANDIDATO
  ↓ só então PROMOVE (troca o container de produção)
  ↓ health da produção
  ↓ rollback (imagem anterior, sem rebuild) se a nova versão falhar
```

O container **CURRENT** (Mesatta, Evolution) **não é parado, recriado nem
reiniciado** em nenhum momento do build ou do staging. Se o build ou o
staging falhar, a versão que está no ar continua exatamente como estava
(mesmo container ID, mesmo StartedAt, mesmo RestartCount, mesmas networks e
volumes).

**Guard de recursos do build:** antes de começar o build, o Korrelo mede
MemAvailable, load, disco, **atividade de swap** e **PSI de memória**. Se o
host estiver sobrecarregado, o deploy **espera** (cooldown de 10 s, até 180 s
por padrão) em vez de derrubar a VPS. Swap usada alta **sozinha** não bloqueia
(o Linux mantém páginas antigas em swap mesmo depois da pressão passar) — o
que bloqueia é a atividade de swap e o PSI.

| env | default |
| --- | --- |
| `KORRELO_BUILD_MEM_AVAILABLE_MB` | 512 |
| `KORRELO_BUILD_LOAD1_MAX` | 1.5 |
| `KORRELO_BUILD_DISK_FREE_MB` | 2000 |
| `KORRELO_BUILD_SWAP_ACTIVITY_MAX_PAGES` | 512 |
| `KORRELO_BUILD_PSI_MEMORY_SOME_MAX` | 1 |
| `KORRELO_BUILD_PSI_MEMORY_FULL_MAX` | 0.01 |
| `KORRELO_BUILD_WAIT_TIMEOUT_SEC` | 180 |
| `KORRELO_BUILD_WAIT_INTERVAL_SEC` | 10 |

O build também roda com prioridade baixa (`nice -n 10` + `ionice -c 3`,
quando existem no host). O work pesado do build acontece dentro do daemon do
Docker, então o que de fato protege a produção é o guard de recursos.

**Dry-run do deploy** (read-only, sem tocar em Docker):
`GET /projects/:id/deploy-dry-run?commit=<sha>&branch=<branch>` mostra
projeto, commit atual/candidato, recursos do host, imagem e container atuais,
limites, banco gerenciado, staging planejado, health planejado, promoção
planejada e se há rollback disponível.

### O boot do Korrelo é somente leitura

Reiniciar ou atualizar o Korrelo **nunca** altera um container que já
existe. No boot o Korrelo só:

- lê o Docker (`docker inspect`, `docker ps`, `docker stats`);
- reconcilia metadados no banco do Core (limite, imagem, política de
  restart, redes, portas);
- detecta divergência entre o Core e o Docker;
- **detecta** container de teste órfão e registra o fato (sem remover).

Remover um container de teste acontece só em dois casos: no `finally` do
deploy que o criou, ou por ação administrativa explícita:

```bash
curl -s -X POST https://SEU_DOMINIO/api/deploy-jobs/cleanup-staging
```

Essa limpeza só alcança containers com a label efêmera **e** cujo nome é de
container de teste (`*-staging`) **e** cujo deploy não está mais em
andamento — um container de produção nunca é removido por ela.

### Limitando o consumo do build (opcional)

O build roda dentro do Docker, e o processo de build (npm/next build) fica
**fora** do limite de memória do container. O Korrelo já reduz o risco de
quatro formas: fila global (um build por vez), teto de heap no build
(`NODE_OPTIONS`), verificação de memória livre antes de começar e imagem
multi-stage. Se ainda assim o build pesar demais na sua VPS, a forma
canônica de limitar é no próprio daemon do Docker (configuração manual,
fora do Korrelo):

```json
// /etc/docker/daemon.json
{ "builder": { "gc": { "enabled": true, "reservedSpace": "2GB" } } }
```

O Korrelo **não** mexe nessa configuração sozinho.

## Guardar arquivo enviado por usuário (upload)

Todo projeto ganha automaticamente um volume persistente montado em
`/app/uploads` dentro do container, pra guardar arquivo que não é código nem
registro de banco (foto, vídeo, PDF etc. enviado por usuário). Aponte o
código da sua aplicação pra escrever ali (ex: `/app/uploads/video.mp4`).

Por que não guardar no banco: bancos de documento/relacional (MongoDB,
Postgres) não são feitos pra arquivo binário grande, isso deixa o banco
lento e infla o backup diário. `/app/uploads` sobrevive a redeploy (ao
contrário do resto do container, que é recriado do zero a cada build) e
**entra automaticamente no backup diário**, igual o banco de dados.

## Importar dados de outro MongoDB

Já usa um MongoDB gerenciado (ex: MongoDB Atlas) e quer trazer os dados pra
dentro da sua VPS? Passo a passo:

1. Provisione um banco **MongoDB** no projeto (aba **Banco de Dados**), se
   ainda não tiver um.
2. Nessa mesma aba, clique em **"Importar de outro MongoDB"**.
3. Cole a connection string do banco de origem (ex:
   `mongodb+srv://usuario:senha@cluster.mongodb.net/meubanco`) e clique em
   **Iniciar importação**.
4. Acompanhe o progresso na tela (com log em tempo real). Ao terminar, os
   dados já estão no banco MongoDB deste projeto, sem precisar trocar nada
   na connection string usada pela aplicação.

**Atenção**: isso substitui todos os dados que já estão no banco do projeto,
não é uma mesclagem. Se o banco de origem for grande, a importação pode
levar alguns minutos. Essa função depende do pacote `mongodb-database-tools`
(instalado automaticamente pelo `setup-vps.sh`); se sua VPS foi configurada
antes dessa função existir, rode `bash scripts/setup-vps.sh` de novo pra
instalar só o que falta.

## Atualizando o Korrelo

**Jeito fácil**: quando houver uma atualização disponível, aparece um aviso
no dashboard com o botão **"Atualizar agora"**, que roda tudo sozinho (com
barra de progresso e log em tempo real) e reinicia o painel no final.

O botão usa **exatamente o mesmo executor** do rollout seguro
(`apps/api/scripts/rollout/`), então tem a mesma proteção: recusa se
houver deploy de projeto em andamento, recusa se o working tree estiver
sujo, faz backup consistente do banco do Core antes da migration, tira
snapshot READ-ONLY dos containers dos projetos antes e depois (divergência =
falha crítica, sem tocar no projeto), prepara os assets do Next standalone
e reinicia só o PM2 do Core.

> **Nota técnica (validação do self-update):** o atualizador de produção roda
> **desacoplado** do processo da API (double fork, re-parentado para o
> init), de modo que um restart da API **não** encerra um update já em
> andamento. O estado do update fica persistido em
> `~/.korrelo/self-update/` e pode ser consultado depois
> (`GET /monitoring/self-update/current`).

**Jeito manual** (via SSH, ex. pra rodar antes de o botão existir na sua instalação):

```bash
cd korrelo
git pull
npm ci --include=dev
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api
npm run build --workspace=apps/web
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
(cd apps/api && npx prisma migrate deploy)
pm2 restart ecosystem.config.js
```

#### Health do Core após o restart (aguarda a API subir)

Depois do `pm2 restart korrelo-api` / `korrelo-web`, o rollout **aguarda a
API ficar saudável** em vez de consultar o health uma vez só: nos primeiros
segundos a API ainda não está escutando (ECONNREFUSED) e isso **não** é
prova de que o Core quebrou.

```
restart -> espera o delay inicial -> health -> falhou -> espera -> health ...
       -> só declara falha se a API continuar ruim durante TODA a janela
```

Defaults (configuráveis por env):

| env | default | o que é |
| --- | --- | --- |
| `KORRELO_ROLLOUT_HEALTH_TIMEOUT_SEC` | **60 s** | janela total de espera pelo health |
| `KORRELO_ROLLOUT_HEALTH_INTERVAL_SEC` | **2 s** | intervalo entre as checagens |
| `KORRELO_ROLLOUT_HEALTH_INITIAL_DELAY_SEC` | **2 s** | espera antes da 1ª checagem (o PM2 ainda está religando) |

Falhas **transitórias** (conexão recusada, timeout, socket reset, 502/503/504,
API ainda não escutando) mantêm a espera — nunca são tratadas como sucesso.
O **rollback usa a mesma estratégia**: um recovery não é marcado como falho
porque a API ainda não voltou.

### Rollout seguro (recomendado em produção)

O script `scripts/rollout-korrelo.sh` faz o rollout do Core com as
proteções que importam quando existem aplicações no ar:

```bash
# 1. Só o plano teórico (não fala com Docker nem com o banco)
bash scripts/rollout-korrelo.sh --plan

# 2. Dry-run REAL: todas as verificações somente leitura, nada é alterado
bash scripts/rollout-korrelo.sh

# 3. Executa de verdade
bash scripts/rollout-korrelo.sh --apply
```

O dry-run (padrão) é uma verificação de verdade, só de leitura: checa Git
(branch, commit, working tree, remoto e candidato local), o banco do Core
(existe, `sqlite3` acessível, jobs `DeployJob` em andamento, migrations
presentes), o host (disco, memória, Docker acessível, PM2 observável, health
da API e do web) e tira um snapshot REAL dos containers dos projetos
(Mesatta app + Mongo, Evolution app + Postgres + Redis) com Container ID,
imagem, StartedAt, RestartCount, memória, swap, restart policy, health,
redes, portas e mounts.

Ele **não escreve nada**: sem lock, sem drain, sem backup, sem `git pull`,
sem `npm ci`/`build`, sem migration, sem `chmod`, sem restart de PM2,
sem nenhum comando Docker de escrita e sem arquivo de status. Cada comando
passa por uma allowlist de leitura — um comando de escrita aborta o dry-run
com erro em vez de acontecer.

#### Guarda de recursos (proteger a produção durante o build)

O `npm ci` e os três builds (`shared-types` → `api` → `web`) rodam na
mesma VPS que hospeda Mesatta, Mongo, Evolution API, Postgres e Redis. Para
não sacrificar a produção, o rollout:

1. mede os recursos **read-only** antes do `npm ci`;
2. revalida **antes de cada build** (ci, shared, api, web) — se a
   condição piorou, o próximo build não começa;
3. compila com prioridade baixa (`nice -n 10` + `ionice -c 3`, quando
   existem) e com teto de heap próprio (`--max-old-space-size`, só nos
   processos do rollout — o `NODE_OPTIONS` do servidor não muda);
4. mantém os builds **estritamente sequenciais**.

Se faltar recurso, o rollout é adiado com
`Rollout adiado: recursos insuficientes para compilar o Core com segurança`.
Abortos antes do `git update` não disparam rollback (não houve mudança);
abortos depois dele voltam o Core ao commit anterior (rollback normal, só do
Core) — **mas o rollback também é resource-aware** (ver abaixo).

Defaults (pensados para 1 vCPU / 4 GB com os projetos rodando na mesma
máquina) e seus equivalentes por env:

| limite | default | env |
| --- | --- | --- |
| MemAvailable mínima | 1200 MB | `KORRELO_ROLLOUT_MEM_REQUIRED_MB` |
| swap em uso máxima (sinal auxiliar) | 512 MB | `KORRELO_ROLLOUT_SWAP_USED_MAX_MB` |
| atividade de swap (páginas na janela) | 512 | `KORRELO_ROLLOUT_SWAP_ACTIVITY_MAX_PAGES` |
| PSI memória (some avg10) | 1.0 | `KORRELO_ROLLOUT_PSI_MEMORY_SOME_MAX` |
| PSI memória (full avg10) | 0.01 | `KORRELO_ROLLOUT_PSI_MEMORY_FULL_MAX` |
| janela de amostragem da atividade | 1000 ms | `KORRELO_ROLLOUT_SWAP_ACTIVITY_SAMPLE_MS` |
| load average (1 min) máxima | 1.5 | `KORRELO_ROLLOUT_LOAD1_MAX` |
| disco livre mínimo | 2 GB | `KORRELO_ROLLOUT_DISK_FREE_GB_MIN` |
| teto de heap do build | 1024 MB | `KORRELO_ROLLOUT_BUILD_HEAP_MB` |
| nice dos builds | 10 | `KORRELO_ROLLOUT_NICE_LEVEL` |
| ionice dos builds | ligado | `KORRELO_ROLLOUT_IONICE=0` desliga |
| intervalo do cooldown | 10 s | `KORRELO_ROLLOUT_RESOURCE_WAIT_INTERVAL_SEC` |
| timeout do cooldown | 180 s | `KORRELO_ROLLOUT_RESOURCE_WAIT_TIMEOUT_SEC` |

**Swap histórica não bloqueia o build.** O Linux mantém páginas antigas em
swap mesmo depois da pressão de RAM passar: no incidente real havia 2648 MB
livres, 601 MB de swap, `si/so = 0` e PSI `0.00` — e o build foi bloqueado
por 180 s. Agora a swap usada é **sinal auxiliar** (registrada e exibida no
diagnóstico) e o bloqueio vem de:

- **MemAvailable** abaixo do mínimo → bloqueia;
- **load** acima do limite → bloqueia;
- **disco** abaixo do mínimo → bloqueia;
- **atividade de swap** real (delta de `pswpin`/`pswpout` na janela de
  amostragem) → bloqueia/aguarda;
- **PSI de memória** (`some avg10` alto ou `full avg10 > 0`) → bloqueia/aguarda;
- RAM baixa + swap alta → bloqueia.

Se o host não expuser `/proc/vmstat` nem `/proc/pressure/memory`, o guard
não quebra: **sem sinal nenhum, o fallback é conservador** (bloqueia).

Swap livre **não** conta como RAM: MemAvailable físico é o critério
principal. O dry-run mostra a checagem completa (`rolloutResourceCheck`) e a
configuração do cooldown (`resourceWaitConfig`).

#### Cooldown: esperar a pressão transitória passar

No primeiro rollout real na VPS, o `npm ci` terminou e o `load1` ficou em
**3.19** (limite 1.5): o build foi bloqueado — corretamente, mas a pressão
era **transitória** (minutos depois, sem nada pesado, o load caiu para
0.77). Abortar ali era um timeout evitável.

Agora, antes de cada operação pesada (`npm ci`, `build-shared`, `build-api`,
`build-web`) e antes do rebuild do rollback, o rollout:

1. mede os recursos;
2. se estiver seguro → segue;
3. se estiver inseguro **de forma transitória** (load alto, swap um pouco
   alta, memória temporariamente abaixo) → **espera** `intervalSec` (sem busy
   loop), mede de novo e repete;
4. se for **hard failure** → aborta na hora: disco abaixo do mínimo, erro de
   leitura de métrica essencial ou memória crítica (< 256 MB);
5. se o timeout estourar → aborta (o rollback entra em recuperação segura).

Os thresholds de produção **não mudam**: o cooldown não afrouxa a proteção,
só espera a pressão passar.

Logs (sem spam):

```
[rollout] build-shared: aguardando recursos
load average (1min)=3.19 (limite 1.5)
tentativa=1
próxima checagem em 10s
...
[rollout] build-shared: recursos normalizados após 30s
load1=1.31
```

#### Rollout consciente dos recursos (nunca sacrificar a produção)

O install é **`npm ci --include=dev`** (determinístico, a partir do
`package-lock.json`; não reescreve o lockfile). O `--include=dev` é
obrigatório: com `NODE_ENV=production` no ambiente da VPS, o npm roda com
`omit=dev` e as devDependencies (o TypeScript que compila o Core) **não são
instaladas** — o build de `packages/shared-types` falha com `tsc: not found`.
A flag é local ao comando: o rollout **não** mexe no `NODE_ENV` global, nem
em `~/.npmrc`, nem em `/etc/npmrc`, nem roda `npm config set`.

Depois do install, a toolchain é **validada** (novo stage `toolchain-check`):
se o TypeScript/`tsc` não estiver disponível, o rollout aborta **antes** de
qualquer build com
`Toolchain de build incompleta após npm ci --include=dev: TypeScript não está
disponível`.

Sem `package-lock.json` no checkout alvo o rollout **aborta** — não existe
fallback para `npm install`. Depois do `npm ci`, o rollout confere se algum
arquivo versionado mudou (ex.: o lockfile reescrito): se mudou, **reporta** e
segue — nada é descartado, resetado ou restaurado em silêncio.

As falhas de build agora carregam o **exit code** e um trecho **sanitizado e
limitado** do stderr/stdout (sem vazar segredo e sem despejar buffer
gigante):

```
build de packages/shared-types falhou [build-shared] (exit=127):
sh: 1: tsc: not found
```

O rollback é **consciente dos recursos e do stage da falha**:

| onde a falha aconteceu | o que o rollback faz |
| --- | --- |
| antes do `git update` | **nenhum rollback** (nada foi alterado no alvo) |
| depois do `git update`, **antes** de qualquer restart de PM2 | o Core em execução continua na versão anterior. Sem recurso: restaura o **Git do alvo (branch + commit)** e os artefatos do Core (por **cópia**, sem compilação), **não compila** e **não reinicia o PM2** → `RECOVERY_DEFERRED` |
| depois do restart de PM2 | o Core pode estar com a versão nova (ou quebrada). Sem recurso: o rebuild é **adiado** → `RECOVERY_REQUIRED` / `CRITICAL`, com rebuild + restart do Core pendentes para quando o host tiver folga |

O rollback/recovery **nunca termina em detached HEAD**: ele restaura a
**branch original** no **commit anterior** (`git checkout <branch>` +
`git reset --hard <previousCommit>`, só na branch local — o remoto nunca é
tocado) e confirma `git branch --show-current` + `git rev-parse HEAD`. No
sucesso, o alvo é validado da mesma forma (branch original + commit
candidato); branch vazia = rollout não concluído.

Se o alvo tiver **alteração tracked inesperada** durante a recuperação, nada
é resetado: a restauração é interrompida com
`RECOVERY_REQUIRED` e a mensagem
`working tree contém alterações inesperadas; restauração automática da
branch foi interrompida para não perder dados` (com os caminhos, nunca o
conteúdo).

Em nenhum dos casos o rollback toca container, volume, rede ou porta de
projeto: **Mesatta e Evolution têm prioridade sobre o painel do Korrelo** —
é aceitável o Core ficar temporariamente indisponível se a alternativa for
ameaçar a produção. O status do rollout registra `recoveryStatus` /
`recoveryRequired`.

Estratégia de artefatos: antes do `npm ci` o rollout copia (não move) os
artefatos do Core que o processo em execução lê do disco — hoje apenas
`apps/api/dist` (poucos MB). O bundle do web (`.next/standalone`) **não** é
copiado: pode passar de 100 MB e a cópia pressionaria o mesmo disco sob
pressão (além de correr com o servidor Next em execução, que lê esses
arquivos a cada request). O que não pode ser garantido é sinalizado
explicitamente (`RECOVERY_REQUIRED`), nunca escondido.

#### Atualizar um checkout ALVO diferente (bootstrap)

O executor (o código do rollout, a config e as libs) e o **alvo** (o checkout
do Korrelo que roda em produção) podem ser coisas diferentes. Isso permite
rodar o rollout novo de um worktree externo e atualizar o checkout antigo:

```bash
# dry-run real contra o checkout de produção
node /tmp/korrelo-rollout-preview/apps/api/scripts/rollout/rollout.cjs \
  --repo-root /home/korrelo/korrelo

# rollout de verdade (o alvo é atualizado, o executor não)
node /tmp/korrelo-rollout-preview/apps/api/scripts/rollout/rollout.cjs \
  --repo-root /home/korrelo/korrelo \
  --apply

# o wrapper repassa os argumentos
bash scripts/rollout-korrelo.sh --repo-root /home/korrelo/korrelo --apply
```

O que o `--repo-root` garante:

- o **alvo** é quem é atualizado: `git status/branch/pull`, banco do Core
  (`<alvo>/apps/api/prisma/dev.db`), `.env`, `npm ci`, builds, migration,
  `chmod` e rollback acontecem todos no alvo;
- o **executor** (onde o `rollout.cjs` está) fornece o código, as libs e o
  `rollout.config.json` — a config nova nunca é lida do alvo antigo;
- `previousCommit` é o HEAD do **alvo** e `candidateCommit` é o
  `origin/main` do **alvo**; o update só acontece se for fast-forward
  (nunca há `reset` nem `merge`);
- o `git pull` sempre nomeia o alvo e a branch (`git -C <alvo> pull --ff-only
  origin <branch>`) — checkout em detached HEAD é recusado antes de qualquer
  escrita;
- o rollback volta o **alvo** ao `previousCommit` (rebuild, assets e restart
  só do Core) — e, se faltarem recursos, **não** compila à força (ver
  "Rollout consciente dos recursos");
- argumento desconhecido **aborta** (nunca é ignorado em silêncio) e
  `--repo-root` sem valor é recusado antes de qualquer lock, drain ou backup.

O que ele garante:

- **não roda no meio de um deploy de projeto** (recusa se houver job em
  andamento);
- **não sacrifica a produção para compilar o Core**: antes do `npm ci` e
  de cada build, o rollout mede MemAvailable, swap em uso, load average e
  disco livre. Se os recursos não forem suficientes, o rollout é **adiado**
  (nada é parado, reduzido ou reiniciado) e os projetos ficam intactos;
- **não descarta alteração local**: com o working tree sujo (ex.:
  `package-lock.json` modificado), o update é abortado com a lista de
  arquivos — a decisão é do operador;
- **faz backup consistente do banco do Core** (`sqlite3 .backup`, validado
  com `PRAGMA integrity_check`) ANTES de qualquer migration, e guarda em
  `~/korrelo-backups/core-pre-update-AAAAMMDD-HHMMSS.db`;
- **só aplica migration depois do backup válido** (se o backup falhar,
  nada de migration acontece e o PM2 não é reiniciado);
- **tira um snapshot READ-ONLY dos containers dos projetos** antes e depois e
  compara Container ID, imagem, StartedAt, RestartCount, memória, swap,
  política de restart, mounts, redes e portas. Qualquer divergência é
  **falha crítica** (o script não "conserta" nada — investigue);
- **reinicia só o PM2 do Core** (`korrelo-api` e `korrelo-web`);
- **drena o worker de deploy** durante a janela e libera no fim;
- em caso de falha, **volta o Core ao commit anterior** (rebuild + restart
  do PM2 do Core). As migrations são aditivas: a versão anterior ignora as
  colunas novas, então não há revert de schema.

O status do último rollout fica em `~/.korrelo/rollouts/last.json` (e em
`GET /api/rollout/status`).

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
- [Node.js 22.23.4+](https://nodejs.org) (linha corrigida; a 20 está EOL). Aceitas também 24.22.1+ e 26.12.1+.
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
2. Instale as dependências (determinístico, a partir do `package-lock.json`,
   **com as devDependencies** — o build do Core precisa do TypeScript):
   ```bash
   npm ci --include=dev
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
