/**
 * `pluggy_rendimento_sofia` — «quanto a Sofia rendeu»: cruza o dinheiro que ENTROU no banco (Pluggy, Pix com nome) com os PACIENTES da agenda da franquia, separados em
 * quem a Sofia atendeu/marcou e quem a equipe marcou. Só leitura; só para quem altera cartões (a mesma regra das outras `pluggy_*`, dado bancário é sensível).
 *
 * COMO ATRIBUI, e só assim (nada é inventado; o que não fecha vai para «não atribuído»):
 *  1. PESSOAS = os pacientes com marcação na agenda da franquia entre 30 dias antes do início e 30 dias depois do fim do período (a agenda dá só o NOME: a franquia
 *     não tem CPF no cadastro, e o número do documento do pagador nem é lido). Duas marcações com o MESMO nome inteiro são a mesma pessoa.
 *  2. ORIGEM de cada pessoa, só com PROVA. `sofia` = a Sofia CONVERSOU (mensagem dela na tabela `messages` — não a da equipe, nem a confirmação D-1, lembrete ou envio automático —, `created_at` DENTRO da janela: 90 dias antes do início até o fim do
 *     período) numa conversa cuja marcação ela gravou (`spine_id_schedule` com `agendou_ia`; a marcação do botão da equipe não conta) ou cujo telefone é o da ficha da franquia (busca pelo nome inteiro, um único cadastro). O tempo de vida da conversa
 *     e o total de mensagens NÃO contam: a Sofia que retoma o lead DEPOIS do período não o torna «sofia». `equipe` = ficha com telefone que NENHUMA conversa da Sofia teve em QUALQUER data
 *     E nenhuma conversa dela SEM telefone (de qualquer data) tem o mesmo PRIMEIRO nome (1 de 5 conversas dela não guarda o telefone; nome de uma palavra só vale). Telefone com fala da Sofia só
 *     FORA da janela, ficha ambígua, sem telefone ou vencida pelo limite de buscas: SEM COMPROVAÇÃO e o Pix é «não atribuído». O nome da conversa NUNCA decide a origem sozinho.
 *  3. PIX → PESSOA pelo nome de quem pagou (primeiro + último, sem acento). Um Pix só vai para uma pessoa se EXATAMENTE UMA pessoa da agenda tem aquele nome; zero, várias,
 *     nome só parecido, empresa (PJ), pessoa de origem sem comprovação → «não atribuído», com o motivo contado.
 *  4. VENDA DE MAQUININHA («Vendas…») chega agregada e sem nome: não é de ninguém. Entradas que não são Pix (TED, depósito, transferência): idem.
 * Os três blocos somam o que entrou na conta bancária no período (a `conferencia` confere). Cartão de crédito fora (é fatura, não dinheiro que entrou).
 *
 * COMO LER O NÚMERO (campo `leitura`, no topo da resposta): o valor da Sofia é um PISO comprovado; o não atribuído contém pacientes dela; Sofia × equipe NÃO é comparável por este número.
 *
 * LIMITES (vão no campo `nota`): quem paga em nome de outra pessoa (pai, filho, cônjuge) cai em «não atribuído»; dois pacientes com o mesmo primeiro e último nome e
 * nomes do meio diferentes são ambíguos; a Sofia conta como origem de quem ela ATENDEU, não só de quem ela marcou (o subconjunto «marcou» vem separado). Nenhum nome sai a menos que `detalhar=true`, e então só o
 * primeiro nome e o valor.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, somarDias } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { primeiroNome } from '../lib/aviso-clinica-agendamento.js';
import { tirarSegredos } from '../lib/integracoes/pluggy.js';
import { chaveDoNome, compararTokens, entradasDoBanco, tokensDoNome, type PixRecebido } from '../lib/pix-casamento.js';
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
  /**
   * Para pacientes cuja marcação a Sofia NÃO gravou: a ficha da franquia pelo nome inteiro (um único cadastro, com WhatsApp) e as conversas da Sofia por TELEFONE. `sofia` = alguma conversa dela tem esse telefone; `equipe` = ficha única com telefone e NENHUMA conversa dela com ele; `desconhecido` = o resto (sem ficha
   * única, sem telefone, falha de leitura). Nunca lança: na dúvida, `desconhecido`.
   */
  origemPorTelefone(empresa: string, nomes: string[], desde: string, ate: string): Promise<Map<string, 'sofia' | 'equipe' | 'desconhecido'>>;
  /** ver `PrimeirosNomesSemTelefone` */
  primeirosNomesSemTelefone(empresa: string): Promise<PrimeirosNomesSemTelefone>;
}

/**
 * Os PRIMEIROS NOMES (normalizados, sem acento; vale nome de uma palavra só) das conversas da Sofia SEM telefone, de QUALQUER data: o telefone nunca poderia dizer que aquela pessoa
 * conversou com ela, então quem tem o mesmo primeiro nome não pode ser dado como «equipe». null = não consegui ler (então ninguém é «equipe»).
 */
export type PrimeirosNomesSemTelefone = Set<string> | null;

/** No máximo tantas buscas de ficha por chamada da ferramenta (cada uma é uma leitura na franquia). */
export const MAX_FICHAS = 60;

/** `semProva` = a marcação não foi gravada pela Sofia e a conferência por telefone ainda não provou nada (pode ser apelido do WhatsApp, homônimo, ficha ambígua) */
type Origem = 'sofia' | 'equipe' | 'semProva';

export interface Pessoa {
  /** nome inteiro normalizado: a identidade de uma pessoa na agenda */
  id: string;
  nome: string;
  origem: Origem;
  /** a marcação dela foi gravada pela Sofia (certeza, não palpite por nome) */
  marcadaPelaSofia: boolean;
  /** alguma conversa da Sofia SEM telefone (de qualquer data) tem o mesmo primeiro nome: o telefone nunca poderia dizer que ela esteve lá, então `equipe` não se prova */
  suspeitaSemTelefone: boolean;
}

const reais = (centavos: number): number => Math.round(centavos) / 100;

/** Monta as pessoas da agenda e dá a origem de cada uma (passos 1 e 2 do cabeçalho). */
export function montarPessoas(agenda: ReadonlyArray<PacienteDaAgenda>, conversas: ReadonlyArray<ConversaDaSofia>, primeirosSemTelefone: PrimeirosNomesSemTelefone = null): Pessoa[] {
  // só marcação com `agendou_ia`: o botão «Marcar consulta» da equipe grava o mesmo `spine_id_schedule` e não é a Sofia
  const idsDaSofia = new Set(conversas.filter((c) => c.marcou).map((c) => c.idSchedule).filter((x): x is number => x !== null));
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
    porId.set(id, { id, nome: p.nome, origem: 'semProva', marcadaPelaSofia: marcada, suspeitaSemTelefone: false });
  }
  for (const pessoa of porId.values()) {
    if (pessoa.marcadaPelaSofia) {
      pessoa.origem = 'sofia';
      continue;
    }
    // sem a lista (leitura falhou) ninguém é «equipe»; com ela, o mesmo PRIMEIRO nome de uma conversa da Sofia sem telefone já tira a prova (nome de uma palavra só também vale)
    const primeiro = tokensDoNome(pessoa.nome)[0] ?? '';
    pessoa.suspeitaSemTelefone = primeirosSemTelefone === null || primeirosSemTelefone.has(primeiro);
  }
  return [...porId.values()];
}

export type MotivoSemDono = 'pixDeEmpresa' | 'pixSemPacienteNaAgenda' | 'pixNomeParecido' | 'pixComMaisDeUmPaciente' | 'pixDePacienteSemOrigemComprovada' | 'pixSemNome';

export interface Atribuicao {
  sofia: { centavos: number; pix: number; pessoas: Set<string>; marcadas: Set<string>; centavosMarcadas: number };
  equipe: { centavos: number; pix: number; pessoas: Set<string> };
  semDono: { centavos: number; pix: number; motivos: Record<MotivoSemDono, { pix: number; centavos: number }> };
  /** pessoas de origem `semProva` que receberam Pix (um Pix cada, nome único): as que valem conferir por telefone */
  paraConferir: Set<Pessoa>;
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
    pixDePacienteSemOrigemComprovada: { pix: 0, centavos: 0 },
    pixSemNome: { pix: 0, centavos: 0 },
  });
  const r: Atribuicao = {
    sofia: { centavos: 0, pix: 0, pessoas: new Set(), marcadas: new Set(), centavosMarcadas: 0 },
    equipe: { centavos: 0, pix: 0, pessoas: new Set() },
    semDono: { centavos: 0, pix: 0, motivos: motivos() },
    paraConferir: new Set(),
    linhas: [],
  };
  const semDono = (p: PixRecebido, m: MotivoSemDono) => {
    r.semDono.centavos += p.centavos;
    r.semDono.pix += 1;
    r.semDono.motivos[m].pix += 1;
    r.semDono.motivos[m].centavos += p.centavos;
  };
  // as pessoas tokenizadas UMA vez e indexadas pelo primeiro nome (800 Pix × milhares de pacientes não se comparam um a um)
  const pessoasPorPrimeiroNome = new Map<string, Array<{ pessoa: Pessoa; tokens: string[] }>>();
  for (const pessoa of pessoas) {
    const tokens = tokensDoNome(pessoa.nome);
    if (tokens.length < 2) continue;
    pessoasPorPrimeiroNome.set(tokens[0]!, [...(pessoasPorPrimeiroNome.get(tokens[0]!) ?? []), { pessoa, tokens }]);
  }
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
    for (const nome of p.nomes) {
      const t = tokensDoNome(nome);
      for (const pessoa of pessoasPorPrimeiroNome.get(t[0] ?? '') ?? []) {
        const nivel = compararTokens(t, pessoa.tokens);
        if (nivel === 'igual') iguais.add(pessoa.pessoa);
        else if (nivel === 'parecido') parecido = true;
      }
    }
    if (iguais.size > 1) semDono(p, 'pixComMaisDeUmPaciente');
    else if (iguais.size === 0) semDono(p, parecido ? 'pixNomeParecido' : 'pixSemPacienteNaAgenda');
    else {
      const dono = [...iguais][0]!;
      if (dono.origem === 'semProva') {
        r.paraConferir.add(dono);
        semDono(p, 'pixDePacienteSemOrigemComprovada');
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

/** A frase que impede a leitura errada do número: vai no TOPO da resposta (`leitura`) e no começo da `nota`. */
export const LEITURA_DO_RENDIMENTO =
  'O valor da Sofia é um PISO comprovado, e «comprovado» = o paciente conversou com a Sofia (pelo menos 1 mensagem dela), NÃO que ela causou o pagamento; telefone compartilhado (mãe e filha no mesmo número) pode juntar duas pessoas. ' +
  'O número FORTE é `numeroForte` (dosQuaisMarcadosPelaSofia): a consulta que a Sofia gravou. O não atribuído contém pacientes dela; Sofia × equipe NÃO é comparável por este número.';

export const NOTA_DO_RENDIMENTO =
  `${LEITURA_DO_RENDIMENTO} ` +
  'Método: o dinheiro que ENTROU na conta bancária no período (Pix com nome) é cruzado pelo nome de quem pagou (primeiro + último, sem acento) com os pacientes da agenda da franquia ' +
  `(marcações de ${FOLGA_DA_AGENDA_DIAS} dias antes a ${FOLGA_DA_AGENDA_DIAS} dias depois do período). «sofia» = paciente cuja marcação a Sofia gravou OU cujo telefone (ficha da franquia) é o de uma conversa em que ela CONVERSOU (mensagem dela; não vale confirmação D-1, lembrete, régua nem fala da equipe) ` +
  `entre ${RETROSPECTO_DA_SOFIA_DIAS} dias antes do início e o fim do período — o que ela falar depois do período ou o tempo de vida da conversa não conta, e o nome da conversa NÃO decide; «equipe» = paciente cuja ficha tem telefone que NENHUMA conversa da Sofia teve em qualquer data, sem conversa dela sem telefone de mesmo primeiro nome; sem essa prova o Pix fica «não atribuído». «dosQuaisMarcadosPelaSofia» (repetido em numeroForte) é o subconjunto em que a Sofia gravou a marcação: o número forte; o resto de «sofia» é conversa, não causa. ` +
  'NÃO ATRIBUÍDO = venda de maquininha (chega agregada, sem nome), TED/depósito/transferência, Pix de empresa, Pix de nome que não está na agenda do período, nome só parecido, nome com mais de um paciente e paciente de origem sem comprovação. ' +
  'Limites: quem paga em nome de outra pessoa (pai, filho, cônjuge) fica fora; o nome da conversa nem sempre é o de registro (apelido do WhatsApp): por isso «equipe» exige a prova do telefone, e quem não tem ficha única com telefone fica em «não atribuído»; o cadastro da franquia não tem CPF, então o casamento é por nome (e telefone para a origem). ' +
  'Pix ainda pendente e cartão de crédito não entram. Os dados do banco são os da última sincronização diária.';

export async function pluggyRendimentoSofia(
  ctx: ContextoPluggy,
  fontes: FontesDoRendimento,
  a: { empresa?: string; inicio: string; fim: string; detalhar?: boolean },
) {
  const leitura = await lerPeriodo(ctx, { empresa: a.empresa, inicio: a.inicio, fim: a.fim });
  const empresa = leitura.empresa;
  const [agenda, conversas, semTelefone] = await Promise.all([
    fontes.agenda(empresa, somarDias(a.inicio, -FOLGA_DA_AGENDA_DIAS), somarDias(a.fim, FOLGA_DA_AGENDA_DIAS)),
    fontes.conversasDaSofia(empresa, somarDias(a.inicio, -RETROSPECTO_DA_SOFIA_DIAS), a.fim),
    fontes.primeirosNomesSemTelefone(empresa).catch(() => null),
  ]);
  if (!agenda) throw new Error('não consegui ler a agenda da franquia desta empresa: sem ela não há como saber de quem é cada Pix. Nada foi atribuído.');
  if (!conversas) throw new Error('não consegui ler as conversas da Sofia desta empresa: sem elas não há como separar Sofia e equipe. Nada foi atribuído.');

  const entradas = entradasDoBanco(leitura.lancamentos);
  const pessoas = montarPessoas(agenda.pacientes, conversas, semTelefone);
  let fichasNaoConferidas = 0;
  let at = atribuirPix(entradas.pix, pessoas);
  // quem não teve a marcação gravada pela Sofia só é «sofia» ou «equipe» com PROVA (telefone); sem prova o Pix fica «não atribuído»
  if (at.paraConferir.size) {
    const lista = [...at.paraConferir];
    fichasNaoConferidas = Math.max(lista.length - MAX_FICHAS, 0);
    const nomes = lista.slice(0, MAX_FICHAS).map((p) => p.nome);
    const resp = await fontes.origemPorTelefone(empresa, nomes, somarDias(a.inicio, -RETROSPECTO_DA_SOFIA_DIAS), a.fim).catch(() => new Map<string, 'sofia' | 'equipe' | 'desconhecido'>());
    for (const p of lista) {
      const o = resp.get(p.nome);
      if (o === 'sofia') p.origem = 'sofia';
      else if (o === 'equipe' && !p.suspeitaSemTelefone) p.origem = 'equipe';
    }
    at = atribuirPix(entradas.pix, pessoas);
  }

  const centavosPix = entradas.pix.reduce((s, p) => s + p.centavos, 0);
  const totalEntrou = centavosPix + entradas.cartaoVendas.centavos + entradas.outras.centavos;
  // a conferência usa uma conta INDEPENDENTE do casamento: soma direta de toda entrada efetivada em conta bancária, sem passar pela separação em Pix/maquininha/outras
  const totalDoExtrato = leitura.lancamentos.filter((l) => l.tipo === 'entrada' && l.status !== 'PENDING' && l.contaTipo !== 'CREDIT').reduce((s, l) => s + Math.round(Math.abs(l.valor) * 100), 0);
  const naoAtribuidoCentavos = at.semDono.centavos + entradas.cartaoVendas.centavos + entradas.outras.centavos;
  const motivos = Object.fromEntries(Object.entries(at.semDono.motivos).filter(([, v]) => v.pix > 0).map(([k, v]) => [k, { pix: v.pix, valor: reais(v.centavos) }]));
  const porOrigem = (...o: Origem[]) => pessoas.filter((p) => o.includes(p.origem)).length;

  return {
    leitura: LEITURA_DO_RENDIMENTO,
    numeroForte: { descricao: 'consulta gravada pela Sofia', pacientes: at.sofia.marcadas.size, valor: reais(at.sofia.centavosMarcadas) },
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
    equipeComprovada: { valor: reais(at.equipe.centavos), pix: at.equipe.pix, pacientes: at.equipe.pessoas.size },
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
      observacao: 'confere que a separação em blocos não perdeu nem repetiu lançamento; NÃO diz que todo o valor é receita: transferência entre contas próprias entra como entrada e cai em «não atribuído».',
    },
    pacientesNaAgenda: { total: pessoas.length, sofia: porOrigem('sofia'), equipeComprovada: porOrigem('equipe'), origemSemComprovacao: porOrigem('semProva') },
    ...(a.detalhar
      ? { detalhe: at.linhas.sort((x, y) => (x.dia < y.dia ? -1 : x.dia > y.dia ? 1 : 0)).map((l) => ({ grupo: l.grupo, paciente: primeiroNome(l.nome) ?? 'sem nome', valor: reais(l.centavos), dia: l.dia })) }
      : {}),
    nota: NOTA_DO_RENDIMENTO,
    ...(!agenda.completa ? { agendaIncompleta: true } : {}),
    ...(fichasNaoConferidas ? { fichasNaoConferidas } : {}),
    ...(leitura.incompleto || !agenda.completa || fichasNaoConferidas ? { incompleto: true, ...(leitura.falhas.length ? { falhas: leitura.falhas } : {}), atencao: 'parte dos dados NÃO veio (extrato ou agenda cortados, ou mais pacientes que o limite de conferências por telefone — veja fichasNaoConferidas): os totais estão INCOMPLETOS e o que não foi lido caiu em «não atribuído» ou ficou de fora.' } : {}),
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
        'O topo da resposta (`leitura`) diz como ler: o valor da Sofia é um PISO comprovado, o não atribuído contém pacientes dela e Sofia × equipe NÃO é comparável por este número. Devolve o total de cada grupo, a quantidade de pacientes, o que NÃO se pode atribuir (venda de maquininha, Pix sem paciente, nome ambíguo) com o motivo, a conferência da soma e o MÉTODO e seus limites no campo `nota`. ' +
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
