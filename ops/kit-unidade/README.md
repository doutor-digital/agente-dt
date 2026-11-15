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
Ele tem dado pessoal (e-mail das atendentes, chave Pix, telefone). A skill `/nova-unidade` grava a clínica real em `ops/kit-unidade/unidades/privado/<slug>.yaml` na SUA máquina
(pasta no `.gitignore`); só a demonstração (`unidades/clinica-demonstracao.yaml`, `@example.com`) é versionada. Para levar à VPS:

    bash ops/kit-unidade/levar-kit-para-vps.sh --questionario <slug> --so-conferir   # confere (não imprime o conteúdo)
    bash ops/kit-unidade/levar-kit-para-vps.sh --questionario <slug>                 # manda SÓ esse arquivo, modo 600, para /root/kit/ops/kit-unidade/unidades/privado/

O `nova-unidade-joao.sh <slug>` procura primeiro em `unidades/` e depois em `unidades/privado/`; o questionário também é apagado do contêiner ao fim.

## Roteiro do João (NA VPS, como root, de `/root/kit`, com `bash arquivo` no seu terminal)
0. `cd /root/kit`
1. Uma vez: `bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir`, depois sem a flag. Cria o Platform App (token em arquivo 600). **Não** dá ao app permissão sobre
   usuários existentes (daria ao token do app o poder de entrar como a pessoa).
2. `bash ops/kit-unidade/nova-unidade-joao.sh <slug> --so-conferir`, depois sem a flag (SECO: mostra o plano) e com `--aplicar` (pergunta antes de cada etapa). O passo
   «conta» põe os administradores da Doutor Digital na conta nova: acha o id deles pela conta de referência (só leitura) e usa `account_users`. Lista: `KIT_ADMINS_DD`
   (e-mails, csv; padrão `suzanne.mychelly1@gmail.com`) ou `chatwoot.admins_dd` no questionário; e-mail que não está na conta 1 só gera aviso.
3. `bash ops/kit-unidade/regra-traefik-joao.sh <subdominio> --so-conferir`, depois sem a flag.
4. Copiar os tokens do cofre (`/root/segredos/kit`) para o env do serviço `ddagent_agent` e reiniciar (o servidor só conhece a conta nova depois).
5. Teste da Sofia, e só então `nova-unidade-joao.sh <slug> --aplicar --ligar-robo`.

## Atenção
- **NÃO PUBLIQUE DEPLOY ENQUANTO O KIT RODA.** O kit roda dentro do contêiner `ddagent_agent`; os segredos gerados ficam em `/run/kit-segredos` até o fim, e o token do
  usuário conector da clínica o Chatwoot entrega UMA vez só. Trocar o contêiner no meio perde o token (apague o usuário no Super Admin e rode de novo).
- O contêiner precisa já ter o kit (deploy do PR da fase 2) — o script recusa, dizendo o motivo, se não tiver.
- Nunca `ssh … 'bash -s' < script`: o `docker exec -i` engole o resto do script. Rode o arquivo.
- Clínica de demonstração: a caixa API fica registrada como `cloud`; não ligue as automações do Chatwoot nela.
- A lista dos administradores da Doutor Digital que entram em toda conta nova vem de `KIT_ADMINS_DD` (exportada na VPS antes de rodar o `nova-unidade-joao.sh`, que a repassa ao contêiner sem imprimir) ou de `chatwoot.admins_dd` no questionário.
- Quem aplica em produção é o João. Nada aqui foi rodado na VPS por quem escreveu; a primeira vez é sempre `--so-conferir`.
