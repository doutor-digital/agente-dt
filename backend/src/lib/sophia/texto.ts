/**
 * Os textos da Sophia: título e descrição do evento na Tramitação, aviso do grupo interno e a regra presencial × online.
 * Tudo PURO. O telefone do cliente só entra na descrição do evento (a Tramitação é o sistema do escritório): nunca no aviso do grupo, no log nem no trace.
 */
import type { Advogado } from './config.js';

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "terça-feira, 18 de novembro" (calculado aqui: o modelo erra o dia da semana). */
export function diaPorExtenso(data: string): string {
  const [a, m, d] = data.split('-').map(Number);
  if (!a || !m || !d) return data;
  const dia = DIAS[new Date(Date.UTC(a, m - 1, d, 12)).getUTCDay()]!;
  return `${dia}, ${d} de ${MESES[m - 1]!}`;
}

/** Sem acento, minúsculo, espaços únicos. */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type Modalidade = 'presencial' | 'online';

/**
 * Presencial só para quem mora em Araguaína/TO; qualquer outra cidade (ou cidade que a pessoa não disse) é online.
 * O estado é opcional: se veio e não é Tocantins, é online ("Araguaína" de outro estado não existe, mas o dado errado não leva ninguém ao escritório).
 */
export function modalidadeDoAtendimento(cidade: string, estado?: string | null): Modalidade {
  const c = normalizar(cidade ?? '');
  if (c !== 'araguaina') return 'online';
  const e = normalizar(estado ?? '');
  return !e || e === 'to' || e === 'tocantins' ? 'presencial' : 'online';
}

/** Tira quebra de linha e caractere de controle, aparando no tamanho. */
export function limpar(v: string | null | undefined, max: number): string {
  const s = (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export const primeiroNome = (nome: string): string => limpar(nome, 80).split(' ')[0] ?? '';

export function tituloDoEvento(nomeDoCliente: string, adv: Pick<Advogado, 'tratamento'>): string {
  return `Atendimento - ${limpar(nomeDoCliente, 80)} (${adv.tratamento})`;
}

export interface DadosDoAtendimento {
  nomeDoCliente: string;
  /** Só vai para a descrição do evento. */
  telefone: string | null;
  cidade: string;
  caso: string;
  temLaudoEExames: boolean;
  situacaoNoInss: string;
  modalidade: Modalidade;
  /** Só no online. Vazio = "a equipe envia o link". */
  linkDoMeet: string | null;
}

export function descricaoDoEvento(d: DadosDoAtendimento): string {
  const onde =
    d.modalidade === 'presencial' ? 'Presencial (no escritório)' : d.linkDoMeet ? `Online pelo Google Meet: ${d.linkDoMeet}` : 'Online pelo Google Meet (a equipe envia o link ao cliente)';
  return [
    'Agendado pela Sophia (IA do escritório).',
    `Modalidade: ${onde}`,
    `Cidade: ${limpar(d.cidade, 80)}`,
    `Caso: ${limpar(d.caso, 400)}`,
    `Laudo e exames: ${d.temLaudoEExames ? 'tem' : 'não tem'}`,
    `Situação no INSS: ${limpar(d.situacaoNoInss, 200)}`,
    `Contato: ${d.telefone ? limpar(d.telefone, 30) : 'está no cartão do Kommo'}`,
  ].join('\n');
}

/** O @ de quem é marcado: com número, o `@número` que o WhatsApp transforma em menção; sem número, só o nome (e o log avisa). */
export function marcacao(adv: Pick<Advogado, 'numero' | 'nome'>): string {
  return adv.numero ? `@${adv.numero}` : `@${adv.nome}`;
}

export function avisoDoAgendamento(a: {
  primeiroNome: string;
  cidade: string;
  caso: string;
  temLaudoEExames: boolean;
  situacaoNoInss: string;
  data: string;
  hora: string;
  modalidade: Modalidade;
  advogado: Pick<Advogado, 'numero' | 'nome'>;
}): string {
  return [
    '✅ Sophia agendou um atendimento',
    `👤 Cliente: ${limpar(a.primeiroNome, 40)}`,
    `📍 Cidade: ${limpar(a.cidade, 60)}`,
    `🩺 Caso: ${limpar(a.caso, 160)}`,
    `📄 Laudo e exames: ${a.temLaudoEExames ? 'tem' : 'não tem'}`,
    `🏛️ Situação no INSS: ${limpar(a.situacaoNoInss, 120)}`,
    `📅 ${diaPorExtenso(a.data)} às ${a.hora} · ${a.modalidade}`,
    `👩‍⚖️ ${marcacao(a.advogado)}`,
    'Já está na agenda da Tramitação e no Kommo.',
  ].join('\n');
}

export type MotivoDoThiago = 'pediu_thiago' | 'tributario';

export function avisoDoThiago(a: {
  primeiroNome: string;
  cidade: string | null;
  resumo: string;
  motivo: MotivoDoThiago;
  linkDoCartao: string | null;
  advogado: Pick<Advogado, 'numero' | 'nome'>;
}): string {
  return [
    '⚖️ Sophia: cliente para o Dr. Thiago (não agendei nada)',
    `👤 Cliente: ${limpar(a.primeiroNome, 40)}`,
    ...(a.cidade ? [`📍 Cidade: ${limpar(a.cidade, 60)}`] : []),
    `🩺 Caso: ${limpar(a.resumo, 240)}`,
    `❓ Motivo: ${a.motivo === 'pediu_thiago' ? 'o cliente pediu o Dr. Thiago' : 'caso tributário'}`,
    ...(a.linkDoCartao ? [`🔗 Cartão: ${a.linkDoCartao}`] : []),
    `${marcacao(a.advogado)} você consegue ligar para ele? Avisei o cliente que o Dr. Thiago entra em contato.`,
  ].join('\n');
}
