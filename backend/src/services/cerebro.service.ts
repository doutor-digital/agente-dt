/**
 * O panorama que o cérebro lê: a franquia e o Kommo contados lado a lado.
 *
 * A divisão de trabalho aqui é a razão de existir do produto. O servidor faz o
 * casamento DURO — telefone, que é a medida padrão — e só ele. O que não casa por
 * telefone volta marcado como ambíguo, com os candidatos, pro agente julgar lendo o
 * contexto. Regra fixa nunca vai decidir se "EDSON DO VALESOUSA" é o "Edson do Vale
 * Sousa" do cartão; e IA nunca deveria estar adivinhando o que um telefone resolve.
 *
 * Só leitura. Nada aqui escreve no Kommo nem na franquia.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { searchClients, searchSchedules, searchTreatments, type SpineUnit } from './spine.service.js';
import { createKommoClient } from './kommo.service.js';

/**
 * Quanto tempo a conferência no Kommo pode tomar do request. O timeout do Kommo é de
 * 15 s por chamada, então isto é ~2 chamadas travadas antes de desistir e avisar.
 */
const ORCAMENTO_KOMMO_MS = 30_000;

/**
 * O cartão que um contato do Kommo representa, se e só se o telefone bater.
 *
 * Isolada e exportada de propósito: é aqui que mora a decisão de aceitar ou recusar um
 * casamento, e é o que o teste prende. A busca do Kommo é textual — ela devolve quem
 * *parece* com o que pedimos. Esta função ignora a sugestão e olha só os dígitos.
 */
export function cartaoDoContato(
  procurado: string | null,
  contatos: Array<{ id: number; nome: string | null; telefone: string | null; leadIds: number[] }>,
): { leadId: number; etapa: string | null; nome: string | null } | null {
  const alvo = chaveTelefone(procurado);
  if (!alvo) return null;
  for (const c of contatos) {
    if (chaveTelefone(c.telefone) !== alvo) continue;
    // Contato sem lead é contato solto na agenda do Kommo: existe, mas não é cartão.
    const ids = c.leadIds.filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) continue;
    // O maior id é o cartão mais novo — é o que a recepção está olhando hoje.
    return { leadId: Math.max(...ids), etapa: null, nome: c.nome };
  }
  return null;
}

/** Dígitos do telefone, sem DDI e sem o 9 que ora está ora não está. */
export function chaveTelefone(bruto: string | null | undefined): string | null {
  const so = String(bruto ?? '').replace(/\D/g, '');
  if (so.length < 10) return null;
  const semDdi = so.startsWith('55') && so.length > 11 ? so.slice(2) : so;
  if (semDdi.length < 10) return null;
  const ddd = semDdi.slice(0, 2);
  let resto = semDdi.slice(2);
  // Celular brasileiro escrito com e sem o 9 é a mesma linha.
  if (resto.length === 9 && resto.startsWith('9')) resto = resto.slice(1);
  return `${ddd}${resto}`;
}

export function normalizarNome(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dois nomes que provavelmente são a mesma pessoa, sem afirmar que são.
 * Devolve 0..1. Compara conjunto de pedaços: pega sobrenome faltando e ordem trocada,
 * mas NÃO resolve "Valesousa" × "Vale Sousa" — esse é o caso que vai pro agente.
 */
export function parecencaDeNome(a: string, b: string): number {
  const pa = new Set(normalizarNome(a).split(' ').filter((p) => p.length > 2));
  const pb = new Set(normalizarNome(b).split(' ').filter((p) => p.length > 2));
  if (!pa.size || !pb.size) return 0;
  let comuns = 0;
  for (const p of pa) if (pb.has(p)) comuns++;
  return comuns / Math.min(pa.size, pb.size);
}

export interface Sessao {
  dia: string;
  hora: string;
  status: string;
  idTreatment: number | null;
  profissional: string | null;
}

export interface PacienteDoCerebro {
  nome: string;
  telefone: string | null;
  sessoes: Sessao[];
  tratamentos: Array<{ categoria: string; status: string; preco: number | null; criado: string | null }>;
  /** `etapa` fica nulo aqui: o vínculo não guarda a etapa do cartão — quem quiser lê no Kommo. */
  cartao: { leadId: number; etapa: string | null; nome: string | null } | null;
  /** Como o cartão foi encontrado. `null` = não encontrado. */
  casadoPor: 'vinculo' | 'telefone' | 'telefone-kommo' | null;
  /**
   * Se o Kommo chegou a ser consultado sobre esta pessoa. `false` com `cartao: null`
   * NÃO quer dizer que ela não tem cartão — quer dizer que ninguém perguntou.
   */
  conferidoNoKommo: boolean;
  /** Cartões que PODEM ser esta pessoa, pro agente decidir. Só quando não casou duro. */
  candidatos: Array<{ leadId: number; nome: string | null; parecenca: number }>;
}

export interface Panorama {
  unidade: string;
  geradoEm: string;
  janela: { dias: number; meses: number };
  contagens: {
    sessoes: number;
    tratamentos: number;
    pacientesNaFranquia: number;
    cartoesVinculados: number;
    casadosPorVinculo: number;
    casadosPorTelefone: number;
    /** Casados perguntando ao Kommo — gente com cartão que nunca conversou com a IA. */
    casadosPorTelefoneNoKommo: number;
    /** Sem cartão de verdade: conferido no Kommo e não achado. */
    semCartao: number;
    /** Ficaram sem conferir (sem telefone, sem credencial, ou a conferência parou). */
    naoConferidos: number;
    ambiguos: number;
  };
  /** Só quem tem algo a resolver: sem cartão, ambíguo, ou sumindo. */
  paraOlhar: PacienteDoCerebro[];
  avisos: string[];
}

const dia = (d: Date) => d.toISOString().slice(0, 10);
const FALTOU = /DESMARC|FALT|NAO COMPARE|NÃO COMPARE/i;

export async function panoramaDaUnidade(
  unit: Unit,
  opts: { dias?: number; meses?: number } = {},
): Promise<Panorama> {
  const dias = Math.min(Math.max(opts.dias ?? 60, 1), 180);
  const meses = Math.min(Math.max(opts.meses ?? 6, 1), 12);
  const hoje = dia(new Date());
  const avisos: string[] = [];

  const [agenda, tratamentos] = await Promise.all([
    searchSchedules(unit as SpineUnit, {
      initialDate: dia(new Date(Date.now() - dias * 864e5)),
      endDate: hoje,
      rowsPerPage: 100,
    }),
    searchTreatments(unit as SpineUnit, { meses }),
  ]);
  if (!agenda.ok) avisos.push(`agenda da franquia indisponível: ${agenda.error}`);
  if (!tratamentos.ok) avisos.push(`tratamentos indisponíveis: ${tratamentos.error}`);
  const sessoes = agenda.ok ? (agenda.data?.schedules ?? []) : [];
  const trats = tratamentos.ok ? (tratamentos.data?.treatments ?? []) : [];

  // O lado do Kommo: o vínculo duro e o telefone da conversa.
  const [vinculos, conversas] = await Promise.all([
    prisma.spineLeadLink.findMany({
      where: { unitId: unit.id },
      select: { kommoLeadId: true, nome: true, spineIdClient: true, spineIdSchedule: true, agendadoPara: true },
    }),
    prisma.conversation.findMany({
      where: { unitId: unit.id, phone: { not: null } },
      select: { leadId: true, phone: true },
    }),
  ]);

  const cartaoPorTelefone = new Map<string, { leadId: number; etapa: string | null; nome: string | null }>();
  for (const c of conversas) {
    const k = chaveTelefone(c.phone);
    const id = Number(c.leadId);
    if (!k || !Number.isFinite(id)) continue;
    if (!cartaoPorTelefone.has(k)) cartaoPorTelefone.set(k, { leadId: id, etapa: null, nome: null });
  }
  const vinculoPorNome = new Map<string, (typeof vinculos)[number]>();
  for (const v of vinculos) if (v.nome) vinculoPorNome.set(normalizarNome(v.nome), v);

  // Junta a franquia por paciente.
  const pacientes = new Map<string, PacienteDoCerebro>();
  const pega = (nome: string): PacienteDoCerebro => {
    const k = normalizarNome(nome);
    let p = pacientes.get(k);
    if (!p) {
      p = {
        nome, telefone: null, sessoes: [], tratamentos: [],
        cartao: null, casadoPor: null, conferidoNoKommo: false, candidatos: [],
      };
      pacientes.set(k, p);
    }
    return p;
  };
  for (const s of sessoes) {
    if (!s.clientName) continue;
    pega(s.clientName).sessoes.push({
      dia: s.dayLocal ?? '',
      hora: s.timeLocal ?? '',
      status: s.statusName ?? '',
      idTreatment: s.idTreatment ?? null,
      profissional: s.physicalTherapist ?? null,
    });
  }
  for (const t of trats) {
    if (!t.clientName) continue;
    pega(t.clientName).tratamentos.push({
      categoria: t.category ?? '',
      status: t.statusName ?? '',
      preco: typeof t.price === 'number' ? t.price : null,
      criado: t.created ?? null,
    });
  }

  let porVinculo = 0;
  let porTelefone = 0;
  let porKommo = 0;
  for (const [chave, p] of pacientes) {
    const v = vinculoPorNome.get(chave);
    if (v) {
      p.cartao = { leadId: v.kommoLeadId, etapa: null, nome: v.nome };
      p.casadoPor = 'vinculo';
      porVinculo++;
      continue;
    }
    // O telefone é a medida padrão: casa duro quando a franquia traz o número.
    const tel = chaveTelefone(p.telefone);
    const porTel = tel ? cartaoPorTelefone.get(tel) : undefined;
    if (porTel) {
      p.cartao = porTel;
      p.casadoPor = 'telefone';
      porTelefone++;
      continue;
    }
    // Sem vínculo: o agente vai precisar decidir. Oferece os candidatos por nome,
    // com a parecença medida — nunca escolhe por ele.
    const cands = vinculos
      .filter((x) => x.nome)
      .map((x) => ({ leadId: x.kommoLeadId, nome: x.nome, parecenca: parecencaDeNome(p.nome, x.nome!) }))
      .filter((x) => x.parecenca >= 0.5)
      .sort((a, b) => b.parecenca - a.parecenca)
      .slice(0, 3);
    p.candidatos = cands;
  }

  const sumindo = (p: PacienteDoCerebro): number => {
    let n = 0;
    for (const s of [...p.sessoes].sort((a, b) => a.dia.localeCompare(b.dia)).reverse()) {
      if (/REMARC/i.test(s.status)) continue;
      if (FALTOU.test(s.status)) n++;
      else break;
    }
    return n;
  };

  const paraOlhar = [...pacientes.values()]
    .filter((p) => !p.cartao || p.candidatos.length > 0 || sumindo(p) >= 2)
    .sort((a, b) => sumindo(b) - sumindo(a))
    .slice(0, 120);

  // Só agora vamos atrás do telefone, e só de quem vai aparecer no relatório: a franquia
  // não manda o número na agenda, e buscar o cadastro de todo paciente seria uma chamada
  // por pessoa — desnecessário pra quem já casou pelo vínculo. Com o número em mãos, boa
  // parte do "sem cartão" vira casamento duro e sai da lista de julgamento do agente.
  const semCartao = paraOlhar.filter((p) => !p.cartao);
  for (let i = 0; i < semCartao.length; i += 5) {
    const lote = semCartao.slice(i, i + 5);
    await Promise.all(
      lote.map(async (p) => {
        const r = await searchClients(unit as SpineUnit, p.nome, 5).catch(() => null);
        if (!r?.ok) return;
        const exato = (r.data?.clients ?? []).find((c) => normalizarNome(c.name) === normalizarNome(p.nome));
        p.telefone = exato?.whatsapp ?? null;
        const tel = chaveTelefone(p.telefone);
        const achado = tel ? cartaoPorTelefone.get(tel) : undefined;
        if (achado) {
          p.cartao = achado;
          p.casadoPor = 'telefone';
          p.candidatos = [];
          porTelefone++;
        }
      }),
    );
  }

  // Última parada: perguntar ao próprio Kommo.
  //
  // Até aqui só olhamos o NOSSO banco — o vínculo e o telefone de quem conversou com a
  // IA. Quem tem cartão no Kommo mas nunca falou com ela (entrou por ligação, veio na
  // recepção, ou é anterior à IA) ficava marcado como "sem cartão". Medido em Marabá,
  // 25/09/2026: os NOVE que o relatório apontou como sem cartão tinham cartão, todos
  // achados pelo telefone. Era o furo inteiro do produto — ele comparava a franquia
  // contra o nosso espelho, não contra a fonte.
  //
  // Só entra quem sobrou E tem telefone. O resto continua indo pro julgamento humano,
  // que é o certo: sem telefone não existe casamento duro.
  const aindaSemCartao = paraOlhar.filter((p) => !p.cartao && chaveTelefone(p.telefone));
  if (aindaSemCartao.length && !unit.kommoAccessToken) {
    // Unidade sem Kommo configurado existe (cidade nova, token ainda não colado). Sem
    // este desvio, `createKommoClient` lança e o panorama inteiro morre — o relatório
    // do dia não sai por causa de uma etapa opcional.
    avisos.push('unidade sem credencial do Kommo: não deu pra conferir quem está sem cartão');
  } else if (aindaSemCartao.length) {
    const kommo = createKommoClient(unit);
    // Teto de tempo, não de quantidade. O que trava aqui é o Kommo lento, e o timeout
    // dele é de 15 s: 120 pacientes em série no pior caso seriam 30 minutos segurando o
    // request de quem chamou. Estourou o orçamento, para e diz que parou.
    const limite = Date.now() + ORCAMENTO_KOMMO_MS;
    let conferidos = 0;
    for (const p of aindaSemCartao) {
      if (Date.now() > limite) {
        avisos.push(
          `conferência no Kommo parou no tempo: ${conferidos} de ${aindaSemCartao.length} conferidos — ` +
            'os demais podem ter cartão',
        );
        break;
      }
      // Em série de propósito: são poucas dezenas por rodada, uma vez por dia, e o
      // Kommo derruba rajada. Paralelizar aqui compraria segundos e pagaria em 429.
      const contatos = await kommo.buscarContatos(chaveTelefone(p.telefone)!, 10).catch(() => null);
      if (contatos === null) {
        // Falhou a consulta, não é "não achou". Para na primeira: se o token venceu ou
        // estamos em 429, as próximas 119 vão falhar igual, devagar, e o relatório sairia
        // dizendo "sem cartão" para gente que tem cartão. Era esse o bug.
        avisos.push(
          `Kommo não respondeu a conferência: ${conferidos} de ${aindaSemCartao.length} conferidos — ` +
            'os demais podem ter cartão',
        );
        break;
      }
      conferidos++;
      p.conferidoNoKommo = true;
      const cartao = cartaoDoContato(p.telefone, contatos);
      if (!cartao) continue;
      p.cartao = cartao;
      p.casadoPor = 'telefone-kommo';
      p.candidatos = [];
      porKommo++;
    }
  }

  return {
    unidade: unit.slug,
    geradoEm: new Date().toISOString(),
    janela: { dias, meses },
    contagens: {
      sessoes: sessoes.length,
      tratamentos: trats.length,
      pacientesNaFranquia: pacientes.size,
      cartoesVinculados: vinculos.length,
      casadosPorVinculo: porVinculo,
      casadosPorTelefone: porTelefone,
      casadosPorTelefoneNoKommo: porKommo,
      // Só conta como "sem cartão" quem foi conferido no Kommo e mesmo assim não tem.
      // Quem não foi conferido entra em `naoConferidos` — são coisas diferentes.
      semCartao: paraOlhar.filter((p) => !p.cartao && p.conferidoNoKommo).length,
      naoConferidos: paraOlhar.filter((p) => !p.cartao && !p.conferidoNoKommo).length,
      ambiguos: paraOlhar.filter((p) => !p.cartao && p.candidatos.length > 0).length,
    },
    paraOlhar,
    avisos,
  };
}

/** A ficha de um paciente, pro agente aprofundar num caso que o panorama marcou. */
export async function pacienteDoCerebro(
  unit: Unit,
  busca: string,
  opts: { dias?: number; meses?: number } = {},
): Promise<PacienteDoCerebro | null> {
  const pano = await panoramaDaUnidade(unit, opts);
  const alvo = normalizarNome(busca);
  const tel = chaveTelefone(busca);
  return (
    pano.paraOlhar.find((p) => normalizarNome(p.nome) === alvo) ??
    pano.paraOlhar.find((p) => (tel ? chaveTelefone(p.telefone) === tel : false)) ??
    pano.paraOlhar.find((p) => parecencaDeNome(p.nome, busca) >= 0.6) ??
    null
  );
}
