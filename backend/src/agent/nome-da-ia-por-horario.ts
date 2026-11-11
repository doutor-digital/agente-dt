/**
 * Nome da IA que muda pelo horário (Tatuí, 11/11/2026): as duas secretárias reais são a Sara (manhã) e a Cíntia
 * (tarde), e a IA se apresenta com o nome de quem estaria no balcão — "como fazíamos com a IA do Maurício".
 *
 * A escala vive em `units.persona_agent_name_schedule` (JSON):
 *   [{"desde":"00:00","nome":"Sara"},{"desde":"13:30","nome":"Cíntia"}]
 * Vale o último "desde" que já passou no relógio LOCAL da unidade; antes do primeiro, vale o último (o da véspera).
 * Sem escala (NULL, vazia ou torta) a unidade usa `personaAgentName`, igual a antes: ligar isto numa unidade não
 * muda nenhuma outra, e uma escala mal escrita nunca derruba o atendimento.
 *
 * O nome é calculado a cada turno (o prompt é montado por turno), não gravado em lugar nenhum.
 */
import type { Unit } from '@prisma/client';

import { fusoDaUnidade, partesNoFuso } from '../lib/fuso.js';

export interface FaixaDeNome {
  /** "HH:MM" local, inclusivo: a faixa começa neste minuto. */
  desde: string;
  nome: string;
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NOME_MAX = 40;

const minutos = (hhmm: string): number | null => {
  const m = HORA.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Lê o JSON livre do banco, descarta o que não estiver no formato e devolve em ordem de horário. */
export function lerEscalaDeNomes(bruto: unknown): FaixaDeNome[] {
  if (!Array.isArray(bruto)) return [];
  const faixas: FaixaDeNome[] = [];
  for (const f of bruto) {
    if (!f || typeof f !== 'object') continue;
    const { desde, nome } = f as Record<string, unknown>;
    if (typeof desde !== 'string' || minutos(desde) === null) continue;
    const limpo = typeof nome === 'string' ? nome.trim() : '';
    if (!limpo || limpo.length > NOME_MAX) continue;
    faixas.push({ desde, nome: limpo });
  }
  return faixas.sort((a, b) => minutos(a.desde)! - minutos(b.desde)!);
}

/** Nome da faixa que vale em `hora` ("HH:MM", local). null = sem escala utilizável. */
export function nomeDaEscalaNoHorario(bruto: unknown, hora: string): string | null {
  const faixas = lerEscalaDeNomes(bruto);
  if (faixas.length === 0) return null;
  const h = minutos(hora.slice(0, 5));
  if (h === null) return null;
  let vale = faixas[faixas.length - 1]!; // antes da primeira faixa do dia: segue a última, da véspera
  for (const f of faixas) if (minutos(f.desde)! <= h) vale = f;
  return vale.nome;
}

type UnidadeComEscala = Pick<Unit, 'personaAgentName' | 'personaAgentNameSchedule'> &
  Partial<Pick<Unit, 'businessHoursTimezone' | 'spineTimezone'>>;

/** "HH:MM" no relógio local da unidade. */
function horaLocal(agora: Date, unit: UnidadeComEscala): string {
  const p = partesNoFuso(agora, fusoDaUnidade(unit));
  return `${String(p.hora).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

/**
 * A unidade como ela é NESTE turno: `personaAgentName` já trocado pelo nome da faixa. É o único ponto de troca —
 * tudo que o compositor lê dali em diante (persona, bloco da rede, follow-up) enxerga o nome certo.
 * Sem escala devolve a própria unidade, sem copiar.
 */
export function unidadeNoTurno<T extends UnidadeComEscala>(unit: T, agora: Date = new Date()): T {
  const nome = nomeDaEscalaNoHorario(unit.personaAgentNameSchedule, horaLocal(agora, unit));
  if (!nome) return unit;
  return { ...unit, personaAgentName: nome };
}

/**
 * A frase para o prompt (`unit` já passou por `unidadeNoTurno`: o nome atual é o `personaAgentName` dela), quando a escala tem mais de um nome: as outras são COLEGAS da mesma recepção, então
 * "a Sara me disse" de manhã não pode ser negado à tarde. Vazio com um nome só (ou sem escala).
 */
export function renderColegasDeRecepcao(unit: UnidadeComEscala): string {
  const atual = unit.personaAgentName?.trim();
  if (!atual || !unit.personaAgentNameSchedule) return '';
  const vistos = new Set<string>([atual.toLowerCase()]);
  const colegas: string[] = [];
  for (const { nome } of lerEscalaDeNomes(unit.personaAgentNameSchedule)) {
    if (vistos.has(nome.toLowerCase())) continue;
    vistos.add(nome.toLowerCase());
    colegas.push(nome);
  }
  if (colegas.length === 0) return '';
  const lista = colegas.length === 1 ? colegas[0]! : `${colegas.slice(0, -1).join(', ')} e ${colegas[colegas.length - 1]}`;
  const varias = colegas.length > 1;
  return (
    `Na recepção também atende ${lista}, ${varias ? 'colegas suas' : 'colega sua'}: é a mesma recepção, em outro turno. ` +
    `Se o paciente falar de ${lista}, ou a conversa tiver fala ${varias ? 'delas' : 'dela'}, siga de onde parou, como quem continua o atendimento. ` +
    `Nunca negue o que ${varias ? 'elas disseram' : 'ela disse'} nem se apresente do zero; mas não invente que ${varias ? 'elas' : 'ela'} te passou o caso se ${varias ? 'não aparecem' : 'não aparece'} na conversa. ` +
    `Só comente a troca se o paciente tocar no assunto.`
  );
}
