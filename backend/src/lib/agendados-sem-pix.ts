/**
 * «Agendados sem Pix»: a lista da manhã da recepção, depois da sincronização do banco.
 *
 * A clínica cobra antecipado (sinal ou consulta) por Pix. Quem foi marcado e NÃO tem Pix no banco precisa de um toque da secretária ANTES do dia da consulta.
 * Esta lista cruza a agenda da franquia (quem foi marcado desde o dia útil anterior: avaliação ou consulta, ainda AGENDADO ou CONFIRMADO, consulta que ainda não
 * aconteceu) com o que entrou no banco pela Pluggy (Open Finance, só leitura) e manda no grupo da recepção: primeiro nome, dia e hora da consulta e o que achei. NUNCA vai
 * CPF, sobrenome, valor nem saldo (o número do documento do pagador nem é lido).
 *
 * COMO CASA (`pix-casamento.ts`): NOME (primeiro + último, sem acento) + VALOR (um dos valores da unidade: sinal e consulta) + DATA (Pix de até 7 dias antes da marcação
 * até hoje). A venda de maquininha chega agregada e sem nome: não entra. Pix de empresa (PJ) não é de paciente.
 *
 * «NÃO ACHEI PIX» É O ÚLTIMO RECURSO. Só sai quando nada impede de afirmar. Vai para «A CONFERIR», nunca para «não achei»: nome parecido, valor diferente, data fora, o mesmo
 * Pix servindo a duas pessoas, HOMÔNIMO (outro paciente com o mesmo primeiro e último nome), Pix de valor de consulta em OUTRO nome (parente pagando), agenda sem sobrenome, banco
 * que não atualizou hoje, MARCAÇÃO FEITA DEPOIS DA LEITURA DO BANCO (menos uma margem: o Pix dela ainda não podia estar lá), marcação CONFIRMADA (a última alteração é a
 * confirmação; a marcação pode ser bem anterior e o Pix também) e unidade em que o paciente pode escolher PAGAR NO DIA («R$ 350 no dia, ou R$ 250 antecipado»): a agenda não diz
 * quem escolheu, então ali ninguém é «não achei» (só quem a conversa da Sofia marcou como «na clínica» sai da lista).
 *
 * Chave por unidade `agendados-sem-pix` (AGENDADOS_SEM_PIX_SLUGS), `exigeSecoAntes`: a tela só liga quem já passou pelo «só no papel». Sem linha na tela e sem a variável: seco, que
 * decide e GRAVA o texto que mandaria (rastro `manual`) e não manda nada. Ligado manda no grupo de `AGENDADOS_SEM_PIX_DESTINOS` (JSON `{"<slug>": "<id>@g.us"}`); sem destino NÃO
 * manda (avisa uma vez no log; volta na varredura seguinte, sem gastar agenda nem banco). Só unidade com pagamento antecipado, agenda da franquia e item da Pluggy.
 *
 * ENVIO SEM METRALHADORA: o texto fica gravado na marca do dia. Recusa certa da Evolution (4xx, ou nem conectou) tenta de novo com 15 min de intervalo, no máximo 3 envios no total, SEM reler
 * agenda nem banco (reenvia o texto guardado); depois desiste e avisa no log. Erro 5xx ou sem resposta é INCERTO (pode ter saído): nunca reenvia.
 *
 * Horário: a partir de AGENDADOS_SEM_PIX_HORA (padrão 12:15, depois da sincronização diária do Meu Pluggy, ~11:59) em dia de agenda e sem feriado, por até 7 h. Banco que não atualizou
 * hoje: espera (sem ler o extrato); passadas 4 h do horário, sai assim mesmo, tudo «a conferir». UMA lista por unidade por dia (marca no banco, vale entre processos e reinícios).
 */
import type { Estado } from './automacoes-estado.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { diaDaSemana } from './feriados.js';
import { logger } from './logger.js';
import { type PixRecebido, chaveDoNome, nivelPixPessoa, semAcento, tokensDoNome } from './pix-casamento.js';
import { primeiroNome } from './aviso-clinica-agendamento.js';

export const ID_DA_AUTOMACAO = 'agendados-sem-pix';

export const estadoDaLista = (slug: string, raw: string | undefined = process.env.AGENDADOS_SEM_PIX_SLUGS): Estado => estadoDaAutomacao(slug, ID_DA_AUTOMACAO, raw);

/** Pix até tantos dias ANTES da marcação ainda conta para ela (o paciente paga assim que recebe a chave, e a recepção marca depois). */
export const PIX_ANTES_DO_AGENDAMENTO_DIAS = 7;
/**
 * O extrato é lido desde tantos dias antes da CONSULTA (não desde a «marcação»: a data de marcação é a última alteração do registro, e uma remarcação ou confirmação a empurra para
 * frente). Pix de nome certo mais velho que a janela de pagamento (7 dias antes da marcação) não vale como «pagou», mas aparece como «a conferir (outra data)».
 */
export const LEITURA_ANTES_DA_CONSULTA_DIAS = 30;
/** Quem foi marcado depois de (leitura do banco − esta margem) não pode ser dado como «não achei Pix»: o Pix dele ainda não podia estar lá. */
export const MARGEM_DO_BANCO_MIN = 60;
/** No máximo tantos envios ao grupo por dia e unidade (o primeiro + as repetições depois de recusa certa). */
export const MAX_ENVIOS = 3;
/** Intervalo mínimo entre uma recusa e a repetição. */
export const ESPERA_ENTRE_ENVIOS_MIN = 15;

const somarDias = (dia: string, n: number): string => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Primeiro dia de Pix que vale como «pagou» para esta marcação. */
export const pixDesde = (a: Pick<Agendado, 'agendadoEm'>): string => somarDias(a.agendadoEm, -PIX_ANTES_DO_AGENDAMENTO_DIAS);
/** Primeiro dia de extrato a LER para esta marcação (a janela larga: ver LEITURA_ANTES_DA_CONSULTA_DIAS). */
export const leituraDesde = (a: Pick<Agendado, 'agendadoEm' | 'dia'>): string => {
  const larga = somarDias(a.dia, -LEITURA_ANTES_DA_CONSULTA_DIAS);
  const estreita = pixDesde(a);
  return larga < estreita ? larga : estreita;
};

/**
 * A categoria da consulta que se paga antes, em qualquer das grafias das franquias: «AVALIAÇÃO», «Avaliação inicial», «Consulta», «Consulta de avaliação», «Primeira consulta».
 * Reavaliação, retorno e sessão não.
 */
export function ehAvaliacao(categoria: string | null | undefined): boolean {
  const c = semAcento(categoria ?? '').trim();
  if (!c || /reavalia|retorno|sess|tratamento/.test(c)) return false;
  return /^(avalia|consulta|primeira consulta|1[ªº]?o?\.? consulta)/.test(c);
}

// ----------------------------------------------------------------------------------------------------------------- decisão (pura)

export interface Agendado {
  nome: string | null;
  /** dia da consulta, AAAA-MM-DD (hora da unidade) */
  dia: string;
  /** HH:mm */
  hora: string;
  /** dia (hora da unidade) da última alteração do registro, AAAA-MM-DD */
  agendadoEm: string;
  /** o instante da última alteração (ms UTC): comparado com a hora em que o banco foi lido */
  alteradoEmMs: number;
  /**
   * Em AGENDADO a última alteração é a MARCAÇÃO. Em CONFIRMADO é a confirmação (a régua confirma os de amanhã toda manhã): a marcação pode ser bem anterior, então esta
   * marcação nunca vira «não achei Pix».
   */
  marcacaoIncerta: boolean;
  idSchedule?: number | null;
}

export type Motivo =
  | 'valor'
  | 'data'
  | 'nome-parecido'
  | 'pix-compartilhado'
  | 'pix-de-outro-nome'
  | 'nome-incompleto'
  | 'banco-desatualizado'
  | 'sem-valores'
  | 'marcado-depois-do-banco'
  | 'marcacao-confirmada'
  | 'homonimo'
  | 'pode-pagar-no-dia';

export interface Veredito {
  agendado: Agendado;
  resultado: 'pagou' | 'sem_pix' | 'conferir';
  motivo?: Motivo;
}

export interface OpcoesDaConferencia {
  /** valores de Pix que valem como sinal/consulta, centavos, do menor ao maior */
  valores: ReadonlyArray<number>;
  hoje: string;
  /** o banco atualizou hoje, leu tudo e está UPDATED; falso = nada vira «não achei Pix» */
  bancoConfiavel: boolean;
  /** o instante (ms UTC) da última sincronização do banco; null = não sei (então nada vira «não achei Pix») */
  bancoLidoEm?: number | null;
  /** a unidade deixa o paciente pagar NO DIA: a agenda não diz quem escolheu, então ninguém vira «não achei Pix» */
  podePagarNoDia?: boolean;
  /**
   * Os nomes de TODOS os pacientes da agenda (qualquer categoria, de três semanas atrás a 45 dias à frente). Servem para duas coisas: o Pix de valor de consulta que é de um paciente
   * CONHECIDO não conta como «Pix de parente»; e dois pacientes com o mesmo primeiro e último nome (homônimos) nunca são dados como «pagou» só pelo nome.
   */
  conhecidos?: ReadonlyArray<string | null>;
}

type Nivel = 'igual' | 'parecido' | 'nenhum';

function nivelDoPar(a: Agendado, p: PixRecebido): Nivel {
  return p.empresa ? 'nenhum' : nivelPixPessoa(p, a.nome);
}

/**
 * Para cada agendado: `pagou` (casamento forte, sem dúvida de homônimo), `conferir` (há um indício que não chega a certeza, ou o dado não permite afirmar) ou `sem_pix`.
 * Pura: não lê banco, agenda nem relógio.
 */
export function conferirAgendados(agendados: ReadonlyArray<Agendado>, pix: ReadonlyArray<PixRecebido>, o: OpcoesDaConferencia): Veredito[] {
  const menor = o.valores[0] ?? Number.POSITIVE_INFINITY;
  const naoEmpresa = pix.filter((p) => !p.empresa);
  const dataOk = (a: Agendado, p: PixRecebido) => p.dia >= pixDesde(a) && p.dia <= o.hoje;
  const valorOk = (p: PixRecebido) => o.valores.includes(p.centavos);
  const identidade = (nome: string | null) => tokensDoNome(nome).join(' ');
  const conhecidos = [...(o.conhecidos ?? []), ...agendados.map((a) => a.nome)];
  // outro paciente com o MESMO primeiro e último nome e nome inteiro diferente: só o nome não diz qual dos dois pagou
  const temHomonimo = (a: Agendado) => conhecidos.some((n) => chaveDoNome(n) === chaveDoNome(a.nome) && identidade(n) !== identidade(a.nome));

  // quem casa forte com cada Pix (para achar o Pix que serve a mais de UMA PESSOA: duas marcações do mesmo paciente não contam como duas pessoas)
  const forteDe = new Map<string, Set<string>>();
  const fortes = agendados.map((a) => {
    const ids: string[] = [];
    if (!chaveDoNome(a.nome)) return ids;
    for (const p of naoEmpresa) if (nivelDoPar(a, p) === 'igual' && dataOk(a, p) && valorOk(p)) ids.push(p.id);
    return ids;
  });
  fortes.forEach((ids, i) => ids.forEach((id) => forteDe.set(id, (forteDe.get(id) ?? new Set<string>()).add(identidade(agendados[i]!.nome)))));
  const reivindicados = new Set(forteDe.keys());

  return agendados.map((a, i): Veredito => {
    if (!chaveDoNome(a.nome)) return { agendado: a, resultado: 'conferir', motivo: 'nome-incompleto' };
    const meus = fortes[i]!;
    if (meus.length) {
      if (!meus.some((id) => (forteDe.get(id)?.size ?? 0) === 1)) return { agendado: a, resultado: 'conferir', motivo: 'pix-compartilhado' };
      if (temHomonimo(a)) return { agendado: a, resultado: 'conferir', motivo: 'homonimo' };
      return { agendado: a, resultado: 'pagou' };
    }
    // sem casamento forte: o melhor indício fraco. O indício mais forte ganha, qualquer que seja a ordem dos Pix: valor diferente (nome certo, data certa) > data fora (nome certo) > nome parecido
    const ranque: Partial<Record<Motivo, number>> = { valor: 3, data: 2, 'nome-parecido': 1 };
    let fraco: Motivo | null = null;
    for (const p of naoEmpresa) {
      const n = nivelDoPar(a, p);
      if (n === 'nenhum' || p.centavos < menor) continue;
      const m: Motivo = n === 'parecido' ? 'nome-parecido' : !valorOk(p) ? 'valor' : !dataOk(a, p) ? 'data' : 'valor';
      if (!fraco || (ranque[m] ?? 0) > (ranque[fraco] ?? 0)) fraco = m;
    }
    if (fraco) return { agendado: a, resultado: 'conferir', motivo: fraco };
    // daqui para baixo é «não achei»: só se NADA impede de afirmar
    if (!o.bancoConfiavel) return { agendado: a, resultado: 'conferir', motivo: 'banco-desatualizado' };
    if (!o.valores.length) return { agendado: a, resultado: 'conferir', motivo: 'sem-valores' };
    // marcado depois (da leitura do banco menos a margem): o Pix dele ainda não podia estar lá
    if (o.bancoLidoEm == null || a.alteradoEmMs > o.bancoLidoEm - MARGEM_DO_BANCO_MIN * 60_000) return { agendado: a, resultado: 'conferir', motivo: 'marcado-depois-do-banco' };
    if (a.marcacaoIncerta) return { agendado: a, resultado: 'conferir', motivo: 'marcacao-confirmada' };
    // Pix de valor de consulta, no período, que não é de NINGUÉM conhecido: pode ser parente pagando. Não dá para dizer «não achei».
    const desde = somarDias(a.agendadoEm, -1);
    const deOutroConhecido = (p: PixRecebido) => agendados.some((b) => nivelDoPar(b, p) === 'igual') || conhecidos.some((n) => nivelPixPessoa(p, n) === 'igual');
    const solto = naoEmpresa.some((p) => !reivindicados.has(p.id) && valorOk(p) && p.dia >= desde && p.dia <= o.hoje && !deOutroConhecido(p));
    if (solto) return { agendado: a, resultado: 'conferir', motivo: 'pix-de-outro-nome' };
    if (o.podePagarNoDia) return { agendado: a, resultado: 'conferir', motivo: 'pode-pagar-no-dia' };
    return { agendado: a, resultado: 'sem_pix' };
  });
}

// ----------------------------------------------------------------------------------------------------------------- texto

const TEXTO_DO_MOTIVO: Record<Motivo, string> = {
  valor: 'achei Pix no nome, mas de valor diferente',
  data: 'achei Pix no nome, mas de outra data',
  'nome-parecido': 'achei Pix de nome parecido',
  'pix-compartilhado': 'o mesmo Pix serve para mais de um agendado',
  'pix-de-outro-nome': 'entrou Pix de valor de consulta em outro nome (pode ser de parente)',
  'nome-incompleto': 'a agenda está sem sobrenome',
  'banco-desatualizado': 'o banco ainda não atualizou hoje',
  'sem-valores': 'não sei o valor do sinal desta unidade',
  'marcado-depois-do-banco': 'foi marcado depois da última leitura do banco',
  'marcacao-confirmada': 'marcação já confirmada: não sei quando foi marcada',
  homonimo: 'há outro paciente com o mesmo nome',
  'pode-pagar-no-dia': 'pode ter escolhido pagar no dia',
};

const MAX_LINHAS = 15;
/** A Evolution corta em 1500 caracteres: o texto é montado para caber, com margem, e diz quantos ficaram de fora (o corte seco comeria o fim da lista e o rodapé). */
export const ORCAMENTO_DO_TEXTO = 1400;
const SEM_NOME = 'paciente (sem nome)';

function linha(v: Veredito, comMotivo: boolean): string {
  const [, m, d] = v.agendado.dia.split('-');
  const semana = diaDaSemana(v.agendado.dia);
  const quando = `${semana ? `${semana}, ` : ''}${d}/${m} às ${v.agendado.hora}`;
  const quem = primeiroNome(v.agendado.nome) ?? SEM_NOME;
  return `• *${quem}* — ${quando}${comMotivo && v.motivo ? ` (${TEXTO_DO_MOTIVO[v.motivo]})` : ''}`;
}

function bloco(titulo: string, vs: Veredito[], comMotivo: boolean, max: number): string[] {
  if (!vs.length) return [];
  const mostrar = vs.slice(0, max).map((v) => linha(v, comMotivo));
  if (vs.length > max) mostrar.push(`… e mais ${vs.length - max}`);
  return [titulo, ...mostrar, ''];
}

export interface DadosDoTexto {
  /** quando o banco foi lido pela última vez, «26/11 11:59» (hora da unidade); null se não sei */
  bancoAte: string | null;
}

const porHorario = (a: Veredito, b: Veredito): number => `${a.agendado.dia} ${a.agendado.hora}`.localeCompare(`${b.agendado.dia} ${b.agendado.hora}`);

/** null = nada a avisar (todo mundo pagou). Sem CPF, sem sobrenome, sem valor, sem saldo. Cabe em ORCAMENTO_DO_TEXTO caracteres. */
export function textoDaLista(vs: ReadonlyArray<Veredito>, d: DadosDoTexto): string | null {
  const semPix = vs.filter((v) => v.resultado === 'sem_pix').sort(porHorario);
  const conferir = vs.filter((v) => v.resultado === 'conferir').sort(porHorario);
  if (!semPix.length && !conferir.length) return null;
  const montar = (max: number) =>
    [
      `🔎 *Agendados sem Pix*${d.bancoAte ? ` — banco lido até ${d.bancoAte}` : ''}`,
      '',
      ...bloco('*Não achei Pix:*', semPix, false, max),
      ...bloco('*A conferir* (pode ter pago; não tenho certeza):', conferir, true, max),
      'Pix feito depois dessa hora ainda não aparece aqui.',
    ].join('\n');
  let texto = montar(MAX_LINHAS);
  for (let max = MAX_LINHAS - 1; texto.length > ORCAMENTO_DO_TEXTO && max >= 1; max--) texto = montar(max);
  return texto;
}

export function contagens(vs: ReadonlyArray<Veredito>): { agendados: number; pagou: number; semPix: number; conferir: number } {
  return {
    agendados: vs.length,
    pagou: vs.filter((v) => v.resultado === 'pagou').length,
    semPix: vs.filter((v) => v.resultado === 'sem_pix').length,
    conferir: vs.filter((v) => v.resultado === 'conferir').length,
  };
}

// ----------------------------------------------------------------------------------------------------------------- o ciclo de uma unidade

export type Desfecho =
  | 'desligado'
  | 'fora_do_horario'
  | 'repetido'
  | 'sem_destino'
  | 'sem_config'
  | 'sem_agendados'
  | 'agenda_falhou'
  | 'banco_falhou'
  | 'aguardando_banco'
  | 'aguardando_nova_tentativa'
  | 'desistiu'
  | 'tudo_pago'
  | 'simulado'
  | 'enviado'
  | 'incerto'
  | 'recusado'
  | 'falhou';

export interface UnidadeDaLista {
  id: string;
  slug: string;
  fuso: string;
  /** hoje na unidade, AAAA-MM-DD */
  hoje: string;
  /** minutos desde 00:00 na unidade */
  minutoDoDia: number;
  /** dia de agenda da unidade e não é feriado nacional */
  diaDeTrabalho: boolean;
  /** o dia útil anterior da unidade (AAAA-MM-DD): quem foi marcado desde então entra na lista de hoje (na segunda, vem desde a sexta, não só desde o domingo) */
  agendadosDesde: string;
  /** a unidade deixa o paciente pagar no dia (só a taxa OBRIGATÓRIA, como Boa Vista, não deixa) */
  podePagarNoDia: boolean;
  valores: number[];
}

export interface LeituraDoBanco {
  pix: PixRecebido[];
  /** «26/11 11:59» na hora da unidade; null = não sei */
  lidoAte: string | null;
  /** o instante (ms UTC) da leitura mais antiga entre os itens; null = não sei */
  lidoAteMs: number | null;
  /** atualizou hoje, leu tudo, UPDATED */
  confiavel: boolean;
}

export interface MarcaLida {
  estado: string;
  payload: Record<string, unknown>;
}

export interface MarcaDaLista {
  /** a marca do dia (estado e dados), ou null se não existe */
  ler(id: string): Promise<MarcaLida | null>;
  /** grava a marca ANTES de mandar; 'novo' = esta chamada ganhou o direito de mandar (marca `pendente` reabre para `enviando`) */
  reivindicar(id: string, a: { unitId: string; titulo: string; payload: Record<string, unknown>; estado: 'enviando' | 'pendente' | 'enviado' | 'simulado' }): Promise<'novo' | 'repetido' | 'erro'>;
  /** troca o estado da marca e junta `patch` ao payload */
  concluir(id: string, estado: 'enviado' | 'incerto' | 'pendente' | 'desistido', patch?: Record<string, unknown>): Promise<void>;
}

export interface DepsDoCiclo {
  /** `agendados` = marcados desde o dia útil anterior; `conhecidos` = nomes de todos os pacientes da agenda. null = não consegui ler a agenda. */
  agendados(u: UnidadeDaLista): Promise<{ agendados: Agendado[]; conhecidos: Array<string | null> } | null>;
  /** dos `idSchedule` dados, os que a conversa da Sofia marcou como «vai pagar na clínica» (saem da lista) */
  pagamNaClinica(u: UnidadeDaLista, idsDeMarcacao: number[]): Promise<Set<number>>;
  /**
   * Lê o banco desde `desde`. Com `lerMesmoDesatualizado` falso e o banco sem atualizar hoje, NÃO lê o extrato (devolve `confiavel: false` e pix vazio): esperar custa
   * uma chamada de status (guardada pelo cliente), ler o extrato a cada 5 min não.
   */
  banco(u: UnidadeDaLista, desde: string, lerMesmoDesatualizado: boolean): Promise<LeituraDoBanco | null>;
  destino(slug: string): string | null;
  /** como falar com a Evolution; null = sem configuração */
  evolution(): { url: string; header: string; valor: string } | null;
  /** recusado = a Evolution recusou (4xx) ou nem conectou: NÃO saiu. incerto = 5xx, sem resposta ou conexão cortada: PODE ter saído. */
  enviar(a: { url: string; header: string; valor: string; numero: string; texto: string }): Promise<'ok' | 'recusado' | 'incerto'>;
  marca: MarcaDaLista;
  agora(): number;
  avisarUmaVez(chave: string, msg: string): void;
}

/** Minuto do dia em que a lista começa («12:15»); valor ruim = 12:15. */
export function minutoDeInicio(raw: string | undefined = process.env.AGENDADOS_SEM_PIX_HORA): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? '').trim());
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  return Number.isInteger(h) && h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : 12 * 60 + 15;
}
/** Depois de tantas horas do início o dia está perdido (a recepção já foi embora). */
export const JANELA_HORAS = 7;
/** Passadas tantas horas do início, sai mesmo com o banco desatualizado (tudo «a conferir»). */
export const ESPERA_DO_BANCO_HORAS = 4;

const TITULO_DA_MARCA = 'Agendados sem Pix (lista da manhã)';

export async function cicloDaUnidade(u: UnidadeDaLista, modo: Estado, deps: DepsDoCiclo, inicio: number = minutoDeInicio()): Promise<Desfecho> {
  if (modo === 'desligado') return 'desligado';
  const desdeInicio = u.minutoDoDia - inicio;
  if (!u.diaDeTrabalho || desdeInicio < 0 || desdeInicio > JANELA_HORAS * 60) return 'fora_do_horario';

  const id = `${ID_DA_AUTOMACAO}:${u.slug}:${u.hoje}:${modo === 'seco' ? 'seco' : 'ligado'}`;
  const marca = await deps.marca.ler(id);
  if (marca?.estado === 'enviando') {
    // alguém ganhou o direito de mandar e não anotou o desfecho (o processo caiu no meio?): pode ter saído, então NUNCA repete; mas o dia não pode ficar calado sem ninguém saber
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:preso`, `${ID_DA_AUTOMACAO}: ${u.slug} tem a lista do dia marcada como «enviando» sem desfecho — não repito (pode ter saído); confira o grupo e o rastro do dia`);
    return 'repetido';
  }
  if (marca && marca.estado !== 'pendente') return 'repetido';

  // ligado sem destino ou sem Evolution: não manda e não gasta agenda nem banco (volta na próxima varredura, quando o João configurar)
  const destino = deps.destino(u.slug);
  const evo = deps.evolution();
  if (modo === 'ligado' && !destino) {
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:destino`, `${ID_DA_AUTOMACAO}: ${u.slug} está LIGADA mas sem destino em AGENDADOS_SEM_PIX_DESTINOS — a lista não é enviada`);
    return 'sem_destino';
  }
  if (modo === 'ligado' && !evo) {
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:evolution`, `${ID_DA_AUTOMACAO}: ${u.slug} está LIGADA mas falta a Evolution (AGENDADOS_SEM_PIX_EVOLUTION_URL ou AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL e a chave) — a lista não é enviada`);
    return 'sem_config';
  }

  // REPETIÇÃO depois de recusa certa: reenvia o texto GUARDADO na marca (nada de reler agenda nem extrato), no máximo MAX_ENVIOS no total e com intervalo
  if (marca?.estado === 'pendente') {
    const tentativas = Number(marca.payload.tentativas) || 1;
    const ultima = Number(marca.payload.ultimaEm) || 0;
    const texto = typeof marca.payload.texto === 'string' ? marca.payload.texto : '';
    if (!texto || tentativas >= MAX_ENVIOS) {
      await deps.marca.concluir(id, 'desistido');
      logger.error({ unidade: u.slug, tentativas }, `${ID_DA_AUTOMACAO}: a Evolution recusou a lista ${tentativas} vez(es) — desisti por hoje`);
      return 'desistiu';
    }
    if (deps.agora() - ultima < ESPERA_ENTRE_ENVIOS_MIN * 60_000) return 'aguardando_nova_tentativa';
    if ((await deps.marca.reivindicar(id, { unitId: u.id, titulo: TITULO_DA_MARCA, payload: {}, estado: 'enviando' })) !== 'novo') return 'repetido';
    const r = await deps.enviar({ ...evo!, numero: destino!, texto });
    await deps.marca.concluir(id, r === 'ok' ? 'enviado' : r === 'incerto' ? 'incerto' : 'pendente', { tentativas: tentativas + 1, ultimaEm: deps.agora() });
    logger.info({ unidade: u.slug, resultado: r, tentativa: tentativas + 1 }, `${ID_DA_AUTOMACAO}: nova tentativa de envio`);
    return r === 'ok' ? 'enviado' : r;
  }

  const agenda = await deps.agendados(u);
  if (!agenda) {
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:agenda`, `${ID_DA_AUTOMACAO}: ${u.slug} não consegui ler a agenda da franquia (falha ou agenda grande demais para o teto de leitura) — sem lista por enquanto; tento de novo em alguns minutos`);
    return 'agenda_falhou';
  }
  const { conhecidos } = agenda;
  // fecha o dia SEM mandar nada
  const fechar = async (payload: Record<string, unknown>) => void (await deps.marca.reivindicar(id, { unitId: u.id, titulo: TITULO_DA_MARCA, payload, estado: modo === 'seco' ? 'simulado' : 'enviado' }));
  // quem a conversa da Sofia marcou como «vai pagar na clínica» não deve nada antes da consulta: sai da lista
  const naClinica = await deps.pagamNaClinica(u, agenda.agendados.map((a) => a.idSchedule).filter((x): x is number => typeof x === 'number'));
  const agendados = agenda.agendados.filter((a) => !(typeof a.idSchedule === 'number' && naClinica.has(a.idSchedule)));
  // sem ninguém a conferir NÃO fecha o dia: quem for marcado depois (a recepção marca a tarde toda) ainda entra na varredura seguinte; a agenda vem do cache, então é barato
  if (!agendados.length) return 'sem_agendados';

  const desde = agendados.reduce((m, a) => (leituraDesde(a) < m ? leituraDesde(a) : m), u.hoje);
  const ultimaChance = desdeInicio >= ESPERA_DO_BANCO_HORAS * 60;
  const banco = await deps.banco(u, desde, ultimaChance);
  if (!banco) {
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:banco`, `${ID_DA_AUTOMACAO}: ${u.slug} não consegui ler o banco (Pluggy fora, item não encontrado em PLUGGY_ITENS ou consentimento vencido) — sem lista por enquanto`);
    return 'banco_falhou';
  }
  if (!banco.confiavel && !ultimaChance) return 'aguardando_banco';

  const vs = conferirAgendados(agendados, banco.pix, { valores: u.valores, hoje: u.hoje, bancoConfiavel: banco.confiavel, bancoLidoEm: banco.lidoAteMs, podePagarNoDia: u.podePagarNoDia, conhecidos });
  const c = contagens(vs);
  const texto = textoDaLista(vs, { bancoAte: banco.lidoAte });
  // só contagens no log: nome de paciente não vai para log
  logger.info({ unidade: u.slug, modo, ...c, pagamNaClinica: naClinica.size, bancoConfiavel: banco.confiavel }, `${ID_DA_AUTOMACAO}: conferência feita`);
  if (!texto) {
    await fechar({ modo, ...c, nada: true });
    return 'tudo_pago';
  }
  if (modo === 'seco') {
    await deps.marca.reivindicar(id, { unitId: u.id, titulo: TITULO_DA_MARCA, payload: { modo, ...c, bancoConfiavel: banco.confiavel, texto }, estado: 'simulado' });
    return 'simulado';
  }

  // o texto vai na marca: a repetição depois de recusa reenvia ESTE texto, sem reler nada
  const ganhou = await deps.marca.reivindicar(id, { unitId: u.id, titulo: TITULO_DA_MARCA, payload: { modo, ...c, bancoConfiavel: banco.confiavel, texto, tentativas: 1, ultimaEm: deps.agora() }, estado: 'enviando' });
  if (ganhou !== 'novo') return ganhou === 'erro' ? 'falhou' : 'repetido';
  const r = await deps.enviar({ ...evo!, numero: destino!, texto });
  // recusado = não saiu: a marca fica `pendente` (repete, no máximo MAX_ENVIOS no total); incerto = pode ter saído, nunca repete
  await deps.marca.concluir(id, r === 'ok' ? 'enviado' : r === 'incerto' ? 'incerto' : 'pendente', { tentativas: 1, ultimaEm: deps.agora() });
  logger.info({ unidade: u.slug, resultado: r, ...c }, `${ID_DA_AUTOMACAO}: lista ${r === 'ok' ? 'enviada' : r === 'incerto' ? 'enviada sem confirmação' : 'recusada pela Evolution (tento de novo, no máximo 3 envios)'}`);
  return r === 'ok' ? 'enviado' : r;
}
