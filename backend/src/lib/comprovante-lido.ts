/**
 * A leitura do comprovante GUARDADA NO BANCO — a única fonte dos campos que decidem se a Sofia marca consulta (Boa Vista).
 *
 * Por quê: quando os campos vinham numa marca dentro do texto da conversa, qualquer texto que chegasse cru ao modelo podia fabricar
 * um comprovante perfeito (salesbot, Meta, áudio transcrito, conversa oficial do Kommo — provado pelo sênior no #190). Agora o servidor
 * lê a imagem, grava a leitura (`comprovantes_lidos`) presa à unidade, ao cartão e à imagem, e põe na fala só uma referência opaca
 * `[comprovante-lido:<uuid>]`. A decisão (`analisarConversa`) pede ao banco as leituras citadas, filtrando por unidade E cartão:
 * citar a referência de outro cartão, ou inventar uma, não devolve nada.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { ehTranscricaoDeComprovante } from './pagamento-antecipado.js';
import { neutralizarMarcasDoSistema, normalizarDados, referenciaDaLeitura, type DadosDoComprovante, type LeituraGuardada } from './comprovante-pix.js';
import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { desdeUltimaFalaDaSofia } from '../services/kommo-talks.service.js';
import { describeImage } from '../services/vision.service.js';

/** O pedaço do Prisma que isto usa (os testes passam um banco de mentira). */
export type BancoDeLeituras = Pick<typeof prisma, 'comprovanteLido'>;

/** Uma imagem = uma fonte: a mesma imagem lida duas vezes (turno retomado, mesma mensagem do Kommo) reaproveita a leitura. */
export const fonteDaUrl = (url: string) => `url:${createHash('sha256').update(url).digest('hex')}`;
export const fonteDaMensagemOficial = (idDaMensagem: string) => `talk:${idDaMensagem}`;

export interface NovaLeitura {
  unitId: string;
  leadId: number;
  fonte: string;
  tipo: 'imagem' | 'arquivo';
  ehComprovante: boolean;
  dados: DadosDoComprovante | null;
  erro?: string | null;
  modelo?: string | null;
  /** já chegou à conversa (imagem que não é comprovante: não há o que entregar) */
  entregue?: boolean;
  /** a leitura falhou (download, visão): fica registrada para a mesma imagem não ser tentada a cada mensagem do paciente */
  falhou?: boolean;
}

/** Prazo da reserva da entrega: o turno que entrega a leitura tem esse tempo para dar certo antes de outro assumir. */
export const PRAZO_DA_ENTREGA_MS = 5 * 60_000;
const MARCA_DE_FALHA = 'leitura falhou: ';

/** Grava a leitura (ou devolve a que já existe para a mesma imagem). */
export async function guardarLeitura(db: BancoDeLeituras, n: NovaLeitura): Promise<{ id: string; criadoEm: Date; entregueEm: Date | null; jaExistia: boolean }> {
  const chave = { unitId_kommoLeadId_fonte: { unitId: n.unitId, kommoLeadId: n.leadId, fonte: n.fonte } };
  const achar = () => db.comprovanteLido.findUnique({ where: chave, select: { id: true, criadoEm: true, entregueEm: true } });
  const ja = await achar();
  if (ja) return { ...ja, jaExistia: true };
  try {
    const c = await db.comprovanteLido.create({
      data: {
        unitId: n.unitId,
        kommoLeadId: n.leadId,
        fonte: n.fonte,
        tipo: n.tipo,
        ehComprovante: n.ehComprovante,
        dados: n.dados === null ? Prisma.DbNull : (n.dados as unknown as Prisma.InputJsonValue),
        erro: n.falhou ? `${MARCA_DE_FALHA}${n.erro ?? ''}` : n.erro ?? null,
        modelo: n.modelo ?? null,
        entregueEm: n.entregue || n.falhou ? new Date() : null,
        reivindicadaEm: n.entregue || n.falhou ? null : new Date(),
      },
      select: { id: true, criadoEm: true, entregueEm: true },
    });
    return { ...c, jaExistia: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const de_novo = await achar();
      if (de_novo) return { ...de_novo, jaExistia: true };
    }
    throw err;
  }
}

/**
 * As leituras citadas, DESTE cartão e desta unidade. Banco fora do ar LANÇA o erro: "não consegui perguntar" não é "não existe" (o grafo não
 * marca nada nesse turno e pergunta de novo na volta seguinte).
 */
export async function carregarLeituras(db: BancoDeLeituras, unitId: string, leadId: number | undefined, ids: ReadonlyArray<string>): Promise<Map<string, LeituraGuardada>> {
  const mapa = new Map<string, LeituraGuardada>();
  if (!leadId || ids.length === 0) return mapa;
  const linhas = await db.comprovanteLido.findMany({
    where: { id: { in: [...ids] }, unitId, kommoLeadId: leadId, ehComprovante: true },
    select: { id: true, dados: true, criadoEm: true },
  });
  for (const l of linhas) mapa.set(l.id.toLowerCase(), { dados: normalizarDados(l.dados), recebidoEm: l.criadoEm.getTime() });
  return mapa;
}

/**
 * A fala do paciente com a imagem lida — o mesmo formato do webhook de sempre ("[imagem do cliente]: COMPROVANTE: …"), a referência à
 * leitura guardada e o carimbo da hora em que foi lida (só do fluxo antigo, a espera da equipe; a decisão de marcar usa a hora do banco).
 */
export function descricaoComReferencia(descricao: string, id: string, lidaEm: Date): string {
  return `${descricao} ${referenciaDaLeitura(id)} [recebido-em:${lidaEm.toISOString()}]`;
}

export function segmentoDaLeitura(tipo: 'imagem' | 'arquivo', descricao: string, id: string, lidaEm: Date): string {
  return `[${tipo} do cliente]: ${descricaoComReferencia(descricao, id, lidaEm)}`;
}

// --- Rota do salesbot: o texto chega sem a imagem; ela está na conversa oficial do Kommo --------------------------------------------

const ANEXO_DE_IMAGEM_OU_ARQUIVO = /^(?:picture|file|document|image|image\/[\w.+-]+|application\/pdf)$/i;
/** Tipos que PARECEM foto ou documento (mesmo os que o servidor não sabe ler): esses não podem sumir em silêncio. Contato, enquete, reação… ficam de fora. */
const ANEXO_QUE_PARECE_IMAGEM_OU_ARQUIVO = /(?:pic|photo|image|img|file|doc|pdf|attach|media|scan)/i;
/** Anexos que nunca são comprovante e que ninguém precisa ver: áudio, vídeo, figurinha… */
const ANEXO_QUE_NAO_E_COMPROVANTE = /^(?:voice|audio|video|sticker|gif|location|contact|link)(?:\/.*)?$/i;
const JANELA_DOS_ANEXOS_MS = 72 * 3_600_000;
const MAX_ANEXOS_POR_TURNO = 3;
/** Tentativas por turno (as que falham não ocupam as vagas das lidas, mas também não podem custar chamadas sem fim). */
const MAX_TENTATIVAS_POR_TURNO = 6;

export interface DepsDosAnexos {
  db: BancoDeLeituras;
  descrever: typeof describeImage;
  agora: () => number;
}

export interface AnexosLidos {
  texto: string;
  lidos: number;
  comprovantes: number;
  /** as leituras de comprovante postas na fala: depois de o turno dar certo, `marcarEntregues` */
  paraEntregar: string[];
  /** anexos do paciente que NÃO foi possível ler neste turno (download ou visão): o modelo é avisado e a equipe ganha a tarefa */
  naoLidos: number;
}

/**
 * Salesbot (por onde Boa Vista conversa): o `message` é só texto, sem a imagem. Aqui as imagens/PDFs que o paciente mandou (rota oficial
 * do Kommo, últimas 72 h) e que ainda não foram lidas são lidas pelo servidor — leitura de sempre + a leitura em campos —, guardadas
 * no banco e devolvidas como falas do paciente para o modelo. Só o que é COMPROVANTE vira fala; o resto é registrado para não ser lido
 * outra vez a cada turno. O MAIS NOVO vai primeiro, e a leitura que falha não ocupa vaga. Comprovante lido num turno que depois falhou
 * (sem `entregueEm`) é entregue de novo no turno seguinte, sem ler a imagem outra vez. Falha de leitura nunca derruba o turno.
 */
export async function lerAnexosDoPaciente(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoAccessToken' | 'openaiApiKey' | 'spineBookingRequiresPayment'>,
  leadId: number,
  msgs: ReadonlyArray<MensagemOficial> | null,
  deps: Partial<DepsDosAnexos> = {},
): Promise<AnexosLidos> {
  const d: DepsDosAnexos = { db: deps.db ?? prisma, descrever: deps.descrever ?? describeImage, agora: deps.agora ?? Date.now };
  const vazio: AnexosLidos = { texto: '', lidos: 0, comprovantes: 0, paraEntregar: [], naoLidos: 0 };
  if (!unit.spineBookingRequiresPayment || !msgs?.length) return vazio;

  // Só o que chegou DEPOIS da última fala da Sofia (como a conversa oficial do turno): anexo velho que nunca foi lido não entra na fala de
  // hoje como se fosse deste turno — o comprovante de uma consulta que já passou não paga a próxima.
  const doPaciente = desdeUltimaFalaDaSofia([...msgs]).filter((m) => m.direcao === 'entrada' && m.autor === 'paciente' && m.anexo && d.agora() - m.em.getTime() <= JANELA_DOS_ANEXOS_MS);
  const legivel = (m: MensagemOficial) => Boolean(m.anexo?.link) && ANEXO_DE_IMAGEM_OU_ARQUIVO.test(m.anexo?.tipo ?? '');
  // anexo que não é áudio/vídeo/figurinha e que o servidor não sabe ler (tipo desconhecido, sem link): não pode sumir em silêncio — o modelo é avisado
  // e a equipe ganha a tarefa (o comprovante pode estar ali)
  const semComoLer = doPaciente.filter((m) => !legivel(m) && !ANEXO_QUE_NAO_E_COMPROVANTE.test(m.anexo?.tipo ?? '') && ANEXO_QUE_PARECE_IMAGEM_OU_ARQUIVO.test(m.anexo?.tipo ?? '')).length;
  const candidatas = doPaciente
    .filter(legivel)
    // o MAIS NOVO primeiro: o comprovante que o paciente acabou de mandar não espera atrás de anexos antigos (que podem estar com o link vencido)
    .sort((a, b) => b.em.getTime() - a.em.getTime());
  if (candidatas.length === 0) return { ...vazio, naoLidos: semComoLer };

  // uma ida ao banco para saber o que já foi lido
  type Existente = { id: string; fonte: string; tipo: string; ehComprovante: boolean; entregueEm: Date | null; erro: string | null; criadoEm: Date };
  let existentes: Existente[] = [];
  try {
    existentes = (await d.db.comprovanteLido.findMany({
      where: { unitId: unit.id, kommoLeadId: leadId, fonte: { in: candidatas.map((m) => fonteDaMensagemOficial(m.id)) } },
      select: { id: true, fonte: true, tipo: true, ehComprovante: true, entregueEm: true, erro: true, criadoEm: true },
    })) as Existente[];
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'comprovante: não consegui saber o que já foi lido (segue sem os anexos)');
    return vazio;
  }
  const porFonte = new Map(existentes.map((e) => [e.fonte, e]));

  const falas: Array<{ em: number; fala: string }> = [];
  const paraEntregar: string[] = [];
  let lidos = 0;
  let tentativas = 0;
  let comprovantes = 0;
  let naoLidos = semComoLer;
  for (const m of candidatas) {
    const fonte = fonteDaMensagemOficial(m.id);
    const ja = porFonte.get(fonte);
    if (ja) {
      // a leitura FALHOU num turno anterior e o anexo ainda é posterior à última fala da Sofia (o turno que avisou não respondeu): avisa de novo
      if (ja.erro?.startsWith(MARCA_DE_FALHA)) naoLidos++;
      // lido antes e nunca entregue (o turno que o leu falhou): entrega de novo, sem pagar a visão outra vez — mas só quem ganhar a
      // reivindicação (prazo de 5 min): duas mensagens seguidas do paciente não entregam o mesmo comprovante duas vezes
      if (ja.ehComprovante && ja.entregueEm === null) {
        const ganhou = await d.db.comprovanteLido
          .updateMany({ where: { id: ja.id, entregueEm: null, reivindicadaEm: { lt: new Date(d.agora() - PRAZO_DA_ENTREGA_MS) } }, data: { reivindicadaEm: new Date(d.agora()) } })
          .catch(() => ({ count: 0 }));
        if (ganhou.count === 1) {
          comprovantes++;
          paraEntregar.push(ja.id);
          falas.push({ em: m.em.getTime(), fala: `[${ja.tipo === 'arquivo' ? 'arquivo' : 'imagem'} do cliente]: COMPROVANTE: leitura guardada pelo servidor ${referenciaDaLeitura(ja.id)} [recebido-em:${new Date(d.agora()).toISOString()}]` });
        }
      }
      continue;
    }
    if (lidos >= MAX_ANEXOS_POR_TURNO || tentativas >= MAX_TENTATIVAS_POR_TURNO) continue;
    try {
      tentativas++;
      const v = await d.descrever(unit, m.anexo?.link as string, { estruturarComprovante: true });
      lidos++;
      // texto escrito DENTRO da imagem e transcrito pela visão não pode se passar pelas marcas que só o servidor grava
      const texto = neutralizarMarcasDoSistema(v.text);
      const ehComprovante = ehTranscricaoDeComprovante(`[${v.tipo} do cliente]: ${texto}`);
      const g = await guardarLeitura(d.db, {
        unitId: unit.id,
        leadId,
        fonte,
        tipo: v.tipo,
        ehComprovante,
        dados: v.comprovante?.dados ?? null,
        erro: v.comprovante?.erro ?? null,
        modelo: v.comprovante?.modelo ?? null,
        entregue: !ehComprovante,
      });
      if (ehComprovante && !g.jaExistia) {
        comprovantes++;
        paraEntregar.push(g.id);
        falas.push({ em: m.em.getTime(), fala: segmentoDaLeitura(v.tipo, texto, g.id, g.criadoEm) });
      }
    } catch (err) {
      logger.warn({ err: String(err), leadId, unit: unit.slug, mensagem: m.id }, 'comprovante: não consegui ler o anexo do paciente na conversa oficial (segue sem)');
      naoLidos++;
      // registra a falha: a mesma imagem não é tentada a cada mensagem do paciente (o aviso à equipe, `naoLidos`, cobre o resto)
      await guardarLeitura(d.db, {
        unitId: unit.id, leadId, fonte, tipo: /file|doc|pdf/i.test(m.anexo?.tipo ?? '') ? 'arquivo' : 'imagem', ehComprovante: false, dados: null, erro: err instanceof Error ? err.message : String(err), falhou: true,
      }).catch(() => undefined);
    }
  }
  // na ordem em que o paciente as mandou
  return { texto: falas.sort((a, b) => a.em - b.em).map((f) => f.fala).join('\n\n'), lidos, comprovantes, paraEntregar, naoLidos };
}

/** O turno que carregava as leituras deu certo: elas não precisam ser entregues de novo. */
export async function marcarEntregues(db: BancoDeLeituras, ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return;
  await db.comprovanteLido.updateMany({ where: { id: { in: [...ids] }, entregueEm: null }, data: { entregueEm: new Date() } });
}
