# Fuso horário no agente_dt: o que está errado, o que este PR conserta, o que fica

Origem: auditoria de 27/11/2026, seção 4 (bug de fuso). Este documento é a decisão e o mapa de risco. Nenhum esquema foi alterado.

## 1. O defeito, reproduzido

- O banco roda com `TimeZone=America/Sao_Paulo`. O Prisma grava `created_at` em **UTC**, em colunas `timestamp` **sem fuso** (83 `@default(now())` no `schema.prisma`, nenhum `@db.Timestamptz`).
- `now()` devolve `timestamptz`. Ao comparar `timestamp` com `timestamptz`, o Postgres lê a coluna como se fosse hora de São Paulo, ou seja, o valor UTC fica 3 h "no futuro". `created_at > now() - interval '30 minutes'` cobre **3h30**.
- Reproduzido em Postgres 16 descartável com `-c timezone=America/Sao_Paulo` (`taxa-erro-worker.pg.test.ts`): 10 chamadas dentro de 30 min + 4 de 2 h atrás; o código antigo contou **14** na janela "recente", o certo é **10**. Em produção (auditoria): 1.965 linhas contra 247 em `llm_calls` (8,0x), `messages` 1.081 contra 231 (4,7x).
- Prova do que o `DEFAULT now()` grava (mesmo banco de teste, mesma hora):

  | quem gravou | `created_at` | hora real UTC |
  |---|---|---|
  | Prisma (`@default(now())` é gerado pelo motor do Prisma, não pelo banco) | `13:30:30` | `13:30:30` |
  | SQL cru que omite a coluna (cai no `DEFAULT now()` do banco) | `10:30:30` | `13:30:30` |

  Ou seja: **o mesmo campo recebe UTC de quem passa pelo Prisma e hora de São Paulo de quem passa pelo default do banco.**

## 2. A escolha: corrigir cada comparação, não mudar o fuso da conexão

Opções avaliadas:

| Opção | O que faz | Por que não / por que sim |
|---|---|---|
| **A. `(now() at time zone 'utc')` em cada comparação** (escolhida) | Troca o `now()` por um `timestamp` já em UTC, do mesmo relógio que o Prisma grava. Vale em qualquer `TimeZone` de sessão | Muda só as consultas que estão erradas; reversível por commit; não toca em dado; funciona mesmo se alguém mudar o fuso do banco depois |
| B. `options=-c timezone=UTC` na `DATABASE_URL` do agente | Todas as consultas do agente passam a ver `now()` em UTC | Altera o significado de **tudo** que hoje usa `now()`/`CURRENT_DATE` em hora local: `worker_leases` (linhas gravadas em hora local viram "vencidas há 3 h" no deploy; com 2 réplicas durante um start-first isso é tomada de trava), `franquia_telefones.atualizado_em`, `disparo_ondas.atualizado_em`, o DEFAULT das gravações cruas. Não conserta quem escreve de fora (n8n, scripts) |
| C. `ALTER DATABASE agente_dt SET timezone='UTC'` | Mesmo que B para todos os clientes (n8n, `psql`, `pg_dump`) | Pior que B: alcança clientes que não são do agente. Relatórios que filtram por data local mudam sem aviso. **Não aplicar sem medir as 372 colunas** |
| D. Migrar colunas para `timestamptz` | Resolve na raiz | 372 colunas em 131 tabelas, reescrita de tabela (`llm_calls` 6,7 GB). Decisão de planejamento, não de PR de conserto |

Regra daqui para frente: SQL cru que compara coluna `timestamp` do agente_dt com "agora" usa `AGORA_UTC` / `agoraUtcSql` de `backend/src/lib/sql-tempo.ts`. Há uma trava (`sql-tempo.test.ts`) que reprova `now() -`, `now() +` ou `< now()` em qualquer arquivo novo, com 2 exceções justificadas (`worker-lease.ts` e `meta-eventos.ts`).

## 3. O que foi corrigido (13 ocorrências em 5 arquivos)

A auditoria contou 15 em 7 arquivos pelo código que estava no servidor. Em `origin/main` de hoje o padrão `now() - interval` existe em 5 arquivos; `units.controller.ts`, `sla-alert-worker.ts`, `pagamento-antecipado.ts` e `franquia-sync-worker.ts` não têm mais a forma (conferido por busca de `now()`, `NOW()`, `::interval`, `make_interval`, `timestamptz`, `current_*`).

| Arquivo | Ocorrências | Efeito do erro | Teste que reprova no código antigo |
|---|---|---|---|
| `lib/taxa-erro-worker.ts` | 5 | janela "30 min" era 3h30; incidente de 100% levava ~52 min para chegar a 25% | `taxa-erro-worker.pg.test.ts` (14 contra 10) |
| `lib/agendamento-perdido-worker.ts` | 3 | carência de 90 min virava 4h30 (aviso de agendamento perdido atrasado 3 h) e a janela de 24 h virava 27 h | `fuso-janelas.pg.test.ts` |
| `lib/aviso-clinica-agendamento.ts` | 2 | "houve aviso recente" olhava 3 h a mais (podia calar um aviso novo da recepção); pendentes velhas voltavam | idem |
| `lib/preenche-campos-worker.ts` | 2 (`$4::timestamptz - ...`) | "esfriou há 6 h" era 9 h; janela de 72 h era 75 h | idem |
| `lib/dedup-cache.ts` | 1 (`<= NOW()`) + o INSERT que gravava `expires_at` em hora local | no `main` a marca vencida só podia ser reivindicada 3 h depois e a limpeza apagava marcas 3 h antes do vencimento (reentrega de 2 h virava ~10 min) | idem (`claimMessageId` 2x pelo INSERT cru) |

Mudança de comportamento esperada em produção após o deploy (todas na direção do que o código já dizia): o aviso de agendamento perdido passa a sair 90 min depois da oferta e não 4h30; o preenchimento de campos passa a pegar conversas de 6 h a 72 h e não de 9 h a 75 h; o monitor de erro passa a ver 30 min de verdade (e por isso ganhou o olhar da rede inteira, ver `taxa-erro-worker.ts`).

**Transição no deploy do dedup** (`message_claims`): as marcas gravadas antes do deploy têm `expires_at` em hora local (3 h atrás do UTC) e, lidas como UTC, parecem vencidas: uma mensagem reentregue enquanto durar o TTL de cada marca antiga (10 min no padrão, até 2 h na reentrega do Kommo, e mais nos escopos de TTL longo) pode ser processada de novo uma vez. Convém publicar fora do pico; não precisa de migração: a exposição acaba sozinha quando o TTL da última marca antiga passa (até 2 h para a reentrega do Kommo).

### O monitor de taxa de erro depois do conserto

Consertar a janela deixou o monitor mais fiel e mais cego ao mesmo tempo, então ele foi recalibrado junto (`lib/taxa-erro-worker.ts`):

- **Por unidade**: janela de 30 min de verdade e mínimo de 20 chamadas, como antes. Como a janela antiga trazia ~8x mais chamadas, uma unidade pequena com a chave quebrada deixou de alcançar o mínimo; por isso entrou a regra «TODAS as chamadas falhando, com pelo menos 8» (`TAXA_ERRO_MINIMO_TUDO_FALHANDO`). A sensibilidade para taxas parciais em unidade com pouco volume é menor que a antiga, que era um efeito do bug.
- **Da rede (queda geral)**: 90% ou mais das chamadas falhando nos últimos 10 min, na rede toda ou num provedor, com pelo menos 5 chamadas, sem o mínimo por unidade, **e erro em 2 unidades ou mais, nenhuma delas com mais de 70% dos erros, a partir de 20 erros (abaixo disso é só madrugada com poucas unidades falando)** (uma unidade em laço mais um erro isolado de outra não é queda da rede; sem exceção para crédito ou chave: cada unidade pode ter a própria chave, `Unit.anthropicApiKey`, e uma acabando não é «a rede toda fora»; uma unidade só com tudo falhando é coberta pela regra por unidade). Só a queda da rede inteira cala os avisos por unidade. Chamadas `cancelled` (prazo estourado) ficam fora de todos os totais.
- **Causa**: lida da mensagem de erro (`lib/causa-erro-ia.ts`, a mesma regra em JS e em SQL, conferida contra um Postgres de verdade): crédito («credit balance», «no credits»), chave (401/403), limite (429) e indisponibilidade (5xx, timeout). Códigos só valem em contexto de status, para um «512 tokens» não virar «provedor fora do ar».
- **Limite conhecido**: chamada `cancelled` (quem chamou desistiu: prazo estourado, sinal abortado) não conta, de propósito (o comentário de `statusDaFalha` em `openai.service.ts` diz que ela não pode acender este monitor). Um provedor que TRAVA, e cujas chamadas morrem no prazo do chamador, fica invisível a este monitor; o vigia externo (`feat/alerta-externo-saude`) tem a mesma regra. Cobrir isso é outro desenho (alarme de proporção de `cancelled`).
- A varredura da rede roda a cada 2 min (`TAXA_ERRO_REDE_SWEEP_MS`); a por unidade continua a cada 10.
- Limite que continua: o aviso sai pelo `opsAlert` (relay dentro da VPS). O alerta de fora do servidor é o PR do vigia externo.

## 4. Os `DEFAULT now()`: quem grava hora local?

Contagem no repositório: 83 `@default(now())` no schema, 82 `DEFAULT CURRENT_TIMESTAMP` nas migrations. **Em tabela escrita pelo Prisma o default não dispara**: o motor do Prisma gera o valor, em UTC (prova na seção 1). O default do banco só dispara para quem insere por SQL cru sem informar a coluna. Escritores de SQL cru no `backend/src` (busca por `INSERT INTO`/`UPDATE` + `now()`):

| Tabela.coluna | Quem grava | Hora gravada | Quem lê / compara | Risco | Ação sugerida |
|---|---|---|---|---|---|
| `message_claims.created_at` | `dedup-cache.ts` (INSERT omite a coluna) | **local** (default do banco) | ninguém compara; só a limpeza usa `expires_at` | Baixo (coluna só informativa); mistura com linhas do Prisma | Gravar `AGORA_UTC` no INSERT, ou ignorar |
| `message_claims.expires_at` | Prisma (UTC) e INSERT cru de `dedup-cache.ts` | Prisma: UTC. INSERT cru: **hora LOCAL** (o `Date` chega como `timestamptz` e o `timestamp` guarda a hora da sessão); corrigido neste PR com `(… ::timestamptz at time zone 'utc')` | `<= NOW()` (corrigido neste PR para `agoraUtcSql`) | Era médio: no `main` a limpeza (`limparClaimsVencidos`, relógio do JS) apagava marcas até 3 h antes do vencimento e o prazo de reentrega de 2 h virava ~10 min; trocar só o `NOW()` sem corrigir o INSERT faria toda marca nascer vencida (mesma mensagem reivindicada 2x). Os dois lados foram corrigidos juntos | nenhuma |
| `worker_leases.expires_at`, `updated_at` | `worker-lease.ts`, tudo por `now()` do banco | **local** | `worker-lease.ts` contra `now()` | Nenhum hoje: os dois lados são local e se compensam. **Quebra se o fuso da conexão ou do banco mudar** (opção B/C): cada deploy vê leases "vencidos" | Manter como está; é o motivo de não mudar o fuso da conexão sem migrar esta tabela junto |
| `franquia_telefones.atualizado_em` | `franquia-indice-telefones.ts` (`now()`) | **local** | ninguém lê hoje (`criado_na_franquia` é UTC e é o que importa) | Baixo; é a mistura que a auditoria temia: `criado_na_franquia` UTC e `atualizado_em` local na mesma linha | Gravar `AGORA_UTC` na próxima mexida no arquivo |
| `disparo_ondas.atualizado_em` | `lib/disparo/onda.ts:209` (`NOW()` na retomada) | **local** | `disparo/chatwoot/onda.ts:118` compara `atualizadoEm < Date.now()-X` (UTC), mas só para ondas em `montando`; a retomada deixa a onda `aprovada` | Baixo hoje; o dia em que a retomada passar por `montando` a onda parece 3 h mais velha e é cancelada como "interrompida" | Gravar `AGORA_UTC` |
| Demais ~75 tabelas com default | só o Prisma, no código do repositório | UTC | várias | Não medido em produção: **escritores fora do repositório** (n8n, scripts `ops/`, `psql` à mão) não aparecem aqui. Nos fluxos de `n8n/rastreio-campanhas` o `INSERT` é no banco do rastreio, não no agente_dt | Antes de qualquer mudança de fuso do banco, rodar em produção: para cada tabela com default, `select max(created_at)` contra `now() at time zone 'utc'`; linhas adiantadas ou atrasadas 3 h mostram escritor externo |

Consulta de auditoria para o João rodar em produção (somente leitura), por tabela suspeita: `select max(created_at), now() at time zone 'utc' as utc, now() as local from <tabela>`. Se `max(created_at)` está perto de `utc`, a tabela é UTC; se está perto de `local`, alguém grava local.

## 5. O que este PR NÃO resolve (e o risco de cada um)

| Item | Onde | Situação |
|---|---|---|
| Relatórios por **hora do dia** e **dia da semana** | `units.controller.ts` (`EXTRACT(HOUR FROM m.created_at)`, `EXTRACT(DOW FROM ...)`, linhas ~562, 570, 613, 1316, 1334) | Contam em UTC, não em hora de São Paulo: "horário de pico" sai deslocado 3 h e o "fim de semana" vai de sexta 21h a domingo 21h. Corrigir muda números que o cliente já viu: decisão de produto |
| `mv_unit_daily` e demais views | `DATE_TRUNC('day', created_at)` | O "dia" das views é o dia UTC: 21h às 23h59 de hoje caem no dia seguinte. Mesmo cuidado |
| `qualidade-ia/consulta.ts` | já converte `UTC -> America/Sao_Paulo` explicitamente | Correto, serve de modelo |
| `agent/teto-mensal.ts` | já compara com parâmetro UTC do JS | Correto |
| 372 colunas `timestamp` sem fuso | schema | Migrar para `timestamptz` é decisão separada (reescreve tabelas grandes) |
| `kommodb` em `Etc/UTC`, agente em São Paulo | infraestrutura | Dois fusos no mesmo sistema; cuidado ao cruzar consultas entre bancos |
