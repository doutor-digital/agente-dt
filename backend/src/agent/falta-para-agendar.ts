/**
 * Diz à IA, a cada turno, o que ainda falta para conseguir marcar a consulta.
 *
 * O buraco que isto tapa apareceu numa conversa real (Núbia, Boa Vista, 29/08):
 * a Sofia perguntou sobre perda de força, a paciente respondeu outra coisa, e
 * ela seguiu adiante como se tivesse sido respondida — a pergunta que decide se
 * o caso é emergência ficou sem resposta a conversa inteira. No mesmo
 * atendimento ela perguntou "onde dói e há quanto tempo", recebeu outra coisa,
 * e pulou pra pergunta seguinte: a conversa ficou uma pergunta atrasada até o
 * fim.
 *
 * A causa é simples: ela sabe o que já foi dito (tem memória), mas nada lhe diz
 * o que FALTA. Uma lista curta e explícita no prompt resolve, e é barata: sai
 * dos fatos que ela mesma já grava.
 *
 * Cada item aceita vários nomes de fato porque a IA inventa a chave na hora —
 * em produção convivem `queixa`, `queixa_principal`, `dor` e `localizacao_dor`
 * para a mesma informação, e `agendou` com `consulta_marcada`. Casar por nome
 * exato deixaria a lista mentindo que falta algo que já existe.
 */

import { canonizarFatos } from '../services/fatos-canonicos.js';

export type Fatos = Record<string, unknown>;

/**
 * Sinais que exigem a pergunta de triagem antes de seguir vendendo.
 * Formigamento comum (perna, braço) SOZINHO não entra (10/11/2026) — na virilha/região íntima entra (FORMIGAMENTO_PERIGOSO): a regra <sinal_de_alerta> (decisão do João, 26/10) diz que dor que desce
 * para a perna ou formigamento, sozinhos, NÃO são sinal de alerta — e esta lista mandava perguntar mesmo assim, a cada turno.
 */
const SINAL_NEUROLOGICO = /dorm[êe]nc|fraquez|perda de for[çc]a|sem for[çc]a|n[ãa]o consegue andar/i;
/** Formigamento só dispara quando vem na virilha / região íntima / entre as pernas / períneo (sinal de cauda equina). */
const FORMIGAMENTO_PERIGOSO =
  /formigament\w*[^.;\n]{0,40}(?:virilha|[íi]ntim|entre as pernas|per[íi]neo|genita|[aâ]nus|\bsela\b)|(?:virilha|[íi]ntim|entre as pernas|per[íi]neo|genita|[aâ]nus|\bsela\b)[^.;\n]{0,40}formigament/i;

/** Fatos que registram a resposta do paciente sobre força/bexiga/intestino. */
const CHAVES_RED_FLAG = ['red_flag', 'redflag', 'perda_forca', 'perda_de_forca', 'bexiga', 'intestino', 'sinal_alerta'];

interface Item {
  rotulo: string;
  chaves: string[];
  comoPedir: string;
  /** Quando o item não se resolve só com "tem valor numa das chaves" (a cidade, que precisa ser cidade de verdade). */
  confere?: (fatos: Fatos) => boolean;
}

/**
 * A cidade conta quando o fato é uma cidade, ou quando o paciente confirmou que consegue vir à unidade.
 *
 * `localizacao` NÃO é chave de cidade: em produção a IA a usa para ONDE DÓI ("lombar", "lado direito"), e a lista
 * dava a cidade por sabida — a Sofia oferecia horário a quem mora em outro estado sem nunca ter perguntado onde a
 * pessoa mora (relatório de 27/11/2026, §2 causa 2). Por isso, mesmo o `cidade` que veio de apelido (fatos-canonicos.ts
 * grava `localizacao` como `cidade`) só vale se o texto não for uma parte do corpo.
 */
const CHAVES_CIDADE = ['cidade', 'municipio', 'cidade_paciente', 'mora_em'];
const CHAVES_VEM_A_UNIDADE = ['consegue_vir', 'pode_vir', 'consegue_ir', 'vem_a_unidade'];
/**
 * Palavras de corpo que NUNCA são nome de cidade: com uma delas o valor em MINÚSCULA é lido como dor ("lombar crônica", "dor no
 * pescoço com formigamento"). Singular, sem acento; o plural entra por `singular()`.
 */
const CORPO_FORTE = new Set([
  'lombar', 'lombalgia', 'cervical', 'cervicalgia', 'toracico', 'toracica', 'dorsal', 'sacro', 'sacroiliaca', 'coluna', 'costas', 'lombo',
  'pescoco', 'nuca', 'ciatico', 'ciatica', 'nervo', 'perna', 'coxa', 'panturrilha', 'calcanhar', 'tornozelo', 'joelho', 'quadril', 'quadris', 'bacia',
  'pelve', 'gluteo', 'nadega', 'coccix', 'virilha', 'ombro', 'cotovelo', 'punho', 'mao', 'antebraco', 'dedo', 'cabeca', 'peito', 'barriga',
  'abdomen', 'costela', 'vertebra', 'hernia', 'disco', 'protrusao', 'abaulamento', 'escoliose', 'artrose', 'tendao', 'musculo', 'articulacao',
  'trapezio', 'escapula', 'omoplata', 'cintura', 'tronco', 'pe',
]);
/**
 * Palavras de corpo/lado que também aparecem em nome de cidade ("Braço do Norte", "Alta Floresta", "Dores do Indaiá", "Baixa Grande"):
 * só contam quando o valor INTEIRO é feito de corpo/lado/ligação ("Lado direito", "dores nas costas"), nunca como sinal isolado.
 */
const CORPO_FRACO = new Set([
  'braco', 'lado', 'direito', 'direita', 'esquerdo', 'esquerda', 'regiao', 'dor', 'baixa', 'baixo', 'alta', 'alto', 'parte', 'meio', 'inferior',
  'superior', 'toda', 'todo', 'ambos', 'ambas', 'cima', 'embaixo', 'frente', 'tras', 'junto',
]);
/**
 * Palavras de ligação e de frase de dor ("dor na lombar que desce pra perna"). Valem SÓ para dizer que o valor inteiro é frase de dor
 * (`every`); nunca para dizer que há palavra de corpo — senão "canaã dos carajás" e "rio de janeiro", em minúscula, deixariam de ser cidade.
 */
const LIGACAO = new Set([
  'de', 'do', 'da', 'dos', 'das', 'e', 'na', 'no', 'nas', 'nos', 'a', 'o', 'as', 'os', 'que', 'doi', 'pra', 'para', 'com', 'sem', 'desce', 'sobe',
  'ate', 'mais', 'muito', 'forte', 'fraca', 'fraco', 'cronica', 'cronico', 'aguda', 'agudo', 'constante', 'intensa', 'leve', 'em', 'um', 'uma',
]);

/** "ombros" → "ombro", "pes" → "pe", "lombares" → "lombar", "dores" → "dor": o plural não esconde a parte do corpo. */
function singular(w: string): string {
  if (w.length > 3 && w.endsWith('es') && (CORPO_FORTE.has(w.slice(0, -2)) || CORPO_FRACO.has(w.slice(0, -2)))) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith('s') && (CORPO_FORTE.has(w.slice(0, -1)) || CORPO_FRACO.has(w.slice(0, -1)))) return w.slice(0, -1);
  return w;
}
const ehCorpoForte = (w: string) => CORPO_FORTE.has(singular(w));
const ehCorpoOuLigacao = (w: string) => CORPO_FORTE.has(singular(w)) || CORPO_FRACO.has(singular(w)) || LIGACAO.has(w);

/** "consegue vir": só afirmação CLARA conta. Qualquer palavra fora desta lista (não, nunca, talvez, mas, longe, que…) derruba. */
const PALAVRAS_DE_SIM = new Set(['sim', 's', 'true', '1', 'consegue', 'consigo', 'pode', 'posso', 'ok', 'claro', 'certeza', 'tranquilo', 'certo', 'positivo']);
const PALAVRAS_NEUTRAS = new Set(['com', 'isso', 'vir', 'ir', 'e', 'tambem', 'la', 'ai', 'aqui', 'da', 'para', 'pra', 'a', 'unidade', 'clinica', 'sempre', 'ate']);
function afirmaClaramente(valor: unknown): boolean {
  const palavras = String(valor ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return palavras.length > 0 && palavras.every((w) => PALAVRAS_DE_SIM.has(w) || PALAVRAS_NEUTRAS.has(w)) && palavras.some((w) => PALAVRAS_DE_SIM.has(w));
}

/**
 * Cidade de verdade, não onde dói. Recusa o valor feito SÓ de corpo/lado/ligação ("lombar", "Ombros", "Lombar (L4-L5)", "hérnia de disco",
 * "Lado direito"), a frase comprida, e o que tem palavra de corpo FORTE escrita em minúscula (a IA grava a dor em minúscula; a cidade, com
 * inicial maiúscula). Cidade com nome de corpo fraco ("Braço do Norte", "Alta Floresta", "Dores do Indaiá") passa, em maiúscula ou não.
 */
/**
 * "Não sei a cidade" escrito como valor: negação ("não informado", "sem cidade"), placeholder ("não especificada", "desconhecida", "n/a",
 * "?", "-") e lugar sem nome ("fora de Marabá", "interior…", "outra cidade"). Medido em 30 dias de fatos reais, passavam como cidade.
 */
const SEM_CIDADE =
  /^(?:nao|sem|nenhum|nenhuma|indefinid\w*|n\/?a|na)(?:\s|$|\/)|\b(?:informad[oa]s?|especificad[oa]s?|desconhecid[oa]s?|nao\s+sei)\b|^fora(?:\s|$)|^interior(?:\s|$)|^outr[oa]s?\s+(?:cidade|local|lugar|estado|regiao)|^[^a-z]*$/;
function semCidadeDeFato(v: string): boolean {
  const n = v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return SEM_CIDADE.test(n);
}

export function pareceCidade(valor: unknown): boolean {
  const v = String(valor ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .trim();
  if (v.length < 2 || v.length > 60 || !/\p{L}/u.test(v)) return false;
  if (semCidadeDeFato(v)) return false;
  const palavras = v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 || w === 'e' || w === 'a' || w === 'o');
  if (palavras.length === 0) return false;
  // frase, não cidade (os conectores não contam: "São José do Rio Preto" tem 4 palavras de nome)
  if (palavras.filter((w) => !['de', 'do', 'da', 'dos', 'das', 'e'].includes(w)).length >= 6) return false;
  if (palavras.every(ehCorpoOuLigacao)) return false;
  if (palavras.some(ehCorpoForte) && /^\p{Ll}/u.test(v)) return false;
  return true;
}

/**
 * Os fatos passam por `canonizarFatos` ANTES de olhar a cidade: um cartão antigo com `localizacao: 'Imperatriz'` (o apelido que a
 * escrita troca por `cidade`) continua valendo; `localizacao: 'lombar'` continua não valendo (`pareceCidade`).
 */
export function cidadeConhecida(fatos: Fatos): boolean {
  const f = canonizarFatos(fatos);
  if (CHAVES_CIDADE.some((k) => pareceCidade(f[k]))) return true;
  return CHAVES_VEM_A_UNIDADE.some((k) => afirmaClaramente(f[k]));
}

const CHECKLIST: Item[] = [
  { rotulo: 'nome', chaves: ['nome'], comoPedir: 'pergunte como pode chamá-lo' },
  {
    rotulo: 'queixa',
    chaves: ['queixa', 'queixa_principal', 'dor', 'localizacao_dor', 'localizacao'],
    comoPedir: 'pergunte onde dói',
  },
  { rotulo: 'tempo de dor', chaves: ['tempo_dor', 'tempo_de_dor'], comoPedir: 'pergunte há quanto tempo' },
  {
    rotulo: 'cidade',
    chaves: [...CHAVES_CIDADE, ...CHAVES_VEM_A_UNIDADE],
    comoPedir: 'pergunte em qual cidade ele mora, antes de oferecer qualquer horário',
    confere: cidadeConhecida,
  },
  {
    rotulo: 'horário escolhido',
    chaves: ['preferencia_horario', 'horario_preferido', 'horario_escolhido'],
    comoPedir: 'consulte a agenda e ofereça 2 ou 3 horários',
  },
];

const CHAVES_AGENDOU = ['agendou', 'consulta_marcada', 'consulta_agendada'];

function temAlgum(fatos: Fatos, chaves: string[]): boolean {
  return chaves.some((k) => {
    const v = fatos[k];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
}

function jaAgendou(fatos: Fatos): boolean {
  return CHAVES_AGENDOU.some((k) => /sim|true|1/i.test(String(fatos[k] ?? '')));
}

/**
 * Monta o bloco. Devolve string vazia quando não há nada a cobrar — prompt que
 * repete o óbvio a cada turno vira ruído e o modelo passa a ignorar o bloco.
 */
export function renderFaltaParaAgendar(
  fatos: Fatos | null | undefined,
  opcoes: {
    semPedirNome?: boolean;
    /** Chave `sem-pergunta-de-alerta` (conversa-direta.ts): a lista não manda perguntar força/xixi/intestino. */
    semPerguntaDeAlerta?: boolean;
    /** Chave `nome-na-hora-de-marcar`: o nome sai da lista e é pedido junto da escolha do horário. */
    nomeNaHoraDeMarcar?: boolean;
    /** Chave `conduzir-direto`: a queixa basta — "há quanto tempo" sai da lista. */
    conduzirDireto?: boolean;
    /** Rótulos que o paciente já respondeu NA CONVERSA mesmo sem o fato gravado (pergunta-respondida.ts): saem da lista. */
    jaRespondidos?: readonly string[];
  } = {},
): string {
  const f = fatos ?? {};
  if (Object.keys(f).length === 0) return '';
  if (jaAgendou(f)) return '';

  // Já pediu o nome 2 vezes (repeticao.ts): a lista não pode continuar mandando "pergunte como pode chamá-lo" a
  // cada turno — era isso que fazia a Sofia pedir o nome 3, 4, 5 vezes a quem ignorava a pergunta.
  // Nome na hora de marcar, a não ser que ele já tenha sido pedido 2 vezes sem resposta (semPedirNome, repeticao.ts): aí não
  // se pede mais, nem junto do horário.
  const pedirNomeNoHorario = Boolean(opcoes.nomeNaHoraDeMarcar && !opcoes.semPedirNome && !temAlgum(f, ['nome']));
  const faltando = CHECKLIST.filter((i) => !(i.confere ? i.confere(f) : temAlgum(f, i.chaves)))
    .filter((i) => !opcoes.jaRespondidos?.includes(i.rotulo))
    .filter((i) => !((opcoes.semPedirNome || opcoes.nomeNaHoraDeMarcar) && i.rotulo === 'nome'))
    .filter((i) => !(opcoes.conduzirDireto && i.rotulo === 'tempo de dor'))
    .map((i) =>
      // Nome na hora de marcar (Timbó, 11/11/2026): o pedido do nome vai junto do horário — o cadastro precisa dele.
      pedirNomeNoHorario && i.rotulo === 'horário escolhido'
        ? { ...i, comoPedir: `${i.comoPedir}; quando ele escolher, peça o nome completo para deixar reservado` }
        : i,
    );

  // Sinal neurológico sem resposta registrada é o item mais urgente da lista:
  // é ele que separa "caso comum" de "emergência", e foi exatamente o que se
  // perdeu quando a paciente respondeu outra coisa e a IA seguiu em frente.
  const textoQueixa = CHECKLIST[1].chaves.map((k) => String(f[k] ?? '')).join(' ');
  const precisaTriagem =
    !opcoes.semPerguntaDeAlerta &&
    (SINAL_NEUROLOGICO.test(textoQueixa) || FORMIGAMENTO_PERIGOSO.test(textoQueixa)) && !temAlgum(f, CHAVES_RED_FLAG);

  // Não há saída antecipada aqui de propósito: "já tem tudo e ainda não marcou"
  // é justamente a hora de empurrar o fechamento, não de calar. Quem já agendou
  // saiu lá em cima.
  const linhas: string[] = [];
  if (precisaTriagem) {
    linhas.push(
      // 10/11/2026: antes dizia "se ele responder outra coisa, repita a pergunta — não siga sem ela", o contrário da
      // regra <sinal_de_alerta> (26/10: "nunca repita a pergunta de segurança uma segunda vez — quem não respondeu
      // direito vai para a equipe"). Nos testes da Sofia 2.0 ela perguntava a mesma coisa 3 vezes e travava a venda.
      '- **ANTES DE QUALQUER COISA:** ele relatou dormência ou fraqueza e você ainda NÃO tem a ' +
        'resposta sobre perda de força / controle de xixi e intestino. Se você AINDA NÃO perguntou: pergunte ' +
        'UMA coisa por vez (primeiro a força, depois o xixi e o intestino) e **espere a resposta**. Um "sim" ' +
        'solto a uma pergunta com as duas coisas não confirma nada: pergunte qual. Se você JÁ perguntou e ele ' +
        'respondeu outra coisa, NÃO repita a pergunta: siga a regra <sinal_de_alerta> — quem não respondeu à ' +
        'pergunta de segurança vai para a equipe (resumir_lead_para_sdr e pausar_ia com sinalDeAlerta: true).',
    );
  }
  if (faltando.length > 0) {
    linhas.push('- Ainda falta, nesta ordem: ' + faltando.map((i) => i.rotulo).join(' → ') + '.');
    linhas.push(`- Próximo passo: ${faltando[0].comoPedir}. Uma pergunta por mensagem.`);
  } else if (pedirNomeNoHorario) {
    linhas.push('- Você já tem tudo para marcar, menos o nome: feche o horário e peça o nome completo para deixar reservado.');
  } else {
    linhas.push('- Você já tem tudo para marcar. Ofereça o horário e feche a reserva.');
  }

  return `<falta_para_agendar>\n(o que impede esta conversa de virar consulta)\n${linhas.join('\n')}\n</falta_para_agendar>`;
}
