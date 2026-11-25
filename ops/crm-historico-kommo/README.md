# Histórico da Kommo → CRM (Timbó)

Importa o histórico da Kommo de Timbó (`timbosc`, unidade `doutor-hernia-timbo`) para o CRM de Timbó (conta 3 do Chatwoot). **Escopo B (João, 25/11/2026):** todos os cartões **abertos** (Comercial e Tratamento, todas as etapas) + os **ganhos e perdidos fechados nos últimos 6 meses**.

**Dado de paciente nunca sai da VPS.** O exportador (Node) lê a Kommo de dentro do contêiner do agente; o arquivo passa direto para o contêiner do CRM por um pipe de `tar` (sem arquivo no hospedeiro) e é apagado no fim, mesmo se der erro (`trap`). Tela e logs: só ids e contagens. O token da Kommo nunca é impresso.

| Quem roda | Comando | O quê |
|---|---|---|
| João (PC) | `bash ops/historico-kommo-crm-joao.sh --so-conferir` | lê a Kommo e conta (cartões por etapa, telefones, mensagens, duração, e quantas conversas já NASCEM vivas — as de consulta de pé, que recebem os lembretes do CRM). **Funciona antes da caixa existir** |
| João (PC) | `... --so-conferir --completo` | lê TUDO e confere contra o CRM (contatos novos/reaproveitados…). Exige a caixa |
| João (PC) | `... --limite=5` | piloto: os 5 cartões mais recentes **que têm telefone** |
| João (PC) | `bash ops/historico-kommo-crm-joao.sh` | o lote inteiro |
| João (PC) | `... --desfazer=<log> [--confirmo-apagar]` | desfaz uma rodada pelo registro de ids |
| qualquer | `bash ops/crm-historico-kommo/testar.sh` | testes da parte pura do Ruby (Docker) |
| qualquer | `bash ops/crm-historico-kommo/testar-silencio.sh` | prova de silêncio numa instalação descartável do Chatwoot |

## ORDEM e travas — rodar DEPOIS da caixa do WhatsApp

O importador **recusa**:
- se a conta ainda não tem a caixa do WhatsApp Cloud (ou há mais de uma e falta `--caixa=N`): o contato importado tem de ser o MESMO que a caixa vai criar quando o paciente escrever;
- se a caixa está com a **trava de conversa única DESLIGADA** (`lock_to_single_conversation`; a de Parauapebas tem ligada): sem ela a próxima mensagem do paciente abre conversa nova e o histórico fica parado ao lado. (O kit passou a criar a caixa com o MESMO valor da caixa de referência.)
- a **conta 1** (Parauapebas), sempre; e arquivo cuja conta (`conta_id` no cabeçalho, gravado pelo exportador a partir de `unit_chatwoot`) não é a pedida, ou sem `conta_id`.

O telefone vira `contact_inboxes.source_id` (só dígitos, com DDI — o `wa_id` do WhatsApp Cloud) e `contacts.phone_number` (`+…`); o Chatwoot casa as duas formas do celular brasileiro (com e sem o 9) pelas variantes do `BrazilPhoneNormalizer`, e o importador procura nas duas. **Provado** no Chatwoot descartável: o paciente que escreve pelo caminho normal (`Whatsapp::IncomingMessageWhatsappCloudService`) cai no contato importado e na conversa importada (que reabre), inclusive com o `wa_id` sem o 9.

## O que cada cartão vira

- **Contato**: nome + telefone (reaproveita o que já existir na caixa ou na conta com o mesmo telefone; senão cria). Vários cartões do mesmo telefone = **um** contato.
- **Conversa RESOLVIDA** (uma por cartão, quando ele vale mais que a conversa de destino do paciente — ver «Destino» abaixo) com a etiqueta `historico`, a marca `additional_attributes.kommo_lead_id` (a chave de idempotência), `kommo_importado_em` (o instante da gravação), `kommo_ordem` (a posição do cartão) e `origem_historico = kommo`, sem responsável, na data de criação do cartão e com a última atividade = a última mensagem/mudança.
- **Destino (estável entre rodadas)**: a caixa trava em conversa única, então a próxima mensagem do paciente cai na conversa de **maior id** do contato. Um cartão **cria** conversa nova só se vale mais (aberto > fechado, depois o mais recentemente atualizado) que o cartão da conversa de destino **e** essa conversa ainda é nossa e ninguém mexeu nela. Em qualquer outro caso o cartão **ENTRA** na conversa de destino **só com a nota-resumo privada e as mensagens antigas** (data original) — **nunca atributo, nunca etiqueta**: campo novo numa conversa que a régua já conhece é «entrou agora» e dispara mensagem, e a etiqueta `historico` numa conversa viva a silenciaria. Entra assim: o paciente que já escreveu pelo WhatsApp, a conversa que a equipe/o paciente já usou, um cartão mais velho que chega numa rodada seguinte. Piloto (`--limite=5`) + lote dão o mesmo destino que o lote direto. A última atividade, o status e o responsável da conversa viva **não mudam**.
- **Atributos do CRM** (datas só-de-data como `retomar_em`/`data_alta`/`data_retorno` usam o dia do valor, sem o −3 h dos campos com hora) (só os que a conta define, e só valor que está na lista de opções): `funil`, `etapa`, `etapa_tratamento`, `data_consulta`, `hora_consulta` (Belém, UTC−3), `situacao_consulta`, `categoria_consulta`, `qualificacao`, `pagamento_antecipado`, `fechou_tratamento`, `retomar_em`, `motivo_espera`, `motivo_nao_agendamento`, `motivo_nao_fechamento`, `proxima_sessao`, `hora_sessao`, `data_alta`, `data_retorno`, `compareceu_ultima_sessao`, `deixou_avaliacao_google`; mais `origem` e `valor_fechado` (chaves que o código do CRM já lê e a conta de Timbó ainda não define: ficam guardadas, a tela só mostra quando o kit as criar).
- **Etiquetas** (só na conversa que a importação CRIA): `historico` sempre; `perdido-*`, `quente`, `anuncio`, `alta`, `pendente-de-revisao` quando a conta as tem; `conferir-etapa` (criada se faltar) nas etapas sem coluna.
- **NOTA-resumo** privada, no começo da conversa: etapa na Kommo, responsável, datas, consulta, motivo de perda, orçamento, queixa, observações, valores, origem, etiquetas da Kommo e o que ficou para conferir.
- **Mensagens**: as **últimas 50** da conversa da Kommo (lida em páginas de 100 até o fim, até 5 conversas do cartão, para as 50 serem as últimas de verdade e o total da nota bater), com a data/hora original; do paciente = recebida, o resto = enviada (sem remetente e marcada como externa, como o Chatwoot grava o que a clínica manda por outro app). Anexo vira «[imagem]», «[áudio]»… (a mídia da Kommo não é baixada).

### De/para das etapas (o mesmo de 12/11 de Parauapebas, estendido)

| Kommo | CRM |
|---|---|
| COMERCIAL › Incoming leads | etapa **Novo lead** |
| EM QUALIFICAÇÃO | **Sofia qualifica** (ou **Esperando humano** se «Atendimento assumido por humano» = Sim) |
| AGENDADO | **Agendado** (ou **Confirmado** se a situação for Confirmado) |
| NÃO COMPARECEU | continua **Agendado**, situação **Não compareceu** |
| COMPARECEU | **Compareceu** |
| EM NEGOCIAÇÃO | **Pós-consulta** |
| GANHO / CONCLUÍDO | **Fechou** (+ `fechou_tratamento`) |
| PERDIDO | **Perdido** + motivo (campo ou motivo nativo) + etiqueta `perdido-*` |
| EM ESPERA, CONFERIR NA FRANQUIA, RETORNO PÓS-TRATAMENTO | **sem coluna no CRM**: etapa vazia + `conferir-etapa` (EM ESPERA leva `retomar_em`/`motivo_espera`; RETORNO leva a categoria «Retorno após tratamento») |
| TRATAMENTO › Incoming leads / EM TRATAMENTO / ALTA / TRATAMENTO CANCELADO | funil **Tratamento** + `etapa_tratamento` **Entrada / Em tratamento / Alta / Tratamento cancelado** (sem etapa comercial) |

## Silêncio e proteção do paciente

- Tudo é gravado com `insert_all!`/`update_all`, **sem callbacks**: sem webhook para o agente, automação nativa, notificação, e-mail, evento de relatório, job. Até a etiqueta `conferir-etapa` é criada sem callback. **Provado** em `testar-silencio.sh` (controle positivo: a criação normal dispara eventos, jobs e a automação).
- **Arquivo só enquanto ninguém mexeu** (`ehArquivo`, `chatwoot-regua.ts`): a conversa importada é arquivo para a régua, o CAPI, a agenda, o funil e as telas **enquanto continua resolvida e a última atividade não passou de `kommo_importado_em`**. O paciente que escreve cai nela (trava de conversa única), a equipe responde ou alguém reabre: ela deixa de ser arquivo e **tudo a enxerga** — régua, agenda (grava Atendido/Não compareceu), CAPI, aviso de demora (`historicoSilencia`), etiqueta `falta-etapa` ao resolver. A etapa que veio da Kommo é ponto de partida (etiqueta `historico` = «visto inicial»): não vira follow-up de meses atrás. O corte de 14/11 é de Parauapebas e não vale aqui.
- **Consulta de pé = viva desde o nascimento**: cartão AGENDADO / NÃO COMPARECEU com consulta de hoje em diante (ou de até 35 dias atrás, situação Agendado/Confirmado/Remarcado/Atendido/Não compareceu) **não** é arquivo: a régua do CRM manda véspera/dia/preparo (e falta, pós-atendimento…). A Kommo deixa de mandar hoje. O `--so-conferir` conta `NASCEM_VIVAS`.
- A leitura do funil (`lerPaginasCruas`) **não para** numa página só de cartões importados da Kommo (a data deles é recente e não obedece a «arquivo é mais velho que as vivas»): lê até o fim da caixa ou o teto de páginas.
- A etiqueta `historico` da conversa que a importação cria faz a régua e o CAPI tratarem o que ela já mostra como estado inicial. **Não tire a etiqueta.**
- **Atenção antes de ligar a régua em Timbó**: quando a régua do CRM for ligada (hoje está em SECO), os lembretes de véspera/dia valem para os cartões AGENDADOS importados — o que é desejado quando a Kommo for desligada, mas **duplica** o lembrete se a Kommo ainda estiver mandando. Ligue a régua só depois de desligar os robôs de lembrete da Kommo.

## Idempotência, re-rodada e desfazer

- A chave é o **id do cartão da Kommo**. Rodar de novo: o que já existe só ganha as **mensagens novas** (pelo `source_id` `kommo:<cartão>:<mensagem>`); **atributo e etiqueta nunca são escritos em conversa que já existe** — o que a equipe mexeu no CRM nunca é sobrescrito. A nota-resumo só é reescrita num caso: a 1ª rodada não conseguiu ler a conversa («a Kommo não entregou a conversa») e a seguinte conseguiu.
- `--desfazer=<log>`: lê as linhas `REG` do log da rodada. Apaga **todas** as mensagens e notas do registro (também as que uma 2ª rodada acrescentou em conversa que já existia), tira as etiquetas das conversas criadas que ficam, e só apaga a conversa que ela CRIOU se **ninguém a usou** (resolvida, sem responsável, nenhuma mensagem fora do registro); contato que a equipe mexeu (nota, etiqueta, campo) **fica**. Exige `--confirmo-apagar`; sem ele só mostra.
- O `REG` de cada cartão sai **depois do commit**: rodada interrompida já deixou o registro do que confirmou.

## Rodar fora do expediente

O exportador faz ~1.300 chamadas à Kommo em ~25 min no **mesmo token** do atendimento ao vivo: o script avisa e pergunta se for entre 7h e 19h. Rode à noite ou de madrugada.

## Combinações recusadas pelo script do João

`--completo` só com `--so-conferir` (sozinho GRAVARIA); `--confirmo-apagar` só com `--desfazer`; `--desfazer` não combina com `--so-conferir`, `--completo` nem `--limite`; `--acompanhar` não combina com nada.
