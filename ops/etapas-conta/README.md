# Etapas do CRM com os nomes da Kommo (Timbó, conta 3)

Troca, na conta 3 do Chatwoot, **a lista dos atributos** `etapa` e `etapa_tratamento`, **a etapa de cada conversa** (as ~740: importadas da Kommo e novas) e **as pastas** (filtros salvos) que filtram por etapa — todos para os nomes da Kommo de Timbó — e grava o mapa em `unit_chatwoot.etapas`. A decisão está em `backend/src/lib/etapas-migracao.ts` (testada); o mapa de Timbó, em `backend/src/lib/chatwoot-etapas-timbo.ts`.

| Quem roda | Comando | O quê |
|---|---|---|
| João (PC) | `bash ops/etapas-conta-joao.sh --so-conferir` | lê o banco do CRM e mostra o que trocaria: contagens «de → para», pastas, listas. **Não grava nada.** |
| João (PC) | `bash ops/etapas-conta-joao.sh` | grava: **primeiro o mapa** (o agente lê o nome antigo e o novo, então nada fica «desconhecido» enquanto ele relê, em até 1 min) e depois **uma transação** no banco do CRM (listas, conversas, etiquetas, pastas) |
| João (PC) | `... --desfazer=<log> [--confirmo-apagar]` | devolve cada valor ao de antes (só onde ainda está o que a migração pôs); sem `--confirmo-apagar` só mostra |

**Pré-requisitos.** (1) deploy dos PRs de etapas por conta (o script `backend/dist/scripts/etapas-conta.js` precisa existir); (2) a importação da Kommo terminada; (3) rodar `--so-conferir` e conferir os números antes de gravar.

## O que muda, conversa por conversa

- A conversa **importada da Kommo e ainda como a importação a deixou** vai para a etapa que o cartão tem na Kommo (a 1ª linha da nota diz: «Na Kommo: COMERCIAL › EM ESPERA»). É assim que as que ficaram **sem etapa + `conferir-etapa`** (EM ESPERA, CONFERIR NA FRANQUIA, RETORNO PÓS-TRATAMENTO) e as que ficaram em **Agendado por falta** (NÃO COMPARECEU) vão para a etapa certa.
- A conversa que a **equipe já mexeu** (ou que não veio da Kommo) só é **renomeada** (Sofia qualifica → EM QUALIFICAÇÃO, Fechou → GANHO / CONCLUÍDO…), nunca reclassificada.
- **Esperando humano** não tem etapa na Kommo: vira EM QUALIFICAÇÃO **+ a etiqueta `esperando-humano`** (a Sofia e a demora já leem a etiqueta).
- **Tratamento:** Entrada → Leads de entrada, Em tratamento → EM TRATAMENTO, Alta → ALTA, Tratamento cancelado → TRATAMENTO CANCELADO.
- **NÃO COMPARECEU com consulta remarcada** (a importação a deixou Agendado + Remarcado): continua AGENDADO.
- A etiqueta `esperando-humano` entra em `taggings` **e** no cache `cached_label_list`, só se a troca da etapa valeu e se a Tag existe (senão o plano aborta antes de gravar).
- **Nunca** é tirada etiqueta (a `conferir-etapa` fica; a equipe tira ao conferir), `updated_at` não muda, e cada UPDATE só vale se o valor de antes ainda é o que o plano viu (quem mexeu no meio fica como está).
- Sem destino na conta (Frio, Resgate) a conversa **fica intacta** e aparece em `INTACTA` no resumo.
- Tudo por SQL **sem callbacks**: sem webhook, régua, notificação nem mensagem ao paciente. A régua lê a etapa em **papel**, então renomear não parece «entrou na etapa».

## As pastas (custom_filters)

Todas as pastas da conta que filtram por `etapa`/`etapa_tratamento` passam para os nomes da conta (valores repetidos somem: «Agendado + Confirmado» → AGENDADO). As pastas **C3 · EM ESPERA**, **C4 · CONFERIR NA FRANQUIA** e **C6 · NÃO COMPARECEU** passam a filtrar pela **etapa de verdade** (antes usavam `motivo_espera`/`retomar_em`, a etiqueta `conferir-etapa` e a situação da consulta). «Esperando humano» (etiqueta) e «Faltaram» (situação da consulta) ficam como estão. Não é preciso criar pasta nova: C3, C4 e C6 já existem.

## Desfazer

Use o log da **primeira** rodada que gravou (uma 2ª rodada registra como «antes» o que a 1ª já migrou). O log da rodada que gravou (`/root/kit/logs/etapas-conta-AAAAMMDD-HHMMSS-gravar.txt`) guarda uma linha `REG` por troca com o **valor de antes**. `--desfazer` restaura listas, etapas e pastas, e tira **só** as etiquetas `esperando-humano` que a migração pôs (único DELETE), e devolve `unit_chatwoot.etapas` ao valor de antes (nulo = molde).

## Depois de gravar

O agente relê a configuração em até 1 minuto: a partir daí régua, Sofia, agenda e telas leem a etapa em papel e gravam o nome da conta. O importador da Kommo (`ops/historico-kommo-crm-joao.sh`) já grava nos nomes da conta quando o mapa existe.
