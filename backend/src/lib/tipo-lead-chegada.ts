/**
 * ⬢ Tipo de lead NA CHEGADA do lead (decisão do João, 06/11/2026).
 *
 * O caso: o Tipo de lead só nascia no agendamento (`campos-sdr.ts`, dentro do sincronizador da franquia, que só visita
 * cartão com consulta) — quem estava em EM QUALIFICAÇÃO ficava vazio (Timbó, lead 5493104, 05/11). Agora o cartão novo
 * ganha o tipo logo que chega, agende ou não.
 *
 * A regra (do João):
 *  - **Resgate** = a pessoa JÁ EXISTIA antes: (a) já cadastrada na franquia pelo telefone, ou (b) o 1º contato foi há mais
 *    de 90 dias — a mesma noção do `campos-sdr` (a data mais antiga entre a criação do cartão, o campo "◷ Data do primeiro
 *    contato" e a data escrita no nome), aqui também com os OUTROS cartões do mesmo contato;
 *  - **Cadastro** = pessoa nova;
 *  - "Transferido de outra unidade" continua manual: campo preenchido, seja com o que for, nunca é tocado;
 *  - VALE O DA CHEGADA: grava só em campo vazio e nunca troca depois. O `campos-sdr` (no agendamento) com o campo já
 *    preenchido só registra confere/diverge.
 *
 * Nunca chuta: na dúvida (franquia fora do ar, sem telefone, sem nome para buscar, nome comum demais, os outros cartões do
 * contato ilegíveis) NÃO grava e tenta de novo — um "Cadastro" por erro de rede seria dado errado e permanente.
 *
 * O telefone decide (ajuste de 06/11): a franquia ignora filtro de telefone, então o telefone é procurado num ÍNDICE do nosso lado
 * (`franquia-indice-telefones.ts`: pacientes + leads da franquia, chave = últimos 8 dígitos, montado 1×/dia por unidade).
 * "Cadastro" exige índice inteiro e fresco (≤36 h); sem ele, não grava. A busca por nome é só reforço (acha o cadastro que
 * nasceu depois da última carga). Mãe e filha no mesmo telefone continuam Resgate.
 *
 * Limites que sobram: o índice só enxerga o campo `whatsapp` do cadastro (telefone fixo ou segundo número não entram); lead da
 * franquia só até 3 anos para trás; cadastro nascido na franquia depois da última carga e com outro nome não aparece até a
 * próxima carga (até ~20 h).
 */
import type { Unit } from '@prisma/client';
import { DIAS_PARA_RESGATE, datasNoNome, primeiroContatoEm } from './campos-sdr.js';
import { normalizar } from './franquia-sync.js';
import { limparNome, termosDeBusca } from './widget-agenda.js';
import { pacienteExistente, type Achado } from './paciente-existente.js';
import { chaveDoTelefone, consultarIndice, type RespostaDoIndice } from './franquia-indice-telefones.js';
import { logger } from './logger.js';
import { ehSemNome } from './titulo-padrao.js';
import { estadoDaAutomacao } from './automacoes-estado.js';

export const ID_AUTOMACAO = 'tipo-lead-chegada';

export const CAMPO_TIPO_LEAD = '⬢ Tipo de lead';
export const CAMPO_PRIMEIRO_CONTATO = '◷ Data do primeiro contato';

const DIA_S = 86_400;

export type TipoDeLead = 'Resgate' | 'Cadastro';

/**
 * O campo pelo nome exato (com o símbolo). `soExato`: sem o plano B pelo nome normalizado — a normalização tira o "⬢" e o
 * "Tipo de lead" antigo (Salto/Tatuí, estrutura velha) casaria; para gravar, só o campo certo.
 */
export function acharCampo<T extends { name: string }>(campos: ReadonlyArray<T>, nome: string, soExato = false): T | null {
  const exatos = campos.filter((c) => c.name.trim() === nome);
  if (exatos.length === 1) return exatos[0]!;
  if (exatos.length > 1 || soExato) return null;
  const alvo = normalizar(nome);
  const parecidos = campos.filter((c) => normalizar(c.name) === alvo);
  return parecidos.length === 1 ? parecidos[0]! : null;
}

/** A opção da lista pelo VALOR, na grafia da conta ("Resgate"/"Cadastro"). null = a conta não tem a opção. */
export function opcaoDaConta(enums: ReadonlyArray<{ value: string }>, tipo: TipoDeLead): string | null {
  const alvo = normalizar(tipo);
  return enums.find((e) => normalizar(e.value) === alvo)?.value ?? null;
}

export interface OutroCartao {
  nome: string | null | undefined;
  criadoEmEpoch: number | null | undefined;
}

/**
 * Puro. (b): o 1º contato foi há mais de 90 dias da chegada deste cartão? `outros` = os demais cartões do mesmo contato
 * (criação e datas dos nomes deles também contam). Devolve a frase, ou null se não é Resgate por idade.
 */
export function resgatePelaIdade(e: {
  nome: string | null | undefined;
  criadoEmEpoch: number | null | undefined;
  primeiroContatoEpoch: number | null | undefined;
  outros: ReadonlyArray<OutroCartao>;
}): string | null {
  const chegada = e.criadoEmEpoch;
  if (!chegada || chegada <= 0) return null;
  // os outros cartões do contato: a criação e as datas do nome delas, lidas com a mesma referência (a chegada deste)
  const outrasDatas = e.outros.flatMap((o) => [o.criadoEmEpoch, ...datasNoNome(o.nome, chegada)]);
  const primeiro = primeiroContatoEm({ nome: e.nome, criadoEmEpoch: chegada, primeiroContatoEpoch: e.primeiroContatoEpoch, referenciaEpoch: chegada, outrasDatas });
  if (primeiro === null) return null;
  // em segundos, como o `tipoDoLead` do campos-sdr: 90 dias e meio já é Resgate nos dois
  if (chegada - primeiro <= DIAS_PARA_RESGATE * DIA_S) return null;
  return `1º contato há ${Math.floor((chegada - primeiro) / DIA_S)} dias (mais de ${DIAS_PARA_RESGATE})`;
}

/** Quantos cartões criados no MESMO minuto fazem uma importação (lead de anúncio não chega assim). */
export const LOTE_NO_MINUTO = 15;
/** ...ou nesta quantidade em 10 minutos. */
export const LOTE_EM_10_MIN = 60;

/**
 * Puro. Cartões que nasceram em LOTE — importação em massa, carga da franquia — e não chegada de lead. Importados "nascem novos"
 * e ganhariam Cadastro de uma vez (a carga de implantação cria centenas num minuto). Aqui ficam de fora; o `campos-sdr` os
 * alcança no agendamento. Devolve os ids a ignorar.
 */
export function cartoesCriadosEmLote(leads: ReadonlyArray<{ id: number; created_at?: number | null }>): Set<number> {
  const porMinuto = new Map<number, number[]>();
  const por10 = new Map<number, number[]>();
  for (const l of leads) {
    if (!l.created_at) continue;
    const m = Math.floor(l.created_at / 60);
    const d = Math.floor(l.created_at / 600);
    (porMinuto.get(m) ?? porMinuto.set(m, []).get(m)!).push(l.id);
    (por10.get(d) ?? por10.set(d, []).get(d)!).push(l.id);
  }
  const fora = new Set<number>();
  for (const ids of porMinuto.values()) if (ids.length >= LOTE_NO_MINUTO) ids.forEach((id) => fora.add(id));
  for (const ids of por10.values()) if (ids.length >= LOTE_EM_10_MIN) ids.forEach((id) => fora.add(id));
  return fora;
}

export type Conhecido = 'sim' | 'nao' | 'desconhecido';

export interface RespostaDaFranquia {
  resultado: Conhecido;
  motivo: string;
  /** a franquia (ou o banco do índice) falhou — diferente de "não deu para buscar" (sem nome, nome comum) */
  falhou?: true;
}

export type BuscarPaciente = (unit: Unit, nome: string, titulo: string, fone: string, opcoes?: { soPrimeiroNome?: boolean }) => Promise<Achado>;
export type ConsultarIndice = (unitId: string, chave: string) => Promise<RespostaDoIndice>;

/**
 * É nome de gente? O contato do WhatsApp às vezes se chama pelo número ("+55 47 99999-1234") ou por um emoji: buscar isso na
 * franquia não prova nada, e "não achei" não pode virar Cadastro. Sem dígito e com pelo menos 3 letras seguidas.
 */
export function pareceNomeDePessoa(s: string | null | undefined): boolean {
  const t = String(s ?? '').trim();
  return t.length > 0 && !/[\d+@#_]/.test(t) && /\p{L}{3}/u.test(t);
}

/** O reforço por NOME (a busca de `pacienteExistente`): acha paciente que o índice ainda não tem. Quem decide é o telefone. */
async function reforcoPorNome(
  unit: Unit,
  e: { titulo: string | null | undefined; nomeDoContato: string | null | undefined; telefone: string },
  buscar: BuscarPaciente,
): Promise<RespostaDaFranquia> {
  // "Lead 06/11/2026" / "Lead #123" é o título provisório, não nome: buscar "Lead" na franquia seria ruído.
  const tituloBruto = String(e.titulo ?? '');
  const tituloLimpo = limparNome(tituloBruto);
  const titulo = ehSemNome(tituloBruto) || /^lead\b/i.test(tituloBruto.trim()) || !pareceNomeDePessoa(tituloLimpo) ? '' : tituloBruto;
  const contatoLimpo = limparNome(e.nomeDoContato);
  // contato que se chama pelo telefone (ou emoji) não é nome: nada a buscar — o índice por telefone decide
  const nomeContato = pareceNomeDePessoa(contatoLimpo) ? contatoLimpo : '';
  const termos = termosDeBusca(titulo, nomeContato);
  if (termos.length === 0) return { resultado: 'desconhecido', motivo: 'sem nome de pessoa para buscar na franquia (título provisório e contato sem nome, ou com o telefone no lugar do nome)' };

  // só o primeiro nome: a busca só prova "não existe" se viu todo mundo com esse nome (página não cheia)
  const temNomeCompleto = termos.some((t) => t.split(' ').length >= 2);
  const nome = nomeContato || limparNome(titulo);
  let achado: Achado;
  try {
    achado = await buscar(unit, nome, titulo, e.telefone, { soPrimeiroNome: !temNomeCompleto });
  } catch (err) {
    return { resultado: 'desconhecido', falhou: true, motivo: `a franquia não respondeu (${String(err).slice(0, 120)})` };
  }
  switch (achado.tipo) {
    case 'achou':
      return { resultado: 'sim', motivo: `já cadastrada na franquia (idClient ${achado.idClient}, achada pelo nome e confirmada pelo telefone)` };
    case 'ambiguo':
      return { resultado: 'sim', motivo: `já cadastrada na franquia (${achado.candidatos.length} cadastros com este telefone)` };
    case 'nao_achou':
      return { resultado: 'nao', motivo: 'a busca por nome não achou o telefone' };
    case 'inconclusivo':
      return { resultado: 'desconhecido', motivo: 'só o primeiro nome e a busca na franquia veio cheia (nome comum)' };
    default:
      return { resultado: 'desconhecido', falhou: true, motivo: 'a franquia não respondeu à busca por nome' };
  }
}

/**
 * (a): este telefone JÁ estava na franquia, como paciente ou como lead? O TELEFONE decide, pelo índice do nosso lado
 * (`franquia-indice-telefones.ts`: a franquia ignora filtro de telefone). A busca por nome fica de reforço — acha o
 * cadastro que nasceu depois da última carga do índice.
 *
 *  - achou no índice um cadastro ANTERIOR à chegada do cartão → sim (vale mesmo com índice velho: prova positiva não envelhece).
 *    Cadastro posterior à chegada é o que NÓS acabamos de criar para este cartão (lead do cadastro-todo-lead, paciente da
 *    Sofia): não conta. Cadastro sem data não prova nada — e impede o "não";
 *  - o reforço por nome achou → sim;
 *  - não está em lugar nenhum E o índice está inteiro e fresco (≤36 h) → não (= Cadastro);
 *  - índice ausente, velho, cortado ou com erro; franquia fora do ar; telefone ilegível → desconhecido: NÃO grava.
 */
export async function franquiaConhece(
  unit: Pick<Unit, 'id' | 'spineEnabled' | 'spineToken'> & Partial<Unit>,
  e: { titulo: string | null | undefined; nomeDoContato: string | null | undefined; telefone: string | null | undefined; chegadaEpoch?: number | null },
  deps: { buscar?: BuscarPaciente; indice?: ConsultarIndice } = {},
): Promise<RespostaDaFranquia> {
  if (!unit.spineEnabled || !unit.spineToken) return { resultado: 'desconhecido', motivo: 'a unidade não tem a franquia conectada' };
  const fone = String(e.telefone ?? '');
  const chave = chaveDoTelefone(fone);
  if (!chave) return { resultado: 'desconhecido', motivo: 'o contato não tem telefone de 8 dígitos ou mais' };
  const chegadaMs = e.chegadaEpoch ? e.chegadaEpoch * 1000 : null;

  // 1. o índice de telefones (paciente E lead)
  let indice: RespostaDoIndice | null = null;
  try {
    indice = await (deps.indice ?? consultarIndice)(unit.id, chave);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.id }, 'tipo-lead-chegada: não consegui ler o índice de telefones da franquia');
  }
  let semData = false;
  if (indice) {
    const provas = indice.entradas.filter((x) => {
      if (!x.criado) {
        semData = true;
        return false;
      }
      // sem a hora da chegada não dá para separar o que já existia do que nós acabamos de criar: não prova
      return chegadaMs !== null && x.criado.getTime() < chegadaMs;
    });
    if (provas.length > 0) {
      const o = provas.map((x) => `${x.origem} ${x.id ?? '?'}`).join(', ');
      return { resultado: 'sim', motivo: `o telefone já estava na franquia (${o}) antes deste cartão` };
    }
  }

  // 2. reforço por nome: acha quem o índice ainda não tem
  const porNome = await reforcoPorNome(unit as Unit, { ...e, telefone: fone }, deps.buscar ?? pacienteExistente);
  if (porNome.resultado === 'sim') return porNome;

  // 3. "não está em lugar nenhum" só com o índice inteiro e fresco
  if (!indice) return { resultado: 'desconhecido', falhou: true, motivo: 'não consegui ler o índice de telefones da franquia' };
  if (!indice.fresco) {
    return {
      resultado: 'desconhecido',
      motivo: indice.idadeHoras === null ? 'o índice de telefones da franquia ainda não foi montado' : `o índice de telefones da franquia está velho (${indice.idadeHoras} h) ou incompleto`,
    };
  }
  if (semData) return { resultado: 'desconhecido', motivo: 'a franquia tem um cadastro com este telefone mas sem data de criação — não dá para saber se é anterior ao cartão' };
  if (porNome.falhou) return { resultado: 'desconhecido', falhou: true, motivo: porNome.motivo };
  return { resultado: 'nao', motivo: `o telefone não está na franquia (nem paciente, nem lead; índice de ${indice.idadeHoras} h)` };
}

export type Veredito = { tipo: TipoDeLead; motivo: string } | { tipo: null; motivo: string };

/**
 * Puro. Junta as respostas. `pelaIdade` = a frase de `resgatePelaIdade` (ou null); `outrosLidos` = false quando não deu
 * para ler os outros cartões do contato (então "não é Resgate por idade" não está provado); `franquia` = (a).
 */
export function decidirTipoDaChegada(e: {
  pelaIdade: string | null;
  outrosLidos: boolean;
  franquia: RespostaDaFranquia | null;
  temDataDeChegada: boolean;
}): Veredito {
  if (e.pelaIdade) return { tipo: 'Resgate', motivo: e.pelaIdade };
  if (e.franquia?.resultado === 'sim') return { tipo: 'Resgate', motivo: e.franquia.motivo };
  if (!e.temDataDeChegada) return { tipo: null, motivo: 'o cartão não diz quando foi criado' };
  if (!e.outrosLidos) return { tipo: null, motivo: 'não consegui ler os outros cartões deste contato no Kommo' };
  if (!e.franquia) return { tipo: null, motivo: 'a franquia ainda não foi consultada' };
  if (e.franquia.resultado === 'desconhecido') return { tipo: null, motivo: e.franquia.motivo };
  return { tipo: 'Cadastro', motivo: `pessoa nova — ${e.franquia.motivo} e o 1º contato é recente` };
}

// ── a Sofia não escreve onde o robô escreve ───────────────────────────────────────────────────────

/**
 * O robô da chegada é o ÚNICO escritor do ⬢ Tipo de lead quando a chave está LIGADA na unidade: a captura da Sofia
 * (`gravarCampoDaRegra`, que grava sem ler) sobrescreveria o que ele gravou e o que a SDR escolheu. Em "só no papel" a Sofia segue
 * como hoje — seco não pode mudar comportamento. O nome é o exato (o campo antigo "Tipo de lead", sem o símbolo, é outro).
 */
export function sofiaNaoGravaTipoDeLead(slug: string | null | undefined, nomeDoCampo: string, raw: string | undefined = process.env.TIPO_LEAD_CHEGADA_SLUGS): boolean {
  return !!slug && nomeDoCampo.trim() === CAMPO_TIPO_LEAD && estadoDaAutomacao(slug, ID_AUTOMACAO, raw) === 'ligado';
}
