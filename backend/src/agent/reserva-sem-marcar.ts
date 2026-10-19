/**
 * Trava "reservado sem marcar": a resposta afirma que o horário está reservado/marcado e não existe
 * consulta nenhuma — sai antes do envio, não depois.
 *
 * Caso que motivou (19/10/2026, Olímpia, relato do João: "o paciente que não pagou, ela agendou, e o
 * que pagou, ela não agendou"):
 *  - Anderson (lead 5646431) pediu a chave Pix e escolheu "Terça às 11:30". A IA respondeu "Vou deixar
 *    reservado pra você. Só confirmando: você consegue vir…?" — e não marcou: faltava o "sim". Ele mandou
 *    o comprovante em vez do "sim", e o horário seguiu livre na agenda.
 *  - Às 16:44 o Marcos (lead 5671317) disse "Sim" e a IA deu a ele o 11h30 de terça. O Anderson pagou
 *    R$ 200 por um horário que não existia.
 * Na rede, em 7 dias, 54 pacientes ouviram "reservado" sem consulta marcada.
 *
 * O detector é o mesmo do vigia "prometeu e não marcou" (`lib/prometeu-sem-marcar.ts`), que separa a
 * afirmação ("deixo reservado pra sexta", "fica marcado") da oferta e da condição ("quer que eu deixe
 * reservado?", "assim que o Pix cair…"). Aqui ele só vale quando NÃO há consulta de verdade: nem marcada
 * neste turno, nem no bloco <consulta_do_paciente> do prompt.
 */
import { detectarPromessa, normalizar, trechos, type Promessa } from '../lib/prometeu-sem-marcar.js';
import { prisma } from '../lib/prisma.js';
import { agoraLocalISO } from './consulta-que-passou.js';

/** O que `agendar_consulta` e `remarcar_consulta` devolvem quando dá certo. */
const MARCOU = /^(Consulta marcada para|Remarcada (de|para)|A CONSULTA NOVA ESTÁ MARCADA)/;

export function marcouNesteTurno(resultadosDasFerramentas: ReadonlyArray<string>): boolean {
  return resultadosDasFerramentas.some((t) => MARCOU.test(String(t ?? '').trim()));
}

/**
 * O prompt do turno diz que existe consulta (ou sessão) futura de verdade — marcada pela IA antes, pela
 * recepção, ou remarcada. Os textos são os do bloco <consulta_do_paciente> (`prompt-composer.ts`); "JÁ
 * PASSOU" e "DESMARCADA" não contam.
 */
const TEM_CONSULTA = /Consulta CONFIRMADA agora no sistema da clínica|Este paciente TEM consulta marcada|Próximo agendamento:/;

export function promptTemConsulta(prompt: string | null | undefined): boolean {
  return TEM_CONSULTA.test(String(prompt ?? ''));
}

/**
 * "Vou deixar reservado pra você." / "Deixo reservado pra você." — a frase do Anderson. O detector do vigia
 * não pega (de propósito: sem dia/hora nem "sua consulta" no MESMO trecho ele não avisa, para o alarme não
 * gritar à toa). Antes do envio a régua é outra: dizer que GUARDOU o horário sem ter marcado é sempre falso.
 * Só "reservado/guardado/garantido" afirmado na primeira pessoa ou como estado — não oferta, pergunta,
 * condição nem a explicação de preço ("a vaga fica reservada e você paga no dia").
 */
const RESERVA_AFIRMADA =
  /\b(?:deixo|deixei|vou (?:ja )?deixar|ja (?:vou )?deixar|ja deixo|ja deixei|fica|ficou|esta|ta|ja esta|ja fica)\s+(?:\S+\s+){0,4}?(?:reservad|guardad|garantid)(?:inh)?[oa]s?\b/;
const NAO_AFIRMA =
  /\b(?:se|senao|assim que|logo que|depois que|quando|caso|apos|garante|garantir|garantindo|pagando|antecipando|quer que|posso|podemos|prefere|gostaria|deseja|nao|nunca|nenhum|nenhuma|sem)\b|\be so\b|\b(?:pra|para) eu\b|\bcom o (?:pix|pagamento|comprovante|adiantamento)\b|\b(?:a|o) (?:vaga|horario) (?:fica|esta|ta)\b/;

export function reservaAfirmada(texto: string | null | undefined): Promessa | null {
  for (const t of trechos(String(texto ?? ''))) {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n) || NAO_AFIRMA.test(n)) continue;
    if (RESERVA_AFIRMADA.test(n)) return { trecho: t, forma: 'reserva', quando: null };
  }
  return null;
}

/** "20/10", "2026-10-20" → "20/10" (sem zero à esquerda), para comparar a data prometida com a da consulta que existe. */
export function datasCitadas(texto: string | null | undefined): Set<string> {
  const s = String(texto ?? '');
  const out = new Set<string>();
  // "2026-10-20T11:30": o T colado não é fronteira de palavra, por isso (?!\d) e não \b no fim
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) out.add(`${Number(m[3])}/${Number(m[2])}`);
  for (const m of s.replace(/\b\d{4}-\d{2}-\d{2}(?!\d)/g, ' ').matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) out.add(`${Number(m[1])}/${Number(m[2])}`);
  return out;
}

/** O bloco <consulta_do_paciente> do prompt (onde está a data da consulta que existe), ou '' sem ele. */
export function blocoDaConsulta(prompt: string | null | undefined): string {
  const m = String(prompt ?? '').match(/<consulta_do_paciente>([\s\S]*?)<\/consulta_do_paciente>/);
  return m ? m[1] : '';
}

/**
 * A promessa que não pode sair: afirma consulta marcada/reservada e ela não existe.
 *
 * `consultasValidas` = textos que trazem a data da consulta que EXISTE (o bloco do prompt, o vínculo do
 * agendar_consulta). Ter consulta não libera qualquer promessa (achado do Codex, 19/10): quem já tem sessão
 * na quarta e ouve "deixo reservado sexta, 23/10" continua barrado. Libera quando a promessa fala da mesma
 * data — ou não diz data nenhuma, e aí o assunto é a consulta que existe.
 */
export function reservaSemMarcar(
  texto: string | null | undefined,
  evidencias: { marcouAgora: boolean; consultasValidas?: ReadonlyArray<string> },
): Promessa | null {
  const p = detectarPromessa(texto) ?? reservaAfirmada(texto);
  if (!p || evidencias.marcouAgora) return null;
  const validas = (evidencias.consultasValidas ?? []).filter((t) => t && t.trim());
  if (validas.length === 0) return p;
  const prometido = marcasDoQuando(`${p.trecho} ${p.quando ?? ''}`);
  const existe = marcasDoQuando(validas.join(' '));
  // Cada coisa que a promessa diz (data, dia da semana, hora) tem de bater com a consulta que existe —
  // "sexta" sem data e "às 15h" no mesmo dia da consulta das 11h também são barrados (achado do Codex).
  // Promessa sem dia nem hora ("sua consulta está confirmada") fala da consulta que existe.
  for (const k of ['datas', 'dias', 'horas'] as const) {
    if (prometido[k].size === 0) continue;
    if (existe[k].size === 0) continue;
    if (![...prometido[k]].every((v) => existe[k].has(v))) return p;
  }
  return null;
}

const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

/** Data, dia da semana e hora citados (ou do "AAAA-MM-DDTHH:mm" do vínculo), normalizados para comparar. */
export function marcasDoQuando(texto: string): { datas: Set<string>; dias: Set<string>; horas: Set<string> } {
  const n = normalizar(texto);
  const datas = datasCitadas(texto);
  const dias = new Set<string>();
  for (const d of DIAS) if (new RegExp(`\\b${d}(?:-feira)?\\b`).test(n)) dias.add(d);
  const horas = new Set<string>();
  for (const m of texto.matchAll(/\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/g)) {
    dias.add(DIAS[new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`).getUTCDay()]);
    horas.add(`${Number(m[4])}:${m[5]}`);
  }
  for (const m of n.replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/g, ' ').matchAll(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?)(?!\d)/g)) {
    horas.add(`${Number(m[1])}:${m[2] ?? m[3] ?? '00'}`);
  }
  return { datas, dias, horas };
}

/** Quando nem a refeita nem o corte tiram a promessa: melhor perguntar de novo que prometer o que não existe. */
export const PERGUNTA_NEUTRA = 'Pra eu marcar certinho na agenda: me confirma o dia e o horário que você quer? 😊';

/** Vai junto da resposta reprovada. Deixa a IA MARCAR (com as ferramentas) quando o paciente já respondeu tudo. */
export const INSTRUCAO_RESERVA_SEM_MARCAR =
  '[instrução interna, não é fala do paciente] Sua resposta acima diz que o horário está reservado ou marcado, ' +
  'mas NENHUMA consulta foi marcada no sistema da clínica — nada fica guardado, e outro paciente pode pegar esse horário. ' +
  'Se o paciente JÁ escolheu o dia e a hora (ou mandou o comprovante depois da chave Pix) e já disse como vai pagar, ' +
  'chame agendar_consulta AGORA. Se falta alguma dessas respostas, reescreva a mensagem SEM dizer que está reservado, ' +
  'marcado, guardado ou garantido, e pergunte só o que falta. Responda só com a mensagem final ou com a chamada da ferramenta.';

/**
 * Último recurso, quando a refeita não serve: tira o trecho que promete e fica o resto
 * ("Perfeito! Vou deixar reservado pra você. Só confirmando: você consegue vir…?" → "Perfeito! Só
 * confirmando: …"). Se sobrar quase nada, devolve null e quem chama decide.
 */
export function semOTrecho(texto: string, trecho: string): string | null {
  const i = texto.indexOf(trecho);
  if (i < 0 || !trecho.trim()) return null;
  const antes = texto.slice(0, i);
  const depois = texto
    .slice(i + trecho.length)
    // a pontuação/travessão que fechava o trecho removido
    .replace(/^\s*[.!;,:]+/, '')
    .replace(/^\s*[—–]\s*/, '');
  const resto = `${antes} ${depois}`.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return resto.replace(/[\p{P}\p{S}\s]/gu, '').length >= 10 ? resto : null;
}

/**
 * A IA marcou antes e o prompt não trouxe a consulta (5 casos em 7 dias na medição de 19/10): o vínculo
 * gravado pelo `agendar_consulta` resolve. Só é lido quando a trava já disparou — não custa nada no turno normal.
 */
export async function agendamentoDoVinculo(unitId: string, leadId: number, fuso: string): Promise<string | null> {
  const v = await prisma.spineLeadLink
    .findUnique({ where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } }, select: { agendadoPara: true } })
    .catch(() => null);
  const quando = (v?.agendadoPara ?? '').slice(0, 16);
  return quando !== '' && quando >= agoraLocalISO(fuso) ? quando : null;
}
