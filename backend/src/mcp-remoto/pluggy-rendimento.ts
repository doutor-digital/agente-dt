/**
 * `pluggy_rendimento_sofia` — «quanto a Sofia rendeu»: cruza o dinheiro que ENTROU no banco (Pluggy, Pix com nome) com os PACIENTES da agenda da franquia, separados em
 * quem a Sofia atendeu/marcou e quem a equipe marcou. Só leitura; só para quem altera cartões (a mesma regra das outras `pluggy_*`, dado bancário é sensível).
 *
 * COMO ATRIBUI, e só assim (nada é inventado; o que não fecha vai para «não atribuído»):
 *  1. PESSOAS = os pacientes com marcação na agenda da franquia entre 30 dias antes do início e 30 dias depois do fim do período (a agenda dá só o NOME: a franquia
 *     não tem CPF no cadastro). Duas marcações com o MESMO nome inteiro são a mesma pessoa.
 *  2. ORIGEM de cada pessoa: `sofia` se a marcação dela é a que a Sofia gravou (`conversation_outcomes.spine_id_schedule`) OU se o nome (primeiro + último) é igual ao de
 *     uma conversa que a Sofia atendeu (90 dias antes do início até o fim); `equipe` se nenhuma conversa da Sofia tem nome igual nem parecido; `incerta` se só há nome PARECIDO.
 *  3. PIX → PESSOA pelo nome de quem pagou (primeiro + último, sem acento). Um Pix só vai para uma pessoa se EXATAMENTE UMA pessoa da agenda tem aquele nome; zero, várias,
 *     nome só parecido, empresa (CNPJ), pessoa de origem `incerta` → «não atribuído», com o motivo contado.
 *  4. VENDA DE MAQUININHA («Vendas…») chega agregada e sem nome: não é de ninguém. Entradas que não são Pix (TED, depósito, transferência): idem.
 * Os três blocos somam o que entrou na conta bancária no período (a `conferencia` confere). Cartão de crédito fora (é fatura, não dinheiro que entrou).
 *
 * LIMITES (vão no campo `nota`): quem paga em nome de outra pessoa (pai, filho, cônjuge) cai em «não atribuído»; dois pacientes com o mesmo primeiro e último nome e
 * nomes do meio diferentes são ambíguos; o nome da conversa nem sempre é o nome de registro (apelido do WhatsApp) e então a pessoa conta como `equipe`; a Sofia
 * conta como origem de quem ela ATENDEU, não só de quem ela marcou (o subconjunto «marcou» vem separado). Nenhum nome sai a menos que `detalhar=true`, e então só o
 * primeiro nome e o valor.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, somarDias } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { primeiroNome } from '../lib/aviso-clinica-agendamento.js';
import { tirarSegredos } from '../lib/integracoes/pluggy.js';
import { chaveDoNome, compararNomes, entradasDoBanco, tokensDoNome, type PixRecebido } from '../lib/pix-casamento.js';
import { AVISO_DE_FRESCOR, MAX_DIAS, lerPeriodo, type ContextoPluggy } from './pluggy.js';

/** Quanto a agenda é lida antes do início e depois do fim do período (o paciente paga antes de vir e depois de começar o tratamento). */
export const FOLGA_DA_AGENDA_DIAS = 30;
/** Conversas da Sofia lidas desde tantos dias antes do início. */
export const RETROSPECTO_DA_SOFIA_DIAS = 90;

export interface ConversaDaSofia {
  nome: string | null;
  /** a Sofia gravou uma consulta nesta conversa */
  marcou: boolean;
  /** id da marcação na franquia, quando a Sofia a gravou */
  idSchedule: number | null;
}

export interface PacienteDaAgenda {
  nome: string | null;
  idSchedule: number | null;
}

/** De onde vêm as pessoas. As implementações reais (banco do agente e agenda da franquia) ficam em `lib/rendimento-sofia-fontes.ts`; os testes passam as suas. */
export interface FontesDoRendimento {
  /** conversas atendidas pela Sofia na empresa entre as datas (AAAA-MM-DD, inclusive); null = não consegui ler */
  conversasDaSofia(empresa: string, de: string, ate: string): Promise<ConversaDaSofia[] | null>;
  /** pacientes com marcação na agenda entre as datas; `completa` falso = a franquia tinha mais do que o teto de leitura */
  agenda(empresa: string, de: string, ate: string): Promise<{ pacientes: PacienteDaAgenda[]; completa: boolean } | null>;
}

type Origem = 'sofia' | 'equipe' | 'incerta';

export interface Pessoa {
  /** nome inteiro normalizado: a identidade de uma pessoa na agenda */
  id: string;
  nome: string;
  origem: Origem;
  /** a marcação dela foi gravada pela Sofia (certeza, não palpite por nome) */
  marcadaPelaSofia: boolean;
}

const reais = (centavos: number): number => Math.round(centavos) / 100;

/** Monta as pessoas da agenda e dá a origem de cada uma (passos 1 e 2 do cabeçalho). */
export function montarPessoas(agenda: ReadonlyArray<PacienteDaAgenda>, conversas: ReadonlyArray<ConversaDaSofia>): Pessoa[] {
  const idsDaSofia = new Set(conversas.map((c) => c.idSchedule).filter((x): x is number => x !== null));
  const porId = new Map<string, Pessoa>();
  for (const p of agenda) {
    if (!p.nome || !chaveDoNome(p.nome)) continue;
    const id = tokensDoNome(p.nome).join(' ');
    const marcada = p.idSchedule !== null && idsDaSofia.has(p.idSchedule);
    const ja = porId.get(id);
    if (ja) {
      ja.marcadaPelaSofia ||= marcada;
      continue;
    }
    porId.set(id, { id, nome: p.nome, origem: 'equipe', marcadaPelaSofia: marcada });
  }
  for (const pessoa of porId.values()) {
    if (pessoa.marcadaPelaSofia) {
      pessoa.origem = 'sofia';
      continue;
    }
    let nivel: 'igual' | 'parecido' | 'nenhum' = 'nenhum';
    for (const c of conversas) {
      const n = compararNomes(c.nome, pessoa.nome);
      if (n === 'igual') {
        nivel = 'igual';
        break;
      }
      if (n === 'parecido') nivel = 'parecido';
    }
    pessoa.origem = nivel === 'igual' ? 'sofia' : nivel === 'parecido' ? 'incerta' : 'equipe';
  }
  return [...porId.values()];
}

export type MotivoSemDono = 'pixDeEmpresa' | 'pixSemPacienteNaAgenda' | 'pixNomeParecido' | 'pixComMaisDeUmPaciente' | 'pixDePacienteComOrigemIncerta' | 'pixSemNome';

export interface Atribuicao {
  sofia: { centavos: number; pix: number; pessoas: Set<string>; marcadas: Set<string>; centavosMarcadas: number };
  equipe: { centavos: number; pix: number; pessoas: Set<string> };
  semDono: { centavos: number; pix: number; motivos: Record<MotivoSemDono, { pix: number; centavos: number }> };
  /** só para `detalhar`: cada Pix atribuído, sem nada além de nome e valor */
  linhas: Array<{ grupo: 'sofia' | 'equipe'; nome: string; centavos: number; dia: string }>;
}

/** Passo 3 do cabeçalho: cada Pix vai para uma pessoa ou para «sem dono» com o motivo. Pura. */
export function atribuirPix(pix: ReadonlyArray<PixRecebido>, pessoas: ReadonlyArray<Pessoa>): Atribuicao {
  const motivos = (): Atribuicao['semDono']['motivos'] => ({
    pixDeEmpresa: { pix: 0, centavos: 0 },
    pixSemPacienteNaAgenda: { pix: 0, centavos: 0 },
    pixNomeParecido: { pix: 0, centavos: 0 },
    pixComMaisDeUmPaciente: { pix: 0, centavos: 0 },
    pixDePacienteComOrigemIncerta: { pix: 0, centavos: 0 },
    pixSemNome: { pix: 0, centavos: 0 },
  });
  const r: Atribuicao = {
    sofia: { centavos: 0, pix: 0, pessoas: new Set(), marcadas: new Set(), centavosMarcadas: 0 },
    equipe: { centavos: 0, pix: 0, pessoas: new Set() },
    semDono: { centavos: 0, pix: 0, motivos: motivos() },
    linhas: [],
  };
  const semDono = (p: PixRecebido, m: MotivoSemDono) => {
    r.semDono.centavos += p.centavos;
    r.semDono.pix += 1;
    r.semDono.motivos[m].pix += 1;
    r.semDono.motivos[m].centavos += p.centavos;
  };
  for (const p of pix) {
    if (p.empresa) {
      semDono(p, 'pixDeEmpresa');
      continue;
    }
    if (!p.nomes.some((n) => chaveDoNome(n))) {
      semDono(p, 'pixSemNome');
      continue;
    }
    const iguais = new Set<Pessoa>();
    let parecido = false;
    for (const pessoa of pessoas) {
      for (const n of p.nomes) {
        const nivel = compararNomes(n, pessoa.nome);
        if (nivel === 'igual') iguais.add(pessoa);
        else if (nivel === 'parecido') parecido = true;
      }
    }
    if (iguais.size > 1) semDono(p, 'pixComMaisDeUmPaciente');
    else if (iguais.size === 0) semDono(p, parecido ? 'pixNomeParecido' : 'pixSemPacienteNaAgenda');
    else {
      const dono = [...iguais][0]!;
      if (dono.origem === 'incerta') {
        semDono(p, 'pixDePacienteComOrigemIncerta');
        continue;
      }
      const grupo = dono.origem === 'sofia' ? r.sofia : r.equipe;
      grupo.centavos += p.centavos;
      grupo.pix += 1;
      grupo.pessoas.add(dono.id);
      if (dono.origem === 'sofia' && dono.marcadaPelaSofia) {
        r.sofia.marcadas.add(dono.id);
        r.sofia.centavosMarcadas += p.centavos;
      }
      r.linhas.push({ grupo: dono.origem === 'sofia' ? 'sofia' : 'equipe', nome: dono.nome, centavos: p.centavos, dia: p.dia });
    }
  }
  return r;
}

export const NOTA_DO_RENDIMENTO =
  'Método: o dinheiro que ENTROU na conta bancária no período (Pix com nome) é cruzado pelo nome de quem pagou (primeiro + último, sem acento) com os pacientes da agenda da franquia ' +
  `(marcações de ${FOLGA_DA_AGENDA_DIAS} dias antes a ${FOLGA_DA_AGENDA_DIAS} dias depois do período). «sofia» = paciente cuja marcação a Sofia gravou OU cujo nome é igual ao de uma conversa que ela atendeu ` +
  `(${RETROSPECTO_DA_SOFIA_DIAS} dias antes do início até o fim); «equipe» = paciente sem conversa da Sofia com nome igual ou parecido. «dosQuaisMarcadosPelaSofia» é o subconjunto em que a Sofia gravou a marcação (certeza). ` +
  'NÃO ATRIBUÍDO = venda de maquininha (chega agregada, sem nome), TED/depósito/transferência, Pix de empresa, Pix de nome que não está na agenda do período, nome só parecido, nome com mais de um paciente e paciente de origem incerta. ' +
  'Limites: quem paga em nome de outra pessoa (pai, filho, cônjuge) fica fora; o nome da conversa nem sempre é o de registro (apelido do WhatsApp), e então a pessoa conta como «equipe»; o cadastro da franquia não tem CPF, então o casamento é só por nome. ' +
  'Pix ainda pendente e cartão de crédito não entram. Os dados do banco são os da última sincronização diária.';

export async function pluggyRendimentoSofia(
  ctx: ContextoPluggy,
  fontes: FontesDoRendimento,
  a: { empresa?: string; inicio: string; fim: string; detalhar?: boolean },
) {
  const leitura = await lerPeriodo(ctx, { empresa: a.empresa, inicio: a.inicio, fim: a.fim });
  const empresa = leitura.empresa;
  const [agenda, conversas] = await Promise.all([
    fontes.agenda(empresa, somarDias(a.inicio, -FOLGA_DA_AGENDA_DIAS), somarDias(a.fim, FOLGA_DA_AGENDA_DIAS)),
    fontes.conversasDaSofia(empresa, somarDias(a.inicio, -RETROSPECTO_DA_SOFIA_DIAS), a.fim),
  ]);
  if (!agenda) throw new Error('não consegui ler a agenda da franquia desta empresa: sem ela não há como saber de quem é cada Pix. Nada foi atribuído.');
  if (!conversas) throw new Error('não consegui ler as conversas da Sofia desta empresa: sem elas não há como separar Sofia e equipe. Nada foi atribuído.');

  const entradas = entradasDoBanco(leitura.lancamentos);
  const pessoas = montarPessoas(agenda.pacientes, conversas);
  const at = atribuirPix(entradas.pix, pessoas);

  const centavosPix = entradas.pix.reduce((s, p) => s + p.centavos, 0);
  const totalEntrou = centavosPix + entradas.cartaoVendas.centavos + entradas.outras.centavos;
  // a conferência usa uma conta INDEPENDENTE do casamento: soma direta de toda entrada efetivada em conta bancária, sem passar pela separação em Pix/maquininha/outras
  const totalDoExtrato = leitura.lancamentos.filter((l) => l.tipo === 'entrada' && l.status !== 'PENDING' && l.contaTipo !== 'CREDIT').reduce((s, l) => s + Math.round(Math.abs(l.valor) * 100), 0);
  const naoAtribuidoCentavos = at.semDono.centavos + entradas.cartaoVendas.centavos + entradas.outras.centavos;
  const motivos = Object.fromEntries(Object.entries(at.semDono.motivos).filter(([, v]) => v.pix > 0).map(([k, v]) => [k, { pix: v.pix, valor: reais(v.centavos) }]));
  const porOrigem = (o: Origem) => pessoas.filter((p) => p.origem === o).length;

  return {
    empresa,
    periodo: { inicio: a.inicio, fim: a.fim },
    dadosDe: leitura.frescor,
    aviso: AVISO_DE_FRESCOR,
    contasLidas: leitura.contasLidas,
    entrouNaConta: { total: reais(totalEntrou), pix: { lancamentos: entradas.pix.length, valor: reais(centavosPix) }, vendasDeMaquininha: { lancamentos: entradas.cartaoVendas.lancamentos, valor: reais(entradas.cartaoVendas.centavos) }, outrasEntradas: { lancamentos: entradas.outras.lancamentos, valor: reais(entradas.outras.centavos) } },
    sofia: {
      valor: reais(at.sofia.centavos),
      pix: at.sofia.pix,
      pacientes: at.sofia.pessoas.size,
      dosQuaisMarcadosPelaSofia: { pacientes: at.sofia.marcadas.size, valor: reais(at.sofia.centavosMarcadas) },
    },
    equipe: { valor: reais(at.equipe.centavos), pix: at.equipe.pix, pacientes: at.equipe.pessoas.size },
    naoAtribuido: {
      valor: reais(naoAtribuidoCentavos),
      pix: at.semDono.pix,
      vendasDeMaquininha: { lancamentos: entradas.cartaoVendas.lancamentos, valor: reais(entradas.cartaoVendas.centavos) },
      outrasEntradas: { lancamentos: entradas.outras.lancamentos, valor: reais(entradas.outras.centavos) },
      motivosDosPix: motivos,
    },
    conferencia: {
      somaDosTresBlocos: reais(at.sofia.centavos + at.equipe.centavos + naoAtribuidoCentavos),
      somaDoExtrato: reais(totalDoExtrato),
      igualAoQueEntrou: at.sofia.centavos + at.equipe.centavos + naoAtribuidoCentavos === totalDoExtrato && totalEntrou === totalDoExtrato,
    },
    pacientesNaAgenda: { total: pessoas.length, sofia: porOrigem('sofia'), equipe: porOrigem('equipe'), origemIncerta: porOrigem('incerta') },
    ...(a.detalhar
      ? { detalhe: at.linhas.sort((x, y) => (x.dia < y.dia ? -1 : x.dia > y.dia ? 1 : 0)).map((l) => ({ grupo: l.grupo, paciente: primeiroNome(l.nome) ?? 'sem nome', valor: reais(l.centavos), dia: l.dia })) }
      : {}),
    nota: NOTA_DO_RENDIMENTO,
    ...(!agenda.completa ? { agendaIncompleta: true } : {}),
    ...(leitura.incompleto || !agenda.completa ? { incompleto: true, ...(leitura.falhas.length ? { falhas: leitura.falhas } : {}), atencao: 'parte dos dados NÃO veio (extrato ou agenda cortados): os totais estão INCOMPLETOS e o que não foi lido caiu em «não atribuído» ou ficou de fora.' } : {}),
  };
}

const empresaArg = z.string().optional().describe('empresa/unidade do conector com leitura bancária (slug ou nome curto). Opcional quando só uma tem. Veja pluggy_contas.');
const dia = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

export function registrarRendimentoDaSofia(server: McpServer, ctx: ContextoPluggy, fontes: FontesDoRendimento, auditar?: Auditar): void {
  server.registerTool(
    'pluggy_rendimento_sofia',
    {
      title: 'Quanto a Sofia rendeu (Pluggy + agenda)',
      description:
        `Quanto ENTROU no banco, num período de até ${MAX_DIAS} dias, de pacientes que a Sofia atendeu e de pacientes que a equipe marcou, cruzando o Pix (nome de quem pagou) com a agenda da franquia. ` +
        'Devolve o total de cada grupo, a quantidade de pacientes, o que NÃO se pode atribuir (venda de maquininha, Pix sem paciente, nome ambíguo) com o motivo, a conferência da soma e o MÉTODO e seus limites no campo `nota`. ' +
        'Não inventa atribuição: na dúvida o valor vai para «não atribuído». Nenhum nome sai, a menos que detalhar=true (primeiro nome e valor). Só leitura. Dado bancário e de paciente é sensível: só para quem tem permissão de alterar cartões.',
      inputSchema: {
        empresa: empresaArg,
        inicio: dia('primeiro dia'),
        fim: dia('último dia (incluso)'),
        detalhar: z.boolean().optional().describe('true: lista cada Pix atribuído com o primeiro nome do paciente, o valor e o dia'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      executar('pluggy_rendimento_sofia', args, auditar, async () => {
        try {
          return await pluggyRendimentoSofia(ctx, fontes, args);
        } catch (e) {
          if (e instanceof ErroDeEntrada) throw e;
          throw new Error(tirarSegredos(e instanceof Error ? e.message : String(e)));
        }
      }),
  );
}

/**
 * O portão: a ferramenta só existe para quem está na lista de quem altera cartões (`escritores`) E com a Pluggy ligada E com as fontes (banco do agente e agenda) passadas.
 * Leitor comum não a vê (nem em `tools/list`, nem por chamada direta). Devolve se registrou.
 */
export function registrarRendimentoSePermitido(server: McpServer, ctx: ContextoPluggy, fontes: FontesDoRendimento | null | undefined, userId: string, escritores: ReadonlySet<string>, auditar?: Auditar): boolean {
  if (!fontes || !escritores.has(userId) || !ctx.fonte || !ctx.itens.length) return false;
  registrarRendimentoDaSofia(server, ctx, fontes, auditar);
  return true;
}
