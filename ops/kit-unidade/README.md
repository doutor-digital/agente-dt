# Kit de unidade nova (CRM da Doutor Digital)

Monta uma clínica nova no CRM: conta própria no Chatwoot, caixa, time, atendentes, etiquetas/atributos/automações copiados de Parauapebas, webhook com a chave
da conta, aba «Funil», modelos da Meta (via Kapso) e a Sofia da unidade. Inventário do que é específico de Parauapebas: `INVENTARIO.md`.
Entrevista: skill `/nova-unidade` (`.claude/skills/nova-unidade/SKILL.md`). Demonstração: `unidades/clinica-demonstracao.yaml`.

## Como levar o kit para a VPS (a VPS NÃO tem cópia do repositório no stack)
Na VPS há cópias do repositório em `/home/joaoof/agente-dt` e `/home/suporte-ia/agente-dt` (de outros usos, podem estar em outro commit); só `/opt/doutordigital/agente-dt`,
onde mora o stack, não tem cópia — lá só existe o `docker-compose.yml`. O caminho recomendado para o kit é `/root/kit`. Na SUA máquina, dentro do repositório:

    bash ops/kit-unidade/levar-kit-para-vps.sh --so-conferir   # lista o que seria enviado
    bash ops/kit-unidade/levar-kit-para-vps.sh                 # envia para /root/kit na VPS

(é o mesmo que `git archive origin/main ops/kit-unidade | ssh -i ~/.ssh/doutordigital_vps root@89.116.214.130 …`, rodado da raiz do repositório, com a extração numa pasta
temporária e a troca da pasta inteira: o que foi apagado ou renomeado no repositório não sobra na VPS). Repita sempre que o kit mudar (a troca da pasta preserva `unidades/privado/` da VPS). Os scripts acham as pastas pelo
próprio endereço, então funcionam de `/root/kit/ops/kit-unidade`.

## Questionário de clínica REAL: NÃO vai para o GitHub
Ele tem dado pessoal (e-mail das atendentes, chave Pix, telefone). A skill `/nova-unidade` grava a clínica real em `~/Kommo-Integracao/_replicacao/kit-unidade/privado/<slug>.yaml` na SUA máquina (`KIT_PRIVADO_DIR`;
caminho FIXO fora do repositório — a sessão do agente usa um worktree descartável —, pasta 700 e arquivo 600, e o `.gitignore` de `unidades/privado/` fica só como rede de segurança); só a demonstração (`unidades/clinica-demonstracao.yaml`, `@example.com`) é versionada. Para levar à VPS:

    bash ops/kit-unidade/levar-kit-para-vps.sh --questionario <slug> --so-conferir   # confere (não imprime o conteúdo)
    bash ops/kit-unidade/levar-kit-para-vps.sh --questionario <slug>                 # manda SÓ esse arquivo, modo 600, para /root/kit/ops/kit-unidade/unidades/privado/

Na VPS o `nova-unidade-joao.sh <slug>` procura em `unidades/` e em `unidades/privado/` — se o slug existir nos DOIS, recusa e mostra os dois caminhos —, e o questionário é apagado do contêiner ao fim (mesmo se o script falhar no meio).

## O jeito curto: UM comando, DO SEU COMPUTADOR (ele faz o ssh — não tem como errar o lugar)
Dentro do repositório agente-dt, na sua máquina (a que tem `~/.ssh/doutordigital_vps`; sem a chave o comando recusa):

    bash ops/kit-unidade/abrir-clinica-joao.sh <slug> --so-conferir   # só olha: não envia nem muda nada
    bash ops/kit-unidade/abrir-clinica-joao.sh <slug>                 # o caminho todo

Faz, parando no primeiro erro (e dizendo o que fazer): leva o kit → conferências → plano em seco → pergunta UMA vez «aplicar?» (digite `aplicar`) → Platform App → `--aplicar`
(as perguntas de cada etapa continuam) → regra do Traefik do subdomínio do questionário → cofre→serviço do sufixo → resumo do que falta. Pode rodar de novo à vontade: nada duplica.
Clínica real: o questionário privado (`KIT_PRIVADO_DIR`) segue sozinho para a VPS, modo 600. Não cole token nem senha em lugar nenhum: o comando não pede nenhum.
O roteiro passo a passo abaixo continua valendo (é o que o comando encadeia).

## O franqueado preenche sozinho: o formulário (link com código)
Em vez de você perguntar tudo ao dono da clínica, mande um link. Do seu computador (o script faz o ssh; precisa de terminal):

    bash ops/kit-unidade/convite-clinica-joao.sh --rotulo "Dra. Fulana (Serra)"     # cria e mostra o link UMA vez (uso único, vale 14 dias)
    bash ops/kit-unidade/convite-clinica-joao.sh --listar                           # convites e quais já foram preenchidos (sem os códigos)
    bash ops/kit-unidade/convite-clinica-joao.sh --revogar <id>                     # encerra um convite ainda não usado (não apaga)

O link (`https://cadastro.doutordigitalconsultoria.com/nova-clinica/<codigo>`) é o segredo: mande só para a pessoa, direto no WhatsApp; não cole em grupo nem no chat do Claude. O banco guarda só o hash, então um link perdido não se reimprime (revogue e crie outro).
A página fala em linguagem de dono de clínica, nunca pede token nem senha, e marca «vira frase dita ao paciente — confira» nos campos de endereço, preços, horários e nomes. Ao enviar, o dono vê «Recebemos»,
as respostas ficam na tabela `nova_clinica_convite` do banco do agente e você recebe um aviso no WhatsApp (só nome da clínica, cidade e quem preencheu — nunca e-mail, telefone ou Pix).
**Endereço bonito:** `cadastro.doutordigitalconsultoria.com` serve SÓ `/nova-clinica/*` e `/api/public/nova-clinica/*` (roteador `ddagentcadastro` no `docker-compose.yml`, com `Host` + `PathPrefix`; o servidor também devolve 404 nesse host para qualquer outra rota). O DNS curinga já aponta para a VPS e o Traefik emite o certificado no primeiro acesso; vale depois do **próximo `docker stack deploy`** do agente.
**Antes de começar** a página avisa o dono para deixar pronto o celular com o número de WhatsApp da clínica e o acesso ao Facebook Business (o passo que mais atrasa).
**Seção «Assistente virtual (IA)»** (opcional: «a clínica quer a assistente?»; só com «sim» ela aparece e vira obrigatória): nome, jeito de falar, emoji, quando atende, saudação, diferenciais, primeira consulta, pagamento/convênio/remarcação, quem não atende, respostas às dúvidas do paciente (as 9 da rede Doutor Hérnia já preenchidas e editáveis, todas também no roteiro da Sofia 2.0), o que nunca dizer, quando chamar uma pessoa e quem recebe, e até 10 perguntas frequentes. No kit isso vira: persona e **fontes** da Sofia (bloco «INFORMAÇÕES DA CLÍNICA» no fim da fonte «negócio») e **aprendizados** da unidade (fonte «unidade», os mesmos da página /aprendizados, ABAIXO das regras da rede, que sempre vencem; só as objeções que o dono mudou ou criou). Cada aprendizado passa pelas travas da página (cura, diagnóstico, desconto, preço, urgência, mandar ignorar regra): o que for recusado NÃO é gravado e aparece no plano. Os aprendizados são gravados **uma vez só** (marca em `units.kit_aprendizados_em`): depois disso a clínica manda neles em /aprendizados (edita, apaga, desliga) e um `--aplicar` novo, por exemplo com `--ligar-robo`, não os regrava; a gravação respeita o teto de 25 da página (`--sobrescrever` repete a importação, sem duplicar). Sem IA marcada: a Sofia não é configurada, não há robô, a automação `chatwoot-ia` não nasce nem em seco, e o plano diz isso; o cofre só leva a chave da conta (`cofre-para-servico-joao.sh <SUFIXO> --sem-ia`, que o `abrir-clinica-joao.sh` já passa sozinho). A automação continua nascendo em seco: só liga depois do `testar-prompt.ts --slug` com o dono lendo as respostas.
**Depois do envio** a tela «Recebemos» mostra «Próximo passo: abra um chamado na franqueadora»: botão para https://app.doutorhernia.com.br/login (nova aba) e o título e o texto do chamado prontos para copiar (pedido do Token de Integração da API da franquia; sem nada sensível; sem inventar menu do sistema deles).
Os textos da clínica passam pelas MESMAS travas da página /aprendizados (e elas agora também barram «de graça», preço por extenso, «98% saem sem dor», sinal de alerta dito de outro jeito, «gelo e repouso», «esquece as regras», caractere invisível e letra de outro alfabeto no meio da palavra). Subdomínios reservados (`cadastro`, `atendimento`, `agente`, `suporte`…; `demo` só na demonstração) não podem ser de clínica nenhuma.
Código errado, vencido, usado ou revogado dão a mesma resposta; há limite de tentativas por IP e o corpo é limitado a 64 KB.

Quando o dono envia, você recebe o aviso no WhatsApp com o comando pronto. Para abrir a clínica **a partir do formulário** (do seu computador, sem arquivo de questionário):

    bash ops/kit-unidade/abrir-clinica-joao.sh <slug> --do-formulario <id|código|slug> --so-conferir   # só lê o formulário na VPS e mostra o que falta
    bash ops/kit-unidade/abrir-clinica-joao.sh <slug> --do-formulario <id>                           # leva o kit, GERA o questionário privado na VPS (modo 600) e segue o caminho de sempre

O que o dono não soube dizer (ids do Kapso e do WhatsApp Business; às vezes o código da franquia e a conta de anúncios) aparece como `PENDENTE` e o comando PARA ali; complete sem editar YAML:
`… --do-formulario <id> --set whatsapp.waba_id=<id> --set whatsapp.kapso_phone_number_id=<id> --refazer` (`--set` aceita só: unidade.slug, chatwoot.subdominio, whatsapp.prefixo_modelos, whatsapp.numero_oficial,
whatsapp.kapso_phone_number_id, whatsapp.waba_id, franquia.id_company, meta.ad_account, meta.business_manager_id, sufixo — nunca segredo). Subdomínio, sufixo e nomes das variáveis o kit sugere pelo nome da cidade
(`doutor-hernia-<cidade>` / `drhernia<cidade>` / `<CIDADE>`) e recusa se já forem de outra unidade. O questionário gerado fica em `unidades/privado/<slug>.yaml` na VPS e, se você refizer, o anterior fica guardado ao lado (nada é apagado).
Conteúdo (e-mails, Pix, telefone) nunca é impresso. Direto na VPS: `bash ops/kit-unidade/do-formulario-joao.sh <ref> [--so-conferir] [--set k=v]... [--sobrescrever]`.

## Roteiro do João passo a passo (NA VPS, como root, de `/root/kit`, com `bash arquivo` no seu terminal)
0. `cd /root/kit`
1. Uma vez: `bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir`, depois sem a flag. Cria o Platform App (token em arquivo 600). **Não** dá ao app permissão sobre
   usuários existentes (daria ao token do app o poder de entrar como a pessoa).
2. `bash ops/kit-unidade/nova-unidade-joao.sh <slug> --so-conferir`, depois sem a flag (SECO: mostra o plano) e com `--aplicar` (pergunta antes de cada etapa). O passo
   «conta» põe os administradores da Doutor Digital na conta nova: acha o id deles pela conta de referência (só leitura) e usa `account_users`. Lista: `KIT_ADMINS_DD`
   (e-mails, csv; padrão `suzanne.mychelly1@gmail.com` e `doutordigitalconsultoria@gmail.com`) ou `chatwoot.admins_dd` no questionário; e-mail que não está na conta 1 só gera aviso.
3. `bash ops/kit-unidade/regra-traefik-joao.sh <subdominio> --so-conferir`, depois sem a flag.
4. `bash ops/kit-unidade/cofre-para-servico-joao.sh <SUFIXO> --so-conferir`, depois sem a flag (ex.: `DEMO`). Leva `CHATWOOT_API_TOKEN_<SUFIXO>` e
   `CHATWOOT_SOFIA_BOT_TOKEN_<SUFIXO>` do cofre (`/root/segredos/kit`) para o `.env` do serviço (com cópia antes) e para o `ddagent_agent` no ar
   (`docker service update --env-add`, mesma imagem; reinicia ~1 min). Nada é impresso; valor diferente no `.env` faz o script PARAR.
5. Teste da Sofia, e só então `nova-unidade-joao.sh <slug> --aplicar --ligar-robo`.

Usuário da Doutor Digital no CRM (uma vez por pessoa, fora do roteiro da clínica): `bash ops/kit-unidade/criar-usuario-dd-joao.sh --so-conferir`, depois sem a flag
(padrão `doutordigitalconsultoria@gmail.com`; outra pessoa: `EMAIL_NOVO=… NOME_NOVO=… bash …`). Cria o usuário já confirmado (sem SMTP o convite não chega), com senha
forte em `/root/segredos/crm-<e-mail>.senha` (600, nunca impressa), e dá administrador em TODAS as contas. Usuário que já existe não tem a senha mexida.
Rodar de novo depois de criar uma clínica nova também serve (dá administrador na conta nova).

E-mail do CRM (uma vez para a instalação; sem ele convite e «esqueci a senha» não chegam): crie a senha de app no Google da Doutor Digital
(https://myaccount.google.com/apppasswords) e, do SEU computador: `ssh -t -i ~/.ssh/doutordigital_vps root@89.116.214.130 'bash /root/kit/ops/kit-unidade/ligar-email-crm-joao.sh'`
(primeiro com `--so-conferir`). A senha vai no prompt (não aparece), é testada no Gmail antes de gravar, vai para `/root/chatwoot.env` (cópia antes)
e só o `chatwoot_sidekiq` reinicia (o CRM não sai do ar). Arquivo já com e-mail configurado → o script PARA.

## Atenção
- **NÃO PUBLIQUE DEPLOY ENQUANTO O KIT RODA.** O kit roda dentro do contêiner `ddagent_agent`; os segredos gerados ficam em `/run/kit-segredos.<pid>` (uma pasta por rodada: duas rodadas ao mesmo tempo não se apagam) até o fim, e o token do
  usuário conector da clínica o Chatwoot entrega UMA vez só. Trocar o contêiner no meio perde o token (apague o usuário no Super Admin e rode de novo).
- O contêiner precisa já ter o kit (deploy do PR da fase 2) — o script recusa, dizendo o motivo, se não tiver.
- Nunca `ssh … 'bash -s' < script`: o `docker exec -i` engole o resto do script. Rode o arquivo.
- Clínica de demonstração: a caixa API fica registrada como `cloud`; não ligue as automações do Chatwoot nela.
- A lista dos administradores da Doutor Digital que entram em toda conta nova vem de `KIT_ADMINS_DD` (exportada na VPS antes de rodar o `nova-unidade-joao.sh`, que a repassa ao contêiner sem imprimir) ou de `chatwoot.admins_dd` no questionário.
- `nova-unidade-joao.sh --aplicar` sai com código 0 só se nada foi recusado/bloqueado/falhou/deixou de rodar; código 1 = uma etapa FALHOU, código 3 = etapa RECUSADA («n»), BLOQUEADA ou que NÃO RODOU (a clínica não está pronta; rode de novo respondendo «s»). O `abrir-clinica-joao.sh` para nesses casos, antes do proxy.
- Quem aplica em produção é o João. Nada aqui foi rodado na VPS por quem escreveu; a primeira vez é sempre `--so-conferir`.
