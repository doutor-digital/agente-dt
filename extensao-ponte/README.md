# Ponte — o cartão do Kommo ao lado da conversa no WhatsApp Web

Extensão do Chrome (e do Firefox), **versão 0.5.1 — textos da unidade sem IA** (sobre a 0.5.0, visual novo). Com uma conversa aberta no WhatsApp Web, o
painel lateral mostra o cartão do Kommo daquele paciente, mastigado para quem não conhece o Kommo:

- **quem é**: nome, telefone, o selo colorido da **unidade** (o `⌂ Unidade de atendimento`; vazio na conta de duas
  unidades = "Escolha a unidade"), a **qualificação** (Quente, Morno, Frio) e como o cartão foi achado (pelo telefone,
  pelas mensagens, pelo nome — "confira" — ou escolhido por você);
- **onde está o cartão** (novo na 0.5.0): a **trilha do funil**, com a etapa atual acesa, há quanto tempo ele está nela
  e de quem é a etapa — **azul = é sua**, **dourado = anda sozinha pela franquia** —, e o que vem depois;
- **O que é seu agora** (0.5.0): de 1 a 3 ações para a etapa e o botão **O que eu faço agora?** (o guia da 0.4.0); e,
  logo abaixo, **O que é da franquia**: como marcar a consulta (0.5.1: paciente novo pelo widget "Assistente do cartão",
  nunca direto na franquia) e "Dar baixa e lançar sessão se faz NA FRANQUIA; o cartão anda sozinho aqui";
- **Na franquia** (0.5.0): próxima consulta (dia da semana, data, hora, fisioterapeuta, "amanhã"), última consulta
  (veio ou faltou), tratamento, **sessões** (feitas, faltas, marcadas e a próxima) e alta — ou "Sem cadastro na
  franquia", com clareza;
- **Resumo** (fase 2), **Sofia** (estado e "Pausar a Sofia neste paciente"; some na unidade sem a IA), **aviso de
  cartão duplicado** (0.3.0, agora recolhido numa linha), responsável, de que anúncio veio, **etiquetas** (pôr e tirar)
  e **Abrir no Kommo**.

E mais duas abas: **Fila de hoje** (fase 2): os números por grupo no topo e quem chamar ou ligar hoje, com **Começar a
ligar** (0.3.0); e **Respostas** (0.3.0): as respostas prontas do Kommo para copiar — na 0.5.0, com as **sugeridas
para a etapa** no topo.

E, no ícone da extensão, **quantos pacientes estão esperando resposta** (0.4.0).

Também tem um bloco "Modo aprendiz", que diz onde cada coisa fica dentro do Kommo. Por enquanto ele é fixo; uma
fase futura vai escolher qual dica mostrar e quando.

## O que há de novo na 0.5.1 (textos da unidade sem IA)

A Ponte vai aparecer no vídeo de treinamento de **Petrópolis e Caxias**, que não têm a Sofia. As telas da 0.5.0 mostraram
textos errados para essas unidades. O que mudou (o resto funciona igual):

1. **Sofia só onde há Sofia.** O rodapé fixo dizia "pausa da Sofia" em toda unidade; agora o trecho só aparece quando o
   servidor diz que a unidade tem a IA (`sofiaNaUnidade: true`, a mesma marca que já escondia o bloco da Sofia). Sem
   saber ainda (antes do 1º cartão), não aparece. A dica "Pausar a Sofia" do modo aprendiz segue a mesma regra
   (`quando: 'com-ia'`, `dicasPara` em `aprendiz.js`), e a página de opções ficou neutra ("…etiqueta, ligação, campo,
   mudança de etapa ou pausa"). No guia (servidor), a dica da ◷ Data da Consulta não fala mais "pela Sofia".
2. **Fila de ligações sem espera.** O cabeçalho dizia "Uma conversa a cada 0 s" (desde a 0.5.0 não há espera). Agora:
   "Sem espera entre uma ligação e outra · no máximo 40 por hora, para o número não parecer spam e ficar protegido."
   Com um intervalo configurado no servidor (`PONTE_LIGACAO_INTERVALO_S`), volta a dizer "Uma conversa a cada N s"
   (`textoDoRitmo`, em `ligacao.js`).
3. **O nome da unidade com acento, sem piscar.** O topo abria com o nome tirado do slug ("Petropolis") e trocava para
   o do servidor ("Petrópolis") quando o cartão chegava — e de novo a cada mudança nas opções; a fila mandava o nome
   inteiro do banco. Agora o nome vem sempre do servidor (cartão, fila ou `/ping`), passa pelo mesmo
   `nomeCurtoDaUnidade` (`trilha.js`, igual ao do servidor) e fica guardado. O do slug só aparece se o servidor não
   responder.
4. **Fila de hoje com Petrópolis e Caxias misturadas: NÃO mudou nesta versão** (precisa de decisão; ver "Em aberto",
   abaixo).
5. **Marcar consulta pelo widget.** A regra dourada ("O que é da franquia"), o "Sem cadastro na franquia", a ação de EM
   ESPERA, a dica do guia e o modo aprendiz agora dizem: paciente **novo** se cadastra e marca pelo widget
   **"Assistente do cartão"** do Kommo (**Cadastrar e marcar na franquia**), **nunca direto na franquia**; paciente já
   cadastrado marca na franquia ou pelo widget. Dar baixa e lançar sessão continuam sendo NA FRANQUIA. O "Sem cadastro na
   franquia" diz "A franquia não achou este paciente" e pede para conferir antes quem pode ter cadastro com outro nome ou
   telefone (não achar não é não existir: cadastrar de novo duplicaria o paciente).
6. **Busca pelo telefone.** Sem a Sofia, a Ponte só achava o cartão pelo nome: o passo do telefone só roda quando o
   WhatsApp mostra o número (conversa `@c.us` ou contato não salvo) — e a maioria hoje é `@lid`, que esconde o número —,
   e o passo das mensagens depende do que a Sofia guardou. A busca manual mandava tudo como nome (e o servidor pula o
   telefone na busca manual). Agora, se a atendente digitar um **telefone com DDD** (10 a 15 dígitos, com ou sem
   `+55`, parênteses, espaço, hífen), a busca vai pelo telefone — o mesmo passo da conversa com número, que confere o
   final e o DDD — sem mudar nada no servidor. Número do Brasil: fixo com 10 dígitos ou celular com 11 e o 9 depois do
   DDD (um CPF não passa por telefone); com `+` de fora, de 10 a 15. Sem o DDD (8 ou 9 dígitos), o painel pede o DDD em
   vez de buscar pelo nome (que nunca acharia). Não achou: o que foi digitado volta na caixa. O cartão achado pelo
   telefone digitado é relido pelo id ao voltar do guia, como o achado pelo nome.

7. **Observações** (pedido do João, 15/10: "vamos colocar o campo de observações"). No cartão, a caixa **Observações**
   (até 2000 letras) e o botão **Salvar no cartão**. A atendente escreve, vê a prévia ("Vai gravar no cartão do Kommo
   (uma nota): Observação pela Ponte · Ana · 15/10/2026 15:42:" e o texto) e só grava em **Gravar no Kommo**. O texto
   vira uma **nota comum** no cartão (a nota de texto do lead), com o prefixo **"Observação pela Ponte · <Seu nome das
   opções> · <data e hora de Brasília>:"** e o texto na linha de baixo. Deu certo: "Salvo no cartão." e a caixa limpa.
   O que foi digitado volta se o cartão for redesenhado ou se a atendente trocar de conversa e voltar (só na memória do
   painel, 30 min; nunca no `storage`). Nunca vai para o WhatsApp.
   - Rota nova: `POST /api/public/widget/:slug/ponte/nota` `{ leadId, texto, por }` (`backend/src/lib/ponte-nota.ts`,
     no `ponte-acoes.controller.ts`), com a mesma porta das outras que gravam (`X-Widget-Key` + slug, chave antes do
     limitador; balde `ponte-nota`, 30 por minuto). Responde `{ ok: true, leadId, notaId, repetido }` ou
     `{ ok: false, error }`.
   - O texto: não vazio, até 2000 letras, **sem HTML** (uma tag de HTML de verdade — `<b>`, `<br>`, `<img …>`,
     `<script>`… — ou um comentário; "dor < 5", "<L4 e L5>" e "pressão <alta>" passam) — senão 400 e nada vai ao
     Kommo. Quebras de linha ficam (no máximo uma linha em branco seguida); a prévia já mostra o texto limpo do mesmo
     jeito que o servidor grava. A hora é a de Brasília, carimbada no servidor (também nas unidades de outro fuso, como
     Boa Vista: foi o pedido).
   - O cartão é lido com o token da unidade da chave (o mesmo das etiquetas e da ligação): cartão de outra conta, ou
     apagado, dá 404 e nada é gravado. Na conta de duas unidades, vale qualquer cartão da conta.
   - Uma nota por observação: o mesmo texto no mesmo cartão em menos de 2 min (clique duplo, resposta perdida) devolve
     a nota da primeira vez. Quando não dá para saber se gravou (o Kommo não respondeu a tempo, deu 5xx, ou disse OK
     sem o id da nota), o erro manda **conferir o histórico do cartão antes de tentar de novo**, e o mesmo texto não
     grava outra vez nesses 2 min; recusa clara (o Kommo respondeu 4xx) libera na hora. Enquanto grava, "Voltar e
     corrigir" fica travado. No log, só o id do cartão, o da nota e o tamanho do texto — nunca o texto.
   - **Só funciona depois do deploy do servidor.** Com o servidor de antes, a rota não existe: a `/public` cai no login
     (401 "unauthenticated", não 404) — o painel mostra **"Disponível depois da atualização do servidor."** (também num
     404 sem a mensagem da Ponte) e o texto fica na caixa. Outro 401 (de um proxy) mostra o erro de verdade.
   - O cartão também tem o campo **✎ Observações** (o do guia, da SDR): esta caixa NÃO mexe nele — grava uma nota.
   - Como qualquer nota escrita no Kommo, ela conta como mexida no cartão: se ele tiver pendência de preenchimento, o
     robô de revisão pode marcar "⚠ Revisar cartão" (o mesmo de hoje quando a SDR escreve uma nota lá).

**O que fica guardado a mais** (`chrome.storage.local`, chave `unidadeVista`): o slug, o nome da unidade e se ela tem a
Sofia. Nada de paciente.

### Em aberto: a Fila de hoje da conta de duas unidades

A fila é montada **por conta do Kommo** (cache de 2 min por conta), e Petrópolis e Caxias dividem a conta
`doutorhernialvp`. Caxias não tem credencial do Kommo (pede a conta da dona, `contaDoKommo`), então a Ponte das duas é
configurada com o slug de **Petrópolis**: o painel não sabe de qual unidade é a atendente. Separar pede:

- **decidir de onde vem "a minha unidade"**: uma opção nova na extensão (Petrópolis / Caxias / as duas) ou aceitar o
  slug de Caxias na Ponte (as rotas usariam a conta da dona);
- **decidir o que fazer com o cartão de ⌂ Unidade de atendimento VAZIO**: aparece para as duas, num grupo "sem
  unidade", ou para ninguém;
- no servidor: ler o ⌂ de cada cartão da fila (`valorDaUnidadeNoCartao`), filtrar **antes** de cortar cada grupo em 30
  (`montarGrupos`), guardar o cache por unidade (não só por conta) e aplicar o mesmo filtro ao número do ícone
  (`contarSemResposta`), para os dois baterem.

Não é um conserto pequeno: ficou para o João decidir.

### A conferir no dia de teste (0.5.1)

- [ ] em Petrópolis: o rodapé, o cartão, o guia e o modo aprendiz sem "Sofia"; numa unidade com a Sofia (Açailândia),
      o rodapé volta a dizer "a pausa da Sofia" depois do 1º cartão;
- [ ] o topo mostra "Petrópolis" desde a abertura do painel (e não "Petropolis");
- [ ] "Começar a ligar": o cabeçalho diz "Sem espera entre uma ligação e outra · no máximo 40 por hora…";
- [ ] a busca manual com o telefone de um paciente de teste (com DDD) acha o cartão;
- [ ] depois do deploy do servidor: salvar uma observação num cartão de teste e ver a nota no histórico do cartão
      ("Observação pela Ponte · <nome> · <hora de Brasília>:"); antes do deploy, o painel diz "Disponível depois da
      atualização do servidor.";
- [ ] se o bloco da Sofia ainda aparecer em Petrópolis: o servidor diz `sofiaNaUnidade: true` para ela (a conta é
      "tem campo de entrega + chave do modelo"; com o provedor padrão `openai`, a chave do `.env` conta) — conferir a
      configuração da unidade.

## O que há de novo na 0.5.0 (visual novo)

O João pediu "um front lindo, mais limpo, colorido, profissional, tipo um dashboard avançado, com tudo mastigado para
quem não tem familiaridade com o Kommo". Três coisas que a atendente precisa ver de cara: **em qual etapa o lead
está**, **o que ela NÃO pode fazer** (é da franquia) e **as respostas prontas**.

### O desenho

- **As cores vêm do logo da Doutor Digital**, que são duas metades que se encaixam: **azul DD** (`#0086F7`) é o que é
  da atendente; **ouro DD** (`#FFB500`) é o que é da franquia. Estados: verde (deu certo), âmbar (atenção), vermelho
  (faltou/erro), cinza (nada ainda). Contraste conferido (≥ 4,5 no texto). Tema claro.
- **Fonte**: Plus Jakarta Sans, dentro da extensão (`fontes/`, 27 KB, licença OFL em `fontes/OFL.txt`). **Ícones**: SVG
  desenhado em `icones.js` (traço, `currentColor`, `aria-hidden`). Nada vem de fora: sem CDN, sem fonte de ícones.
- Cartões arredondados, foco visível no teclado, animação curta só quando o PACIENTE muda (pausar ou pôr etiqueta não
  pisca) e nenhuma para quem pede menos movimento. Funciona de 320 a 500 px de largura.

### A trilha do funil (`trilha.js`)

As etapas do COMERCIAL (e, com o cartão no TRATAMENTO, as do TRATAMENTO, com o nome embaixo de cada uma e "COMERCIAL
concluído") numa linha: a atual acesa, as de antes feitas, GANHO e PERDIDO separados como saídas. Cada etapa tem um
**dono**, reconhecido pelo NOME (cada conta tem os seus ids), pela regra da franquia (`backend/src/lib/franquia-move.ts`,
18/09/2026: "a franquia é onde a clínica registra; o cartão anda sozinho atrás do fato"):

| Dono | Etapas | Marca |
| --- | --- | --- |
| Anda sozinha pela franquia | AGENDADO, COMPARECEU, NÃO COMPARECEU, GANHO, EM TRATAMENTO, ALTA, RETORNO PÓS-TRATAMENTO | losango dourado |
| É sua | entrada, EM QUALIFICAÇÃO, EM ESPERA, CONFERIR NA FRANQUIA, EM NEGOCIAÇÃO, PERDIDO, TRATAMENTO CANCELADO | bolinha azul |

Embaixo da linha, a etapa atual em destaque: o nome grande, de quem é, há quanto tempo (o relógio fica âmbar quando a
etapa da atendente está parada demais: entrada 1 dia, qualificação 2, NÃO COMPARECEU 3…) e o que vem depois ("Vai
sozinho para COMPARECEU ou NÃO COMPARECEU quando a franquia der baixa na consulta"). "Ver as 10 etapas" abre a lista
com o dono de cada uma.

### "O que é seu agora" × "O que é da franquia"

De 1 a 3 ações claras por etapa (`acoesDaEtapa`); a primeira é o próximo passo que o servidor já monta (com a data da
consulta). Na conta de duas unidades com o campo vazio, a primeira é escolher a unidade. O botão **O que eu faço
agora?** abre o guia. Embaixo, em dourado, o que NÃO se faz no Kommo: agendar, dar baixa e lançar sessão — é na
franquia, e o cartão anda sozinho.

### Respostas sugeridas para a etapa

No topo da aba Respostas, as que combinam com a etapa do cartão da tela, pelo **começo do nome do modelo** (sem acento
nem caixa; `PREFIXOS_DA_ETAPA` em `respostas.js`): `lead_`, `primeiro_contato`, `boas_vindas` em entrada/EM
QUALIFICAÇÃO; `espera_`, `retomada_` em EM ESPERA; `consulta_`, `confirmacao_`, `endereco_` em AGENDADO; `falta_`,
`remarcar_` em NÃO COMPARECEU; `sessao_`, `tratamento_` em EM TRATAMENTO… Modelo com prefixo de unidade (`caxias_…`,
`petropolis_…`) só aparece para cartão DAQUELA unidade: num cartão de Petrópolis, os `caxias_` saem da lista (com o
aviso "1 resposta de outra unidade ficou de fora"); sem unidade escolhida, ficam na lista, mas fora das sugeridas.
Continua só **copiar**, nunca enviar.

### Abrir a conversa sem recarregar o WhatsApp Web

Até a 0.4.0, "Abrir conversa" e "Começar a ligar" trocavam a URL da aba (`web.whatsapp.com/send?phone=…`): o WhatsApp
Web recarregava inteiro a cada paciente. Agora o painel pede ao content script, e `abrir.js` cria **um link da própria
Ponte**, `<a href="https://wa.me/<dígitos>">`, escondido, aciona `.click()` **nesse elemento** e o tira da página na
hora. O WhatsApp Web trata link wa.me dentro dele mesmo e abre a conversa sem recarregar.

Isso não está documentado pelo WhatsApp (é o que acontece quando se clica num link wa.me dentro do WhatsApp Web; não
achamos fonte oficial nem extensão conhecida que documente o truque — as que abrem conversa sem recarregar usam módulos
internos, que a Ponte não usa). Por isso, duas travas, e na dúvida o **jeito antigo**:

1. se o WhatsApp **não tratar** o clique (ninguém chamou `preventDefault`), a Ponte **cancela a navegação** — a aba não
   sai do WhatsApp para a página do wa.me — e o painel abre na hora pelo jeito antigo;
2. se tratou, a Ponte espera até **4 s** a conversa daquele número aparecer no cabeçalho (pelos 8 últimos dígitos; em
   conversa `@lid`, que não mostra o número, vale a troca de conversa). Não apareceu → jeito antigo.

Toda queda para o jeito antigo fica no console (`[Ponte] a conversa não abriu pelo link wa.me (…)`). Aba com o
content script de uma versão antiga (WhatsApp aberto antes de atualizar a Ponte) também cai no jeito antigo. Nas
opções, a chave **Abrir conversa sem recarregar** vem **ligada**; desligada, volta ao jeito antigo sempre. O ritmo do
"Começar a ligar" passa a não ter espera entre uma ligação e a próxima (antes eram 40 s); o teto de 40 por hora continua.

### Os campos novos do cartão (backend)

`POST /api/public/widget/:slug/ponte/cartao` passa a mandar, além do que já mandava (montados em
`backend/src/lib/ponte-painel.ts`, sem chamada a mais no Kommo — os campos da conta vêm do cache de 10 min do guia):

| Campo | O que é |
| --- | --- |
| `cartao.telefone` | o número do contato do Kommo (ou o da conversa), como se lê: "(99) 90000-0001" |
| `cartao.unidade` | `{ nome, compartilhada, opcoes }`: na conta de duas unidades, o `⌂ Unidade de atendimento` (`nome: null` = vazio) e as unidades da conta; na de uma só, o nome curto da unidade ("Açailândia", sem "Doutor Hérnia") |
| `cartao.qualificacao` | o ★ Qualificação: o texto, `null` (a conta tem o campo e ele está vazio) ou ausente (a conta não tem o campo) |
| `cartao.naEtapaDesde` | desde quando está na etapa (o mesmo do resumo) |
| `cartao.barraTratamento` | a trilha do funil TRATAMENTO (EM TRATAMENTO, ALTA, TRATAMENTO CANCELADO), só com o cartão nele |
| `sofiaNaUnidade` | a unidade tem a Sofia (caminho de entrega + chave do modelo)? Sem ela, o painel esconde o estado da Sofia e a pausa |
| `unidadeDaConta` | o nome curto da unidade da conta, para o topo do painel |
| `franquiaAndaSozinha` | "A franquia move a etapa" **e** o "Sincronizador da franquia" estão **ligados** (tela de Automações, `unit_automacoes`, ou o `.env`) para a unidade DO CARTÃO? |
| `franquia.codigo` | `sem_unidade` quando a franquia recusa porque o cartão está sem a unidade (conta de duas unidades) |

**A decisão do `franquiaAndaSozinha`** (recomendação aceita pelo João, 14/10/2026): onde as duas automações não estão
ligadas — "só no papel" não conta —, o cartão NÃO anda sozinho. O painel então troca "Anda sozinha pela franquia" por
**"A recepção atualiza pela franquia"** (na etapa atual, na legenda e nas estações), tira o "sozinho" do que vem depois
("Vai para COMPARECEU ou NÃO COMPARECEU quando a recepção der baixa na consulta, na franquia") e a regra dourada vira
"Agendar, dar baixa e lançar sessão se faz NA FRANQUIA; nesta unidade, a recepção atualiza o cartão pela franquia". Na
conta de duas unidades, vale a automação da unidade do cartão; com o campo vazio, nenhuma automação mexe nele, e o
painel diz que é a recepção.

**Com o servidor de antes** (a 0.4.0) o painel também funciona: o campo que não vier não aparece, e nada quebra. O selo
da unidade usa o nome da franquia (e pede a unidade quando a franquia recusa por falta dela); o cartão no TRATAMENTO
mostra "COMERCIAL concluído"; e, sem `franquiaAndaSozinha`, vale o texto de sempre ("anda sozinha"). As sessões já
vinham (`franquia.agenda.sessoes`, `proximaSessao`), pela mesma leitura do widget "Agenda da franquia", que lê a
franquia da unidade DO CARTÃO.

## O que há de novo na 0.4.0 (fase 4)

### "O que eu faço agora?"

No cartão, logo abaixo da etapa, um botão grande abre o **guia** no lugar do cartão (o **← Voltar ao cartão** volta).
O guia vem pronto do servidor (`GET /api/public/widget/:slug/ponte/guia?leadId=`) e mostra, em ordem:

1. **A unidade, primeiro** — só nas contas do Kommo que atendem duas unidades (a de Petrópolis atende Petrópolis e
   Caxias; o campo é o `⌂ Unidade de atendimento`). Com o campo vazio, o guia mostra só este passo: escolher a
   unidade. Enquanto ele estiver vazio, o servidor recusa gravar qualquer outro campo e mudar a etapa (cadastrar o
   paciente na unidade errada "dá BO" na franquia). A Ponte só preenche a unidade vazia; trocar é no Kommo.
2. **⚠ Pendência do cartão** — o campo que o robô de revisão escreve e que fica **escondido** no Kommo (a SDR só
   achava o motivo no histórico; decisão D13). Corrigido o que ele diz, o aviso sai sozinho.
3. **Falta nesta etapa** — os campos vazios que o Kommo exige para estar nesta etapa e os que são **da SDR** nela
   (os de preencher à mão, do molde da Serra e da Açailândia: na qualificação, ★ Qualificação, ⚕ Região da dor, ✎
   Queixa e ✎ Observações; em EM ESPERA, ⊘ Motivo da espera e ◷ Retomar em; e assim por etapa — a lista fica em
   `CAMPOS_DA_SDR_POR_ETAPA`, `backend/src/lib/ponte-guia.ts`). Campo escondido na etapa não aparece. Os que o
   robô, a Sofia ou a franquia preenchem não aparecem — a não ser que o Kommo os exija, e aí aparecem **sem caixa
   para digitar**, dizendo quem preenche ("Marque a consulta primeiro: a data entra sozinha no cartão"). Dá para
   preencher ali mesmo: texto, lista, data (calendário) e número.
4. **Para onde vai o paciente?** — as saídas da etapa, cada uma com o que aconteceu, do jeito que a SDR fala
   ("Quer, mas depois", "Faltou à consulta"…). Escolhida a saída, aparecem o que falta para mover (e campos
   opcionais), o aviso **"Ao mover, os robôs desta etapa podem mandar mensagem ao paciente."** (sempre), as
   mensagens conhecidas dos robôs daquela etapa e as dicas (ex.: a etiqueta NO_FOLLOW_UP antes do PERDIDO).

**Antes de gravar, a Ponte mostra o que vai gravar.** "Revisar o que vou gravar" e "Revisar e mover" abrem a prévia
("⊘ Motivo da espera: Viajando · ◷ Retomar em: 20/10/2026 · Etapa: EM QUALIFICAÇÃO → EM ESPERA" + o aviso dos robôs),
e só **Gravar no Kommo** / **Mover agora** gravam. O que foi digitado fica guardado na memória do painel por 30 min
(trocar de aba e voltar não perde); nada vai para o `storage`.

As saídas, por etapa do funil COMERCIAL (`SAIDAS_POR_ETAPA`; o que cada uma exige além dos obrigatórios do Kommo):

| Etapa atual | Saídas |
| --- | --- |
| entrada | EM QUALIFICAÇÃO, AGENDADO, EM ESPERA, PERDIDO |
| EM QUALIFICAÇÃO | AGENDADO (◷ Data da Consulta), EM ESPERA (⊘ Motivo da espera + ◷ Retomar em), PERDIDO (⊘ Motivo do não agendamento) |
| EM ESPERA | EM QUALIFICAÇÃO, AGENDADO, PERDIDO |
| CONFERIR NA FRANQUIA | AGENDADO, PERDIDO |
| AGENDADO | COMPARECEU, NÃO COMPARECEU (sugere ⊘ Motivo da falta), EM ESPERA, PERDIDO — as duas últimas lembram de desmarcar na franquia |
| NÃO COMPARECEU | AGENDADO, EM ESPERA, PERDIDO |
| COMPARECEU | EM NEGOCIAÇÃO, PERDIDO (⊘ Motivo de não fechamento do tratamento) |
| EM NEGOCIAÇÃO | AGENDADO (nova consulta), PERDIDO |
| PERDIDO | EM QUALIFICAÇÃO (voltou a conversar), EM ESPERA |
| RETORNO PÓS-TRATAMENTO, GANHO, funil TRATAMENTO | nenhuma: são da franquia e dos robôs |

**Regras do mover** (`POST /api/public/widget/:slug/ponte/mover` `{ leadId, de, para, campos, por, confirmado }`):

- **Obrigatório é CUMULATIVO**, como na tela do Kommo (provado na Marabá em 26/08): entrar numa etapa exige os
  obrigatórios dela **e de todas as etapas antes dela** no funil. GANHO exige os do funil inteiro; PERDIDO só os dele
  (o João testou na Serra em 02/10 que mover para PERDIDO não pede os de GANHO). Os obrigatórios vêm da API
  (`required_statuses` de cada campo, como **(funil, etapa)** — 142/143 se repetem em todo funil). A API do Kommo
  não confere obrigatório nenhum: quem segura é a Ponte. Faltou algum → 422 com a lista, e nada vai para o Kommo.
- **AGENDADO só com a consulta marcada**: a ◷ Data da Consulta tem que estar no cartão e ser de hoje em diante (a
  Ponte não escreve na franquia nem inventa consulta — ela entra pela franquia, pelo widget "Marcar" ou pela Sofia).
- Só as etapas do COMERCIAL que são da SDR, e só as saídas da etapa atual: **nunca GANHO nem o funil TRATAMENTO**.
- Confirmação explícita (`confirmado: true`, que o painel só manda depois de **Mover agora**); se o cartão mudou de
  etapa desde que o guia abriu (`de`), recusa e pede para abrir de novo.
- Os campos que faltavam e a etapa vão **num PATCH só** (o Kommo recusou um valor → o cartão não anda sem ele). Depois,
  o servidor **relê o cartão**, confere que andou e devolve o guia novo.
- No PERDIDO, vai junto o **motivo de perda do Kommo** (o do cabeçalho) que tiver o MESMO nome do ⊘ escolhido —
  "Sem interesse", por exemplo, é dos que calam o acompanhamento da Sofia. Sem nome igual, vai sem.
- Teto de **60 cartões movidos por hora** em cada conta (`PONTE_MOVER_POR_HORA`): mover dispara robôs, e uma chave
  vazada não vira um disparador. A vaga volta se o cartão não andar.
- Nota no cartão: "➜ Etapa mudada pela Ponte: EM QUALIFICAÇÃO → EM ESPERA · por Ana" (e o que foi preenchido junto).

**Regras do gravar** (`POST /api/public/widget/:slug/ponte/campos` `{ leadId, campos: [{ id, valor }], por }`): só
grava campo **da SDR** (o das listas por etapa e das saídas, o ⌂ Unidade de atendimento vazio, ou um que a conta
exige em alguma etapa); recusa campo da franquia, de robô, "Apenas API", ☎ (tem rota própria) e **cabeçalho** —
campo cujo nome começa com `##` ou `*` (`## CONSULTA`, `*AGENDADO*`) é título visual e nunca é alvo. Manda só o que
mudou, num PATCH, relê o cartão (o valor não aparece → erro, para a SDR não achar que gravou) e deixa a nota
"✎ Preenchido pela Ponte · por Ana: …". Data vai como meia-noite do fuso da unidade (como o Kommo guarda: é dela que o
robô conta "9 h depois do ◷ Retomar em").

**As mensagens dos robôs.** O servidor não lê os gatilhos do Kommo (a rota `/ajax/v4/triggers/bots` pede o cookie de
sessão de um usuário; o token da API não lê), então o painel **avisa sempre**. As mensagens conhecidas de cada etapa
ficam em `MENSAGENS_DA_ETAPA` (`backend/src/lib/ponte-guia.ts`), por conta do Kommo — hoje a Açailândia, a régua no ar
desde 07/10 (`video-tutorial/v3/mensagens_por_etapa.json` e `gatilhos_por_etapa.json`): ex., AGENDADO → "Ao entrar, se
¤ Pagamento antecipado = Sim e ainda não pagou: «A sua consulta está pré-agendada…»; 3 h antes da consulta…".
Conta nova, sem mexer no código: `PONTE_MENSAGENS_DA_ETAPA_<SLUG>` (slug em maiúsculas, `-` vira `_`) com um JSON
`{"AGENDADO": ["…"], "PERDIDO": ["…"]}`, que substitui as etapas que listar.

**A Ponte NÃO escreve na franquia nesta versão** (nada de marcar consulta).

### O número no ícone

O ícone da extensão mostra **quantos pacientes da unidade estão esperando resposta**, com a dica ao passar o mouse:
"3 pacientes esperando resposta". A conta é a do grupo "sem resposta" da Fila de hoje — conversa não lida há mais de
2 h e a última fala não foi da Sofia, cartão na entrada ou em EM QUALIFICAÇÃO — e a regra é a mesma função dos dois
lados (`candidatosSemResposta`, `backend/src/lib/ponte-fila.ts`).

- O script de fundo pergunta a cada **5 min** (`chrome.alarms`, permissão nova `alarms`) em
  `GET /api/public/widget/:slug/ponte/contador`. O servidor guarda **90 s por conta** (e, se a Fila de hoje foi
  montada há menos de 90 s sem aviso, usa o total dela), então várias atendentes não multiplicam as chamadas ao
  Kommo (o limitador do processo segura os 7 pedidos por segundo).
- **Subiu** desde a última leitura: vermelho. Tem gente mas não subiu: laranja. **Zerou**: ícone sem número.
- **Falha** (servidor, Kommo ou internet): **"?"**, nunca um 0 falso, que diria "ninguém esperando". Leitura cortada
  (conversas demais) com 0 também é "?"; com algum número, "3+".
- No Firefox é o mesmo `action.setBadgeText`, com o `config.js` e o `contador.js` carregados antes do `fundo.js`
  (`background.scripts` do `firefox/manifest.json`).
- Sem notificação do sistema nesta versão. Guarda em `storage.local` só o último total e o slug (para saber se subiu).

## O que há de novo na 0.3.0 (fase 3)

### Etiquetas: ver, pôr e tirar

No cartão, cada etiqueta vira um chip com **✕** para tirar, e o botão **+ etiqueta** abre uma busca entre as
etiquetas que **já existem** na conta do Kommo. A atendente não cria etiqueta nova (decisão A3 da trilha): se o
nome não existe na conta, o servidor recusa — o `tags_to_add` do Kommo criaria a etiqueta sozinho.

Algumas etiquetas fazem um robô (Salesbot) do Kommo **mandar um modelo de WhatsApp para o paciente** — as
"etiquetas de robô". São as que começam com **▶** e as de uma **lista**, porque nem toda etiqueta de robô tem ▶:
"**Aderência meio**" dispara o BOT_…_sessao_aderencia_meio (modelo de WhatsApp) em Açailândia, Serra e
Imperatriz (gatilhos conferidos em 07/10/2026). A lista fica em `ETIQUETAS_DE_ROBO_SEM_SETA`
(`backend/src/lib/ponte-etiquetas.ts`), e dá para acrescentar sem mexer no código:

- `PONTE_ETIQUETAS_DE_ROBO="Lembrete; Outra"` — vale para todas as unidades;
- `PONTE_ETIQUETAS_DE_ROBO_<SLUG>` — só uma unidade (slug em maiúsculas, `-` vira `_`; ex.:
  `PONTE_ETIQUETAS_DE_ROBO_DOUTOR_HERNIA_ACAILANDIA`).

Por que lista e não "ler os gatilhos do Kommo": os gatilhos de bot só saem pela rota `/ajax/v4/triggers/bots`,
que pede o cookie de sessão de um usuário; o token da API, que o servidor tem, não lê. **Etiqueta nova que
dispara robô precisa entrar na lista.** Na dúvida, a regra pede confirmação a mais, nunca a menos.

Quem decide é o **servidor**: a lista da conta vem com `robo` e o cartão com `etiquetasRobo`. Ao escolher uma
etiqueta de robô, o painel pergunta: "Esta etiqueta faz o robô mandar uma mensagem para o paciente. Pôr mesmo
assim?" — e só põe depois de **Pôr mesmo assim**. O servidor recusa sem essa confirmação (e o painel então
pergunta), deixa uma nota no cartão ("Etiqueta ▶ Retomada posta pela Ponte · por Ana") e põe no máximo 30
etiquetas de robô por hora em cada conta (`PONTE_ETIQUETA_ROBO_POR_HORA`): se a chave da unidade vazar, ela não
vira um disparador. A vaga do teto é reservada no mesmo passo em que é conferida (pedidos chegando juntos não
passam do teto) e devolvida se nada for gravado. Tirar não pede confirmação.

Depois de pôr ou tirar, o servidor **relê o cartão** e o painel mostra a lista que o Kommo devolveu. Rotas:
`GET` (as etiquetas da conta, cache de 10 min), `POST` e `DELETE /api/public/widget/:slug/ponte/etiquetas`, com
`{ leadId, nome, por, confirmado }`. A armadilha do Kommo continua valendo: `tags_to_add` / `tags_to_delete` vão
na RAIZ do corpo do PATCH (dentro de `_embedded` o Kommo ignora, e `_embedded.tags` substitui todas) — quem grava
é o `addTag` / `removeTag` de sempre, e há teste disso.

### Fila de ligações com 1 clique ("Começar a ligar")

O João queria um discador automático pelo WhatsApp. Automatizar o clique de ligar é automação do WhatsApp (risco
de banir o número), então a Ponte faz tudo **menos ligar**: a atendente dá o único clique, no 📞 do próprio
WhatsApp Web (que liga pelo navegador desde jul/2026).

Na aba **Fila de hoje**, **Começar a ligar** entra no modo ligação: um paciente por vez, na ordem da fila (etapa
e tempo de espera). Para cada um, a Ponte abre a conversa (o mesmo "Abrir conversa" de antes: troca a URL da aba
para `web.whatsapp.com/send?phone=…`, só navegação), mostra nome, etapa e motivo, e diz **"Clique no 📞 do
WhatsApp para ligar"**. Depois a atendente marca: **Atendeu · Não atendeu · Caixa postal · Número errado ·
Pular**.

- O resultado (menos Pular) vai para `POST /api/public/widget/:slug/ponte/ligacao` `{ leadId, resultado, por }` e
  é gravado nos campos ☎ do cartão, **achados pelo nome** (nunca id fixo): ☎ Última ligação = agora; ☎ Resultado
  = a opção (Atendida, Não atendida, Caixa postal, Número inválido); ☎ Tentativas + 1; ☎ Agente = "Ponte · Ana";
  e ☎ Campanha 3C **vazio** (é assim que se separa a ligação da SDR da discadora 3C: se o cartão tinha a campanha
  de uma ligação antiga da 3C, ela é esvaziada; gravação e duração da 3C não são tocadas).
- **Nota só quando os campos ☎ não gravaram** (conta sem os campos, ou o Kommo recusou): "☎ Ligação pela Ponte:
  não atendeu · por Ana". Com os campos gravados não há nota: o ☎ Agente já diz quem ligou, o histórico do Kommo
  guarda cada mudança dos campos, e uma nota a cada ligação quebraria a isenção do `card-validation-worker` (ele só
  deixa passar o cartão em que TODA mudança foi em campo ☎ — com a nota, cada cartão ligado ganharia "⚠ Revisar
  cartão"). Estender a isenção a notas exigiria ler o texto da nota, que os eventos do Kommo não trazem.
- **Uma gravação por tentativa.** Ao abrir a conversa, o painel cria o id da tentativa (guardado junto da posição)
  e manda com o resultado; o servidor grava cada tentativa uma vez só por 10 min (clique duplo, tela redesenhada
  ou o painel reaberto não somam duas ligações nem pulam as ☎ Tentativas). Enquanto o resultado vai para o
  servidor, os botões ficam travados, mesmo se a tela for redesenhada.
- Depois do resultado, avança sozinho, **sem espera** (desde a 0.5.0; pedido do João em 14/10 — antes eram 40 s). O que
  segura spam é o teto de 40 aberturas por hora (janela corrida); passando dele, aparece a contagem regressiva.
  Os números ficam em `RITMO_DAS_LIGACOES` (`backend/src/lib/ponte-ligacao.ts`), no estilo de `PRAZOS_DA_FILA`:
  `PONTE_LIGACAO_INTERVALO_S` (padrão 0 = sem espera) e `PONTE_LIGACAO_TETO_HORA` (máximo 120). Vão para a extensão junto da
  fila.
- Paciente sem telefone (só @lid ou nome de usuário) é pulado com o aviso "sem telefone — abra pelo Kommo" — mas
  só quando o servidor **afirma** que não há telefone (`semTelefone: true`). Se o Kommo não respondeu na leitura
  dos telefones, a fila avisa "Não consegui ler os telefones agora: tente de novo (Atualizar)", não fica em cache,
  e o painel deixa esses pacientes "para depois" **sem marcar como feitos** (nem diz que a fila acabou).
  Pular não grava nada. **Pausar** segura a contagem; **Sair** volta para a fila.
- A posição sobrevive a fechar o painel: fica em `chrome.storage.local` só o dia, a unidade, os ids dos cartões
  feitos e as horas das aberturas — **nunca nome nem telefone**. Reabrindo, o botão vira "Continuar a ligar".
- A Ponte não põe ▶ Retomada (nem etiqueta nenhuma) depois da ligação — decisão do João.

### Respostas prontas para COPIAR

A aba **Respostas** lista as respostas prontas da conta: os **modelos gerais** do Kommo (texto livre,
`GET /api/v4/chats/templates` com `type: "amocrm"`). Os modelos do WhatsApp (`type: "waba"`) ficam de fora. Tem
busca e o botão **Copiar**, que troca o marcador de nome (`{{contact.name}}`, "[Nome do contato]") pelo primeiro
nome do paciente da conversa aberta; campo do cartão (`{{lead.cf.…}}`) aparece como "[◷ Data da Consulta]", com
o aviso "Complete o que está entre colchetes antes de enviar". A Ponte **nunca** põe texto na caixa do WhatsApp
nem envia: a atendente cola e envia. Cache de 10 min. Rota: `GET /api/public/widget/:slug/ponte/respostas`.

Conta sem nenhuma: "Nenhuma resposta pronta cadastrada no Kommo", com onde cadastrar: **Configurações › Modelos ›
Modelos gerais › Adicionar um novo modelo** (só administrador; caminho da ajuda do Kommo em pt-BR, 14/10/2026).

### Aviso de cartão duplicado

A resposta do cartão traz `duplicados`: os outros cartões **abertos** do paciente, cada um com `via`:

- `contato` — o paciente é o contato **principal** do outro cartão (aparecer como contato secundário, como a mãe
  que acompanha a filha, não conta);
- `telefone` — o principal do outro cartão é **outro contato com o mesmo telefone completo** (DDD + número). Pode
  ser da família dividindo o WhatsApp: o painel mostra num grupo separado, com "pode ser da família — confira se
  é a mesma pessoa antes de juntar".

"Aberto" é fora de GANHO e PERDIDO e fora das etapas finais pelo nome (ALTA, CANCELADO, CONCLUÍDO, FINALIZADO,
ENCERRADO — o funil TRATAMENTO tem "ALTA"). Com dois ou mais abertos, o painel mostra a faixa amarela ("Este
paciente tem 2 cartões abertos"), cada um com nome, funil/etapa, ⚑ Origem e **Abrir no Kommo**, e a regra:
"Confira se é a mesma pessoa antes de juntar. Fica o que veio do anúncio; o outro é juntado (Mesclar) no Kommo,
nunca apagado". A Ponte não junta nem apaga nada.

### A chave antes do limitador

As rotas da Ponte conferem a chave da unidade **antes** do limitador de pedidos (`unidadeDaPonte`, em
`widget-franquia.controller.ts`): sem a chave, a resposta é 403 e não gasta o limite da unidade. Antes, quem
soubesse só o slug travava as rotas da unidade com 31 pedidos por minuto. As outras rotas de widget continuam
como eram. A chave só vale no header `X-Widget-Key` (nunca na URL, que fica no log de acesso).

Fica documentado, sem mexer: o Express não tem `trust proxy`, então atrás do Traefik o `req.ip` é o do proxy e o
limite é, na prática, por unidade (todas as atendentes dividem o mesmo balde). Ligar o `trust proxy` muda o
limitador de todas as rotas e precisa ser conferido com a configuração do Traefik — fica para outra vez.

## O que há de novo na 0.2.0 (fase 2)

### Pausar a Sofia neste paciente

No cartão, o botão **Pausar a Sofia neste paciente** abre as opções: **até amanhã às 8h**, **3 dias**,
**1 semana** ou **escolher a data** (a Sofia volta às 8h do dia escolhido; no máximo 30 dias), e um motivo
opcional. Pausada, o painel mostra "Sofia pausada até 14/10 08:00 · motivo · por Ana" e o botão
**Retomar agora**.

É a **mesma pausa** do widget "Pausar a Sofia" do Kommo (`backend/src/lib/pausa-lead.ts`): a linha em
`lead_pausas` manda na Sofia, a caixinha "Pausar IA" é marcada junto (os Salesbots leem a caixinha) e o worker
de vencimento solta sozinho na data. Rotas: `POST` e `DELETE /api/public/widget/:slug/ponte/pausa`, com
`{ leadId, ate, motivo, por }`. O `por` é o **Seu nome** das opções da extensão (campo novo, opcional).

Se a SDR marcou a caixinha "Pausar IA" à mão (sem data), o painel só avisa — a caixinha é dela, e a Sofia só
volta quando alguém desmarcar no Kommo.

### Fila de hoje ("ligações por etapa")

O João pediu "ligações por etapa". A leitura: uma aba com quem a atendente precisa **chamar ou ligar hoje**,
separada por etapa do funil COMERCIAL, cada grupo com contador:

| Etapa | Entra na fila quando | Motivo |
| --- | --- | --- |
| entrada / EM QUALIFICAÇÃO | a conversa do Kommo está aberta e **não lida** há mais de 2 h, e a última fala não foi a Sofia | sem resposta |
| EM ESPERA | o "◷ Retomar em" é hoje ou já passou | retomar contato |
| AGENDADO | a "◷ Data da Consulta" é amanhã e a "✓ Situação da consulta" não diz confirmada | confirmar presença |
| NÃO COMPARECEU | sempre (menos quem já tem consulta nova no futuro) | faltou: remarcar |
| EM NEGOCIAÇÃO | o cartão não mudou de etapa e a conversa não mexeu há 3 dias (o "parado" do worker de parados) | retomar negociação |

Cada paciente mostra nome, etapa, o motivo, há quanto tempo, e três botões: **Abrir conversa** (troca a URL da
aba do WhatsApp Web para `https://web.whatsapp.com/send?phone=<dígitos>` — é navegação, como clicar num link;
nada é digitado nem enviado), **Copiar telefone** (para ligar) e **Abrir no Kommo**.

Rota: `GET /api/public/widget/:slug/ponte/fila`, só leitura, com cache de 2 min por conta do Kommo. Os prazos
(amanhã, 3 dias, 2 h…) ficam todos em `PRAZOS_DA_FILA` (`backend/src/lib/ponte-fila.ts`), cada um com variável
de ambiente (`PONTE_FILA_CONFIRMAR_DIAS`, `PONTE_FILA_NEGOCIACAO_DIAS`, `PONTE_FILA_SEM_RESPOSTA_HORAS`…).

### Resumo do lead

3 a 5 linhas no topo do cartão, **sem gastar IA**: os campos do cartão (cidade, queixa, região da dor), a
memória que a Sofia já guarda do paciente (desfecho e onde travou), a franquia (consultas, faltas, tratamento)
e há quanto tempo o cartão está na etapa. Por último, o próximo passo sugerido para a etapa.

O botão **Resumir com IA** só aparece quando a unidade tem chave da Anthropic. Ele lê a conversa do Kommo e
pede o resumo ao modelo mais barato que o projeto já usa em tarefa auxiliar (Haiku 4.5), com a chave da
própria unidade; o custo entra na tela de custo da IA. Fica guardado 6 h por paciente. Sem conversa para ler,
devolve o resumo do cartão sem chamar a IA. Rota: `POST /api/public/widget/:slug/ponte/resumo-ia`.

## Instalar (modo desenvolvedor)

1. No Chrome, abra `chrome://extensions` e ligue **Modo do desenvolvedor**, no canto de cima à direita.
2. Clique em **Carregar sem compactação** e escolha esta pasta (`extensao-ponte/`).
3. A página de opções abre sozinha. Preencha:
   - o **slug da unidade** (ex.: `doutor-hernia-acailandia`);
   - a **chave**: a mesma do widget do cartão no Kommo daquela unidade (o HMAC do slug, ver
     `backend/src/lib/widget-agenda.ts`);
   - **seu nome** (opcional): aparece como "por Ana" quando você pausa a Sofia num paciente, põe etiqueta, grava
     a ligação, preenche campos pelo guia ou muda a etapa;
   - **Abrir conversa sem recarregar** (0.5.0, já vem ligada): abre a conversa pelo link wa.me, sem recarregar o
     WhatsApp Web. Desligue só se der problema (volta ao jeito antigo, com recarga).

   Depois clique em **Salvar e testar**. Deve aparecer "Conectado: <unidade>".

   Já tinha uma versão anterior instalada? Em `chrome://extensions`, clique no ↻ da Ponte e recarregue a aba do
   WhatsApp Web (F5).
4. Abra `https://web.whatsapp.com` e clique no ícone da Ponte na barra do Chrome. O painel lateral abre.

A chave fica só no computador, em `chrome.storage.local`. O servidor é o mesmo dos widgets do Kommo
(`https://agente-vps.doutordigitalconsultoria.com`, em `config.js`); trocar o endereço exige trocar também o
`host_permissions` do `manifest.json`.

## Como acha o cartão

Pela rota `POST /api/public/widget/:slug/ponte/cartao` (`backend/src/controllers/ponte.controller.ts`). É POST
para que nome e telefone vão no corpo e não na URL, que fica no log de acesso; a rota não escreve nada. São 4
passos, nesta ordem, parando no primeiro que achar:

1. **Telefone.** Só quando o WhatsApp mostra o número de verdade: o `data-id` da conversa termina em `@c.us`,
   ou o cabeçalho de um contato não salvo mostra o número. O servidor busca o contato no Kommo e **confere o
   número completo**: os 8 últimos dígitos e o DDD. Se o mesmo número tem contatos com nomes diferentes
   (família dividindo o WhatsApp), o painel mostra a lista e a atendente escolhe.
2. **Impressão das mensagens.** O servidor compara a impressão das últimas 5 mensagens recebidas (explicada
   abaixo) com as mensagens que a Sofia guardou nas últimas 48 h. Precisa bater em 2 mensagens; se só uma foi
   enviada, 1 basta, mas só nas últimas 23 h (a impressão não tem data). Empate entre conversas não aponta
   ninguém. Só funciona em unidade com a Sofia.
3. **Nome do cabeçalho.** Busca por texto no Kommo. Se mais de um contato casar, o painel mostra a lista e a
   atendente escolhe.
4. **Nada.** O painel mostra a busca manual, por nome ou (0.5.1) por telefone com DDD.

### A impressão (o texto não sai do navegador)

Para cada mensagem recebida, a extensão calcula `SHA-256(texto normalizado + "|" + HH:MM em São Paulo)`.
Normalizar é passar para minúsculas, tirar os acentos e trocar tudo que não é letra ou número por um espaço.
Só esse hash vai para o servidor, que faz a mesma conta sobre o que já guarda. Os dois lados são testados
contra os mesmos vetores fixos (`testes/vetores-impressao.json`).

## O que a Ponte faz e o que NUNCA faz

**Faz:**

- lê o DOM visível da conversa aberta, só em `https://web.whatsapp.com/*`, num content script em mundo
  isolado: o nome do cabeçalho, o `data-id` das mensagens, e o texto e a hora das últimas mensagens recebidas;
- percebe a troca de conversa com um `MutationObserver`, porque a URL não muda;
- mostra o painel com `chrome.sidePanel`, uma página da própria extensão;
- abre a conversa de um telefone no "Abrir conversa" e no modo "Começar a ligar" (este sem espera entre uma e
  outra, no máximo 40 por hora). Na 0.5.0, **aciona o próprio link wa.me para abrir a conversa; nada além disso**: o
  content script cria um `<a href="https://wa.me/<dígitos>">` da Ponte, clica NESSE link e o tira da página na hora.
  Se o WhatsApp não abrir, troca a URL da aba (o jeito antigo, com recarga). Nunca leva texto;
- copia texto para a área de transferência quando a atendente clica em Copiar;
- mostra no ícone quantos pacientes esperam resposta (pergunta ao NOSSO servidor a cada 5 min);
- no guia "O que eu faço agora?", grava no Kommo os campos da SDR e muda a etapa — só depois da prévia e da
  confirmação da atendente, e só no funil COMERCIAL.

**Nunca faz:**

- envia, responde ou apaga mensagem; marca como lida; clica, digita, foca ou rola qualquer coisa do WhatsApp (o único
  clique da Ponte na página é no link wa.me que ela mesma criou, e só para abrir a conversa);
- **liga**: no modo "Começar a ligar" ela só abre a conversa; o clique no 📞 é sempre da atendente;
- põe texto na caixa de mensagem: as respostas prontas só vão para a área de transferência, no clique em Copiar;
- injeta qualquer coisa na página do WhatsApp (nem botão, nem CSS, nem `web_accessible_resources`) — a não ser o link
  wa.me escondido, que entra e sai no mesmo instante;
- usa WA-JS, wppconnect, whatsapp-web.js, "Store" ou qualquer módulo interno do WhatsApp;
- lê a lista de contatos ou de grupos (a coluna da esquerda é ignorada);
- guarda texto de conversa, nem no `storage` da extensão nem no servidor. O texto vira hash dentro do content
  script, e o painel só recebe nome, telefone e hashes;
- trata o id `@lid` como telefone;
- monta link do WhatsApp com texto (`text=`): "Abrir conversa" (o wa.me e o jeito antigo) leva só o telefone, e quem
  escreve é a atendente;
- cria etiqueta nova no Kommo, põe etiqueta de robô (▶ ou da lista, como "Aderência meio") sem a atendente
  confirmar, ou põe ▶ Retomada sozinha depois de uma ligação;
- marca como "sem telefone" quem só não teve o telefone lido agora;
- junta (mescla) ou apaga cartão: o aviso de duplicado só avisa;
- guarda nome ou telefone de paciente no `storage` (a fila de ligações guarda só ids e horas; o contador, só o último
  total e o slug; na 0.5.1, o nome da unidade e se ela tem a Sofia; o que foi digitado no guia fica só na memória do
  painel);
- muda a etapa sem a atendente confirmar, com um obrigatório do destino vazio, para GANHO, para o funil TRATAMENTO,
  para uma etapa que não é saída da etapa atual, ou com a unidade de atendimento vazia (na conta de duas unidades);
- grava campo da franquia, de robô, "Apenas API" ou cabeçalho (`##…`, `*…*`), ou troca a unidade de atendimento já
  escolhida;
- mostra notificação do sistema;
- escreve na franquia (nem marca consulta). No Kommo, só escreve quando a atendente clica: pausar e retomar a Sofia
  num paciente, pôr e tirar etiqueta, o resultado da ligação (campos ☎; nota só sem eles), e — na 0.4.0 — os campos
  do guia e a mudança de etapa (com nota de quem fez); na 0.5.1, a observação (uma nota comum, depois da prévia). Tudo vai pelo NOSSO servidor com a chave da unidade — nunca
  pelo WhatsApp.

Permissões: `sidePanel`, `storage` e (0.4.0) `alarms` — só para o relógio de 5 min do número no ícone —, mais
`host_permissions` apenas para o servidor da Doutor Digital. A 0.5.0 não pede permissão nova. O
"Abrir conversa" usa o content script que já roda no WhatsApp Web (o link wa.me) e, no jeito antigo,
`chrome.tabs.update` na aba que a Ponte já lê — nenhum dos dois pede permissão a mais; o "Copiar telefone" e o
"Copiar" das respostas usam a área de transferência só no clique.

## ⚠ Os seletores são uma SUPOSIÇÃO

Todos os seletores estão em `seletores.js`. Eles foram escritos a partir do que se sabe do DOM do WhatsApp
Web em out/2026, e as fixtures de `testes/fixtures/` **imitam** esse DOM: não são cópia do WhatsApp real.
Antes de usar de verdade, é preciso **um dia de teste no computador de uma atendente**, conferindo:

- [ ] `#main` e `#main header` existem, e o nome sai do `span[dir="auto"][title]` do cabeçalho;
- [ ] o `data-id` das mensagens tem o formato `true|false_<jid>_<id>[_<participante>]`, termina em `@c.us`
      nas conversas com número e em `@lid` nas outras. Medir quantas conversas ainda são `@c.us`;
- [ ] o `data-pre-plain-text` começa com `[HH:MM, …]` (ou `[h:mm AM, …]` em inglês);
- [ ] o texto está em `span.selectable-text`;
- [ ] contato não salvo mostra o número no cabeçalho;
- [ ] a impressão bate: abrir uma conversa que a Sofia atendeu e ver o chip "achei pelas mensagens";
- [ ] a Ponte não deixa o WhatsApp Web mais lento (o observador lê no máximo a cada 0,7 s).

Quando um seletor quebrar, o conserto é só em `seletores.js`. Rode os testes de novo depois.

## Testes

```bash
cd extensao-ponte
npm install         # só o jsdom, para os testes
npm test            # node --test 'testes/*.test.js'
```

- `impressao.test.js`: a normalização e o hash batem com os vetores, e a hora é convertida para São Paulo;
- `leitor.test.js`: as fixtures com `@c.us`, `@lid`, número no cabeçalho, grupo e sem conversa, mais a prova
  de que a leitura não clica, não foca, não dispara evento e não muda o DOM;
- `conteudo.test.js`: o content script inteiro no jsdom. Só nome, telefone e hashes saem para o painel, e a
  troca de conversa é percebida;
- `desenho.test.js`: o painel (cartão, candidatos, busca manual e dado do servidor tratado como texto) e, na
  fase 2, o resumo e o "Resumir com IA", o bloco da pausa, a fila (grupos, contadores e os três botões) e a
  prova de que "Abrir conversa" é só o link com o telefone;
- `pausa.test.js`: as datas de cada opção da pausa, o limite de 30 dias e o estado da Sofia depois de pausar;
- `etiquetas.test.js` (0.3.0): a regra do ▶, a busca entre as etiquetas da conta e o bloco do cartão (✕, "+
  etiqueta", a pergunta da ▶ — só põe depois de confirmar —, o erro e o dado tratado como texto);
- `ligacao.test.js` (0.3.0): a ordem da fila de ligações, o ritmo (sem espera por padrão, teto por hora), o estado guardado (só ids,
  horas e o id da tentativa), o telefone não lido (fica para depois, sem marcar) e a tela do modo ligação (botões
  travados enquanto grava);
- `respostas.test.js` (0.3.0): o nome no lugar do marcador ("[nome]" quando não se sabe), a busca e a aba;
- `painel.test.js` (0.3.0): o `painel.js` inteiro com `chrome`, `fetch` e relógio falsos — "Começar a ligar"
  abre só pela URL com o telefone, espera o ritmo, grava o resultado, pula quem não tem telefone, respeita o teto
  e continua de onde parou; o resultado pendente não destrava com o redesenho nem manda duas vezes; telefone não
  lido não vira "feito"; a etiqueta vai com quem pôs; e a resposta copiada nunca sai com o nome do paciente
  anterior. Na 0.4.0: o guia abre pelo botão, grava e move com quem fez e `confirmado: true` só depois da prévia,
  relê o cartão ao voltar, não fecha com mensagem nova na mesma conversa, fecha ao trocar de conversa (e a resposta
  atrasada não volta) e guarda o que foi digitado ao trocar de aba;
- `guia.test.js` (0.4.0): a leitura do que a atendente digita (número com R$, data do calendário, opção da lista) e o
  desenho do guia — pendência, campos com a entrada certa, prévia antes de gravar, saída com o aviso dos robôs e a
  confirmação, campo da franquia sem caixa e com o mover travado, a unidade primeiro (e só ela) na conta de duas
  unidades, e o dado do servidor como texto;
- `contador.test.js` (0.4.0): o número, a cor (subiu / não subiu), a dica, o "?" na falha (nunca 0), o alarme de
  5 min, os scripts de fundo do Chrome (com `importScripts`) e do Firefox, e os manifests (0.5.0, `alarms`, sem
  notificação, `abrir.js` antes do `conteudo.js`, nenhuma permissão nova) e a pasta montada do Firefox (com a fonte e
  a licença);
- `abrir.test.js` (0.5.0): o link é wa.me só com os dígitos; nas fixtures, o ÚNICO clique é no link da Ponte, que sai
  da página na hora, e nada do WhatsApp muda; WhatsApp que não trata o link → a navegação é cancelada e a resposta vem
  na hora; trata mas não abre em tempo → "nao-abriu"; conversa já aberta → nenhum clique; `@lid` e grupo; e o content
  script inteiro respondendo "ponte:abrir-conversa";
- `trilha.test.js` (0.5.0): o dono de cada etapa (com e sem acento), o que vem depois, de 1 a 3 ações por etapa, as
  estações (PERDIDO não pinta nada), o tempo e o relógio de alerta, qualificação, situação da consulta, "amanhã" no
  fuso da unidade e o selo da unidade (Petrópolis e Caxias nunca com a mesma cor);
- na 0.5.0, `desenho.test.js` ganhou o visual novo — a resposta do servidor de HOJE (sem os campos novos) desenha sem
  quebrar —, o cabeçalho, a unidade vazia que abre o guia, a trilha (inclusive a do TRATAMENTO), "O que é seu agora",
  o cartão "Na franquia" (consulta, sem cadastro, franquia fora do ar, sessões e alta), a Sofia que some sem a IA, o
  dado do servidor como texto nos campos novos e as respostas sugeridas; `respostas.test.js`, o casamento pelo nome e
  os modelos de unidade; e `painel.test.js`, o "abrir sem recarregar" (abriu: só traz a aba para a frente, sem URL;
  não abriu ou script antigo: o jeito antigo, com o aviso no console; chave desligada: direto pelo jeito antigo).
- na 0.5.1: `desenho.test.js` — nada de "Sofia" no cartão da unidade sem IA, o modo aprendiz com e sem a IA, a regra
  dourada e o "Sem cadastro" com o widget, o cabeçalho "Sem espera…" e a busca que reconhece o telefone;
  `ligacao.test.js` — `textoDoRitmo` sem e com intervalo; `trilha.test.js` — a regra do widget e `nomeCurtoDaUnidade`;
  `painel.test.js` — o topo com o nome do servidor (e guardado; o do slug só sem resposta), a fila que não troca o nome,
  o rodapé e o modo aprendiz só com a IA, e a busca manual por nome × por telefone (relida pelo id ao voltar do guia).
  No backend, `ponte-guia.test.ts` confere a dica da ◷ Data da Consulta (widget, sem Sofia). As Observações:
  `desenho.test.js` (vazia, longa, HTML, prévia, só grava no confirmar, "Salvo no cartão.", erro e rascunho),
  `painel.test.js` (o pedido com quem escreveu, nada no WhatsApp, o servidor sem a rota — 401 e 404 —, o erro da Ponte
  legível e o rascunho que volta) e, no backend, `ponte-nota.test.ts` (o pedido, o HTML, o texto da nota com a hora de
  Brasília, o cartão de outra conta, o id que não veio, o POST de nota comum e uma nota por observação) e
  `ponte-porta.test.ts` (a nota passa pela mesma porta).

Na 0.5.0, no backend: `ponte-painel.test.ts` (o selo da unidade nas contas de uma e de duas unidades, o nome curto —
"Comercial" cai no slug —, o `franquiaAndaSozinha` com as duas automações pela tela e pelo `.env`, da unidade do cartão
e nunca com o campo vazio, a qualificação com e sem os campos da conta, o telefone, a Sofia na unidade e a trilha do
TRATAMENTO).

No backend: `ponte-fila.test.ts` (cada regra da fila e os prazos), `ponte-resumo.test.ts` (o resumo sem IA, o
pedido e a leitura da resposta da IA), `ponte-pausa.test.ts` (o pedido, as regras de sempre e o próprio
`pausa.js` daqui passando pela regra do servidor) e, na 0.3.0, `ponte-etiquetas.test.ts` (só etiqueta que existe,
de robô — ▶ e "Aderência meio" — só confirmada e com nota, teto por hora inclusive com 10 pedidos juntos, a vaga
devolvida quando nada grava, releitura, e o PATCH com `tags_to_add` na raiz), `ponte-ligacao.test.ts` (os campos ☎
pelo nome com os ids reais de Açailândia, tentativas + 1, campanha 3C esvaziada, nota só sem os campos, a isenção
da revisão de cartão mantida, e a mesma tentativa gravando uma vez), `ponte-respostas.test.ts` (só os modelos
gerais, os marcadores e o primeiro nome), `ponte-duplicados.test.ts` (o mesmo telefone completo, contato
principal, etapas finais e quando avisar), `ponte-fila.test.ts` ("sem telefone" só quando o Kommo afirma) e
`controllers/ponte-porta.test.ts` (a chave antes do limitador — na 0.4.0, também nas rotas do guia e do contador).
Na 0.4.0: `ponte-guia.test.ts` (obrigatório cumulativo — inclusive o 142 do TRATAMENTO, que não conta para o GANHO
do COMERCIAL —, obrigatório faltando trava o mover e nada vai ao Kommo, um PATCH só com campos + etapa, releitura,
nota com quem, cabeçalho `##`/`*…*` nunca é alvo, campo da franquia/robô recusado, GANHO e TRATAMENTO nunca, sem
confirmação nada, etapa que mudou no meio, consulta que já passou não volta para AGENDADO, motivo de perda casado
pelo nome, teto por hora e a vaga devolvida, a unidade vazia pedida antes de tudo, data à meia-noite do fuso com o
valor real de um cartão da Açailândia, e as mensagens por etapa com a variável de ambiente) e `ponte-contador.test.ts`
(a mesma conta do grupo "sem resposta", e falha do Kommo = `total: null`, que a extensão mostra como "?").

### A conferir no dia de teste (fase 2)

- [ ] a fila "sem resposta": o `is_read` das conversas do Kommo fica falso quando só a Sofia respondeu? (a
      regra já ignora conversa em que a última fala é da Sofia, mas só nas unidades com a Sofia);
- [ ] a fila "EM NEGOCIAÇÃO": o Kommo aceita o filtro `value_after` nos eventos de mudança de etapa? (se não
      aceitar, o grupo avisa e usa a última alteração do cartão, que robô também mexe);
- [ ] "Abrir conversa" recarrega o WhatsApp Web e abre o chat certo; contato sem WhatsApp mostra o aviso do
      próprio WhatsApp;
- [ ] "Copiar telefone" funciona no painel lateral do Chrome e na barra lateral do Firefox.

### A conferir no dia de teste (0.3.0)

- [ ] pôr uma etiqueta ▶ pela Ponte dispara o robô (o gatilho do Kommo vale para etiqueta posta pela API? — é a
      mesma dúvida das "Etiquetas ▶ automáticas"); testar num cartão de teste;
- [ ] conferir nos gatilhos de cada conta se há outra etiqueta de robô SEM ▶ além de "Aderência meio" e, se houver,
      pôr na lista (`PONTE_ETIQUETAS_DE_ROBO`);
- [ ] "Começar a ligar": depois que a conversa abre, o 📞 aparece e liga; contato sem WhatsApp mostra o aviso do
      próprio WhatsApp (marcar "Número errado");
- [ ] os campos ☎ aparecem certos no cartão (data, resultado, tentativas, "Ponte · <nome>") e a campanha 3C fica
      vazia; o dashboard/relatório que lê ☎ separa a ligação da SDR da 3C;
- [ ] a aba Respostas lista os modelos gerais da conta (em Açailândia, os "⚡ …") e o texto colado no WhatsApp sai
      com o nome certo;
- [ ] a faixa de duplicado aparece num paciente com dois cartões abertos (e não aparece num GANHO + um aberto).

### A conferir no dia de teste (0.4.0)

- [ ] o guia de um cartão de teste em cada etapa: o que falta bate com o que o Kommo cobra ao arrastar o cartão na
      tela (o cumulativo) e com os campos que a SDR vê na etapa;
- [ ] mover pela Ponte um cartão de teste (sem conversa, como no teste da Marabá) e ver os robôs da etapa: a lista de
      mensagens da Açailândia bate com o que sai?
- [ ] PERDIDO pela Ponte com "Sem interesse": o motivo de perda do cabeçalho do Kommo vem junto, e a Sofia não manda
      o acompanhamento;
- [ ] em Petrópolis, um cartão com o ⌂ Unidade de atendimento vazio: o guia pede a unidade antes de tudo, e a etiqueta
      PETRÓPOLIS/CAXIAS aparece depois da varredura do robô de unidade;
- [ ] o número no ícone bate com o grupo "sem resposta" da Fila de hoje e some quando a fila zera; desligar a
      internet mostra "?";
- [ ] no Firefox, o número aparece no ícone da barra (com o acesso ao servidor ligado em about:addons → Permissões).

### A conferir no dia de teste (0.5.0)

- [ ] **"Abrir conversa" sem recarregar**: abrir um paciente da Fila de hoje e ver se a conversa abre SEM o WhatsApp
      Web recarregar. Se recarregar, abrir o console da aba do WhatsApp (F12) e ler o motivo (`[Ponte] … (nao-tratou)`
      ou `(nao-abriu)`). Conferir também que nenhuma aba nova do wa.me se abre;
- [ ] o mesmo num contato que nunca conversou com a clínica, e num número sem WhatsApp (o aviso do próprio WhatsApp);
- [ ] "Começar a ligar" com 3 pacientes seguidos: a conversa troca sem recarregar e o 📞 aparece;
- [ ] desligar "Abrir conversa sem recarregar" nas opções: volta a recarregar (o jeito antigo);
- [ ] o visual no computador da atendente (Windows): a fonte carrega, a trilha cabe na largura do painel, e as cores
      da etapa batem com o que ela entende ("é sua" × "da franquia");
- [ ] as respostas sugeridas: os nomes dos modelos gerais de cada conta seguem os prefixos (`consulta_`, `espera_`,
      `lead_`…)? Se não, acrescentar o prefixo da conta em `PREFIXOS_DA_ETAPA`.

O backend confere o mesmo contrato em `backend/src/lib/ponte-impressao.test.ts`, que carrega o `impressao.js`
daqui, e em `ponte-cartao.test.ts`. O `ponte-guia.test.ts` carrega o `guia.js` (o aviso dos robôs e a leitura do número)
e o `ponte-contador.test.ts`, o `contador.js` (o "?" na falha).

## Firefox

O Firefox não tem o painel lateral do Chrome; a versão dele usa a **barra lateral** (`sidebar_action`). Os
arquivos são os mesmos, só trocam o `manifest.json` e o `fundo.js` (em `firefox/`). Para montar:
`bash firefox/montar.sh ~/Downloads/extensao-ponte-firefox`. Na 0.4.0 o Firefox carrega `config.js`, `contador.js` e
`fundo.js` no script de fundo (o número no ícone), e a extensão pede a permissão `alarms`. Na 0.5.0 o `montar.sh` leva
também a pasta `fontes/` (a fonte do painel e a licença).

Instalar para testar: `about:debugging` → **Este Firefox** → **Carregar extensão temporária…** → escolha o
`manifest.json` da pasta montada. A extensão temporária some quando o Firefox fecha; para ficar instalada de
vez, precisa ser assinada pela Mozilla (envio "não listado" no addons.mozilla.org). Depois de carregar, em
`about:addons` → Ponte → **Permissões**, ligue o acesso a `web.whatsapp.com` e ao servidor da Doutor Digital
(no Firefox, com Manifest V3, o acesso a sites não vem ligado sozinho).
