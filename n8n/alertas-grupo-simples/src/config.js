// ===== DESTINOS (fonte única; o build cola este bloco nos nós Entrada e Validar) =====
const TEST_NUM = '5563991021043';          // 🧪 vai SEMPRE para este número (João), nunca para grupo
// Só estas unidades mandam para grupo. Para ligar a 2ª: some uma linha aqui (jid copiado do mapa do fluxo antigo K33m9ZYNA6R3h2j0).
const UNITS = {
  acailandia: { jid: '120363399681615902@g.us', nome: 'Açailândia', mention: '559991063655' }, // mention: só na bandeira vermelha; '' = sem menção
  // imperatriz: { jid: '...@g.us', nome: 'Imperatriz', mention: '' },
};
// Subdomínio da conta Kommo -> slug (a conta manda mais que o slug do texto). Unidade que está aqui mas não em UNITS = descartada e logada.
const SUBS = {
  doutorherniaacailandia: 'acailandia', attivacorpoementeitz: 'imperatriz', araguainadoutorhernia: 'araguaina',
  doutorherniaporto: 'porto', doutorherniabalsas: 'balsas', doutorherniacanaa: 'canaa', marabadoutorhernia: 'maraba',
  parauapebasdoutorhernia: 'parauapebas', drherniaserra: 'serra', boavistarrdoutorhernia: 'boavista',
  doutorherniarioverde2026: 'rioverde',
};
