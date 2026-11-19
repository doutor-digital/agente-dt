# Histórico do Instagram Direct e do Messenger no CRM

Importa o histórico de mensagens das caixas **7 (Instagram)** e **8 (Messenger)** da conta 1 (Doutor Hérnia Parauapebas) e corrige os «John Doe» do Messenger. Roda **dentro do contêiner `chatwoot_rails`** (`rails runner`): dado de paciente não sai da VPS.

| Quem roda | Comando | O quê |
|---|---|---|
| João (PC) | `bash ops/historico-social-crm-joao.sh --so-conferir` | conta tudo (Meta e banco, só leitura) |
| João (PC) | `bash ops/historico-social-crm-joao.sh --limite=5` | piloto: 5 conversas por caixa |
| João (PC) | `bash ops/historico-social-crm-joao.sh` | o lote inteiro |
| João (PC) | `bash ops/historico-social-crm-joao.sh --desfazer=<log>` (+ `--confirmo-apagar`) | desfaz uma rodada pelo registro de ids |
| João (PC) | `bash ops/nomes-messenger-crm-joao.sh --so-conferir / --ligar / --desligar / --status` | rotina de 10 min dos «John Doe» |
| qualquer | `bash ops/crm-historico-social/testar.sh` | testes da parte pura (Docker, sem Ruby no PC) |
| qualquer | `bash ops/crm-historico-social/testar-silencio.sh` | prova de silêncio numa instalação descartável do Chatwoot |

## Por que nada reage à importação

Tudo é gravado com `insert_all!` / `update_all` — **sem callbacks do Rails**. Webhook para o nosso agente, automações nativas, notificações, e-mail, ActionCable e jobs do Sidekiq nascem nos `after_*_commit` de `Message`, `Conversation` e `Contact`; sem callback, não nascem. Conversa vira RESOLVIDA, com a etiqueta `historico`, sem responsável. As conversas vivas não são tocadas (o `UPDATE` só alcança conversa com a marca `meta_conversation_id` e ainda resolvida). `testar-silencio.sh` prova isso (controle positivo: a criação normal dispara eventos, jobs e a automação; a importação, zero).

## Regras

- **Contato** = o mesmo `contact_inboxes.source_id` que o Chatwoot usa (IGSID no Instagram, PSID no Messenger): mensagem nova da pessoa cai no mesmo contato. Contato existente é reaproveitado; no Instagram, quem já veio pelo Messenger com o mesmo id também (igual ao Chatwoot).
- **Idempotente** por `messages.source_id` = id da mensagem na Meta (os ids da Graph e do webhook são os mesmos — conferido). Conversa de histórico é achada por `additional_attributes.meta_conversation_id`.
- **Corte**: mensagem a partir de «início da rodada − 15 min» é *viva* e fica para o webhook. Se a importação gravasse uma mensagem viva antes do webhook, o Chatwoot a trataria como já existente e a equipe nunca a veria.
- **Anexo** vira texto («[imagem]», «[áudio]», «[vídeo]», «[arquivo]», «[figurinha]», «[compartilhamento]», «[menção em story]»…); a URL da Meta expira e não é baixada nem guardada.
- **Instagram**: a Meta entrega só as ~20 mensagens mais recentes de cada conversa (a `paging.next` devolve erro 4/1349210, que parece limite de chamadas e não é — não se segue). Conversa com 20 é contada como «possivelmente truncada». **Messenger**: paginação completa.
- **Nome**: Messenger troca só «John Doe» exato ou vazio pelo nome da conversa da página (`participants`), nunca um nome editado. Instagram: nome do perfil (mesma chamada do Chatwoot), senão o @usuário.
- **Limite da Meta**: ~0,7 s entre chamadas; código de limite espera 90 s/180 s e tenta de novo, depois para; token/permissão negados param na hora; 5 falhas seguidas da Meta ou 10 erros seguidos param a rodada.
- **Saída**: só ids e contagens. Linhas `REG {...}` = registro de ids criados (contatos, contact_inboxes, conversas, taggings, mensagens), impressas **depois do commit de cada conversa** — uma rodada interrompida já deixou o registro do que confirmou.

## Rotina dos «John Doe» (caixa 8)

O Chatwoot pede o perfil à Meta (`get_object(PSID)`), a Meta nega (falta «Business Asset User Profile Access») e o contato nasce «John Doe». O nome vem de `GET /{page}/conversations?platform=messenger&user_id={PSID}&fields=participants`. Mora no **cron da VPS** (`/etc/cron.d/crm-nomes-messenger`, a cada 10 min): `nomes-messenger-cron.sh` pergunta ao Postgres se há candidato (contatos das últimas 2 h; 1×/hora, dos últimos 3 dias) e só então acorda o Rails. Mesmo lock da importação (não rodam juntas). Parar sem desinstalar: `touch /root/kit/crm-historico-social/PARAR`.
