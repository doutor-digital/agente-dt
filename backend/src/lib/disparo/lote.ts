/**
 * Uma rodada do disparo para uma unidade: aplica os freios, escolhe quem e manda (ou, em seco, só decide).
 *
 * TODO o contato com o mundo passa pelo `Porto`. O envio de verdade (`porto.enviar`) e o espelho no Kommo
 * (`porto.espelhar`) só são chamados dentro de `enviarUm`, e `enviarUm` só é chamado quando o modo é `ligado`.
 * É essa única porta que o teste do modo seco tranca: com o modo `seco`, `enviar` e `espelhar` NUNCA rodam.
 */
import { falhasSeguidasDemais, dentroDaJanela, passouDoLimiteDeSair, vagas, type Freios } from './freios.js';
import { textoFinal, valoresDasVariaveis, type SituacaoNaFranquia } from './regras.js';
import type { Definicao } from './modelo.js';
import type { ResultadoDoTemplate } from '../whatsapp-meta.js';

export type Modo = 'ligado' | 'seco' | 'desligado';

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
  aprovadaEm: Date | null;
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
  /** Telefones (só dígitos) que podem receber de verdade; `null` = todos (decisão explícita, `*`); conjunto vazio = ninguém. Existe para provar em produção só no número do João. */
  listaDeTeste(): ReadonlySet<string> | null;
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
  pausarOndas(unitId: string, campanhaId: string | null, motivo: string): Promise<void>;
  pausarOnda(ondaId: string, motivo: string): Promise<void>;
  concluirOnda(ondaId: string): Promise<void>;
  pediuSair(d: Destino): Promise<boolean>;
  franquia(d: Destino): Promise<SituacaoNaFranquia>;
  enviar(onda: OndaNoLote, d: Destino, valores: string[]): Promise<ResultadoDoTemplate>;
  espelhar(d: Destino, texto: string): Promise<void>;
  dormir(ms: number): Promise<void>;
  log(nivel: 'info' | 'warn', dados: Record<string, unknown>, msg: string): void;
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
}

const vazio = (modo: Modo, parou?: string): ResumoDaRodada => ({ modo, parou, processados: 0, mandou: 0, receberia: 0, falhou: 0, saiu: 0, descartados: 0 });

/** A mensagem de erro da Meta em uma linha (código + texto), para o banco e a tela. */
export function motivoDaMeta(r: ResultadoDoTemplate): string {
  const e = (r.detalhe as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null)?.error;
  if (e) return `${r.incerto ? 'INCERTO: ' : ''}Meta ${e.code ?? '?'}: ${e.error_data?.details ?? e.message ?? 'sem detalhe'}`.slice(0, 300);
  return `${r.incerto ? 'INCERTO: ' : ''}${typeof r.detalhe === 'string' ? r.detalhe : 'a Meta não devolveu o id da mensagem'}`.slice(0, 300);
}

export function textoDoEspelho(onda: OndaNoLote, texto: string): string {
  return (
    `📲 Disparo de campanha pelo WhatsApp oficial (modelo ${onda.template}):\n${texto}\n\n` +
    'Esta nota existe porque o Kommo não mostra mensagem enviada por fora dele. O paciente recebeu normalmente.'
  );
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

type Resultado = 'pulou' | 'feito' | 'adiado';

/** MODO SECO: decide tudo, grava quem RECEBERIA, e não toca em nada que saia da casa. */
async function simularUm(porto: Porto, onda: OndaNoLote, u: UnidadeNoLote, d: Destino, r: ResumoDaRodada): Promise<Resultado> {
  const v = await aindaPode(porto, d);
  if (v.tipo === 'adiar') return 'adiado';
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
  try {
    const v = await aindaPode(porto, d);
    if (v.tipo === 'adiar') return 'adiado';
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
      await porto.gravar(d.id, { estado: 'enviado', wamid: res.wamid, enviadoEm: porto.agora() });
      r.mandou += 1;
      // Mensagem por fora do Kommo não aparece lá: sem a nota, a resposta do paciente chega sem a pergunta.
      await porto.espelhar(d, textoDoEspelho(onda, textoFinal(onda.textoModelo, valores))).catch((err) =>
        porto.log('warn', { unit: u.slug, err: String(err), lead: d.kommoLeadId }, 'disparo: enviei mas não consegui espelhar a nota no cartão'),
      );
      return 'feito';
    }
    // Recusa definitiva não conta no teto (a Meta não aceitou); incerta pode ter saído: conta e NUNCA é reenviada sozinha.
    await porto.gravar(d.id, { estado: 'falhou', motivo: motivoDaMeta(res), enviadoEm: res.incerto ? porto.agora() : null });
    r.falhou += 1;
    porto.log('warn', { unit: u.slug, onda: onda.id, motivo: motivoDaMeta(res) }, 'disparo: a Meta recusou o envio');
    return 'feito';
  } catch (err) {
    porto.log('warn', { unit: u.slug, onda: onda.id, err: String(err), chamouAMeta }, 'disparo: erro inesperado com uma pessoa');
    if (!chamouAMeta) {
      if (reivindicou) await porto.gravar(d.id, { estado: 'pendente', enviadoEm: null }).catch(() => undefined);
      return 'adiado';
    }
    await porto.gravar(d.id, { estado: 'falhou', motivo: `INCERTO: erro interno (${String(err).slice(0, 150)})`, enviadoEm: porto.agora() }).catch(() => undefined);
    r.falhou += 1;
    return 'feito';
  }
}

/** Depois de tantas pessoas adiadas na mesma rodada o problema não é a pessoa: é a franquia, o banco ou o Kommo. */
const ADIADOS_PARA_PARAR = 3;

/** Uma rodada de uma unidade, com as ondas APROVADAS dela em ordem de criação. */
export async function rodarUnidade(porto: Porto, f: Freios, u: UnidadeNoLote, ondas: OndaNoLote[]): Promise<ResumoDaRodada> {
  const modo = porto.modoDaUnidade(u.slug);
  if (modo === 'desligado') return vazio(modo, 'automação desligada nesta unidade');
  const r = vazio(modo);
  const real = modo === 'ligado';
  const via = real ? 'ligado' : 'seco';

  // Freio 1 — SAIR, por campanha: passou de N, a unidade para nessa campanha.
  let ativas = ondas;
  for (const campanhaId of new Set(ondas.map((o) => o.campanhaId))) {
    const sairam = await porto.quantosSairam(campanhaId, u.id);
    if (passouDoLimiteDeSair(sairam, f)) {
      await porto.pausarOndas(u.id, campanhaId, `${sairam} pessoas responderam SAIR (limite ${f.maxSair}): unidade parada até o João decidir`);
      porto.log('warn', { unit: u.slug, campanhaId, sairam }, 'disparo: unidade PARADA por excesso de SAIR');
      ativas = ativas.filter((o) => o.campanhaId !== campanhaId);
    }
  }
  if (ativas.length === 0) return { ...r, parou: 'parada por SAIR' };

  // Freio 2 — falhas seguidas: token vencido ou número bloqueado não é "a lista estar ruim".
  // Só olha envios DEPOIS da aprovação mais recente: consertou o token e aprovou de novo, começa limpo.
  const desdeAprovacao = new Date(Math.max(0, ...ativas.map((o) => o.aprovadaEm?.getTime() ?? 0)));
  if (real && falhasSeguidasDemais(await porto.ultimosResultados(u.id, f.falhasSeguidas, desdeAprovacao), f)) {
    await porto.pausarOndas(u.id, null, `${f.falhasSeguidas} envios seguidos falharam na Meta: confira o token e a qualidade do número`);
    porto.log('warn', { unit: u.slug }, 'disparo: unidade PARADA por falhas seguidas');
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
      await porto.pausarOnda(o.id, `a aprovação passou de ${f.validadeDias} dias: monte e aprove a onda de novo`);
      porto.log('warn', { unit: u.slug, onda: o.id }, 'disparo: aprovação VENCIDA, onda pausada');
    }
    ativas = ativas.filter((x) => x.aprovadaEm && x.aprovadaEm.getTime() >= vencimento);
    if (ativas.length === 0) return { ...r, parou: 'aprovação vencida' };
  }

  const teste = real ? porto.listaDeTeste() : null;
  if (teste && teste.size === 0) {
    porto.log('warn', { unit: u.slug }, 'disparo: unidade LIGADA mas sem lista de teste (DISPARO_LISTA_DE_TESTE) — ninguém recebe; use * para liberar todos');
    return { ...r, parou: 'ligada sem lista de teste: ninguém recebe' };
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
      const res = real ? await enviarUm(porto, onda, u, d, r) : await simularUm(porto, onda, u, d, r);
      if (res === 'pulou') continue; // perdeu a disputa para outro processo: não gasta vaga nem tempo
      r.processados += 1;
      cabem -= 1;
      if (res === 'adiado') {
        adiados += 1;
        if (adiados >= ADIADOS_PARA_PARAR) {
          porto.log('warn', { unit: u.slug, adiados }, 'disparo: pessoas adiadas demais nesta rodada (franquia, banco ou Kommo instáveis) — rodada encerrada');
          return { ...r, parou: `sistema instável: ${adiados} pessoas adiadas` };
        }
        continue;
      }
      seguidas = r.falhou > antes ? seguidas + 1 : 0;
      if (real && seguidas >= f.falhasSeguidas) {
        await porto.pausarOndas(u.id, null, `${f.falhasSeguidas} envios seguidos falharam na Meta: confira o token e a qualidade do número`);
        porto.log('warn', { unit: u.slug }, 'disparo: unidade PARADA por falhas seguidas (no meio da rodada)');
        return { ...r, parou: 'parada por falhas seguidas' };
      }
      await porto.dormir(f.pausaMs);
    }
    // Só uma lista inteira esgotada conclui a onda; com lista de teste ela nunca conclui (os outros seguem pendentes).
    if (real && !teste && (await porto.sobram(onda.id, via, null)) === 0 && (await porto.ondaAprovada(onda.id))) await porto.concluirOnda(onda.id);
  }
  return r;
}
