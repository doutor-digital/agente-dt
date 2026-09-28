/**
 * Franquia → Kommo, carga de implantação: CRIAR o cartão que não existe.
 *
 * O `franquia-sync-worker` sabe achar o paciente, espelhar os campos e mover a etapa — mas quando
 * não encontra cartão ele só conta e segue (`semLead`). Em unidade recém-implantada isso é a regra,
 * não a exceção: medido em Petrópolis (28/09/2026), a franquia tinha **183 pacientes com agenda** e
 * o Kommo **1 lead**; a varredura rodava de 15 em 15 minutos e gravava zero, porque não havia cartão
 * para preencher.
 *
 * Esta lib é a decisão pura de *quem merece cartão e em que etapa ele nasce*. Serve a dois casos, e
 * são os dois que o João pediu (28/09/2026): povoar uma conta vazia, e arrumar as etapas de uma conta
 * cujos cartões estão todos no lugar errado.
 *
 * ## Por que o cartão ANDA pela máquina em vez de nascer numa etapa escolhida à mão
 *
 * A tabela de etapas mora em `planejarMovimento`, com dez anos de regra de negócio dentro (jornada
 * por idade do fato, ciclo de retorno pós-tratamento, ex-paciente que vai pra ALTA sem passar por
 * GANHO). Reescrever "se atendido então COMPARECEU" aqui seria uma segunda verdade, que iria divergir
 * na primeira mudança. Então o cartão novo **nasce na etapa de entrada e caminha**: pergunta-se à
 * máquina pra onde ele vai, aplica-se, pergunta de novo, até ela dizer "fica". A etapa onde ele para
 * é onde ele nasce.
 *
 * ## Por que ele nasce em AGENDADO e não na etapa de entrada
 *
 * Tentar nascer na entrada não funciona, e o motivo é uma decisão consciente de 18/09/2026: da etapa
 * de entrada (e de EM QUALIFICAÇÃO / EM ESPERA) a máquina **não inventa falta nem perda**, porque
 * quem está lá é da Sofia — ela pode estar conversando com um paciente antigo que voltou, e declarar
 * "NÃO COMPARECEU" por cima disso seria atropelar a conversa. Um cartão que nasce da franquia não tem
 * conversa nenhuma: o fato registrado lá é tudo o que existe sobre ele.
 *
 * Por isso o berço é **AGENDADO**, que é a afirmação "este paciente tem consulta na franquia" — e é
 * exatamente o que sabemos dele. De lá a máquina alcança todo o resto: atendida vira COMPARECEU ou
 * NEGOCIAÇÃO ou PERDIDO pela idade, falta vira NÃO COMPARECEU ou EM ESPERA, tratamento vira GANHO e
 * depois EM TRATAMENTO. Nascer na entrada deixaria os 30 cartões perdidos de Petrópolis empilhados
 * ali, que é o oposto de organizar.
 *
 * ## O que NUNCA entra
 *
 * Paciente sem telefone utilizável. Cartão sem contato é cartão que ninguém consegue trabalhar, e
 * `POST /leads/complex` aceitaria numa boa — o Kommo não reclama, e a SDR descobre depois.
 */
import { ETAPA, planejarMovimento, type EtapaAtual, type Funil, type TratamentoParaEtapa } from './franquia-move.js';
import type { SpineSchedule } from '../services/spine.service.js';

/** Onde o cartão novo é posto antes de caminhar — ver o cabeçalho para o porquê de não ser a entrada. */
const NASCIMENTO: EtapaAtual = { funil: 'COMERCIAL', status: ETAPA.AGENDADO };

/**
 * Teto de passos do caminhar. A máquina é um grafo, não uma árvore: um dia alguém escreve duas regras
 * que se apontam (COMPARECEU → NEGOCIAÇÃO → COMPARECEU) e o laço não termina. Seis passos cobrem a
 * jornada mais longa que existe hoje (entrada → agendado → compareceu → negociação → ganho →
 * em tratamento → alta) com folga de um.
 */
export const MAX_PASSOS = 8;

export interface DestinoDoCartao {
  funil: Funil;
  status: string;
  /** o caminho que a máquina percorreu, para o log e para a prévia explicar a decisão */
  caminho: string[];
}

export interface EntradaDestino {
  agendamentos: SpineSchedule[];
  tratamentos: TratamentoParaEtapa[];
  agoraEpoch: number;
  horasAteNegociacao: number;
}

/**
 * Em que etapa um cartão novo deste paciente nasceria, deixando a máquina de `planejarMovimento`
 * caminhar desde a etapa de entrada. Devolve a etapa de entrada quando a máquina não move nada —
 * paciente que a franquia conhece mas sobre quem não há fato nenhum.
 */
export function destinoDoCartao(e: EntradaDestino): DestinoDoCartao {
  let atual: EtapaAtual = { ...NASCIMENTO };
  const caminho: string[] = [];
  const vistos = new Set<string>([`${atual.funil}/${atual.status}`]);

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    const mov = planejarMovimento({
      atual,
      agendamentos: e.agendamentos,
      tratamentos: e.tratamentos,
      agoraEpoch: e.agoraEpoch,
      horasAteNegociacao: e.horasAteNegociacao,
    });
    if (!mov) break;
    const chave = `${mov.funil}/${mov.para}`;
    // já passamos por aqui: duas regras se apontando. Para no que temos em vez de girar.
    if (vistos.has(chave)) break;
    vistos.add(chave);
    atual = { funil: mov.funil, status: mov.para };
    caminho.push(`${mov.para} (${mov.motivo})`);
  }
  return { funil: atual.funil, status: atual.status, caminho };
}

export interface PacienteDaFranquia {
  nome: string;
  idClient: number | null;
  /** já normalizado: só dígitos */
  telefone: string | null;
  agendamentos: SpineSchedule[];
  tratamentos: TratamentoParaEtapa[];
}

export type MotivoDeFora =
  | 'ja-tem-cartao'
  | 'sem-telefone'
  | 'sem-fato';

export interface CartaoAcriar {
  nome: string;
  idClient: number | null;
  /** E.164 pronto pro Kommo */
  telefone: string;
  funil: Funil;
  status: string;
  caminho: string[];
}

export interface PlanoDeCarga {
  criar: CartaoAcriar[];
  /** quem ficou de fora e por quê — a prévia mostra isso, senão o número não fecha e ninguém confia */
  fora: Array<{ nome: string; motivo: MotivoDeFora }>;
}

/**
 * Telefone da franquia em E.164. A franquia devolve "(24) 98837-4861"; o Kommo quer "+5524988374861".
 * Devolve `null` para o que não dá pra discar — é o que tira o paciente da carga.
 */
export function telefoneE164(bruto: string | null | undefined): string | null {
  const so = String(bruto ?? '').replace(/\D/g, '');
  if (so.length < 10) return null;
  // 10 (fixo) ou 11 (celular) dígitos = número nacional, falta o país
  if (so.length <= 11) return `+55${so}`;
  // já veio com 55 na frente (ou outro país): respeita
  if (so.length <= 15) return `+${so}`;
  return null;
}

export interface EntradaCarga {
  pacientes: PacienteDaFranquia[];
  /** responde "este paciente já tem cartão?" — quem chama resolve com o vínculo e o telefone */
  temCartao: (p: PacienteDaFranquia) => boolean;
  agoraEpoch: number;
  horasAteNegociacao: number;
}

/** Puro: quem ganha cartão, em que etapa, e quem fica de fora com o motivo. */
export function planejarCarga(e: EntradaCarga): PlanoDeCarga {
  const criar: CartaoAcriar[] = [];
  const fora: PlanoDeCarga['fora'] = [];

  for (const p of e.pacientes) {
    if (e.temCartao(p)) {
      fora.push({ nome: p.nome, motivo: 'ja-tem-cartao' });
      continue;
    }
    const telefone = telefoneE164(p.telefone);
    if (!telefone) {
      fora.push({ nome: p.nome, motivo: 'sem-telefone' });
      continue;
    }
    // sem agendamento e sem tratamento não há o que espelhar: é cadastro solto na franquia
    if (!p.agendamentos.length && !p.tratamentos.length) {
      fora.push({ nome: p.nome, motivo: 'sem-fato' });
      continue;
    }
    const destino = destinoDoCartao({
      agendamentos: p.agendamentos,
      tratamentos: p.tratamentos,
      agoraEpoch: e.agoraEpoch,
      horasAteNegociacao: e.horasAteNegociacao,
    });
    criar.push({
      nome: p.nome,
      idClient: p.idClient,
      telefone,
      funil: destino.funil,
      status: destino.status,
      caminho: destino.caminho,
    });
  }
  return { criar, fora };
}

/** Quantos cartões por etapa — o número que a prévia mostra antes de alguém apertar "aplicar". */
export function porEtapa(plano: PlanoDeCarga): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of plano.criar) {
    const chave = c.funil === 'TRATAMENTO' ? `TRATAMENTO / ${c.status}` : c.status;
    out[chave] = (out[chave] ?? 0) + 1;
  }
  return out;
}
