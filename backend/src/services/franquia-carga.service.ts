/**
 * Carga de implantação: traz para o Kommo os pacientes que só existem na franquia.
 *
 * Roda uma vez, na implantação de uma unidade — não é worker. Serve aos dois casos que o João
 * descreveu (28/09/2026): povoar uma conta vazia, e organizar uma conta cujos cartões estão na
 * etapa errada. O mesmo mecanismo resolve os dois porque a decisão de etapa é a mesma:
 * `planejarMovimento`, a máquina que o sincronizador já usa de 15 em 15 minutos.
 *
 * ## Simula por padrão
 *
 * `aplicar` só cria quando quem chama pede explicitamente. Não existe apagar lead por API — nem no
 * Kommo nem na franquia — então uma carga errada é permanente, e 180 cartões errados são 180 erros
 * permanentes. A prévia existe para alguém conferir a distribuição por etapa antes.
 *
 * ## Recusa rodar com bot ativo
 *
 * Criar cartão em etapa que tem gatilho dispara o gatilho, e o gatilho manda template para paciente
 * de verdade — gente atendida meses atrás recebendo "sua consulta é amanhã". O cartão nascer direto
 * na etapa final já evita as transições, mas a etapa de destino em si pode ter gatilho de entrada.
 * Por isso a trava é dupla: etapa final E nenhum bot ativo na conta.
 *
 * ## De onde vêm os dados, e as três armadilhas da API da franquia
 *
 *   1. `searchSchedules` **não devolve `idClient`**, só `clientName` — o casamento é por nome.
 *   2. A janela tem de ser ≤ 30 dias, senão estoura o timeout de 30 s.
 *   3. `searchClients(unit, '', N)` devolve só 100 cadastros, e quase nenhum é quem tem agenda.
 *      Por isso se parte da AGENDA e busca cada paciente pelo nome.
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoClient } from './kommo.service.js';
import { searchClients, searchSchedules, searchTreatments, type SpineSchedule } from './spine.service.js';
import { carregarFunis, resolverLead, type Funis } from '../lib/franquia-sync-worker.js';
import { horasAteNegociacao, type TratamentoParaEtapa } from '../lib/franquia-move.js';
import { planejarCarga, porEtapa, type CartaoAcriar, type PacienteDaFranquia, type PlanoDeCarga } from '../lib/franquia-carga.js';
import { normalizar } from '../lib/franquia-sync.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/** Quantos meses para trás a carga olha. Além disso o paciente é história, não operação. */
const MESES_PARA_TRAS = 4;
/** A franquia estoura o timeout com janela maior que isto. */
const DIAS_POR_JANELA = 30;
const DIAS_PARA_FRENTE = 45;
/** Pausa entre criações: o Kommo derruba a conexão em rajada. */
const PAUSA_MS = 120;


/**
 * Roda em lotes concorrentes. A prévia fazia 2 chamadas por paciente EM SÉRIE — em Petrópolis,
 * 360 idas à franquia uma atrás da outra. O console desiste em 15 s e o próprio ssh caiu esperando.
 * Seis de cada vez é o que a franquia aguenta sem começar a recusar (ela já derruba conexão em rajada).
 */
const CONCORRENCIA = 6;
async function emLotes<T>(itens: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < itens.length; i += CONCORRENCIA) {
    await Promise.all(itens.slice(i, i + CONCORRENCIA).map((x) => fn(x).catch(() => undefined)));
  }
}

const diaDe = (base: Date, delta: number): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
};

export interface OpcoesCarga {
  /** meses para trás (padrão 4) */
  meses?: number;
}

export interface PreviaDaCarga {
  unidade: string;
  pacientesNaFranquia: number;
  criaria: number;
  porEtapa: Record<string, number>;
  fora: { jaTemCartao: number; semTelefone: number; semFato: number };
  /** alguns nomes, para a prévia não ser só número */
  exemplos: Array<{ nome: string; etapa: string; porque: string }>;
  /** janelas da agenda que a franquia não respondeu: com qualquer uma, a lista está incompleta */
  janelasComFalha: string[];
  /** quando não está liberado, diz o porquê — a tela mostra isso em vez do botão */
  bloqueio: string | null;
}

/** Varre a agenda da franquia em janelas de 30 dias e agrupa por paciente. */
async function coletarDaFranquia(unit: Unit, meses: number): Promise<{ porPaciente: Map<string, PacienteDaFranquia>; janelasComFalha: string[] }> {
  const hoje = new Date();
  const janelas: Array<[number, number]> = [];
  for (let inicio = -meses * 30; inicio < DIAS_PARA_FRENTE; inicio += DIAS_POR_JANELA) {
    janelas.push([inicio, Math.min(inicio + DIAS_POR_JANELA - 1, DIAS_PARA_FRENTE)]);
  }

  const porPaciente = new Map<string, PacienteDaFranquia>();
  const falhas: string[] = [];
  for (const [de, ate] of janelas) {
    try {
      const r = await searchSchedules(unit, { initialDate: diaDe(hoje, de), endDate: diaDe(hoje, ate) });
      // a franquia devolve {ok:false} em vez de lançar — sem isto a janela falha calada e a prévia mente
      if (!r?.ok) {
        falhas.push(`${diaDe(hoje, de)}..${diaDe(hoje, ate)}`);
        logger.warn({ unit: unit.slug, de, ate, erro: r?.error }, 'franquia-carga: janela da agenda falhou');
        continue;
      }
      for (const s of r?.data?.schedules ?? []) {
        if (!s.clientName) continue;
        const chave = normalizar(s.clientName);
        const p = porPaciente.get(chave) ?? { nome: s.clientName, idClient: null, telefone: null, agendamentos: [], tratamentos: [] };
        p.agendamentos.push(s as SpineSchedule);
        porPaciente.set(chave, p);
      }
    } catch (err) {
      // uma janela que falha não invalida a carga; a prévia mostra o total que sobrou
      logger.warn({ err, unit: unit.slug, de, ate }, 'franquia-carga: janela da agenda falhou');
    }
  }

  try {
    const t = await searchTreatments(unit);
    for (const tr of t?.data?.treatments ?? []) {
      if (!tr.clientName) continue;
      const chave = normalizar(tr.clientName);
      const p = porPaciente.get(chave) ?? { nome: tr.clientName, idClient: tr.idClient ?? null, telefone: null, agendamentos: [], tratamentos: [] };
      // o /treatments/search não devolve idStatus, só o nome — mesma conversão que o worker faz;
      // `finalizado()`/`aberto()` casam por regex no statusName quando o id não veio
      p.tratamentos.push({ idStatus: null, statusName: tr.statusName ?? null } satisfies TratamentoParaEtapa);
      p.idClient = p.idClient ?? tr.idClient ?? null;
      porPaciente.set(chave, p);
    }
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'franquia-carga: tratamentos indisponíveis');
  }
  return { porPaciente, janelasComFalha: falhas };
}

/** Busca o cadastro de cada paciente para pegar o WhatsApp — a agenda não traz telefone. */
async function completarContatos(unit: Unit, pacientes: Map<string, PacienteDaFranquia>): Promise<void> {
  await emLotes([...pacientes.entries()], async ([chave, p]) => {
    try {
      const r = await searchClients(unit, p.nome, 10);
      const achados = r?.data?.clients ?? [];
      // só nome idêntico. O fallback "se veio um só, é ele" grava o telefone de OUTRO paciente
      // num cartão que não dá pra apagar depois.
      const exato = achados.find((c) => normalizar(c.name) === chave);
      if (!exato) return;
      p.idClient = p.idClient ?? exato.idClient ?? null;
      p.telefone = exato.whatsapp ?? null;
    } catch {
      // paciente sem cadastro encontrável cai em 'sem-telefone' e aparece na prévia
    }
  });
}

/** Nenhum bot pode estar ativo: mover ou criar cartão em etapa com gatilho manda template a paciente real. */
async function botAtivo(kommo: KommoClient): Promise<boolean> {
  try {
    // a chave é `salesbot` — com `bots`/`items` a lista vem sempre vazia e a trava nunca bloqueia
    // (conferido contra units.controller.ts e api.routes.ts, que já liam certo)
    const raw = (await kommo.listSalesbots()) as { _embedded?: { salesbot?: Array<{ settings?: { active?: boolean }; is_active?: boolean }> } };
    return (raw?._embedded?.salesbot ?? []).some((b) => b?.settings?.active === true || b?.is_active === true);
  } catch {
    // não deu para checar: trata como ativo. Errar para o lado de não mandar mensagem.
    return true;
  }
}

async function montarPlano(unit: Unit, kommo: KommoClient, meses: number): Promise<{ plano: PlanoDeCarga; pacientes: number; janelasComFalha: string[] }> {
  const { porPaciente, janelasComFalha } = await coletarDaFranquia(unit, meses);
  await completarContatos(unit, porPaciente);

  const lista = [...porPaciente.values()];
  const temCartaoDe = new Map<string, boolean>();
  await emLotes(lista, async (p) => {
    const ids = p.agendamentos.map((c) => c.idSchedule).filter((x): x is number => typeof x === 'number');
    // O cache do resolverLead guarda "não achei" por 6 h. Se a carga rodar duas vezes dentro desse
    // prazo, ele repetiria o "não achei" e criaria tudo de novo — e lead não se apaga por API. O
    // vínculo gravado no banco é a resposta que não envelhece, então é ele que decide primeiro.
    const temVinculo = p.idClient
      ? (await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, spineIdClient: p.idClient }, select: { id: true } })) !== null
      : false;
    const leadId = temVinculo ? 1 : await resolverLead(unit, kommo, p.nome, p.idClient, ids);
    temCartaoDe.set(normalizar(p.nome), leadId !== null);
  });

  const plano = planejarCarga({
    pacientes: lista,
    temCartao: (p) => temCartaoDe.get(normalizar(p.nome)) === true,
    agoraEpoch: Math.floor(Date.now() / 1000),
    horasAteNegociacao: horasAteNegociacao(),
  });
  return { plano, pacientes: lista.length, janelasComFalha };
}

const contar = (plano: PlanoDeCarga, motivo: string) => plano.fora.filter((f) => f.motivo === motivo).length;

/** Prévia: o que a carga faria, sem escrever nada. */
export async function previaDaCarga(unit: Unit, opts: OpcoesCarga = {}): Promise<PreviaDaCarga> {
  const kommo = createKommoClient(unit);
  const funis = await carregarFunis(kommo);
  const { plano, pacientes, janelasComFalha } = await montarPlano(unit, kommo, opts.meses ?? MESES_PARA_TRAS);

  let bloqueio: string | null = null;
  if (janelasComFalha.length) bloqueio = `a franquia não respondeu em ${janelasComFalha.length} janela(s) (${janelasComFalha.join(', ')}) — a lista está incompleta`;
  if (!funis) bloqueio = 'não consegui ler os funis desta conta';
  else if (!bloqueio && await botAtivo(kommo)) bloqueio = 'há bot ativo na conta — desative todos antes, senão criar cartão dispara mensagem para paciente real';

  return {
    unidade: unit.slug,
    pacientesNaFranquia: pacientes,
    criaria: plano.criar.length,
    porEtapa: porEtapa(plano),
    fora: {
      jaTemCartao: contar(plano, 'ja-tem-cartao'),
      semTelefone: contar(plano, 'sem-telefone'),
      semFato: contar(plano, 'sem-fato'),
    },
    janelasComFalha,
    exemplos: plano.criar.slice(0, 8).map((c) => ({ nome: c.nome, etapa: c.status, porque: c.caminho[c.caminho.length - 1] ?? 'tem consulta na franquia' })),
    bloqueio,
  };
}

export interface ResultadoDaCarga {
  unidade: string;
  criados: number;
  falhas: number;
  porEtapa: Record<string, number>;
  erros: string[];
}

/** Aplica: cria de verdade. Só chame depois de alguém ver a prévia. */
export async function aplicarCarga(unit: Unit, opts: OpcoesCarga = {}): Promise<ResultadoDaCarga | { bloqueio: string }> {
  const kommo = createKommoClient(unit);
  const funis = await carregarFunis(kommo);
  if (!funis) return { bloqueio: 'não consegui ler os funis desta conta' };
  if (await botAtivo(kommo)) return { bloqueio: 'há bot ativo na conta — desative todos antes' };

  const { plano, janelasComFalha } = await montarPlano(unit, kommo, opts.meses ?? MESES_PARA_TRAS);
  if (janelasComFalha.length) return { bloqueio: `a franquia não respondeu em ${janelasComFalha.length} janela(s) — não crio cartão com lista incompleta` };
  const idClientFieldId = await acharCampoIdClient(kommo);

  let criados = 0;
  let falhas = 0;
  const erros: string[] = [];
  // conta o que FOI criado, não o que estava planejado: com qualquer falha os dois números divergem
  const criadosPorEtapa: Record<string, number> = {};
  for (const c of plano.criar) {
    const destino = funis.idDe(c.funil, c.status);
    if (!destino) {
      falhas++;
      if (erros.length < 5) erros.push(`${c.nome}: etapa «${c.status}» não existe no funil ${c.funil}`);
      continue;
    }
    try {
      const id = await criarUm(kommo, c, destino, idClientFieldId);
      if (id) {
        criados++;
        const chave = c.funil === 'TRATAMENTO' ? `TRATAMENTO / ${c.status}` : c.status;
        criadosPorEtapa[chave] = (criadosPorEtapa[chave] ?? 0) + 1;
        // grava o vínculo: é o que impede recriar tudo numa segunda rodada e o que faz o
        // sincronizador casar por vínculo em vez de por telefone na varredura seguinte
        if (c.idClient) {
          await prisma.spineLeadLink
            .create({ data: { unitId: unit.id, kommoLeadId: id, spineIdClient: c.idClient } })
            .catch(() => undefined);
        }
      } else {
        falhas++;
        if (erros.length < 5) erros.push(`${c.nome}: o Kommo não devolveu id`);
      }
    } catch (err) {
      falhas++;
      if (erros.length < 5) erros.push(`${c.nome}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, PAUSA_MS));
  }
  logger.info({ unit: unit.slug, criados, falhas }, 'franquia-carga: aplicada');
  return { unidade: unit.slug, criados, falhas, porEtapa: criadosPorEtapa, erros };
}

/**
 * O `⚙ idClient (franquia)` é o que faz o sincronizador casar por vínculo em vez de por telefone na
 * varredura seguinte. Sem ele a carga funciona, mas o casamento fica frágil.
 */
async function acharCampoIdClient(kommo: KommoClient): Promise<number | null> {
  try {
    const campos = await kommo.listLeadCustomFieldsTyped();
    return campos.find((f) => normalizar(f.name).includes('idclient'))?.id ?? null;
  } catch {
    return null;
  }
}

async function criarUm(
  kommo: KommoClient,
  c: CartaoAcriar,
  destino: { pipelineId: number; statusId: number },
  idClientFieldId: number | null,
): Promise<number | null> {
  return kommo.criarLeadComContato({
    nome: c.nome,
    telefone: c.telefone,
    pipelineId: destino.pipelineId,
    statusId: destino.statusId,
    customFields: idClientFieldId && c.idClient ? [{ field_id: idClientFieldId, values: [{ value: String(c.idClient) }] }] : undefined,
  });
}
