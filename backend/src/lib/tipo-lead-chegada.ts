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
 * Limite conhecido (diga na hora de ligar): a franquia só busca paciente por NOME (o telefone decide entre os achados) e o
 * lead dela só por intervalo de datas. Então "já estava na franquia" enxerga paciente cadastrado com o mesmo nome do
 * WhatsApp/cartão; um lead que a recepção cadastrou lá sem nunca ter cartão aqui não aparece (a busca de lead por
 * data custaria até 10 páginas por cartão). Quem estava só como lead antigo no Kommo aparece pela regra dos 90 dias.
 */
import type { Unit } from '@prisma/client';
import { DIAS_PARA_RESGATE, datasNoNome, primeiroContatoEm } from './campos-sdr.js';
import { normalizar } from './franquia-sync.js';
import { limparNome, termosDeBusca } from './widget-agenda.js';
import { fim8, pacienteExistente, type Achado } from './paciente-existente.js';
import { ehSemNome } from './titulo-padrao.js';

export const ID_AUTOMACAO = 'tipo-lead-chegada';

export const CAMPO_TIPO_LEAD = '⬢ Tipo de lead';
export const CAMPO_PRIMEIRO_CONTATO = '◷ Data do primeiro contato';

const DIA_S = 86_400;

export type TipoDeLead = 'Resgate' | 'Cadastro';

/** O campo pelo nome exato (com o símbolo) primeiro: a normalização tira o "⬢" e o "Tipo de lead" antigo casaria. */
export function acharCampo<T extends { name: string }>(campos: ReadonlyArray<T>, nome: string): T | null {
  const exatos = campos.filter((c) => c.name.trim() === nome);
  if (exatos.length === 1) return exatos[0]!;
  if (exatos.length > 1) return null;
  const alvo = normalizar(nome);
  const parecidos = campos.filter((c) => normalizar(c.name) === alvo);
  return parecidos.length === 1 ? parecidos[0]! : null;
}

/** A opção da lista pelo VALOR, na grafia da conta ("Resgate"/"Cadastro"). null = a conta não tem a opção. */
export function opcaoDaConta(enums: ReadonlyArray<{ value: string }>, tipo: TipoDeLead): string | null {
  const alvo = normalizar(tipo);
  return enums.find((e) => normalizar(e.value) === alvo)?.value ?? null;
}

/** Valor atual de um campo do cartão (texto), null se vazio. */
export function valorDoCampo(
  lead: { custom_fields_values?: Array<{ field_id: number; values: Array<{ value: unknown }> }> | null },
  fieldId: number,
): string | null {
  const v = lead.custom_fields_values?.find((f) => f.field_id === fieldId)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
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
  const dias = Math.floor((chegada - primeiro) / DIA_S);
  return dias > DIAS_PARA_RESGATE ? `1º contato há ${dias} dias (mais de ${DIAS_PARA_RESGATE})` : null;
}

export type Conhecido = 'sim' | 'nao' | 'desconhecido';

export interface RespostaDaFranquia {
  resultado: Conhecido;
  motivo: string;
}

export type BuscarPaciente = (unit: Unit, nome: string, titulo: string, fone: string, opcoes?: { soPrimeiroNome?: boolean }) => Promise<Achado>;

/**
 * (a): a franquia conhece esta pessoa? Uma busca por cartão (o worker guarda a resposta). A franquia busca por NOME e o
 * telefone (8 últimos dígitos) decide — a mesma busca de `pacienteExistente`. `desconhecido` = não dá para afirmar nem
 * que sim nem que não (franquia fora do ar, sem telefone, sem nome, nome comum demais): nunca vira Cadastro.
 */
export async function franquiaConhece(
  unit: Pick<Unit, 'spineEnabled' | 'spineToken'> & Partial<Unit>,
  e: { titulo: string | null | undefined; nomeDoContato: string | null | undefined; telefone: string | null | undefined },
  buscar: BuscarPaciente = pacienteExistente,
): Promise<RespostaDaFranquia> {
  if (!unit.spineEnabled || !unit.spineToken) return { resultado: 'desconhecido', motivo: 'a unidade não tem a franquia conectada' };
  const fone = String(e.telefone ?? '');
  if (!fim8(fone)) return { resultado: 'desconhecido', motivo: 'o contato não tem telefone' };

  // "Lead 06/11/2026" / "Lead #123" é o título provisório, não nome: buscar "Lead" na franquia seria ruído.
  const tituloBruto = String(e.titulo ?? '');
  const titulo = ehSemNome(tituloBruto) || /^lead\b/i.test(tituloBruto.trim()) ? '' : tituloBruto;
  const nomeContato = limparNome(e.nomeDoContato);
  const termos = termosDeBusca(titulo, nomeContato);
  if (termos.length === 0) return { resultado: 'desconhecido', motivo: 'sem nome para buscar na franquia (título provisório e contato sem nome)' };

  // só o primeiro nome: a busca só prova "não existe" se viu todo mundo com esse nome (página não cheia)
  const temNomeCompleto = termos.some((t) => t.split(' ').length >= 2);
  const nome = nomeContato || limparNome(titulo);
  let achado: Achado;
  try {
    achado = await buscar(unit as Unit, nome, titulo, fone, { soPrimeiroNome: !temNomeCompleto });
  } catch (err) {
    return { resultado: 'desconhecido', motivo: `a franquia não respondeu (${String(err).slice(0, 120)})` };
  }
  switch (achado.tipo) {
    case 'achou':
      return { resultado: 'sim', motivo: `já cadastrada na franquia (idClient ${achado.idClient}, pelo telefone)` };
    case 'ambiguo':
      return { resultado: 'sim', motivo: `já cadastrada na franquia (${achado.candidatos.length} cadastros com este telefone)` };
    case 'nao_achou':
      return { resultado: 'nao', motivo: 'o telefone não está na franquia' };
    case 'inconclusivo':
      return { resultado: 'desconhecido', motivo: 'só o primeiro nome e a busca na franquia veio cheia (nome comum): não dá para afirmar que é nova' };
    default:
      return { resultado: 'desconhecido', motivo: 'a franquia não respondeu à busca' };
  }
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
