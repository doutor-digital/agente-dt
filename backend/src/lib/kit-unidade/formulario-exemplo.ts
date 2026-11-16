/** Resposta de formulário completa e válida, TUDO fictício — só para teste e para a prévia visual. */
export const respostasValidas = () => ({
  quem: { nome: 'Dra. Ana Teste', email: 'ana.teste@clinica.example', whatsapp: '(94) 99999-0000' },
  clinica: { nome: 'Doutor Hérnia Serra', cidade: 'Serra', uf: 'ES', endereco: 'Rua Exemplo, 100, Sala 2, Centro, Serra/ES, 29160-000', mapa_url: 'https://maps.example/serra', telefone: '(27) 3333-4444' },
  horarios: { dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00', almoco_inicio: '12:00', almoco_fim: '13:00', duracao_min: 30 },
  profissionais: [{ nome: 'Dra. Ana Teste', funcao: 'fisioterapeuta' }],
  valores: { consulta_no_dia: '350', consulta_antecipada: 'R$ 250,00', sinal_pix: '50', chave_pix: 'pix-teste@clinica.example', favorecido: 'Clínica Teste Ltda' },
  whatsapp: { numero: '+55 27 99999-0000', aplicativo: 'business', conexao: 'coexistencia' },
  equipe: [
    { nome: 'Gerente Teste', email: 'Gerente@Clinica.example', funcao: 'gerente' },
    { nome: 'Recepção Teste', email: 'recepcao@clinica.example', funcao: 'secretaria' },
  ],
  celular_email: 'celular@clinica.example',
  franquia_id_company: '',
  meta: { ad_account: '', business_manager_id: '' },
  assistente: { quer: false },
  confirmou: true,
});


/** A seção «Assistente virtual» COMPLETA (tudo fictício): padrão da rede intacto em quase tudo, uma objeção mudada, uma criada, FAQ e quem recebe. */
export const assistenteCompleta = () => ({
  quer: true,
  nome_ia: 'Sofia',
  tom: 'proximo',
  emoji: 'pouco',
  quando_atende: 'fora-expediente',
  quando_atende_detalhe: '',
  saudacao: 'Oi! Aqui é a Sofia, da Doutor Hérnia Serra, especialista em coluna sem cirurgia.',
  diferenciais: 'Equipe com mais de 10 anos de experiência e atendimento individual.',
  primeira_consulta: { como_funciona: 'O especialista conversa com você, examina a coluna e explica a causa da dor e as opções de tratamento.', duracao: 'cerca de 40 minutos', o_que_levar: 'exames de imagem, se tiver', chegada: '15 minutos antes' },
  pagamento: { formas: 'Pix, cartão de débito e crédito', parcelamento: 'cartão de crédito em até 3 vezes', convenio: 'reembolso', convenio_quais: 'damos o recibo para você pedir reembolso ao seu plano', remarcacao: 'Avise com 24 horas de antecedência para remarcar sem custo; faltas sem aviso perdem a vaga do dia.' },
  nao_atende: 'crianças menores de 12 anos',
  objecoes: [
    { id: 'caro', resposta: 'Entendo! Muita gente sente o mesmo no começo. A consulta mostra a causa da dor e o que resolve de verdade, e o sinal garante a vaga.' },
    { id: 'pensar', resposta: 'Claro! O que pesa mais para você decidir: o valor, o horário ou saber se o tratamento serve pra você?' },
    { id: 'medo', resposta: 'É normal ter receio. A consulta é para conversar e examinar com cuidado, no seu ritmo.' },
    { id: 'outra', gatilho: 'Vocês atendem plano da Unimed?', resposta: 'Nosso atendimento é particular, mas damos o recibo para pedir reembolso ao plano.' },
  ],
  nunca_extra: 'falar mal de outras clínicas',
  passar_extra: 'o paciente pedir para falar com o médico antes de marcar',
  quem_recebe: { nome: 'Recepção da clínica', contato: 'recepcao@clinica.example' },
  faq: [
    { pergunta: 'Tem estacionamento?', resposta: 'Sim, estacionamento gratuito na frente da clínica.' },
    { pergunta: 'Atende aos sábados?', resposta: 'Atendemos de segunda a sexta.' },
  ],
});
