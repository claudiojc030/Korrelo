# Migração para Node.js 22 — plano de implantação

Status: **documento de referência**. Nada aqui é executado automaticamente pelo
Korrelo. O `self-update` não roda `setup-vps.sh` e não altera sudoers.

Contexto: CVE-2026-111497 (decoder Brotli do Node.js) foi corrigida em
22.23.4 / 24.22.1 / 26.12.1. Node 20 está EOL (30/04/2026) e **não recebe
correção**. O Core roda sob PM2 no host; os projetos rodam em containers.

---

## 0. O que já está pronto no repositório

| Item | Onde |
|---|---|
| Requisito de runtime (`>=22.23.4`) | `package.json` (root, api, web) + `.nvmrc` |
| Checagem de runtime | `bash scripts/check-runtime.sh` |
| Runtime lado a lado (sem trocar o global) | `bash scripts/install-node-runtime.sh` |
| PM2 com interpretador detectado automaticamente | `ecosystem.config.js` (`KORRELO_NODE_BIN` opcional) |
| Imagem base dos projetos Node | `NODE_BASE_IMAGE = node:22.23.4-alpine` |
| Rejeição de corpo Brotli na API | `apps/api/src/infrastructure/request-encoding.ts` |
| Helpers privilegiados restritos | `scripts/lib/korrelo-certbot.sh`, `scripts/lib/korrelo-service.sh` |

### Política de versões (`engines` + `check-runtime.sh`)

| linha | patch mínimo | por quê |
|---|---|---|
| 22 | **22.23.4** | correção do CVE-2026-111497 |
| 24 | **24.22.1** | idem |
| 26 | **26.12.1** | idem |

Linhas 20, 23, 25 e 27+ são **recusadas** (EOL ou sem patch desta rodada).
`>=22.23.4` sozinho aceitaria 26.7.0 — que está abaixo do patch da própria
linha e continua vulnerável. A regra por linha é a mesma em `engines`,
`scripts/check-runtime.sh` e neste documento.

---

## 1. Preflight obrigatório (somente leitura)

Na VPS, **como usuário do Korrelo**, sem reiniciar nada:

```bash
cd ~/korrelo
git rev-parse --short HEAD            # commit implantado
git status --porcelain                # deve estar vazio
node -v; npm -v
pm2 ls
pm2 jlist | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const p of JSON.parse(d))console.log(p.name,p.pm2_env.exec_interpreter,p.pm2_env.pid)})'
# confirma o binário REAL por trás do PM2 (não só o campo do PM2):
for pid in $(pm2 jlist | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const p of JSON.parse(d))if(p.pid)console.log(p.pid)})'); do
  echo "pid=$pid -> $(readlink -f /proc/$pid/exe 2>/dev/null || ps -o args= -p $pid | cut -d' ' -f1)"
done
df -h / ; free -m ; nproc ; uptime
docker --version ; docker compose version
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
ls -l ~/korrelo-backups | tail -n 5
bash scripts/check-runtime.sh || true   # estado ATUAL (esperado: falhar em 20.x)
```

Confirmar:

- [ ] `node -v` no host (esperado: 20.20.2 — EOL) e o interpretador de cada app do PM2.
- [ ] RAM livre > 1.2 GB e disco livre > 3 GB (build do Core usa ~1 GB).
- [ ] Nenhum deploy em andamento (`deploy queue` vazia / nenhum job `running`).
- [ ] Nenhum self-update em andamento.
- [ ] `.env` do Core com permissão `600`.
- [ ] Banco do Core: `apps/api/prisma/dev.db` (SQLite) com backup recente.

## 2. Backups (obrigatório antes de qualquer mudança)

```bash
cd ~/korrelo && bash scripts/backup.sh        # backup manual, mesmo caminho do cron
ls -lh ~/korrelo-backups | tail -n 3
# cópia extra do SQLite só para esta janela:
cp apps/api/prisma/dev.db ~/korrelo-backups/dev.db.pre-node22
```

- [ ] Último backup automático concluído sem falha (`~/korrelo-backups/backup.log`).
- [ ] Backup semanal da Hostinger confirmado no painel.
- [ ] Cópia do SQLite feita e testada com `sqlite3 ... "PRAGMA integrity_check;"`.

## 3. Migrations pendentes

```bash
cd ~/korrelo/apps/api
npx prisma migrate status        # leitura
```

- Se houver migration pendente, **aplicar antes** da troca de runtime (com o Node
  atual), com o backup do passo 2 já feito: `npx prisma migrate deploy`.
- Nunca rodar `migrate dev` em produção.

### Commits e migrations pendentes

A atualização de runtime arrasta **todo** o código não implantado. Antes:

```bash
git log --oneline "$(git rev-parse HEAD)" -n 10
# comparar com o commit que está rodando (preflight, passo 1):
git log --oneline <commit-da-vps>..HEAD
git log --oneline <commit-da-vps>..HEAD -- apps/api/prisma/migrations
cd apps/api && npx prisma migrate status
```

- Se houver commit não revisado no intervalo, **abortar** até revisar.
- Se houver migration pendente, ela **não** é aplicada nesta janela: decidir
  à parte (com o backup do passo 2) ou abortar.
- O banco do Core é SQLite (`apps/api/prisma/dev.db`); o deploy de código não
  o toca.

## 4. Sudoers restrito (passo manual, separado)

### Ordem das operações (importante)

A versão nova da API chama `/usr/local/sbin/korrelo-certbot` e
`/usr/local/sbin/korrelo-service`. Já o código **antigo** chama `sudo certbot`
e `sudo systemctl ...` diretamente. Por isso a ordem importa:

1. **Instalar os helpers** (não altera sudoers). O código antigo continua
   funcionando normalmente.
2. **Trocar o `/etc/sudoers.d/korrelo`** para a regra restrita. A partir daqui
   o código antigo perde `certbot`/serviços, mas o novo ainda não subiu —
   janela de ~1 minuto sem emissão de certificado nem toggle de serviço.
3. **Subir o código novo** (self-update/deploy) e reiniciar o PM2.
4. Validar: `sudo -l` mostra só `reload nginx` + os dois helpers.

Essa janela afeta **apenas ações administrativas** (emitir certificado de
domínio novo, ligar/desligar serviço do SO). Deploy de projetos, painel,
backups e containers não passam por esses helpers.

O repositório novo usa helpers; a VPS ainda tem a regra antiga com curinga.
Isso **não** é feito pelo self-update:

```bash
cd ~/korrelo
# 1) instala helpers + regra nova (idempotente, valida com visudo antes)
sudo bash -c '
  install -m 0755 -o root -g root scripts/lib/korrelo-certbot.sh /usr/local/sbin/korrelo-certbot
  install -m 0755 -o root -g root scripts/lib/korrelo-service.sh /usr/local/sbin/korrelo-service
'
sudo visudo -f /etc/sudoers.d/korrelo     # conferir: sem "*"
# 2) teste funcional (renovação já agendada pelo certbot continua via systemd timer)
sudo /usr/local/sbin/korrelo-certbot --help 2>&1 | head -n 2   # deve recusar uso inválido
sudo /usr/local/sbin/korrelo-service                # deve recusar uso inválido
```

Rollback do passo: restaurar `/etc/sudoers.d/korrelo` anterior (guardar cópia).

## 5. Core: runtime novo lado a lado

```bash
cd ~/korrelo
bash scripts/install-node-runtime.sh 22.23.4      # /opt/korrelo/node/22.23.4
KORRELO_NODE_BIN=/opt/korrelo/node/current/bin/node bash scripts/check-runtime.sh
```

Depois (janela curta, com o painel em uso mínimo):

```bash
cd ~/korrelo
# O ecosystem detecta /opt/korrelo/node/current/bin/node sozinho e coloca o
# diretório no PATH dos processos filhos (o self-update passa a usar o npm do
# Node 22). Nenhum export é necessário para reinícios futuros.
npm ci --include=dev --engine-strict=false
npm run build
pm2 restart ecosystem.config.js --update-env
pm2 save
```

> **Persistência:** `pm2 save` grava o interpretador no `~/.pm2/dump.pm2`, e o
> `pm2 resurrect` do systemd (configurado pelo setup) restaura no boot. Se o
> dump for regenerado a partir do ecosystem, a detecção automática aponta para
> o runtime novo mesmo sem `KORRELO_NODE_BIN`. `KORRELO_NODE_BIN` continua
> existindo apenas como override (ex.: rollback explícito).

Validação imediata:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -fsSI http://127.0.0.1:3000/ | head -n 1
pm2 logs korrelo-api --lines 50 --nostream | tail -n 20
pm2 ls
```

Critérios de sucesso: ambos `online`, health `200`, sem restart loop,
`dist` e `.next/standalone` gerados, login no painel funcionando.

## 6. Projetos Docker (separado, controlado)

**Nenhum container é reconstruído por esta atualização.** O `node:22.23.4-alpine`
só entra em builds futuros. Para atualizar um projeto:

1. Deploy pelo Korrelo (build → staging health → promote).
2. Se o staging falhar, o deploy aborta e a produção continua na versão antiga.
3. Mesatta é o último (produção intocada até o staging responder).

**Independência:** o restart do Core (PM2) **não** toca em containers. Korrelo
e projetos são processos separados; Mesatta/Evolution continuam servindo
durante a janela. O self-update do Core também não dispara deploy de projeto —
só o próximo deploy manual (pela fila) usará a imagem nova.

Antes de cada projeto, registrar a imagem atual para rollback:

```bash
docker inspect --format '{{.Config.Image}}' korrelo-mesatta-8452004c
```

## 7. PHP (somente se existir)

```bash
command -v php && php -v || echo "sem php no host"
dpkg -l | grep -i '^ii  php' || true
```

- Host: `sudo apt update && sudo apt install --only-upgrade php8.3*` (noble
  corrigido em 8.3.6-0ubuntu0.24.04.13).
- Projetos PHP gerados pelo Korrelo: a imagem agora é `php:8.3-cli-alpine`
  (flutuante). Rebuild controlado pega a versão ≥ 8.3.36.

## 8. Critérios objetivos de ABORTAR

Abortar (e reverter) se qualquer item ocorrer:

- health da API diferente de `200` após 3 minutos;
- qualquer app do PM2 em `errored`/restart loop;
- erro de build (`tsc`, Next, Prisma);
- memória disponível < 700 MB durante o build;
- `npm ci` alterando arquivos versionados (o rollout já alerta);
- staging do Mesatta sem resposta após o timeout configurado;
- qualquer sinal de corrupção do SQLite (`integrity_check` != `ok`).

## 9. Rollback

### Runtime do Core (rápido)

```bash
cd ~/korrelo
# Override explícito para o node global (Node 20). Sem o override, o
# ecosystem usaria de novo /opt/korrelo/node/current se ele existir.
KORRELO_NODE_BIN="$(command -v node)" pm2 restart ecosystem.config.js --update-env
pm2 save
```

Alternativa definitiva: remover o symlink
`sudo rm /opt/korrelo/node/current` e reiniciar (o ecosystem cai no PATH).
O runtime novo continua em `/opt/korrelo/node/<versão>` para nova tentativa.

O runtime novo continua em `/opt/korrelo/node/` para nova tentativa. O
`/usr/bin/node` nunca foi alterado.

### Código

```bash
cd ~/korrelo && git log --oneline -5
git checkout <commit-anterior>     # ex.: a19d581
npm ci --include=dev && npm run build
pm2 restart ecosystem.config.js --update-env
```

Usar `git checkout` só com autorização (pode descartar trabalho local). O
banco SQLite não é tocado pelo rollback de código; se uma migration já tiver
sido aplicada, restaurar o `dev.db.pre-node22` junto.

### Projetos Docker

Promover a imagem anterior pelo próprio Korrelo (rollback por imagem), sem
reconstruir.

## 10. Limites de recurso

- 1 vCPU: não rodar build do Core e deploy de projeto ao mesmo tempo.
- Build do Core: ~1 GB de RAM, 2–4 min.
- Manter o `NODE_OPTIONS` do PM2 (192 MB) na primeira janela; só revisar depois.
- Swap serve como rede de segurança, não como capacidade de build.

## 11. Observação sobre a defesa Brotli

A API recusa `Content-Encoding: br` com **415** antes do parser. O painel não
usa corpo Brotli. Se algum cliente externo precisar disso no futuro, a decisão
precisa considerar que o decoder nativo continua sendo o do runtime.
