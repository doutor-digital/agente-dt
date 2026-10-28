/**
 * Uma rodada do disparo para uma unidade: aplica os freios, escolhe quem e manda (ou, em seco, só decide).
 *
 * TODO o contato com o mundo passa pelo `Porto`. O envio de verdade (`porto.enviar`) e o espelho no Kommo
 * (`porto.espelhar`) só são chamados dentro de `enviarUm`, e `enviarUm` só é chamado quando o modo é `ligado`.
 * É essa única porta que o teste do modo seco tranca: com o modo `seco`, `enviar` e `espelhar` NUNCA rodam.
 */
import { falhasSeguidasDemais, dentroDaJanela, passouDoLimiteDeSair, vagas, type Freios } from './freios.js';
import { alertaLimiteDeTaxa, alertaNumeroRestrito, alertaPausaPorFalhas, alertaPausaPorSair, type OndaParaAvisar } from './alerta.js';
import { textoFinal, valoresDasVariaveis, type SituacaoNaFranquia } from './regras.js';
import type { Definicao } from './modelo.js';
import type { ResultadoDoTemplate } from '../whatsapp-meta.js';
import { FUSO_PADRAO, fusoValido } from '../fuso.js';

export type Modo = 'ligado' | 'seco' | 'desligado';

/** Por que uma onda parou, em palavra de máquina. Só a pausa por SAIR tem retomada (decisão do João, 26/10). */
export type CausaDaPausa = 'sair' | 'falhas' | 'vencida' | 'meta';

export interface Destino {
  id: string;
  ondaId: string;
  campanhaId: string;
  unitId: string;
  telefone: string;
  chave: string;
  nome: string;
  /** nome inteiro do contato (só para reconferir a franquia); cai no primeiro nome se não foi guardado */
  nomeCompleto: string;
  kommoLeadId: number | null;
}

export interface OndaNoLote extends Definicao {
  id: string;
  campanhaId: string;
  /** o nome da campanha como o João a cadastrou (vem de `DisparoCampanha.nome`); aparece na nota do cartão */
  campanhaNome: string;
  aprovadaEm: Date | null;
  /** quantos SAIR o João já tinha visto quando retomou esta onda; o freio por SAIR só conta os que vierem depois */
  sairAceitos?: number;
  /** o modo da unidade quando foi aprovada: só 'ligado' vale para envio real (aprovar em seco não é aprovar envio) */
  aprovadaModo: string | null;
}

export interface UnidadeNoLote {
  id: string;
  slug: string;
  nome: string;
  fuso: string;
}

export interface DadosDeGravacao {
  estado?: 'pendente' | 'enviado' | 'falhou' | 'saiu' | 'descartado';
  motivo?: string | null;
  wamid?: string | null;
  /** `null` = desfaz um "receberia" que a reconferência invalidou (não pode continuar contando no teto do seco) */
  simuladoEm?: Date | null;
  /** `null` = desfaz a marca de tentativa que `reivindicar` pôs (não enviou, então não conta no teto) */
  enviadoEm?: Date | null;
}

export interface Porto {
  agora(): Date;
  modoDaUnidade(slug: string): Modo;
  /** Telefones (só dígitos) que podem receber de verdade NESTA unidade; `null` = todos dela (decisão explícita, `slug=*`); conjunto vazio = ninguém. Existe para provar em produção só no número do João. */
  listaDeTeste(slug: string): ReadonlySet<string> | null;
  /** Mensagens da unidade desde `desde`: enviadas (ligado) ou "receberia" gravadas (seco). */
  contarNaJanela(unitId: string, desde: Date, modo: 'ligado' | 'seco'): Promise<number>;
  pendentes(ondaId: string, modo: 'ligado' | 'seco', limite: number, soTelefones: ReadonlySet<string> | null): Promise<Destino[]>;
  sobram(ondaId: string, modo: 'ligado' | 'seco', soTelefones: ReadonlySet<string> | null): Promise<number>;
  /** Quantas pessoas da campanha, nesta unidade, RECEBERAM e responderam SAIR. Quem já tinha pedido para sair antes não conta: o freio mede reação ao envio. */
  quantosSairam(campanhaId: string, unitId: string): Promise<number>;
  /** Os últimos envios (mais recente primeiro) depois de `desde`: depois de consertar o token, uma onda nova não herda as falhas velhas. */
  ultimosResultados(unitId: string, n: number, desde: Date): Promise<Array<'enviado' | 'falhou'>>;
  /** A onda continua APROVADA agora? Cancelar ou pausar no meio da rodada vale já, não só na próxima. */
  ondaAprovada(ondaId: string): Promise<boolean>;
  /** pendente → enviando, atômico e SÓ se a onda ainda está aprovada; marca a tentativa em `enviadoEm` (conta no teto mesmo se o processo morrer aqui). `false` = outro processo pegou, ou a onda foi parada. */
  reivindicar(id: string): Promise<boolean>;
  gravar(id: string, dados: DadosDeGravacao): Promise<void>;
  pausarOndas(unitId: string, campanhaId: string | null, motivo: string, causa?: CausaDaPausa): Promise<void>;
  /**
   * Pausa as ondas aprovadas de TODAS as unidades que usam o mesmo número de WhatsApp que esta (a restrição e o limite da Meta
   * são do número) e zera o contador de limite de taxa dele. Devolve as unidades e as ondas pausadas, para o aviso.
   */
  pausarNumero(unitId: string, motivo: string, causa: CausaDaPausa): Promise<{ unidades: string[]; ondas: string[] }>;
  pausarOnda(ondaId: string, motivo: string, causa?: CausaDaPausa): Promise<void>;
  /** Aprovação dada fora do modo ligado: volta a `montada` para nova aprovação e devolve à fila o que o seco descartou. */
  devolverParaAprovacao(ondaId: string, motivo: string): Promise<void>;
  concluirOnda(ondaId: string): Promise<void>;
  pediuSair(d: Destino): Promise<boolean>;
  franquia(d: Destino): Promise<SituacaoNaFranquia>;
  enviar(onda: OndaNoLote, d: Destino, valores: string[]): Promise<ResultadoDoTemplate>;
  espelhar(d: Destino, texto: string): Promise<void>;
  dormir(ms: number): Promise<void>;
  /** Registra se a rodada terminou em limite de taxa da Meta e devolve quantas rodadas SEGUIDAS já foram assim; `houve: false` (um envio passou) zera. */
  limiteDeTaxa(unitId: string, houve: boolean): Promise<number>;
  /** Avisa o João (Telegram). Não lança: aviso que falha não derruba a rodada. */
  avisar(texto: string): Promise<void>;
  /** O link do painel da onda (null se o endereço público do servidor não está configurado). */
  linkDoPainel(ondaId: string): string | null;
  log(nivel: 'info' | 'warn' | 'error', dados: Record<string, unknown>, msg: string): void;
}

export interface ResumoDaRodada {
  modo: Modo;
  parou?: string;
  /** seco: gravou "receberia" · ligado: mandou */
  processados: number;
  mandou: number;
  receberia: number;
  falhou: number;
  saiu: number;
  descartados: number;
  /** pessoas que não deu para conferir (franquia fora, banco instável) e voltaram para o fim da fila */
  adiados: number;
}

const vazio = (modo: Modo, parou?: string): ResumoDaRodada => ({ modo, parou, processados: 0, mandou: 0, receberia: 0, falhou: 0, saiu: 0, descartados: 0, adiados: 0 });

/** A mensagem de erro da Meta em uma linha (código + texto), para o banco e a tela. */
export function motivoDaMeta(r: ResultadoDoTemplate): string {
  const e = (r.detalhe as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null)?.error;
  if (e) return `${r.incerto ? 'INCERTO: ' : ''}Meta ${e.code ?? '?'}: ${e.error_data?.details ?? e.message ?? 'sem detalhe'}`.slice(0, 300);
  return `${r.incerto ? 'INCERTO: ' : ''}${typeof r.detalhe === 'string' ? r.detalhe : 'a Meta não devolveu o id da mensagem'}`.slice(0, 300);
}

/**
 * Teto do texto da nota. O código não tinha teto de nota (o Kommo não documenta um que o corpo de um modelo da Meta, de até 1024
 * caracteres, alcance); este é folga de segurança: se estourar, encurta a MENSAGEM, nunca o link nem o resto (um link absurdo, maior que o teto sozinho, passa inteiro: cortá-lo o quebraria).
 */
export const NOTA_MAX = 4000;

const NOME_DA_MIDIA = { image: 'Imagem enviada junto', video: 'Vídeo enviado junto', document: 'Documento enviado junto' } as const;

/** "28/10 às 14:05" no fuso da unidade (São Paulo se o fuso for inválido). */
export function quandoEmTexto(quando: Date, fuso: string): string {
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: fusoValido(fuso) ? fuso : FUSO_PADRAO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(quando);
  const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? '';
  return `${p('day')}/${p('month')} às ${p('hour')}:${p('minute')}`;
}

/**
 * A nota que fica no cartão depois que a Meta aceitou o envio. Quem lê é a SDR: precisa entender em poucos segundos o que o
 * paciente recebeu (campanha, quando, o texto, a imagem) e que a resposta dele é a essa mensagem. Sem telefone, sem id da Meta,
 * sem o nome interno do modelo. A linha da imagem não leva emoji de propósito: o Kommo só aceita emoji simples e o 🖼 seria
 * apagado, deixando um espaço sobrando no começo da linha.
 */
export function textoDoEspelho(onda: OndaNoLote, texto: string, quando: Date, fuso: string): string {
  // o nome é digitado livremente: uma linha só, para uma quebra de linha no nome não deformar a abertura
  const campanha = onda.campanhaNome.replace(/\s+/g, ' ').trim();
  const abertura = `📲 Campanha${campanha ? ` "${campanha}"` : ''} — enviada em ${quandoEmTexto(quando, fuso)} pelo WhatsApp oficial.`;
  const midia = onda.cabecalho ? `\n\n${NOME_DA_MIDIA[onda.cabecalho.tipo]}: ${onda.cabecalho.link}` : '';
  const fim = '\n\nSe o paciente responder, é resposta a esta mensagem.';
  const moldura = (mensagem: string) => `${abertura}\n\nMensagem enviada:\n${mensagem}${midia}${fim}`;
  const sobra = NOTA_MAX - moldura('').length;
  if (texto.length <= sobra) return moldura(texto);
  let corte = Math.max(0, sobra - 1);
  const ultimo = texto.charCodeAt(corte - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) corte -= 1; // não parte um emoji ao meio
  return moldura(`${texto.slice(0, corte).trimEnd()}…`);
}

type Veredito =
  | { tipo: 'pode' }
  | { tipo: 'barrou'; estado: 'saiu' | 'descartado'; motivo: string }
  /** não deu para conferir: tenta de novo na próxima rodada, NÃO descarta a pessoa para sempre */
  | { tipo: 'adiar'; motivo: string };

/** Decide, sem mandar nada, se a pessoa ainda pode receber. */
async function aindaPode(porto: Porto, d: Destino): Promise<Veredito> {
  if (await porto.pediuSair(d)) return { tipo: 'barrou', estado: 'saiu', motivo: 'pediu para sair (SAIR) antes do envio' };
  const f = await porto.franquia(d);
  if (f === 'livre') return { tipo: 'pode' };
  if (f === 'indisponivel') return { tipo: 'adiar', motivo: 'a franquia não respondeu' };
  const motivo = f === 'consulta-futura' ? 'consulta marcada na franquia' : 'tratamento aberto na franquia';
  return { tipo: 'barrou', estado: 'descartado', motivo: `${motivo} (conferido na hora do envio)` };
}

/** `limite`: a Meta pediu para esperar (limite de taxa); a pessoa continua na fila e a rodada acaba. */
type Resultado = 'pulou' | 'feito' | 'adiado' | 'limite' | 'restrito';

/**
 * Não deu para conferir agora: a pessoa NÃO é descartada, mas vai para o FIM da fila. A gravação do motivo atualiza o
 * `atualizadoEm`, que é a ordem da fila: sem isso três pessoas presas ficavam sempre na frente e a onda inteira parava.
 */
async function adiar(porto: Porto, d: Destino, motivo: string): Promise<Resultado> {
  await porto.gravar(d.id, { motivo: `adiado: ${motivo}`.slice(0, 300) }).catch(() => undefined);
  return 'adiado';
}

/** MODO SECO: decide tudo, grava quem RECEBERIA, e não toca em nada que saia da casa. */
async function simularUm(porto: Porto, onda: OndaNoLote, u: UnidadeNoLote, d: Destino, r: ResumoDaRodada): Promise<Resultado> {
  const v = await aindaPode(porto, d);
  if (v.tipo === 'adiar') return adiar(porto, d, v.motivo);
  if (v.tipo === 'barrou') {
    await porto.gravar(d.id, { estado: v.estado, motivo: v.motivo });
    if (v.estado === 'saiu') r.saiu += 1;
    else r.descartados += 1;
    return 'feito';
  }
  await porto.gravar(d.id, { simuladoEm: porto.agora() });
  r.receberia += 1;
  const texto = textoFinal(onda.textoModelo, valoresDasVariaveis(onda.variaveis, { primeiroNome: d.nome, unidade: u.nome }));
  porto.log('info', { unit: u.slug, onda: onda.id, para: `…${d.telefone.slice(-4)}`, texto }, 'disparo [seco]: receberia');
  return 'feito';
}

/**
 * MODO LIGADO: a única função que manda de verdade.
 *
 * Ordem: PRIMEIRO as conferências (só leitura), DEPOIS a reivindicação, e o envio logo em seguida. Assim uma
 * reivindicação que ficou para trás (processo caiu) quase sempre é de um envio que de fato pode ter saído — e só o
 * trecho a partir do `enviar` vira "INCERTO" se algo estourar. Antes dele nada saiu: a pessoa volta para a fila
 * (um blip no banco ou no Kommo não pode queimar vaga de teto nem pausar a unidade como se fosse a Meta).
 */
async function enviarUm(porto: Porto, onda: OndaNoLote, u: UnidadeNoLote, d: Destino, r: ResumoDaRodada): Promise<Resultado> {
  let reivindicou = false;
  let chamouAMeta = false;
  let wamidAceito: string | null = null;
  try {
    const v = await aindaPode(porto, d);
    if (v.tipo === 'adiar') return adiar(porto, d, v.motivo);
    if (v.tipo === 'barrou') {
      await porto.gravar(d.id, { estado: v.estado, motivo: v.motivo, simuladoEm: null });
      if (v.estado === 'saiu') r.saiu += 1;
      else r.descartados += 1;
      return 'feito';
    }
    if (!(await porto.reivindicar(d.id))) return 'pulou'; // outro processo pegou: não mandar duas vezes
    reivindicou = true;
    const valores = valoresDasVariaveis(onda.variaveis, { primeiroNome: d.nome, unidade: u.nome });
    chamouAMeta = true;
    const res = await porto.enviar(onda, d, valores);
    if (res.ok && res.wamid) {
      // O wamid é a única prova de que a mensagem saiu: vai para o log ANTES de qualquer gravação. Se o banco falhar em seguida, o
      // catch marca a pessoa como INCERTA (não reenvia) e o wamid continua achável aqui, para casar na mão.
      porto.log('info', { unit: u.slug, onda: onda.id, wamid: res.wamid, para: `…${d.telefone.slice(-4)}` }, 'disparo: a Meta aceitou o envio');
      wamidAceito = res.wamid;
      await porto.gravar(d.id, { estado: 'enviado', wamid: res.wamid, enviadoEm: porto.agora() });
      r.mandou += 1;
      // Mensagem por fora do Kommo não aparece lá: sem a nota, a resposta do paciente chega sem a pergunta.
      await porto.espelhar(d, textoDoEspelho(onda, textoFinal(onda.textoModelo, valores), porto.agora(), u.fuso)).catch((err) =>
        porto.log('warn', { unit: u.slug, err: String(err), lead: d.kommoLeadId }, 'disparo: enviei mas não consegui espelhar a nota no cartão'),
      );
      return 'feito';
    }
    // A Meta pediu para ESPERAR (limite de taxa): não é recusa da pessoa nem do modelo. Ela volta para a fila, não conta no
    // teto nem no freio de falhas, e a rodada acaba — tentar de novo é problema do próximo minuto.
    if (res.limiteDeTaxa) {
      await porto.gravar(d.id, { estado: 'pendente', enviadoEm: null, motivo: `limite de taxa da Meta: tento de novo depois (${motivoDaMeta(res)})`.slice(0, 300) });
      porto.log('warn', { unit: u.slug, onda: onda.id, motivo: motivoDaMeta(res) }, 'disparo: a Meta pediu para esperar (limite de taxa) — rodada encerrada');
      return res.restrito ? 'restrito' : 'limite';
    }
    // Recusa definitiva não conta no teto (a Meta não aceitou); incerta pode ter saído: conta e NUNCA é reenviada sozinha.
    await porto.gravar(d.id, { estado: 'falhou', motivo: motivoDaMeta(res), enviadoEm: res.incerto ? porto.agora() : null });
    r.falhou += 1;
    porto.log('warn', { unit: u.slug, onda: onda.id, motivo: motivoDaMeta(res) }, 'disparo: a Meta recusou o envio');
    return 'feito';
  } catch (err) {
    porto.log('warn', { unit: u.slug, onda: onda.id, err: String(err), chamouAMeta }, 'disparo: erro inesperado com uma pessoa');
    if (!chamouAMeta) {
      if (reivindicou) await porto.gravar(d.id, { estado: 'pendente', enviadoEm: null, motivo: 'adiado: erro antes de falar com a Meta' }).catch(() => undefined);
      else await adiar(porto, d, 'erro antes de falar com a Meta');
      return 'adiado';
    }
    await porto.gravar(d.id, { estado: 'falhou', motivo: `INCERTO: erro interno${wamidAceito ? ` DEPOIS de a Meta aceitar (wamid ${wamidAceito})` : ''} (${String(err).slice(0, 150)})`.slice(0, 300), enviadoEm: porto.agora() }).catch(() => undefined);
    r.falhou += 1;
    return 'feito';
  }
}

/** Depois de tantas pessoas adiadas na mesma rodada o problema não é a pessoa: é a franquia, o banco ou o Kommo. */
const ADIADOS_PARA_PARAR = 3;

/** As unidades do aviso: as pausadas, e sempre a que levou o erro (mesmo que ela não tivesse onda aprovada para pausar). */
const unidadesParaAvisar = (slug: string, pausadas: readonly string[]): string[] => [...new Set([slug, ...pausadas])];

const paraAvisar = (porto: Porto, os: ReadonlyArray<{ id: string }>): OndaParaAvisar[] => os.map((o) => ({ id: o.id, painel: porto.linkDoPainel(o.id) }));

/** Uma rodada de uma unidade, com as ondas APROVADAS dela em ordem de criação. */
export async function rodarUnidade(porto: Porto, f: Freios, u: UnidadeNoLote, ondasDaUnidade: OndaNoLote[]): Promise<ResumoDaRodada> {
  let ondas = ondasDaUnidade;
  const modo = porto.modoDaUnidade(u.slug);
  if (modo === 'desligado') return vazio(modo, 'automação desligada nesta unidade');
  const r = vazio(modo);
  const real = modo === 'ligado';
  const via = real ? 'ligado' : 'seco';

  // Aprovação dada com a unidade em seco (ou desligada) NÃO é aprovação de envio: o João viu "aprovar não manda nada". Ao ligar,
  // a onda volta para a tela dele e só sai depois de um clique com a unidade ligada.
  if (real) {
    const emSeco = ondas.filter((o) => o.aprovadaModo !== 'ligado');
    for (const o of emSeco) {
      await porto.devolverParaAprovacao(o.id, 'a unidade foi LIGADA e esta onda tinha sido aprovada com ela em modo seco: aprove de novo (o seco não manda nada, então ainda não é aprovação de envio real)');
      porto.log('warn', { unit: u.slug, onda: o.id, aprovadaModo: o.aprovadaModo }, 'disparo: aprovação dada em seco não vale para envio real — onda devolvida para nova aprovação');
    }
    ondas = ondas.filter((o) => o.aprovadaModo === 'ligado');
    if (ondas.length === 0) return { ...r, parou: emSeco.length ? 'aprovação dada em modo seco: aprove de novo' : undefined };
  }

  // Freio 1 — SAIR, por campanha: passou de N, a unidade para nessa campanha.
  let ativas = ondas;
  for (const campanhaId of new Set(ondas.map((o) => o.campanhaId))) {
    const sairam = await porto.quantosSairam(campanhaId, u.id);
    // O João pode ter retomado a onda depois de ver quem pediu SAIR: conta só o que veio depois do que ele viu.
    // Com ondas diferentes na mesma campanha vale a MENOR base: uma onda nova (base 0) não herda a folga de outra.
    const base = Math.min(...ondas.filter((o) => o.campanhaId === campanhaId).map((o) => o.sairAceitos ?? 0));
    if (passouDoLimiteDeSair(sairam - base, f)) {
      await porto.pausarOndas(u.id, campanhaId, `${sairam} pessoas responderam SAIR (limite ${f.maxSair}${base > 0 ? `, além das ${base} que o João já viu` : ''}): unidade parada até o João decidir`, 'sair');
      porto.log('warn', { unit: u.slug, campanhaId, sairam }, 'disparo: unidade PARADA por excesso de SAIR');
      // Só o João retoma: ele precisa saber. Quantos pediram e o link; o que escreveram fica no painel.
      await porto.avisar(alertaPausaPorSair({ unidade: u.slug, ondas: paraAvisar(porto, ondas.filter((o) => o.campanhaId === campanhaId)), sairam, limite: f.maxSair })).catch(() => undefined);
      ativas = ativas.filter((o) => o.campanhaId !== campanhaId);
    }
  }
  if (ativas.length === 0) return { ...r, parou: 'parada por SAIR' };

  // Freio 2 — falhas seguidas: token vencido ou número bloqueado não é "a lista estar ruim".
  // Só olha envios DEPOIS da aprovação mais recente: consertou o token e aprovou de novo, começa limpo.
  const desdeAprovacao = new Date(Math.max(0, ...ativas.map((o) => o.aprovadaEm?.getTime() ?? 0)));
  if (real && falhasSeguidasDemais(await porto.ultimosResultados(u.id, f.falhasSeguidas, desdeAprovacao), f)) {
    await porto.pausarOndas(u.id, null, `${f.falhasSeguidas} envios seguidos falharam na Meta: confira o token e a qualidade do número`, 'falhas');
    porto.log('warn', { unit: u.slug }, 'disparo: unidade PARADA por falhas seguidas');
    await porto.avisar(alertaPausaPorFalhas({ unidade: u.slug, ondas: paraAvisar(porto, ativas), falhas: f.falhasSeguidas })).catch(() => undefined);
    return { ...r, parou: 'parada por falhas seguidas' };
  }

  // Freio 3 — janela de horário.
  const agora = porto.agora();
  const janela = dentroDaJanela(agora, u.fuso, f);
  if (!janela.ok) return { ...r, parou: janela.motivo };

  // Freio 4 — tetos por hora e por dia, desta unidade.
  const [naHora, noDia] = await Promise.all([
    porto.contarNaJanela(u.id, new Date(agora.getTime() - 3_600_000), via),
    porto.contarNaJanela(u.id, new Date(agora.getTime() - 86_400_000), via),
  ]);
  let cabem = vagas(f, naHora, noDia);
  if (cabem === 0) return { ...r, parou: `teto atingido (${naHora}/h, ${noDia}/24h)` };

  // Freio 5 — validade da aprovação (só importa para quem manda de verdade).
  if (real) {
    const vencimento = agora.getTime() - f.validadeDias * 86_400_000;
    for (const o of ativas.filter((x) => !x.aprovadaEm || x.aprovadaEm.getTime() < vencimento)) {
      await porto.pausarOnda(o.id, `a aprovação passou de ${f.validadeDias} dias: monte e aprove a onda de novo`, 'vencida');
      porto.log('warn', { unit: u.slug, onda: o.id }, 'disparo: aprovação VENCIDA, onda pausada');
    }
    ativas = ativas.filter((x) => x.aprovadaEm && x.aprovadaEm.getTime() >= vencimento);
    if (ativas.length === 0) return { ...r, parou: 'aprovação vencida' };
  }

  const teste = real ? porto.listaDeTeste(u.slug) : null;
  if (teste && teste.size === 0) {
    porto.log('warn', { unit: u.slug }, 'disparo: unidade LIGADA mas sem lista de teste (DISPARO_LISTA_DE_TESTE) — ninguém recebe; use slug=telefone ou slug=* para esta unidade');
    return { ...r, parou: 'ligada sem lista de teste desta unidade: ninguém recebe' };
  }
  let seguidas = 0;
  let adiados = 0;
  for (const onda of ativas) {
    if (cabem === 0) break;
    const lote = await porto.pendentes(onda.id, via, cabem, teste);
    for (const d of lote) {
      // Cancelar ou pausar com a rodada andando vale para a PRÓXIMA pessoa, não só para a próxima rodada.
      if (!(await porto.ondaAprovada(onda.id))) break;
      // Reconta o teto antes de CADA envio real: o `cabem` do começo da rodada pode ter envelhecido (outro processo, mesmo
      // que o lease raramente deixe). A reivindicação marca a tentativa, então a próxima contagem já enxerga a anterior.
      if (real && vagas(f, await porto.contarNaJanela(u.id, new Date(porto.agora().getTime() - 3_600_000), 'ligado'), await porto.contarNaJanela(u.id, new Date(porto.agora().getTime() - 86_400_000), 'ligado')) === 0) {
        return { ...r, parou: 'teto atingido durante a rodada' };
      }
      const antes = r.falhou;
      const mandouAntes = r.mandou;
      const res = real ? await enviarUm(porto, onda, u, d, r) : await simularUm(porto, onda, u, d, r);
      if (res === 'pulou') continue; // perdeu a disputa para outro processo: não gasta vaga nem tempo
      if (res === 'restrito') {
        const motivo = 'a Meta RESTRINGIU o número por spam/qualidade (código 131048): a unidade foi pausada; resolva com a Meta e monte a onda de novo';
        // A restrição é do NÚMERO: pausa todas as unidades que o usam, não só esta (Caxias seguiria mandando pelo número de Petrópolis).
        const pausadas = await porto.pausarNumero(u.id, motivo, 'meta');
        porto.log('error', { unit: u.slug, unidades: pausadas.unidades }, 'disparo: número RESTRITO pela Meta (131048) — unidades do número PAUSADAS, não tento de novo');
        // Uma mensagem por número: a pausa tira as ondas de "aprovada", e na rodada seguinte não sobra onda para repetir o aviso.
        await porto.avisar(alertaNumeroRestrito({ unidades: unidadesParaAvisar(u.slug, pausadas.unidades), ondas: pausadas.ondas })).catch(() => undefined);
        return { ...r, parou: 'número restrito pela Meta (131048): unidades do número pausadas' };
      }
      if (res === 'limite') {
        const seguidas = await porto.limiteDeTaxa(u.id, true);
        if (seguidas >= f.limiteDeTaxaSeguidos) {
          const pausadas = await porto.pausarNumero(u.id, `a Meta pediu para esperar em ${seguidas} rodadas seguidas (limite de taxa): as unidades deste número foram pausadas; confira a qualidade do número e monte a onda de novo`, 'meta');
          porto.log('error', { unit: u.slug, unidades: pausadas.unidades, rodadas: seguidas }, 'disparo: limite de taxa da Meta por rodadas demais — unidades do número PAUSADAS');
          await porto.avisar(alertaLimiteDeTaxa({ unidades: unidadesParaAvisar(u.slug, pausadas.unidades), ondas: pausadas.ondas, rodadas: seguidas })).catch(() => undefined);
          return { ...r, parou: `limite de taxa da Meta por ${seguidas} rodadas seguidas: unidades do número pausadas` };
        }
        return { ...r, parou: 'a Meta pediu para esperar (limite de taxa): tento de novo na próxima rodada' };
      }
      r.processados += 1;
      cabem -= 1;
      if (res === 'adiado') {
        adiados += 1;
        r.adiados += 1;
        if (adiados >= ADIADOS_PARA_PARAR) {
          porto.log('warn', { unit: u.slug, adiados }, 'disparo: pessoas adiadas demais nesta rodada (franquia, banco ou Kommo instáveis) — rodada encerrada');
          return { ...r, parou: `sistema instável: ${adiados} pessoas adiadas` };
        }
        continue;
      }
      if (r.mandou > mandouAntes) await porto.limiteDeTaxa(u.id, false); // um envio passou: o limite acabou
      seguidas = r.falhou > antes ? seguidas + 1 : 0;
      if (real && seguidas >= f.falhasSeguidas) {
        await porto.pausarOndas(u.id, null, `${f.falhasSeguidas} envios seguidos falharam na Meta: confira o token e a qualidade do número`, 'falhas');
        porto.log('warn', { unit: u.slug }, 'disparo: unidade PARADA por falhas seguidas (no meio da rodada)');
        await porto.avisar(alertaPausaPorFalhas({ unidade: u.slug, ondas: paraAvisar(porto, ativas), falhas: f.falhasSeguidas })).catch(() => undefined);
        return { ...r, parou: 'parada por falhas seguidas' };
      }
      await porto.dormir(f.pausaMs);
    }
    // Só uma lista inteira esgotada conclui a onda; com lista de teste ela nunca conclui (os outros seguem pendentes).
    if (real && !teste && (await porto.sobram(onda.id, via, null)) === 0 && (await porto.ondaAprovada(onda.id))) await porto.concluirOnda(onda.id);
  }
  return r;
}

/**
 * Quantas rodadas seguidas uma unidade ficou SEM ANDAR: só gente adiada, ninguém decidido (enviado, "receberia", falha, SAIR,
 * descartado). Rodada que não tentou ninguém (fora da janela, teto) não conta nem zera. O worker alerta quando passa de N.
 */
export function rodadasSemAndar(anterior: number, r: Pick<ResumoDaRodada, 'adiados' | 'mandou' | 'receberia' | 'falhou' | 'saiu' | 'descartados'>): number {
  const andou = r.mandou + r.receberia + r.falhou + r.saiu + r.descartados > 0;
  if (andou) return 0;
  return r.adiados > 0 ? anterior + 1 : anterior;
}
