/**
 * «Agendados sem Pix»: a lista da manhã da recepção, depois da sincronização do banco.
 *
 * A clínica cobra antecipado (sinal ou consulta) por Pix. Quem marcou ontem/hoje e NÃO tem Pix no banco precisa de um toque da secretária ANTES do dia da consulta.
 * Esta lista cruza a agenda da franquia (quem foi marcado nos últimos 2 dias, avaliação, ainda AGENDADO/CONFIRMADO) com o que entrou no banco pela Pluggy
 * (Open Finance, só leitura) e manda no grupo da recepção: primeiro nome, dia e hora da consulta e «não achei Pix». NUNCA vai CPF, sobrenome, valor nem saldo.
 *
 * COMO CASA (`pix-casamento.ts`): CPF do pagador, quando a agenda tem o CPF do paciente (a franquia não tem hoje); senão NOME (primeiro + último, sem acento) +
 * VALOR (um dos valores da unidade: sinal e consulta) + DATA (Pix de até 7 dias antes do agendamento até hoje). A venda de maquininha chega agregada e sem nome:
 * não entra. O que não é certeza vai para «A CONFERIR», nunca para «não achei Pix»: nome parecido, valor diferente, data fora, o mesmo Pix servindo a dois
 * agendados, Pix de valor de consulta em OUTRO nome (parente pagando), nome sem sobrenome na agenda, e tudo isto quando o banco não atualizou hoje.
 * Ninguém sai da lista por palpite; ninguém entra em «não achei» por falta de dado.
 *
 * Chave por unidade `agendados-sem-pix` (AGENDADOS_SEM_PIX_SLUGS). Sem linha na tela e sem a variável: «só no papel» (seco). Seco decide e GRAVA o texto que mandaria
 * (rastro `manual` com o texto, para conferir na tela de rastros) e não manda nada. Ligado manda no grupo de `AGENDADOS_SEM_PIX_DESTINOS` (JSON
 * `{"<slug>": "<id>@g.us"}`); sem destino NÃO manda (avisa uma vez no log e tenta de novo na varredura seguinte, sem gastar o banco). Sem `exigeSecoAntes`: a
 * tela liga direto. Só unidade com pagamento antecipado (`unidadeSemAntecipado` falso), com agenda da franquia e com item da Pluggy em PLUGGY_ITENS.
 *
 * Horário: a partir de AGENDADOS_SEM_PIX_HORA (padrão 12:15, depois da sincronização diária do Meu Pluggy, ~11:59) em dia de agenda e sem feriado, por até 7 h.
 * Banco que não atualizou hoje: espera (a cada 5 min); passadas 4 h do horário, sai assim mesmo, tudo «a conferir» e com o aviso. UMA lista por unidade por dia
 * (marca no banco, vale entre processos e reinícios); a leitura do extrato é UMA por conta por dia (o cliente da Pluggy guarda item e contas; o extrato só é lido
 * depois de saber que há agendado a conferir).
 */
import type { Estado } from './automacoes-estado.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { diaDaSemana } from './feriados.js';
import { logger } from './logger.js';
import { type PixRecebido, chaveDoNome, nivelPixPessoa, tokensDoNome } from './pix-casamento.js';
import { primeiroNome } from './aviso-clinica-agendamento.js';

export const ID_DA_AUTOMACAO = 'agendados-sem-pix';

export const estadoDaLista = (slug: string, raw: string | undefined = process.env.AGENDADOS_SEM_PIX_SLUGS): Estado => estadoDaAutomacao(slug, ID_DA_AUTOMACAO, raw);

/** Pix até tantos dias ANTES do agendamento ainda conta para ele (o paciente paga assim que recebe a chave, e a recepção marca depois). */
export const PIX_ANTES_DO_AGENDAMENTO_DIAS = 7;
/**
 * Quando a data em que o paciente foi MARCADO não é conhecida (marcação CONFIRMADA: a última alteração é a confirmação, não a marcação), o Pix vale desde tantos dias antes da consulta.
 */
export const PIX_ANTES_DA_CONSULTA_DIAS = 30;

const somarDias = (dia: string, n: number): string => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Primeiro dia de Pix que vale para este agendado. */
export const pixDesde = (a: Pick<Agendado, 'dia' | 'agendadoEm'>): string =>
  a.agendadoEm ? somarDias(a.agendadoEm, -PIX_ANTES_DO_AGENDAMENTO_DIAS) : somarDias(a.dia, -PIX_ANTES_DA_CONSULTA_DIAS);

// ----------------------------------------------------------------------------------------------------------------- decisão (pura)

export interface Agendado {
  nome: string | null;
  /** dia da consulta, AAAA-MM-DD (hora da unidade) */
  dia: string;
  /** HH:mm */
  hora: string;
  /**
   * Dia em que foi marcado, AAAA-MM-DD (a franquia não dá a data de criação: é a última alteração de quem ainda está AGENDADO); null = não sei (marcação CONFIRMADA: a última
   * alteração é a confirmação). Sem ela, o Pix vale desde 30 dias antes da consulta e a leitura do banco sobe junto.
   */
  agendadoEm: string | null;
  /** CPF do paciente (11 dígitos) quando a fonte tem; a franquia não tem */
  cpf?: string | null;
}

export type Motivo = 'valor' | 'data' | 'nome-parecido' | 'pix-compartilhado' | 'pix-de-outro-nome' | 'nome-incompleto' | 'banco-desatualizado' | 'sem-valores';

export interface Veredito {
  agendado: Agendado;
  resultado: 'pagou' | 'sem_pix' | 'conferir';
  motivo?: Motivo;
}

export interface OpcoesDaConferencia {
  /** valores de Pix que valem como sinal/consulta, centavos, do menor ao maior */
  valores: ReadonlyArray<number>;
  /**
   * Os nomes de TODOS os pacientes da agenda (qualquer categoria, de três semanas atrás a 45 dias à frente), não só dos marcados desde ontem. Serve para uma coisa: o Pix
   * de valor de consulta que é de um paciente CONHECIDO (outro, marcado antes, ou em tratamento) não conta como «Pix de parente» para quem está na lista.
   */
  conhecidos?: ReadonlyArray<string | null>;
  hoje: string;
  /** o banco atualizou hoje, leu tudo e está UPDATED; falso = nada vira «não achei Pix» */
  bancoConfiavel: boolean;
}

type Nivel = 'cpf' | 'igual' | 'parecido' | 'nenhum';

function nivelDoPar(a: Agendado, p: PixRecebido): Nivel {
  if (p.empresa) return 'nenhum';
  if (a.cpf && p.cpf && a.cpf === p.cpf) return 'cpf';
  return nivelPixPessoa(p, a.nome);
}

/**
 * Para cada agendado: `pagou` (casamento forte), `conferir` (há um indício que não chega a certeza, ou o dado não permite afirmar) ou `sem_pix`.
 * Pura: não lê banco, agenda nem relógio.
 */
export function conferirAgendados(agendados: ReadonlyArray<Agendado>, pix: ReadonlyArray<PixRecebido>, o: OpcoesDaConferencia): Veredito[] {
  const menor = o.valores[0] ?? Number.POSITIVE_INFINITY;
  const naoEmpresa = pix.filter((p) => !p.empresa);
  const dataOk = (a: Agendado, p: PixRecebido) => p.dia >= pixDesde(a) && p.dia <= o.hoje;
  const valorOk = (p: PixRecebido) => o.valores.includes(p.centavos);

  // quem casa forte com cada Pix (para achar o Pix que serve a mais de UMA PESSOA: duas marcações do mesmo paciente não contam como duas pessoas)
  const pessoaDe = (a: Agendado): string => a.cpf ?? tokensDoNome(a.nome).join(' ');
  const forteDe = new Map<string, Set<string>>();
  const fortes = agendados.map((a) => {
    const ids: string[] = [];
    if (!a.cpf && !chaveDoNome(a.nome)) return ids;
    for (const p of naoEmpresa) {
      const n = nivelDoPar(a, p);
      const forte = n === 'cpf' ? dataOk(a, p) && p.centavos >= menor : n === 'igual' && dataOk(a, p) && valorOk(p);
      if (forte) ids.push(p.id);
    }
    return ids;
  });
  fortes.forEach((ids, i) => ids.forEach((id) => forteDe.set(id, (forteDe.get(id) ?? new Set<string>()).add(pessoaDe(agendados[i]!)))));
  const reivindicados = new Set(forteDe.keys());

  return agendados.map((a, i): Veredito => {
    if (!a.cpf && !chaveDoNome(a.nome)) return { agendado: a, resultado: 'conferir', motivo: 'nome-incompleto' };
    const meus = fortes[i]!;
    if (meus.length) {
      if (meus.some((id) => (forteDe.get(id)?.size ?? 0) === 1)) return { agendado: a, resultado: 'pagou' };
      return { agendado: a, resultado: 'conferir', motivo: 'pix-compartilhado' };
    }
    // sem casamento forte: o melhor indício fraco
    let fraco: Motivo | null = null;
    for (const p of naoEmpresa) {
      const n = nivelDoPar(a, p);
      if (n === 'nenhum' || p.centavos < menor) continue;
      if (n === 'parecido') fraco = fraco ?? 'nome-parecido';
      else if (!dataOk(a, p)) fraco = fraco === 'valor' ? fraco : 'data';
      else fraco = 'valor';
    }
    if (fraco) return { agendado: a, resultado: 'conferir', motivo: fraco };
    if (!o.bancoConfiavel) return { agendado: a, resultado: 'conferir', motivo: 'banco-desatualizado' };
    if (!o.valores.length) return { agendado: a, resultado: 'conferir', motivo: 'sem-valores' };
    // Pix de valor de consulta, no período, que não é de NINGUÉM desta lista: pode ser parente pagando. Não dá para dizer «não achei».
    const desde = a.agendadoEm ? somarDias(a.agendadoEm, -1) : pixDesde(a);
    const deOutroConhecido = (p: PixRecebido) => agendados.some((b) => ['cpf', 'igual'].includes(nivelDoPar(b, p))) || (o.conhecidos ?? []).some((n) => nivelPixPessoa(p, n) === 'igual');
    const solto = naoEmpresa.some((p) => !reivindicados.has(p.id) && valorOk(p) && p.dia >= desde && p.dia <= o.hoje && !deOutroConhecido(p));
    return solto ? { agendado: a, resultado: 'conferir', motivo: 'pix-de-outro-nome' } : { agendado: a, resultado: 'sem_pix' };
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

const porHorario = (a: Veredito, b: Veredito): number => `${a.agendado.dia} ${a.agendado.hora}`.localeCompare(`${b.agendado.dia} ${b.agendado.hora}`);

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
  valores: number[];
}

export interface LeituraDoBanco {
  pix: PixRecebido[];
  /** «26/11 11:59» na hora da unidade; null = não sei */
  lidoAte: string | null;
  /** atualizou hoje, leu tudo, UPDATED */
  confiavel: boolean;
}

export interface MarcaDaLista {
  /** o estado gravado na marca do dia (enviado, enviando, pendente, incerto, simulado), ou null se não existe */
  estado(id: string): Promise<string | null>;
  /** grava a marca ANTES de mandar; 'novo' = esta chamada ganhou o direito de mandar */
  reivindicar(id: string, a: { unitId: string; titulo: string; payload: Record<string, unknown>; estado: 'enviando' | 'pendente' | 'enviado' | 'simulado' }): Promise<'novo' | 'repetido' | 'erro'>;
  concluir(id: string, estado: 'enviado' | 'incerto' | 'pendente'): Promise<void>;
}

export interface DepsDoCiclo {
  /** `agendados` = marcados desde ontem; `conhecidos` = nomes de todos os pacientes da agenda (ver `OpcoesDaConferencia.conhecidos`). null = não consegui ler a agenda. */
  agendados(u: UnidadeDaLista): Promise<{ agendados: Agendado[]; conhecidos: Array<string | null> } | null>;
  /**
   * Lê o banco desde `desde`. Com `lerMesmoDesatualizado` falso e o banco sem atualizar hoje, NÃO lê o extrato (devolve `confiavel: false` e pix vazio): esperar custa
   * uma chamada de status (guardada pelo cliente), ler o extrato a cada 5 min não.
   */
  banco(u: UnidadeDaLista, desde: string, lerMesmoDesatualizado: boolean): Promise<LeituraDoBanco | null>;
  destino(slug: string): string | null;
  /** como falar com a Evolution; null = sem configuração */
  evolution(): { url: string; header: string; valor: string } | null;
  enviar(a: { url: string; header: string; valor: string; numero: string; texto: string }): Promise<'ok' | 'recusado' | 'incerto'>;
  marca: MarcaDaLista;
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

export async function cicloDaUnidade(u: UnidadeDaLista, modo: Estado, deps: DepsDoCiclo, inicio: number = minutoDeInicio()): Promise<Desfecho> {
  if (modo === 'desligado') return 'desligado';
  const desdeInicio = u.minutoDoDia - inicio;
  if (!u.diaDeTrabalho || desdeInicio < 0 || desdeInicio > JANELA_HORAS * 60) return 'fora_do_horario';

  const id = `${ID_DA_AUTOMACAO}:${u.slug}:${u.hoje}:${modo === 'seco' ? 'seco' : 'ligado'}`;
  const jaTem = await deps.marca.estado(id);
  if (jaTem === 'enviando') {
    // alguém ganhou o direito de mandar e não anotou o desfecho (o processo caiu no meio?): pode ter saído, então NUNCA repete; mas o dia não pode ficar calado sem ninguém saber
    deps.avisarUmaVez(`${u.slug}:${u.hoje}:preso`, `${ID_DA_AUTOMACAO}: ${u.slug} tem a lista do dia marcada como «enviando» sem desfecho — não repito (pode ter saído); confira o grupo e o rastro do dia`);
    return 'repetido';
  }
  if (jaTem !== null && jaTem !== 'pendente') return 'repetido';

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

  const agenda = await deps.agendados(u);
  if (!agenda) return 'agenda_falhou';
  const { agendados, conhecidos } = agenda;
  // fecha o dia SEM mandar nada; se uma tentativa anterior ficou `pendente` (a Evolution recusou) e agora não há o que avisar, a marca também fecha
  const marcar = async (estado: 'enviado' | 'simulado', payload: Record<string, unknown>) => {
    if (jaTem === 'pendente') await deps.marca.concluir(id, 'enviado');
    else await deps.marca.reivindicar(id, { unitId: u.id, titulo: 'Agendados sem Pix (lista da manhã)', payload, estado });
  };
  if (!agendados.length) {
    await marcar(modo === 'seco' ? 'simulado' : 'enviado', { modo, agendados: 0, nada: true });
    return 'sem_agendados';
  }

  const desde = agendados.reduce((m, a) => (pixDesde(a) < m ? pixDesde(a) : m), u.hoje);
  const ultimaChance = desdeInicio >= ESPERA_DO_BANCO_HORAS * 60;
  const banco = await deps.banco(u, desde, ultimaChance);
  if (!banco) return 'banco_falhou';
  if (!banco.confiavel && !ultimaChance) return 'aguardando_banco';

  const vs = conferirAgendados(agendados, banco.pix, { valores: u.valores, hoje: u.hoje, bancoConfiavel: banco.confiavel, conhecidos });
  const c = contagens(vs);
  const texto = textoDaLista(vs, { bancoAte: banco.lidoAte });
  // só contagens no log: nome de paciente não vai para log
  logger.info({ unidade: u.slug, modo, ...c, bancoConfiavel: banco.confiavel }, `${ID_DA_AUTOMACAO}: conferência feita`);
  if (!texto) {
    await marcar(modo === 'seco' ? 'simulado' : 'enviado', { modo, ...c, nada: true });
    return 'tudo_pago';
  }
  if (modo === 'seco') {
    await marcar('simulado', { modo, ...c, bancoConfiavel: banco.confiavel, texto });
    return 'simulado';
  }

  const ganhou = await deps.marca.reivindicar(id, { unitId: u.id, titulo: 'Agendados sem Pix (lista da manhã)', payload: { modo, ...c, bancoConfiavel: banco.confiavel }, estado: 'enviando' });
  if (ganhou !== 'novo') return ganhou === 'erro' ? 'falhou' : 'repetido';
  const r = await deps.enviar({ ...evo!, numero: destino!, texto });
  // recusado = não saiu: a marca fica `pendente` e a próxima varredura tenta de novo; incerto = pode ter saído, nunca repete
  await deps.marca.concluir(id, r === 'ok' ? 'enviado' : r === 'incerto' ? 'incerto' : 'pendente');
  logger.info({ unidade: u.slug, resultado: r, ...c }, `${ID_DA_AUTOMACAO}: lista ${r === 'ok' ? 'enviada' : r === 'incerto' ? 'enviada sem confirmação' : 'recusada pela Evolution (tento de novo)'}`);
  return r === 'ok' ? 'enviado' : r;
}
