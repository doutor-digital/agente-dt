/**
 * "Prometeu e não marcou": a IA diz ao paciente que a consulta ESTÁ marcada (reservada, confirmada,
 * "te espero sexta às 9h") sem ter marcado nada na agenda da franquia.
 *
 * Casos reais que motivaram (05/10/2026, Açailândia):
 *  - resgate, lead 10824318: "Quinta, 08/10, às 8h30 fica reservado pro seu nome 😊" — nenhuma
 *    chamada a consultar_horarios/agendar_consulta; o horário nem existia mais quando a comercial olhou.
 *  - resgate, lead 27957957 (Giovanni): "Deixo reservado pra sexta, 09/10" — foi para EM ESPERA sem
 *    consulta nenhuma. O paciente acha que está marcado; a clínica não sabe que ele vem.
 *  - resgate, lead 27774111 (Sergio): "Sua consulta está reservada pra quarta-feira, 07/10, às 10h" —
 *    a equipe marcou à mão às 11h, e só descobriu porque leu a conversa.
 *
 * Este arquivo é PURO (sem banco, sem Kommo): o detector de frases e a decisão de avisar. Quem lê o
 * banco e escreve no Kommo é `prometeu-sem-marcar-worker.ts`.
 *
 * COMO O DETECTOR PENSA
 * ---------------------
 * A Sofia fala "reservado" o tempo todo, e quase sempre é oferta ou condição: "o Pix já garante seu
 * horário reservado", "quer que eu deixe reservado?", "assim que decidir, já deixo reservado". Em
 * 30 dias de produção (set–out/2026) "reservad" apareceu 1.490 vezes nas falas da IA — a imensa maioria,
 * conversa normal. Então:
 *
 *  1. Quebra a mensagem em trechos (frase, e também o travessão " — ", que a Sofia usa para emendar
 *     a afirmação numa pergunta: "Deixo reservado pra sexta, 09/10 — só me confirma: manhã ou tarde?").
 *  2. Um trecho AFIRMA quando tem um verbo de fato consumado ("está marcada", "fica reservado",
 *     "deixo reservado", "marquei", "te espero") E fala de consulta: tem dia/hora (no próprio trecho ou
 *     no seguinte, para o modelo "✅ Agendamento confirmado! ⭐ Data: …") ou nomeia a consulta/horário.
 *  3. E NÃO é pergunta, oferta, condição, negação nem passado: "quer que eu…", "posso…", "tenho às 9h
 *     ou às 10h", "se quiser…", "assim que o Pix cair…", "não encontrei consulta marcada", "você
 *     tinha uma consulta marcada…".
 *
 * Errar para o lado de NÃO avisar é de propósito: alarme que grita à toa vira ruído e ninguém olha.
 * Parte do que escapa daqui o vigia de agendamento perdido pega (a IA consultou horário e não marcou).
 *
 * Medido em 30 dias de mensagens reais (39.972 falas da IA): 642 afirmações; 369 com o agendar_consulta
 * no rastro (verdadeiras); 273 sem — 204 alertas depois do "um por cartão a cada 24 h". Numa amostra
 * de 13 desses conferida no Kommo, 7 não tinham consulta nenhuma e 6 tinham (marcada pela recepção, ou
 * paciente em tratamento) — é o que as checagens do cartão e da franquia no worker removem.
 */

/** Minúsculas, sem acento, sem negrito do WhatsApp e com espaço simples — o detector só vê isto. */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trechos na ordem: fim de frase, quebra de linha e travessão separam. Cada trecho mantém o texto original. */
export function trechos(texto: string): string[] {
  return (
    texto
      // fim de frase, linha nova, travessão; emoji seguido de maiúscula ("…às 9h 😊 Você consegue vir?") é frase
      // nova sem ponto; ", e quando…"/", se…" emenda uma condição numa afirmação que já estava completa.
      .split(
        /(?<=[.!?…])\s+|\n+|\s+[—–]\s+|\s+-\s+|(?<=\p{Extended_Pictographic}\uFE0F?)\s+(?=\p{Lu})|,\s+(?=e\s|(?:quando|se|assim que|caso)\b)/u,
      )
      .map((t) => t?.trim() ?? '')
      // só emoji ("🎉 ⭐") não é trecho: atrapalharia olhar o vizinho ("Remarcado! 🎉 ⭐ Data: terça, 22/09")
      .filter((t) => /[\p{L}\p{N}]/u.test(t))
  );
}

/** Dia ou hora concretos: "sexta", "09/10", "dia 13", "amanhã", "às 9h", "14:30". */
const TEM_QUANDO =
  /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?\b|\b\d{1,2}\/\d{1,2}\b|\bdia \d{1,2}\b|\b(amanha|hoje)\b|\b\d{1,2}(:\d{2}|h\d{0,2})\b|\bas \d{1,2}\b/;

/**
 * O sujeito é UMA consulta definida — "sua consulta", "esse horário", "no seu nome" — e não o pagamento,
 * o exame, a hérnia "já confirmada", nem o vago "fico com um horário reservado pra você" do follow-up.
 * "A vaga"/"o horário" sem dono ficam de fora: é como a IA explica o preço ("não precisa pagar antes — a
 * vaga fica reservada e você paga no dia").
 */
const FALA_DA_CONSULTA =
  /\b(?:sua|seu|esse|essa|este|nossa|nosso)\s+(?:\S+\s+)?(?:consulta|consultinha|avaliacao|agendamento|horario|vaga|reserva|presenca|retorno)\b|\b(?:a|o)\s+(?:consulta|consultinha|avaliacao|agendamento|reserva|presenca)\b|\b(?:no|pro|para o|pra o|em) (?:seu|teu) nome\b/;

const PARTICIPIO = '(?:marcad|agendad|reservad|confirmad|garantid|remarcad)(?:inh)?[oa]s?';

/**
 * Verbos de fato consumado. Cada um sozinho não basta — ver `afirma`. `sujeito: 'antes'` = a consulta tem
 * de ser nomeada ANTES do verbo ("sua vaga está garantida"), senão "sua hérnia está confirmada por exame,
 * vale marcar sua consulta" viraria promessa.
 */
const AFIRMACOES: ReadonlyArray<{ nome: string; re: RegExp; sujeito: 'antes' | 'qualquer' }> = [
  // "está marcada", "fica reservado", "ficou confirmadinho", "continua marcada", "segue reservado"
  {
    nome: 'estado',
    re: new RegExp(
      `\\b(?:esta|estao|ta|fica|ficam|ficou|ficaram|ficara|foi|foram|continua|continuam|segue|seguem|permanece)\\s+(?:\\S+\\s+){0,5}?${PARTICIPIO}\\b`,
      'g',
    ),
    sujeito: 'antes',
  },
  // "deixo reservado pra sexta", "vou deixar reservado o horário das 10h", "fico com esse horário reservado"
  {
    nome: 'deixar',
    re: new RegExp(`\\b(?:deixei|deixo|vou (?:ja )?deixar|ja vou deixar|fico com)\\s+(?:\\S+\\s+){0,8}?${PARTICIPIO}\\b`, 'g'),
    sujeito: 'qualquer',
  },
  // "marquei sua consulta", "já reservei sexta às 9h"
  // ("confirmei" fica de fora: é "confirmei aqui na agenda e o único horário livre é às 11h")
  { nome: 'primeira-pessoa', re: /\b(?:marquei|agendei|reservei|remarquei)\b/g, sujeito: 'qualquer' },
  // "✅ Agendamento confirmado", "sua consulta já está certinha marcada", "Presença confirmada"
  {
    nome: 'consulta-marcada',
    re: new RegExp(`\\b(?:consulta|avaliacao|agendamento|horario|vaga|reserva|presenca)\\s+(?:\\S+\\s+){0,2}?${PARTICIPIO}\\b`, 'g'),
    sujeito: 'qualquer',
  },
  // "remarcado com sucesso"
  { nome: 'remarcado', re: /\bremarcad[oa] com sucesso\b/g, sujeito: 'qualquer' },
  // "te espero sexta às 9h", "te esperamos amanhã", "nos vemos segunda às 14h"
  { nome: 'te-espero', re: /\b(?:te|lhe) (?:espero|esperamos|aguardo|aguardamos)\b|\bnos vemos\b/g, sujeito: 'qualquer' },
  // "sua consulta é hoje, às 8h", "sua avaliação fica pra quinta"
  {
    nome: 'sua-consulta-e',
    re: /\b(?:sua|seu|a sua|o seu)\s+(?:consulta|avaliacao|agendamento|horario|retorno)\b(?:\s+\S+){0,3}?\s+(?:e|sera|vai ser|fica|ficou|esta|ta|continua|segue)\s+(?:\S+\s+){0,2}?(?:para|pra|no dia|dia|na|no|amanha|hoje|as)\b/g,
    sujeito: 'qualquer',
  },
];

/** Afirmações que só valem com dia/hora NO MESMO trecho ("te espero por aqui" não é consulta). */
const SO_COM_QUANDO_NO_TRECHO = new Set(['te-espero', 'sua-consulta-e', 'primeira-pessoa']);

/** Pergunta: termina em "?" depois de tirar a muleta final (", combinado?", ", tá?", ", beleza?"). */
function ehPergunta(n: string): boolean {
  const semMuleta = n
    .replace(/[^\p{L}\p{N}?]+$/u, '')
    .replace(/[,\s]+(combinado|beleza|blz|ok|certo|certinho|ta bom|ta|tudo bem|tudo certo|pode ser|fechado|ne|viu|entao|combinado assim)\s*\?+$/, '');
  return /\?\s*$/.test(semMuleta);
}

/** Oferta ou pergunta disfarçada: a IA está propondo, não afirmando ("tenho às 9h ou às 10h", "os horários de quinta"). */
const OFERTA =
  /\b(quer que|quer|posso|podemos|pode ser|consigo|consegue|prefere|preferencia|qual|quais|que tal|gostaria|deseja|tenho|temos|disponive(l|is)|livres?|opcao|opcoes|alguma dessas?|horarios|vagas)\b|\bou (?:na |no |a |as |pra |para )?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|\d{1,2}(?:h|:\d{2}|\/\d{1,2}))/;

/**
 * Condição: só vale se algo acontecer — "se quiser", "assim que o Pix cair", "quando puder", "é só me
 * falar que já deixo", "garantindo com o Pix… a vaga fica reservada", "aí o horário já fica garantido".
 */
const CONDICAO = new RegExp(
  [
    String.raw`\bse (?:voce|vc|ele|ela|o|a|os|as|der|for|\w+r(?:em)?)\b|\bsenao\b`,
    String.raw`\b(?:assim que|logo que|depois que|caso|quando)\b`,
    String.raw`\bapos (?:o|a) (?:pix|pagamento|comprovante|confirmacao)\b`,
    String.raw`\be so (?:me )?(?:falar|avisar|confirmar|mandar|dizer|chamar|responder)\b`,
    String.raw`\bme (?:chama|chame|avisa|avise|fala|diga|diz|manda|mande|confirma|confirme|passa|passe|envia|envie)\b`,
    String.raw`\b(?:pra|para) (?:eu|garantir|deixar|fechar|confirmar|marcar|agendar|fecharmos|combinarmos|conversarmos|retomarmos|decidirmos|marcarmos|agendarmos)\b`,
    String.raw`\b(?:puder|quiser|souber|preferir|decidir|puderem|quiserem|souberem|decidirem)\b`,
    String.raw`\b(?:garante|garantir|garantindo|pagando|antecipando)\b|\bem conta\b`,
    String.raw`\bcom o (?:pagamento|adiantamento|antecipado|pix|comprovante)\b|\bso (?:fica|e|esta|com)\b`,
    String.raw`\bassim (?:ja |eu )?(?:deixo|consigo|garanto|reservo|fica)\b|\bassim (?:voce|vc|voces|a gente)\b`,
    String.raw`\b(?:e )?ai (?:o|a|os|as|seu|sua|ja|voce|vc|fica|e so)\b`,
  ].join('|'),
);

/**
 * Negação, dúvida ou passado ANTES da afirmação: "não encontrei consulta marcada", "preciso achar seu
 * horário marcado", "você tinha uma consulta marcada pra 10/09", "sem a reserva garantida".
 */
const NEGA_OU_PASSADO =
  /\b(?:nao|nunca|nenhum|nenhuma|tinha|tinham|estava|estavam|havia|teve|desmarcad\w*|cancelad\w*|achar|encontrar|localizar|verificar|conferir|checar)\b|\bsem (?:a |o )?(?:reserva|vaga|horario|consulta)\b/;

/**
 * Não é promessa: narração interna que vazou ("Movi a Patrícia para EM ESPERA com retomada agendada"), o
 * aviso de sinal grave ("procure um pronto-socorro, não pode esperar consulta agendada") e a explicação
 * de como a agenda funciona ("as consultas são marcadas de 30 em 30 min, cada horário é reservado só pra você"),
 * a sessão de tratamento (quem marca é a clínica, nunca a IA — e o paciente já é da casa) e o "reservada,
 * porém ainda não confirmada", que avisa em vez de prometer.
 */
const NAO_E_PROMESSA = new RegExp(
  [
    String.raw`\b(?:movi|retomada|em espera|follow|esperar|pronto[- ]atendimento|pronto[- ]socorro|upa|hospital|emergencia|cada|consultas|sessao|sessoes|tratamento)\b`,
    String.raw`\bainda nao\b`,
    // "atendemos somente com horário marcado" é como a clínica funciona, não uma consulta
    String.raw`\bcom (?:hora|horario) (?:marcad|agendad)\w*|\bhora marcada\b`,
    // "o valor fica garantido até sexta", "a agenda de sexta está toda marcada", "agenda lotada"
    String.raw`\bgarantid\w* (?:so )?ate\b|\btoda (?:marcad|reservad|agendad)\w*|\blotad\w*`,
  ].join('|'),
);

/**
 * Sujeito que não é consulta logo antes do verbo: "seu Pix foi confirmado", "a hérnia foi confirmada na
 * ressonância de 12/09", "o desconto está garantido". Sem isto, qualquer data no trecho ou no vizinho
 * transformava esses em promessa.
 */
const SUJEITO_ALHEIO =
  /\b(?:hernia|hernias|exame|exames|ressonancia|laudo|diagnostico|valor|preco|desconto|pix|pagamento|comprovante|agenda|condicao|promocao|beneficio|taxa|cadastro|dados)\b/;

/** Reserva de "um horário" qualquer, sem dizer qual. */
const UM_HORARIO_QUALQUER = new RegExp(
  `\\b(?:um|uma) (?:\\S+ )?(?:horario|horariozinho|vaga|espaco|espacinho)\\s+(?:\\S+\\s+){0,3}?${PARTICIPIO}`,
);

/** Onde começa a oração do verbo: vírgula, ponto e vírgula e dois-pontos separam. */
function inicioDaOracao(n: string, pos: number): number {
  const antes = n.slice(0, pos);
  return Math.max(antes.lastIndexOf(','), antes.lastIndexOf(';'), antes.lastIndexOf(':')) + 1;
}

/**
 * Cortesia no fim da frase ("…, qualquer dúvida me chama", "fico à disposição") não é condição da
 * consulta — sai antes de procurar condição.
 */
const CORTESIA =
  /\b(?:qualquer (?:duvida|coisa|problema|imprevisto)|se precisar(?: de)? (?:algo|alguma coisa|mais alguma coisa|remarcar)|(?:estou|fico) (?:a disposicao|por aqui))\b[^.!?,;]*/g;

/** "Te espero dia 23 pra sua resposta" espera a resposta, não o paciente na clínica. */
const ESPERA_RESPOSTA = /\b(?:resposta|retorno|decisao|comprovante|contato)\b/;

export interface Promessa {
  /** O trecho original (sem normalizar) em que a IA afirma — vai no alerta. */
  trecho: string;
  /** Qual forma pegou — para medir e calibrar. */
  forma: string;
  /** O dia/hora citados, normalizados ("sexta 09/10 7h"), ou null quando ela não disse. */
  quando: string | null;
}

/** Dia e hora citados no trecho, compactos, para o texto do alerta e a tela. */
export function quandoCitado(texto: string): string | null {
  const n = normalizar(texto);
  const partes: string[] = [];
  const dia = n.match(/\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/);
  if (dia) partes.push(dia[1]);
  const rel = n.match(/\b(amanha|hoje)\b/);
  if (rel && !dia) partes.push(rel[1]);
  const data = n.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (data) partes.push(`${data[1].padStart(2, '0')}/${data[2].padStart(2, '0')}`);
  const hora = n.match(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\b/) ?? n.match(/\bas (\d{1,2})\b/);
  if (hora) {
    const min = hora[2] ?? hora[3];
    partes.push(min && min !== '00' ? `${Number(hora[1])}h${min}` : `${Number(hora[1])}h`);
  }
  return partes.length ? partes.join(' ') : null;
}

/**
 * O trecho afirma consulta marcada? Devolve a forma que casou, ou null.
 *
 * Cada filtro olha só o pedaço que importa (achado da revisão de 07/10): a negação, a oração do verbo
 * ("Não se preocupe, sua consulta está marcada pra sexta" afirma); a condição, o trecho todo menos a
 * cortesia do fim ("Fico com o horário, é só me chamar quando quiser" não afirma; "…marcada pra sexta,
 * qualquer dúvida me chama" afirma); a oferta, da oração do verbo em diante ("Tenho uma ótima notícia:
 * sua consulta está marcada" afirma, "deixo reservado amanhã: posso às 7h30 ou às 16h30" não).
 */
export function afirma(trecho: string, seguinte: string | null): string | null {
  const n = normalizar(trecho);
  if (!n || ehPergunta(n) || NAO_E_PROMESSA.test(n)) return null;

  const quandoAqui = TEM_QUANDO.test(n);
  const semCortesia = n.replace(CORTESIA, ' ');
  // "fico com UM horário reservadinho pra sua avaliação" sem dia nenhum é o tique do follow-up, não uma
  // consulta: o paciente não sai dali achando que tem hora marcada.
  if (!quandoAqui && UM_HORARIO_QUALQUER.test(n)) return null;
  // O dia/hora do trecho seguinte só vale se ele também não for pergunta nem oferta ("já deixei um horário
  // reservado pra você — tenho terça às 10h ou quinta às 15h" é oferta). É o que pega o modelo
  // "✅ Agendamento confirmado! ⭐ Data: sexta, 09/10".
  const vizinho = seguinte === null ? '' : normalizar(seguinte);
  const quandoAoLado = vizinho !== '' && TEM_QUANDO.test(vizinho) && !ehPergunta(vizinho) && !OFERTA.test(vizinho);

  for (const { nome, re, sujeito } of AFIRMACOES) {
    let fimAnterior = 0;
    for (const m of n.matchAll(re)) {
      const inicio = m.index ?? 0;
      const ate = inicio + m[0].length;
      const oracao = inicioDaOracao(n, inicio);
      const antesDoVerbo = n.slice(Math.max(oracao, fimAnterior), inicio);
      fimAnterior = ate;
      if (NEGA_OU_PASSADO.test(n.slice(oracao, ate))) continue;
      if (CONDICAO.test(semCortesia)) continue;
      if (OFERTA.test(n.slice(oracao))) continue;
      if ((nome === 'estado' || nome === 'deixar') && SUJEITO_ALHEIO.test(`${antesDoVerbo} ${m[0]}`)) continue;
      if (SO_COM_QUANDO_NO_TRECHO.has(nome)) {
        if (!quandoAqui) continue;
        if (nome === 'te-espero' && ESPERA_RESPOSTA.test(n)) continue;
        return nome;
      }
      const comSujeito = FALA_DA_CONSULTA.test(sujeito === 'antes' ? n.slice(0, ate) : n);
      if (quandoAqui || quandoAoLado || comSujeito) return nome;
    }
  }
  return null;
}

/** A primeira afirmação de consulta marcada na mensagem, ou null. */
export function detectarPromessa(texto: string | null | undefined): Promessa | null {
  if (!texto) return null;
  const ts = trechos(texto);
  for (let i = 0; i < ts.length; i++) {
    const seguinte = ts[i + 1] ?? null;
    const forma = afirma(ts[i], seguinte);
    if (!forma) continue;
    const quandoAqui = quandoCitado(ts[i]);
    const comVizinho = quandoAqui ?? (seguinte ? quandoCitado(seguinte) : null);
    return { trecho: ts[i], forma, quando: comVizinho };
  }
  return null;
}

/**
 * Mensagens que não são da IA conversando — não entram:
 *  - `kommo_talks`/`backfill-kommo`: texto da equipe copiado do chat oficial do Kommo;
 *  - `confirmacao_*`: a confirmação de véspera só sai para consulta que existe;
 *  - `chat_cartao`: o cartão de chegada só sai depois de marcar;
 *  - `lead_note`: virou nota interna, o paciente nunca leu.
 */
export function mensagemDaIA(meta: unknown): boolean {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const origem = typeof m.origem === 'string' ? m.origem : '';
  const via = typeof m.via === 'string' ? m.via : '';
  if (origem === 'kommo_talks' || origem === 'backfill-kommo' || origem.startsWith('confirmacao')) return false;
  if (m.autor === 'equipe') return false;
  if (via === 'chat_cartao' || via === 'lead_note') return false;
  return true;
}

/**
 * A consulta que um passo de sucesso do rastro marcou, em hora local da clínica ("2026-10-09T07:00").
 * Lê os dois títulos de sucesso — o da IA ("Consulta marcada: 2026-10-09 07:00 (idSchedule 1)") e o do
 * widget da recepção ("Consulta marcada na franquia: …"). Qualquer outro título (recusado, falhou) é null.
 */
export function consultaDoRastro(titulo: string): string | null {
  const m = /^Consulta marcada(?: na franquia)?: (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(titulo);
  return m ? `${m[1]}T${m[2]}` : null;
}

/**
 * Alguma das consultas (hora local "AAAA-MM-DDTHH:mm") é de `desdeLocal` em diante? Comparação de texto,
 * sem fuso — os dois lados já estão na hora da clínica. Consulta anterior é de outro ciclo (o paciente
 * faltou e voltou) e não cala o alerta.
 */
export function algumaDesde(quandos: ReadonlyArray<string | null | undefined>, desdeLocal: string): boolean {
  const desde = desdeLocal.slice(0, 16);
  return quandos.some((q) => typeof q === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(q) && q.slice(0, 16) >= desde);
}

/**
 * Consultas que o rastro marcou e que o próprio rastro não desmarcou depois, em hora local. Cancelar
 * ("cancelar_consulta 123: cancelada") e remarcar trocando ("remarcar: trocada (antiga 123)") tiram a
 * consulta da conta — senão uma sexta cancelada calava o alerta da promessa de segunda.
 */
export function consultasVivasDoRastro(titulos: ReadonlyArray<string>): string[] {
  const canceladas = new Set<string>();
  for (const t of titulos) {
    const c = /^cancelar_consulta (\d+): cancelada\b/.exec(t) ?? /^remarcar: trocada \(antiga (\d+)\)/.exec(t);
    if (c) canceladas.add(c[1]);
  }
  const vivas: string[] = [];
  for (const t of titulos) {
    const quando = consultaDoRastro(t);
    if (!quando) continue;
    const id = /\(idSchedule (\d+)\)/.exec(t)?.[1];
    if (id && canceladas.has(id)) continue;
    vivas.push(quando);
  }
  return vivas;
}

/**
 * Palavras que toda afirmação tem — o filtro barato no banco (ILIKE, sem tirar acento) antes do detector.
 * Se uma forma nova entrar em `AFIRMACOES`, a palavra dela entra aqui (o teste confere com as frases reais).
 */
export const PALAVRAS_DO_FILTRO: readonly string[] = [
  'marcad', 'agendad', 'reservad', 'confirmad', 'garantid',
  'marquei', 'agendei', 'reservei', 'remarquei', 'confirmei',
  'te espero', 'te esperamos', 'te aguardo', 'te aguardamos',
  'lhe espero', 'lhe esperamos', 'lhe aguardo', 'lhe aguardamos', 'nos vemos',
  'sua consulta', 'sua avalia', 'seu agendamento', 'seu horário', 'seu horario', 'seu retorno',
];

/** O que se sabe da agenda deste lead, de cada fonte. `null` = não deu para saber. */
export interface Evidencias {
  /** `agendar_consulta`/`remarcar` deu certo para este lead (rastro), em qualquer unidade da mesma conta. */
  marcouNoRastro: boolean;
  /** `spine_lead_links.agendado_para` é a consulta atual da Sofia e ainda não passou. */
  vinculoFuturo: boolean;
  /** ◷ Data da Consulta do cartão é de agora em diante (recepção, SDR ou sincronizador). */
  cartaoComConsulta: boolean | null;
  /**
   * A franquia tem consulta por vir para o paciente. `null` = não deu para saber: unidade sem franquia,
   * paciente não achado pelo telefone, ou a franquia não respondeu.
   */
  franquiaComConsulta: boolean | null;
}

export type Decisao =
  | { avisar: true; motivo: string }
  /** `adiar`: faltou ler uma fonte (o cartão) — nem avisa nem dá por conferido; a próxima varredura tenta. */
  | { avisar: false; motivo: string; adiar?: true };

/**
 * Avisa só quando NENHUMA fonte mostra consulta. Cartão ilegível (`null`) não vira alerta: sem ler o
 * cartão não dá pra saber se a recepção marcou, e quem decide isso é a próxima varredura.
 */
export function decidir(e: Evidencias): Decisao {
  if (e.marcouNoRastro) return { avisar: false, motivo: 'a IA marcou (rastro do agendar_consulta)' };
  if (e.vinculoFuturo) return { avisar: false, motivo: 'consulta da Sofia no vínculo com a franquia' };
  if (e.cartaoComConsulta === true) return { avisar: false, motivo: 'cartão tem ◷ Data da Consulta' };
  if (e.franquiaComConsulta === true) return { avisar: false, motivo: 'a franquia tem consulta marcada pelo telefone' };
  if (e.cartaoComConsulta === null) return { avisar: false, adiar: true, motivo: 'não consegui ler o cartão — fica pra próxima' };
  return {
    avisar: true,
    motivo:
      e.franquiaComConsulta === null
        ? 'sem consulta no rastro, no vínculo e no cartão (na franquia: paciente não achado pelo telefone, ou sem franquia)'
        : 'sem consulta no rastro, no vínculo, no cartão e na franquia',
  };
}

/** Um alerta por cartão nesse intervalo — a SDR já foi avisada daquele paciente. */
export const UM_POR_LEAD_MS = 24 * 60 * 60_000;

export type Passo =
  /** abre a tarefa ALERTA */
  | 'alertar'
  /** só no papel: registra "alertaria" na tela */
  | 'alertaria'
  /** a consulta existe: nada a fazer (no papel, registra "confere") */
  | 'confere'
  /** faltou ler uma fonte: tenta na próxima varredura */
  | 'adiar'
  /** este cartão já ganhou alerta nas últimas 24 h */
  | 'ja-avisado';

/**
 * O que fazer com uma promessa, dado o que as fontes disseram e o último alerta deste cartão. Puro: o
 * worker lê banco e Kommo, esta função decide. A ordem importa — conferir a agenda vem antes do
 * dedupe, para que a tela "só no papel" mostre todas as promessas sem consulta, e o dedupe só segura
 * a TAREFA repetida.
 */
export function proximoPasso(a: {
  estado: 'ligado' | 'seco';
  decisao: Decisao;
  ultimoAvisoEm: Date | null;
  agora: Date;
}): Passo {
  if (!a.decisao.avisar) return a.decisao.adiar ? 'adiar' : 'confere';
  if (a.estado === 'seco') return 'alertaria';
  if (a.ultimoAvisoEm && a.agora.getTime() - a.ultimoAvisoEm.getTime() < UM_POR_LEAD_MS) return 'ja-avisado';
  return 'alertar';
}

/**
 * Mensagens já resolvidas (alertou, conferiu ou não era promessa), para a varredura de 2 em 2 min não
 * reler o cartão de novo a cada passada. Esquece sozinha depois do prazo — a mensagem já saiu da janela.
 */
export class Lembranca {
  private readonly ate = new Map<string, number>();
  lembrar(id: string, porMs: number, agora = Date.now()): void {
    this.ate.set(id, agora + porMs);
  }
  sabe(id: string, agora = Date.now()): boolean {
    const t = this.ate.get(id);
    return t !== undefined && t > agora;
  }
  esquecerVencidas(agora = Date.now()): void {
    for (const [k, t] of this.ate) if (t <= agora) this.ate.delete(k);
  }
  get tamanho(): number {
    return this.ate.size;
  }
}

/** Corta o trecho para caber na tarefa sem perder o começo, que é onde está o "fica reservado". */
export function cortar(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const MARCA = 'ALERTA · prometeu e não marcou';

/** O texto da tarefa. `ALERTA · <slug> · [Contato: nome] …` é o formato que o roteador de alertas lê. */
export function textoDoAlerta(a: { slug: string; nome: string | null; trecho: string; quando: string | null }): string {
  const contato = a.nome?.trim() ? `[Contato: ${a.nome.trim()}] ` : '';
  const para = a.quando ? ` (${a.quando})` : '';
  return (
    `ALERTA · ${a.slug} · ${contato}⚠️ A IA disse ao paciente que a consulta está marcada${para}: ` +
    `"${cortar(a.trecho)}". A consulta NÃO está na agenda — ligue ou mande mensagem e marque.`
  );
}
