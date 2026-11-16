# Modelo de relatório seguro — capacidade e rollout

Copie este modelo para `docs/audits/<data>-capacidade.md` **sem** dados sensíveis.

## Regras de redação

- Nunca incluir: `.env`, `Config.Env`, tokens, cookies, senhas, connection strings com credenciais,
  cmdlines de processos, chaves SSH, IPs públicos completos (use `203.0.113.x`), e-mails de clientes.
- Nomes de containers/imagens podem ser mantidos; IDs de imagem podem ser truncados (`sha256:06c3cce5…`).
- Anexar o JSON da auditoria apenas se revisado; ele já não lê env/cmdline, mas revise por precaução.

## Modelo

```markdown
# Auditoria de capacidade — <AAAA-MM-DD HH:MM TZ>

## Ambiente
- Host: <provedor>, <vCPU> vCPU, <RAM> GB, <disco> GB SSD
- Kernel: <uname -r>
- Docker: <versão> (root dir <path>)
- Korrelo instalado: commit <sha curto> / imagem <tag>
- Mesatta produção: <sha curto>, imagem <id curto>
- Evolution API: <imagem/tag>

## Coleta
- Ferramenta: scripts/ops/vps-capacity-audit.mjs (somente leitura)
- Horário da coleta: <timestamp> · duração <s>
- Fonte de OOM: journalctl | dmesg | indisponível

## Métricas
| Métrica | Valor | Limiar | Situação |
|---|---|---|---|
| vCPU | | — | |
| load 1/5/15 | | 5min <= 0.6×CPU | |
| MemTotal / MemAvailable | | >= 2560 MB | |
| swap total/livre | | livre > 0 | |
| PSI memory full avg10 | | <= 1% | |
| disco livre (Docker) | | >= 10 GB | |
| inodes livres | | >= 100k e >= 20% | |
| OOM (24h) | | 0 | |
| containers OOM/unhealthy | | 0 | |

## Containers (resumo)
| Container | Imagem | Limite RAM | CPU | Restarts | Health | Uso (stats) |
|---|---|---|---|---|---|---|

## Avaliação automática
- coreUpdate: GO | NO-GO — falhas: ...
- stagingActivation: GO | NO-GO — falhas: ...
- Margem projetada: <MB> (app 1024 + Mongo 384 + overhead 512)

## Conclusão
- Atualizar o Core: GO | NO-GO
- Ativar staging: GO | NO-GO
- Staging externo necessário: sim | não
- Riscos remanescentes: ...
```
