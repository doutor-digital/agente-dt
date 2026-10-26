/**
 * Quando a pergunta de confirmação (véspera e reforço) NÃO deve sair, mesmo com a consulta de pé na franquia.
 *
 * A franquia não sabe de desistência: a regra da casa é cancelar só no Kommo (a SDR move o cartão), e o paciente
 * avisa pelo WhatsApp. Caso Milena/Leomar, Canaã (28071358): em 17/10/2026 12:53 escreveu "tive um imprevisto, não
 * vou poder comparecer à consulta"; a equipe ofereceu outro dia, o cartão ficou em AGENDADO e a franquia com a
 * consulta de 19/10 08:00. A nossa véspera saiu em 18/10 09:41 — junto com os três robôs do Kommo.
 *
 * Daí as três travas, nesta ordem: cartão perdido, etapa de cancelado/espera e desistência escrita pelo paciente
 * depois que a consulta foi marcada. Pausar IA, sozinho, não trava: em várias unidades a pausa nunca é tirada
 * e cortaria o lembrete de quem só foi atendido pela equipe.
 */
import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { falouDeOutraConsulta, pareceDesistenciaDaConsulta, quisManter } from './desistencia-frases.js';
import { semAcento as normalizar } from './sem-acento.js';

/**
 * O paciente disse que não vem ou quer outro horário. Estreita de propósito: "não" solto não conta, nem
 * "não vou conseguir pagar antes" — só frase sobre IR à consulta, desmarcar ou remarcar.
 */
const DESISTE = [
  /\bimprevisto\b/,
  /\b(desmarc|cancel|remarc|reagend)\w*/,
  /\bn(ao|) (vou|vamos|vai|irei|iremos|poderei|poderemos|posso|podemos|consigo|conseguimos|conseguirei|conseguiremos)( mais)?( (poder|conseguir))? (ir|comparecer|vir|estar ai|estar la|estar presente)\b/,
  /\bn(ao|) vai (dar|rolar) (pra|para|de) (ir|vir|comparecer)\b/,
  /\boutro (dia|horario)\b/,
];

/** Confirmação dita por extenso, ou o "1" / botão da própria pergunta. */
const CONFIRMA = [
  /^1\b/,
  /\bconfirm(o|ado|ada|amos|ei)\b/,
  /\b(vou|vamos|estarei|estaremos) (sim|la|ai|estar la|estar ai)\b/,
  /\bpode (confirmar|contar)\b/,
];

export function pareceDesistencia(texto: string): boolean {
  const s = normalizar(texto);
  if (!s) return false;
  // Quem quer MANTER a consulta ("não quero remarcar, quero manter", "cancela não") e quem fala de OUTRA consulta ("cancela a do meu
  // filho, a minha mantém") não deixa de receber a véspera da sua — achado do sênior no #132.
  if (quisManter(texto) || falouDeOutraConsulta(texto)) return false;
  // Superconjunto do detector da régua e da Sofia (desistencia-da-consulta.ts): a frase que cala a régua e faz a Sofia
  // oferecer horário NUNCA pode deixar a véspera sair. Aqui entram também "remarcar", "reagendar" e "outro dia".
  return pareceDesistenciaDaConsulta(texto) || DESISTE.some((r) => r.test(s));
}

export function pareceConfirmacao(texto: string): boolean {
  const s = normalizar(texto);
  return !!s && CONFIRMA.some((r) => r.test(s));
}

/**
 * A última palavra do paciente sobre a consulta, desde que ela foi marcada: devolve a mensagem de desistência
 * quando é ela a mais recente das que decidem. Confirmação depois dela desfaz ("não vou poder… ah, consegui,
 * confirmo"). `desde` é quando o horário atual foi gravado — desistência de uma consulta anterior, já remarcada,
 * não cala o lembrete da nova.
 */
export function desistenciaEscrita(msgs: MensagemOficial[], desde: Date): MensagemOficial | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.em < desde) break;
    if (m.direcao !== 'entrada' || m.autor !== 'paciente' || !m.texto) continue;
    if (pareceConfirmacao(m.texto)) return null;
    if (pareceDesistencia(m.texto)) return m;
  }
  return null;
}

export type MotivoSemVespera = 'perdido' | 'etapa' | 'desistencia';

/** Cartão fechado como perdido, ou numa etapa de quem não vem (cancelado, desistência, em espera). */
export function etapaSemVespera(etapa: { statusId: number; nome: string | null | undefined }): MotivoSemVespera | null {
  if (etapa.statusId === 143) return 'perdido';
  const nome = normalizar(etapa.nome ?? '');
  if (/\b(cancelad|desist|perdid|em espera)/.test(nome)) return 'etapa';
  return null;
}

/** Tarefa para a equipe quando a desistência escrita segurou a pergunta. */
export function textoTarefaDesistencia(args: {
  slug: string;
  nome: string | null | undefined;
  quando: string;
  etapa: string | null | undefined;
  mensagem: string;
}): string {
  const dia = args.quando.slice(8, 10) + '/' + args.quando.slice(5, 7);
  const hora = args.quando.slice(11, 16);
  const trecho = args.mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome || 'paciente'}] Escreveu que não vem: "${trecho}". ` +
    `A confirmação da consulta de ${dia} às ${hora} não saiu. Ela segue na agenda da franquia e o cartão em ` +
    `${args.etapa || 'etapa de agendado'}: remarcar ou mover o cartão — enquanto ele estiver aí, os lembretes do Kommo continuam saindo.`
  );
}
