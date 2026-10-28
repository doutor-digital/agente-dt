/**
 * Dicionário dos campos do cartão Doutor Hérnia (padrão da rede), cópia de
 * `~/Kommo-Integracao/_replicacao/widget-campos/dicionario.json` (a mesma fonte do widget de guia dos campos).
 * Chave = NOME EXATO do campo no Kommo. o = o que é · q = quem preenche · w = quando · ex = exemplo ·
 * chega_sozinho = como o valor chega sem ninguém digitar.
 * NÃO inventar campo aqui: o Copiloto só conhece o que está neste arquivo.
 */
export interface EntradaDoDicionario {
  o: string;
  q: string;
  w: string;
  ex: string;
  chega_sozinho?: string;
  sub?: unknown;
}
export interface Dicionario {
  campos: Record<string, EntradaDoDicionario>;
  generico: Record<string, { o: string; q: string; w: string; ex: string }>;
  etapas: Record<string, string[]>;
  proxima: Record<string, string[]>;
  missao: Record<string, string>;
}
export const DICIONARIO: Dicionario = {
 "campos": {
  "☻ Responsável agendamento": {
   "o": "Quem marcou a consulta: o nome da SDR ou I.A SOFIA quando foi a Sofia.",
   "q": "SDR (a Sofia preenche sozinha quando ela marca)",
   "w": "Na hora de agendar.",
   "ex": "GIULIA",
   "chega_sozinho": "o botão grava quando você marca"
  },
  "¤ Valor da Consulta": {
   "o": "Valor cobrado pela avaliação.",
   "q": "SDR",
   "w": "Ao agendar.",
   "ex": "150"
  },
  "◷ Data da Consulta": {
   "o": "Dia e hora em que o paciente VEM à clínica. Não é a data em que você agendou (isso é 'Agendado pela SDR em').",
   "q": "SDR (Sofia preenche quando ela marca)",
   "w": "Ao agendar. Obrigatório pra mover pra AGENDADO.",
   "ex": "18/09/2026 14:00",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "✓ Consulta pg antecipado": {
   "o": "Sim ou Não. Marque Sim quando o dinheiro ENTROU — só depois de ver o comprovante. É este que prova o pagamento, não o \"Pagamento antecipado\".",
   "q": "SDR",
   "w": "Só marque Sim depois de conferir o comprovante.",
   "ex": "Sim",
   "chega_sozinho": "a regra do comprovante marca sozinha quando o Pix cai"
  },
  "Consulta pg no dia": {
   "o": "Sim ou Não. Marque Sim quando ele vai pagar a avaliação na clínica. É o contrário de \"Consulta pg antecipado\" — marque um dos dois, nunca os dois.",
   "q": "SDR",
   "w": "Ao agendar, se não pagou antes.",
   "ex": "SIM"
  },
  "¤ Pagamento antecipado": {
   "o": "Sim ou Não — apesar do símbolo ¤, NÃO é valor. Marque Sim quando o paciente DISSE que vai pagar antes, por Pix. Ainda não é prova de que pagou.",
   "q": "Sofia ou SDR",
   "w": "Quando o paciente escolhe pagar por Pix.",
   "ex": "Sim"
  },
  "★ Satisfação / NPS": {
   "o": "Nota que o paciente deu ao atendimento da avaliação.",
   "q": "Recepção",
   "w": "Depois da consulta, quando a pesquisa voltar.",
   "ex": "9"
  },
  "◷ Retomar em": {
   "o": "Data em que vamos voltar a falar com o paciente que pediu pra deixar pra depois.",
   "q": "SDR ou Sofia",
   "w": "Ao mover pra EM ESPERA.",
   "ex": "01/10/2026"
  },
  "⊘ Motivo da espera": {
   "o": "Por que o paciente quer, mas não agora.",
   "q": "SDR ou Sofia",
   "w": "Ao mover pra EM ESPERA.",
   "ex": "Está viajando"
  },
  "◉ Semáforo": {
   "o": "Gravidade do caso depois da avaliação: verde, amarelo ou vermelho.",
   "q": "Fisio ou SDR, com o retorno da fisioterapeuta",
   "w": "Assim que o paciente sair da avaliação. Obrigatório pra mover pra COMPARECEU.",
   "ex": "Amarelo"
  },
  "¤ Valor do tratamento": {
   "o": "Valor total do plano de tratamento proposto ou fechado.",
   "q": "SDR",
   "w": "Ao apresentar a proposta. Obrigatório em EM NEGOCIAÇÃO e GANHO.",
   "ex": "2400",
   "chega_sozinho": "vem do tratamento lançado na franquia"
  },
  "⚕ Fisioterapeuta": {
   "o": "Quem avaliou o paciente.",
   "q": "SDR",
   "w": "Depois da consulta. Obrigatório pra mover pra COMPARECEU.",
   "ex": "Dra. Ana",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "⚕ Tratamento indicado": {
   "o": "O que a fisioterapeuta indicou. Se não indicou nada, use SEM TRATAMENTO INDICADO.",
   "q": "SDR, com o retorno da fisioterapeuta",
   "w": "Depois da consulta. Obrigatório pra mover pra COMPARECEU.",
   "ex": "Protocolo coluna 10 sessões"
  },
  "⚕ Tratamento fechado": {
   "o": "O tratamento que o paciente de fato comprou.",
   "q": "SDR",
   "w": "Ao fechar. Obrigatório pra mover pra GANHO.",
   "ex": "Protocolo coluna 10 sessões",
   "chega_sozinho": "vem do tratamento lançado na franquia"
  },
  "⬢ Tipo de fechamento de tratamento": {
   "o": "Como o tratamento foi fechado (escolha na lista).",
   "q": "SDR",
   "w": "Ao fechar. Obrigatório pra mover pra GANHO.",
   "ex": "Pacote completo"
  },
  "✎ Contraindicação / bandeira vermelha": {
   "o": "Sinal de alerta que a fisioterapeuta encontrou na avaliação e o que foi feito (encaminhamento, exame).",
   "q": "SDR, com o retorno da fisioterapeuta",
   "w": "Depois da consulta, se houver.",
   "ex": "Perda de força na perna → encaminhado ao ortopedista"
  },
  "◷ Data de retorno com exames": {
   "o": "Quando o paciente volta trazendo os exames pedidos.",
   "q": "SDR",
   "w": "Se a fisioterapeuta pediu exames.",
   "ex": "25/09/2026"
  },
  "✓ Fechou tratamento": {
   "o": "Sim ou Não: o paciente fechou o tratamento?",
   "q": "SDR",
   "w": "Ao decidir. Obrigatório pra mover pra GANHO.",
   "ex": "Sim",
   "chega_sozinho": "vem do tratamento lançado na franquia"
  },
  "◷ Data de fechamento": {
   "o": "Dia em que o paciente fechou.",
   "q": "SDR",
   "w": "Ao fechar.",
   "ex": "19/09/2026"
  },
  "◷ Data do tratamento iniciado": {
   "o": "Dia da primeira sessão.",
   "q": "SDR ou Recepção",
   "w": "Quando começar.",
   "ex": "22/09/2026",
   "chega_sozinho": "o CRM carimba quando o cartão entra em EM TRATAMENTO"
  },
  "¤ Desconto concedido": {
   "o": "Valor de desconto dado na negociação.",
   "q": "SDR",
   "w": "Se deu desconto.",
   "ex": "200"
  },
  "⬢ Forma de pagamento": {
   "o": "Como o paciente pagou o tratamento.",
   "q": "SDR",
   "w": "Ao fechar.",
   "ex": "Cartão parcelado"
  },
  "# Nº de parcelas": {
   "o": "Em quantas vezes.",
   "q": "SDR",
   "w": "Ao fechar, se parcelou.",
   "ex": "6"
  },
  "¤ Valor pago / entrada": {
   "o": "Quanto o paciente já pagou do tratamento.",
   "q": "SDR",
   "w": "Ao receber.",
   "ex": "800"
  },
  "◷ Data do pagamento": {
   "o": "Data que aparece no comprovante, não a de hoje.",
   "q": "SDR",
   "w": "Ao receber.",
   "ex": "19/09/2026"
  },
  "✎ Negociação feita": {
   "o": "Resumo da proposta, objeções e o que ficou combinado.",
   "q": "SDR",
   "w": "Durante a negociação.",
   "ex": "Ofereci 10 sessões, achou caro, ficou de falar com o marido"
  },
  "◷ Data da perda": {
   "o": "Dia em que o paciente desistiu.",
   "q": "SDR",
   "w": "Ao mover pra PERDIDO.",
   "ex": "12/09/2026",
   "chega_sozinho": "o CRM carimba quando o cartão vai pra PERDIDO"
  },
  "⊘ Motivo de não fechamento do tratamento": {
   "o": "Por que não comprou DEPOIS de ter feito a avaliação. Antes da avaliação, use 'Motivo do não agendamento'.",
   "q": "SDR",
   "w": "Ao perder um paciente que já foi avaliado.",
   "ex": "Sem condições financeira"
  },
  "✓ Interação": {
   "o": "Se o paciente respondeu à régua de resgate.",
   "q": "Automático (resgate)",
   "w": "Não preencher à mão.",
   "ex": "Sim"
  },
  "# Nº de tentativas de contato": {
   "o": "Quantas vezes a régua de resgate tentou falar com o paciente.",
   "q": "Automático (resgate)",
   "w": "Não preencher à mão.",
   "ex": "3"
  },
  "⬢ Tipo de resgate": {
   "o": "Como o resgate foi feito.",
   "q": "Automático (resgate)",
   "w": "Não preencher à mão.",
   "ex": "Template de Mensagem"
  },
  "⬢ Tentativas de resgate": {
   "o": "Em que passo da régua de resgate o paciente está.",
   "q": "Automático (resgate)",
   "w": "Não preencher à mão.",
   "ex": "Resgate 4 - 120h"
  },
  "⬢ Tipo de lead": {
   "o": "Cadastro = paciente novo; Resgate = voltou depois de perdido; Transferido = veio de outra unidade.",
   "q": "Sofia ou automático",
   "w": "Na entrada. Obrigatório em EM QUALIFICAÇÃO.",
   "ex": "Cadastro",
   "sub": "DIGITAL"
  },
  "✎ Queixa": {
   "o": "Onde dói, há quanto tempo e o que a dor impede. É o que a fisioterapeuta lê antes da avaliação.",
   "q": "Sofia (complete se o paciente contou mais por telefone)",
   "w": "Assim que o paciente descrever o problema.",
   "ex": "Dor lombar há 2 meses irradiando pra perna direita, não consegue ficar sentado",
   "sub": "DIGITAL"
  },
  "★ Qualificação (Quente/Morno/Frio)": {
   "o": "Quente = quer marcar; Morno = interessado, decidindo; Frio = só curiosidade ou preço.",
   "q": "Sofia (ajuste se discordar)",
   "w": "Durante a conversa. Obrigatório em EM QUALIFICAÇÃO.",
   "ex": "Quente",
   "sub": "DIGITAL"
  },
  "⚥ Sexo": {
   "o": "Sexo do paciente.",
   "q": "Sofia (pelo nome ou pela conversa)",
   "w": "Automático; corrija se errar.",
   "ex": "Feminino"
  },
  "⬢ Plano de saúde": {
   "o": "Plano de saúde, se o paciente mencionou.",
   "q": "Sofia ou SDR",
   "w": "Se aparecer na conversa.",
   "ex": "Unimed"
  },
  "✎ Observações": {
   "o": "Anotações livres da equipe: ligações feitas, combinados, contexto.",
   "q": "SDR",
   "w": "Sempre que fizer algo que não cabe em outro campo.",
   "ex": "Liguei 2x, não atendeu. Pediu pra chamar depois das 18h",
   "sub": "DIGITAL"
  },
  "◷ Preferência de horário": {
   "o": "Dia ou turno que o paciente prefere pra avaliação.",
   "q": "Sofia",
   "w": "Quando o paciente falar.",
   "ex": "Manhã, quinta ou sexta",
   "chega_sozinho": "não é usado por ninguém"
  },
  "⬢ Tipo de agendamento": {
   "o": "Cadastro = agendou um paciente novo; Resgate = agendou um paciente resgatado.",
   "q": "SDR",
   "w": "Ao agendar. Obrigatório pra mover pra AGENDADO.",
   "ex": "Cadastro"
  },
  "✓ Situação da consulta": {
   "o": "Em que pé está a consulta: Agendado → Confirmado → Atendido. Ou Não compareceu, Remarcado, Desmarcado.",
   "q": "SDR (Sofia marca Agendado e Confirmado quando ela cuida)",
   "w": "Atualize a cada mudança. Obrigatório pra mover pra COMPARECEU.",
   "ex": "Confirmado",
   "chega_sozinho": "você muda na franquia, o cartão copia"
  },
  "⌂ Categoria da consulta": {
   "o": "Tipo de consulta marcada: Avaliação, Sessão, Retorno, Retorno com exames, Retorno após tratamento.",
   "q": "SDR",
   "w": "Ao agendar.",
   "ex": "Avaliação",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "⊘ Motivo do não agendamento": {
   "o": "Por que o paciente não marcou ou desistiu ANTES da avaliação.",
   "q": "Sofia ou SDR",
   "w": "Ao mover pra PERDIDO. Obrigatório em PERDIDO. Se for 'está viajando' ou 'vai se organizar', prefira EM ESPERA.",
   "ex": "Outra cidade",
   "sub": "DIGITAL"
  },
  "⊘ Motivo do no-show": {
   "o": "Por que o paciente não veio na consulta marcada.",
   "q": "SDR",
   "w": "Ao mover pra NÃO COMPARECEU.",
   "ex": "Esqueceu"
  },
  "◷ Data do reagendamento": {
   "o": "Nova data marcada depois de uma falta.",
   "q": "SDR",
   "w": "Ao reagendar.",
   "ex": "23/09/2026 09:00"
  },
  "# Nº de reagendamentos": {
   "o": "Quantas vezes essa consulta já foi remarcada.",
   "q": "SDR",
   "w": "A cada remarcação.",
   "ex": "1"
  },
  "◷ Agendado pela SDR em": {
   "o": "Dia e hora em que VOCÊ fez o agendamento (hoje, agora). Não é a data da consulta.",
   "q": "SDR",
   "w": "No ato de agendar.",
   "ex": "14/09/2026 15:30",
   "chega_sozinho": "o botão grava quando você marca",
   "sub": "DIGITAL"
  },
  "⌂ Cidade": {
   "o": "Cidade do paciente. Serve pra saber se é da unidade ou de fora.",
   "q": "Sofia ou SDR",
   "w": "Quando o paciente falar.",
   "ex": "Vitória",
   "chega_sozinho": "vem da ficha da franquia"
  },
  "⌂ Bairro": {
   "o": "Bairro do paciente.",
   "q": "Sofia ou SDR",
   "w": "Se aparecer.",
   "ex": "Centro"
  },
  "⚑ Origem": {
   "o": "Por onde o paciente chegou: Meta-Instagram, Meta-Facebook, Google, Indicação, etc.",
   "q": "Automático (anúncio) ou Sofia",
   "w": "Na entrada. Obrigatório em EM QUALIFICAÇÃO. Preencha à mão só se vier vazio.",
   "ex": "Meta-Instagram",
   "chega_sozinho": "o n8n grava do anúncio"
  },
  "⌂ Campanha": {
   "o": "Campanha de anúncio que trouxe o paciente.",
   "q": "Automático (rastreio de anúncios)",
   "w": "Não preencher à mão.",
   "ex": "DH · Coluna · Set/26"
  },
  "⌂ Plataforma de origem": {
   "o": "Instagram, Facebook, Google…",
   "q": "Automático (rastreio de anúncios)",
   "w": "Não preencher à mão.",
   "ex": "Instagram"
  },
  "⌂ Anúncio (ad)": {
   "o": "Nome do anúncio clicado.",
   "q": "Automático (rastreio de anúncios)",
   "w": "Não preencher à mão.",
   "ex": "Vídeo dor lombar"
  },
  "⌂ ID do anúncio": {
   "o": "Código do anúncio no Meta.",
   "q": "Automático",
   "w": "Não preencher à mão.",
   "ex": "120212…"
  },
  "⌂ Título do anúncio": {
   "o": "Título do anúncio.",
   "q": "Automático",
   "w": "Não preencher à mão.",
   "ex": "Dor na coluna? Faça sua avaliação"
  },
  "⌂ Imagem do anúncio": {
   "o": "Link da imagem do anúncio.",
   "q": "Automático",
   "w": "Não preencher à mão.",
   "ex": "https://…"
  },
  "⌂ Conjunto de anúncio": {
   "o": "Conjunto de anúncios (público) que trouxe o paciente.",
   "q": "Automático",
   "w": "Não preencher à mão.",
   "ex": "Mulheres 35-60"
  },
  "⌂ ctwa_clid": {
   "o": "Código técnico do clique no anúncio (click-to-WhatsApp).",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "ARA…"
  },
  "⌂ URL de origem do clique": {
   "o": "Endereço de onde veio o clique.",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "https://…"
  },
  "⌂ Cliques no anúncio": {
   "o": "Quantos cliques esse paciente deu em anúncios.",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "1"
  },
  "Pausar IA": {
   "o": "Marcado = a Sofia para de responder este paciente e você assume. Desmarque pra ela voltar.",
   "q": "SDR",
   "w": "Quando quiser conduzir a conversa você mesma.",
   "ex": "✓"
  },
  "Resposta da IA": {
   "o": "Campo técnico por onde a Sofia envia a mensagem.",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "—"
  },
  "# Sessões previstas": {
   "o": "Quantas sessões o tratamento fechado tem.",
   "q": "Recepção",
   "w": "Ao iniciar o tratamento.",
   "ex": "10",
   "chega_sozinho": "contadas na agenda da franquia"
  },
  "# Sessões realizadas": {
   "o": "Quantas sessões já foram feitas.",
   "q": "Recepção",
   "w": "A cada sessão.",
   "ex": "4",
   "chega_sozinho": "ninguém escreve este campo hoje"
  },
  "◷ Próxima sessão": {
   "o": "Data da próxima sessão marcada.",
   "q": "Recepção",
   "w": "A cada sessão.",
   "ex": "20/09/2026 10:00",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "◷ Última sessão marcada": {
   "o": "Data da última sessão que foi marcada.",
   "q": "Recepção",
   "w": "A cada sessão.",
   "ex": "17/09/2026 10:00",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "✓ Compareceu à última sessão marcada": {
   "o": "Se o paciente veio na última sessão.",
   "q": "Recepção",
   "w": "Depois de cada sessão.",
   "ex": "Sim",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "# Nº de faltas em sessão": {
   "o": "Quantas sessões o paciente faltou.",
   "q": "Recepção",
   "w": "A cada falta.",
   "ex": "1",
   "chega_sozinho": "vem da agenda da franquia"
  },
  "◷ Data prevista de término": {
   "o": "Quando o tratamento deve terminar.",
   "q": "Recepção",
   "w": "Ao iniciar o tratamento.",
   "ex": "30/10/2026"
  },
  "✎ Observações de sessões": {
   "o": "Anotações sobre a evolução nas sessões.",
   "q": "Recepção ou Fisio",
   "w": "Quando houver algo relevante.",
   "ex": "Melhora da dor a partir da 3ª sessão"
  },
  "✓ Alta": {
   "o": "Se o paciente recebeu alta.",
   "q": "Fisio ou Recepção",
   "w": "Ao dar alta.",
   "ex": "Sim",
   "chega_sozinho": "a franquia finaliza o tratamento e o cartão vai pra ALTA"
  },
  "◷ Data de alta": {
   "o": "Dia da alta.",
   "q": "Fisio ou Recepção",
   "w": "Ao dar alta. Obrigatório em RETORNO PÓS-TRATAMENTO.",
   "ex": "30/10/2026",
   "chega_sozinho": "vem da franquia"
  },
  "★ Satisfação / NPS (Tratamento)": {
   "o": "Nota do paciente sobre o tratamento inteiro.",
   "q": "Recepção",
   "w": "Após a alta.",
   "ex": "10"
  },
  "◷ Data da pesquisa NPS": {
   "o": "Quando a pesquisa foi respondida.",
   "q": "Recepção",
   "w": "Após a alta.",
   "ex": "02/11/2026"
  },
  "⊘ Motivo da insatisfação": {
   "o": "Se a nota foi baixa, por quê.",
   "q": "Recepção",
   "w": "Se nota ≤ 6.",
   "ex": "Demora no atendimento"
  },
  "✓ Deixou avaliação (Google)": {
   "o": "Se o paciente avaliou a clínica no Google.",
   "q": "Recepção",
   "w": "Após a alta.",
   "ex": "Sim"
  },
  "✓ Autorizou depoimento / vídeo": {
   "o": "Se autorizou usar depoimento ou vídeo.",
   "q": "Recepção",
   "w": "Após a alta.",
   "ex": "Sim"
  },
  "# Indicações geradas": {
   "o": "Quantas pessoas esse paciente indicou.",
   "q": "Recepção",
   "w": "Quando alguém chegar por indicação dele.",
   "ex": "2"
  },
  "◷ Data solicitação de cancelamento": {
   "o": "Quando o paciente pediu pra cancelar.",
   "q": "Recepção",
   "w": "Ao receber o pedido.",
   "ex": "05/10/2026"
  },
  "⊘ Motivo do cancelamento do tratamento": {
   "o": "Por que cancelou.",
   "q": "Recepção",
   "w": "Ao cancelar.",
   "ex": "Mudou de cidade"
  },
  "✓ Cancelamento revertido": {
   "o": "Se conseguimos convencer o paciente a continuar.",
   "q": "Recepção",
   "w": "Se reverter.",
   "ex": "Não"
  },
  "◷ Data do cancelamento": {
   "o": "Dia em que o cancelamento foi efetivado.",
   "q": "Recepção",
   "w": "Ao cancelar.",
   "ex": "06/10/2026"
  },
  "◷ Data de retorno": {
   "o": "Se o paciente disse que volta, quando.",
   "q": "Recepção",
   "w": "Ao cancelar, se houver.",
   "ex": "01/2027"
  },
  "Clinica de transferência": {
   "o": "Pra qual unidade o paciente foi transferido.",
   "q": "Recepção",
   "w": "Ao transferir.",
   "ex": "DH Açailândia"
  },
  "Data das sessões realiadas": {
   "o": "Datas das sessões feitas antes da transferência.",
   "q": "Recepção",
   "w": "Ao transferir.",
   "ex": "01/09, 08/09"
  },
  "Valor de repasse": {
   "o": "Valor a repassar à unidade que recebe.",
   "q": "Recepção / Financeiro",
   "w": "Ao transferir.",
   "ex": "1200"
  },
  "Clinica Rebida": {
   "o": "De qual unidade o paciente veio (quando recebemos a transferência).",
   "q": "Recepção",
   "w": "Ao receber.",
   "ex": "DH Marabá"
  },
  "Data das Sessões realiadas": {
   "o": "Datas das sessões feitas aqui após receber o paciente.",
   "q": "Recepção",
   "w": "A cada sessão.",
   "ex": "15/09, 22/09"
  },
  "Valor de Recebimento": {
   "o": "Valor recebido da unidade de origem.",
   "q": "Recepção / Financeiro",
   "w": "Ao receber.",
   "ex": "1200"
  },
  "№ Cliente": {
   "o": "Código do paciente no Asaas (cobrança).",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "cus_…"
  },
  "№ Cobrança": {
   "o": "Código da cobrança no Asaas.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "pay_…"
  },
  "№ Assinatura": {
   "o": "Código da assinatura no Asaas, se for recorrente.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "sub_…"
  },
  "⬢ Status do pagamento": {
   "o": "Situação da cobrança no Asaas: pendente, pago, vencido…",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "Pago"
  },
  "◷ Vencimento": {
   "o": "Vencimento da cobrança.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "20/09/2026"
  },
  "◷ Próximo vencimento": {
   "o": "Próxima parcela.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "20/10/2026"
  },
  "↗ Link da fatura": {
   "o": "Link da fatura pra mandar ao paciente.",
   "q": "Automático (Asaas)",
   "w": "Copie e envie ao paciente quando ele pedir.",
   "ex": "https://…"
  },
  "↗ Boleto / PIX": {
   "o": "Link do boleto ou do Pix pra mandar ao paciente.",
   "q": "Automático (Asaas)",
   "w": "Copie e envie ao paciente.",
   "ex": "https://…"
  },
  "✎ Descrição": {
   "o": "Descrição da cobrança no Asaas.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "Avaliação fisioterapêutica"
  },
  "¤ Valor da cobrança": {
   "o": "Valor cobrado no Asaas.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "150"
  },
  "¤ Valor líquido recebido": {
   "o": "Valor que entrou depois das taxas.",
   "q": "Automático (Asaas)",
   "w": "Não mexer.",
   "ex": "148,50"
  },
  "☎ Última ligação": {
   "o": "Quando foi a última ligação pelo 3C.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "12/09/2026 10:12"
  },
  "☎ Resultado": {
   "o": "Resultado da última ligação.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "Não atendeu"
  },
  "☎ Duração da conversa": {
   "o": "Quanto durou a ligação.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "02:14"
  },
  "☎ Motivo (qualificação)": {
   "o": "Como a ligação foi classificada no 3C.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "Interessado"
  },
  "☎ Agente": {
   "o": "Quem ligou.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "Giulia"
  },
  "☎ Campanha 3C": {
   "o": "Campanha de ligações.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "Perdidos set/26"
  },
  "☎ Tentativas": {
   "o": "Quantas ligações já foram feitas.",
   "q": "Automático (3C)",
   "w": "Não mexer.",
   "ex": "3"
  },
  "☎ Gravação": {
   "o": "Link da gravação da ligação.",
   "q": "Automático (3C)",
   "w": "Ouça se precisar do contexto.",
   "ex": "https://…"
  }
 },
 "generico": {
  "utm_": {
   "o": "Rastreio técnico da campanha que trouxe o paciente.",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "—"
  },
  "Statistics": {
   "o": "Rastreio técnico de anúncios.",
   "q": "Automático",
   "w": "Não mexer.",
   "ex": "—"
  }
 },
 "etapas": {
  "Incoming leads": [
   "⬢ Tipo de lead",
   "✎ Queixa",
   "★ Qualificação (Quente/Morno/Frio)"
  ],
  "EM QUALIFICAÇÃO": [
   "⬢ Tipo de lead",
   "✎ Queixa",
   "★ Qualificação (Quente/Morno/Frio)",
   "✎ Observações"
  ],
  "EM ESPERA": [
   "◷ Retomar em",
   "⊘ Motivo da espera",
   "✎ Observações"
  ],
  "AGENDADO": [
   "⬢ Tipo de agendamento",
   "¤ Valor da Consulta",
   "¤ Pagamento antecipado",
   "Consulta pg no dia"
  ],
  "NÃO COMPARECEU": [
   "⊘ Motivo do no-show",
   "◷ Data do reagendamento",
   "# Nº de reagendamentos"
  ],
  "COMPARECEU": [
   "⚕ Tratamento indicado",
   "◉ Semáforo",
   "✎ Contraindicação / bandeira vermelha",
   "◷ Data de retorno com exames",
   "★ Satisfação / NPS"
  ],
  "EM NEGOCIAÇÃO": [
   "✎ Negociação feita",
   "¤ Desconto concedido",
   "⬢ Forma de pagamento",
   "# Nº de parcelas",
   "⊘ Motivo de não fechamento do tratamento"
  ],
  "RETORNO PÓS-TRATAMENTO": [],
  "GANHO / CONCLUIDO": [
   "⬢ Tipo de fechamento de tratamento",
   "◷ Data de fechamento",
   "⬢ Forma de pagamento",
   "# Nº de parcelas",
   "¤ Valor pago / entrada",
   "◷ Data do pagamento"
  ],
  "PERDIDO": [
   "⊘ Motivo do não agendamento",
   "⊘ Motivo de não fechamento do tratamento"
  ],
  "EM TRATAMENTO": [
   "◷ Data prevista de término"
  ],
  "ALTA": [
   "★ Satisfação / NPS (Tratamento)",
   "◷ Data da pesquisa NPS",
   "✓ Deixou avaliação (Google)",
   "✓ Autorizou depoimento / vídeo",
   "# Indicações geradas"
  ],
  "TRATAMENTO CANCELADO": [
   "◷ Data solicitação de cancelamento",
   "⊘ Motivo do cancelamento do tratamento",
   "✓ Cancelamento revertido",
   "◷ Data do cancelamento",
   "◷ Data de retorno"
  ]
 },
 "proxima": {
  "Incoming leads": [
   "EM QUALIFICAÇÃO"
  ],
  "EM QUALIFICAÇÃO": [
   "AGENDADO",
   "EM ESPERA"
  ],
  "EM ESPERA": [
   "AGENDADO"
  ],
  "AGENDADO": [
   "COMPARECEU",
   "NÃO COMPARECEU"
  ],
  "NÃO COMPARECEU": [
   "AGENDADO",
   "PERDIDO"
  ],
  "COMPARECEU": [
   "EM NEGOCIAÇÃO",
   "GANHO / CONCLUIDO"
  ],
  "EM NEGOCIAÇÃO": [
   "GANHO / CONCLUIDO",
   "PERDIDO"
  ],
  "GANHO / CONCLUIDO": [
   "RETORNO PÓS-TRATAMENTO"
  ],
  "RETORNO PÓS-TRATAMENTO": [],
  "PERDIDO": [
   "EM QUALIFICAÇÃO"
  ]
 },
 "missao": {
  "Incoming leads": "Lead acabou de chegar. Leia a conversa, salve o nome no título e mova pra EM QUALIFICAÇÃO.",
  "EM QUALIFICAÇÃO": "Descubra a queixa, a região da dor e a urgência. Salve o nome no título e marque Quente, Morno ou Frio.",
  "EM ESPERA": "Quer, mas agora não pode. Preencha quando retomar e o motivo. Não é perdido.",
  "AGENDADO": "Consulta marcada. Confira data e hora, registre o pagamento antecipado e quem agendou.",
  "NÃO COMPARECEU": "Faltou à consulta. Registre o motivo e tente reagendar. Remarcou? Volta pra AGENDADO.",
  "COMPARECEU": "Veio à consulta. Registre fisioterapeuta, tratamento indicado, semáforo e o que foi decidido.",
  "EM NEGOCIAÇÃO": "Saiu avaliando. Registre o valor proposto e a negociação feita, e acompanhe de perto.",
  "GANHO / CONCLUIDO": "Fechou o tratamento. Registre qual tratamento, valor, forma de pagamento e as datas.",
  "RETORNO PÓS-TRATAMENTO": "Paciente voltando depois do tratamento. Registre a nova consulta como um retorno.",
  "PERDIDO": "Não vai vir. Registre o motivo do não agendamento. Se ele voltar a escrever, volta pra qualificação.",
  "EM TRATAMENTO": "Paciente em tratamento agora. A franquia preenche as sessões sozinha; você confere faltas e a data prevista de término.",
  "ALTA": "Tratamento concluído. Confirme a data de alta, registre a satisfação e se autorizou depoimento.",
  "TRATAMENTO CANCELADO": "Paciente parou o tratamento. Registre o motivo, a data e se há previsão de retorno."
 }
};
