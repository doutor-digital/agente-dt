/** Resposta de formulário completa e válida, TUDO fictício — só para teste e para a prévia visual. */
export const respostasValidas = () => ({
  quem: { nome: 'Dra. Ana Teste', contato: '(94) 99999-0000' },
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
  sofia: { nome_ia: '', tom: 'friendly' },
  confirmou: true,
});

