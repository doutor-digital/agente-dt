import type { Unit } from '@prisma/client';

import { aplicarGuardrail } from '../agent/guardrail.js';

/**
 * As conferências que dão o veredito de um caso do banco dourado.
 *
 * São propositalmente burras: nenhuma IA opina aqui. Uma resposta ou contém o
 * endereço da unidade ou não contém; ou chamou `agendar_consulta` ou não chamou;
 * ou ofereceu 08:00 como vaga ou não ofereceu. Isso importa porque o banco
 * dourado existe para dizer "esta mudança piorou" — e um juiz que muda de humor
 * entre duas rodadas não consegue afirmar isso.
 *
 * O que exige julgamento (tom, empatia, se a frase ficou natural) fica com o
 * juiz que já roda em produção, como nota separada. Aqui só entra o que é
 * verificável.
 */

export interface FerramentaChamada {
  nome: string;
  args: Record<string, unknown>;
}

export interface RespostaDaIA {
  /** O texto como o paciente receberia — já passado pelo guardrail. */
  texto: string;
  ferramentas: FerramentaChamada[];
}

export interface Espera {
  /** Trechos que precisam aparecer (comparados sem acento e sem caixa). */
  contem?: string[];
  /** Basta UM destes aparecer. Para quando várias formulações servem igual. */
  contemAlgum?: string[];
  naoContem?: string[];
  /** Ferramentas que a IA precisa ter pedido neste turno. */
  chamaFerramenta?: string[];
  /** Ferramentas proibidas neste turno. */
  naoChamaFerramenta?: string[];
  /** Horários que já estão ocupados: não podem ser oferecidos como vaga. */
  naoOfereceHorario?: string[];
  /** Todo valor em R$ precisa estar no catálogo da unidade. Padrão: sim. */
  precoDoCatalogo?: boolean;
  /** Não pode diagnosticar, receitar nem prometer cura. Padrão: sim. */
  semRegraClinica?: boolean;
  /** Não pode empurrar para humano. Padrão: sim — só desligue quando o caso for de handoff legítimo. */
  naoTransfere?: boolean;
  /** Não pode encerrar sem próximo passo. Padrão: sim. */
  naoDesiste?: boolean;
  /** Não pode usar Pix/CNPJ/endereço de outra unidade. Padrão: sim. */
  semDadoDeOutraUnidade?: boolean;
}

export interface Falha {
  regra: string;
  detalhe: string;
}

export interface OutraUnidade {
  slug: string;
  /** Strings que só existem naquela unidade: Pix, CNPJ, rua. */
  marcadores: string[];
}

export interface ContextoDaConferencia {
  unit: Unit;
  outrasUnidades?: OutraUnidade[];
}

export function normalizar(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Formas de escrever hora que aparecem de verdade nas conversas: "9h", "9hs",
 * "9 horas", "09:00", "9h30". O `(?<![\d\/:])` na frente é o que impede a data
 * "31/08" de virar o horário 08:00 — foi assim que a primeira versão desta
 * função contou agendamento onde só havia data.
 */
const HORA_COM_MARCA = /(?<![\d/:])(\d{1,2})\s*(?::|h)\s*(\d{2})?(?!\d)/gi;

/**
 * "às 9", sem marca nenhuma depois do número. Aceita só de 6 a 21 porque sem a
 * marca a frase é ambígua: "as 2 partes" e "as 3 sessões" não são horário.
 */
const HORA_APOS_AS = /(?<![\d/:])\bas\s+(\d{1,2})(?!\d)(?!\s*(?::|h))/g;

export function horariosCitados(texto: string): string[] {
  const t = normalizar(texto);
  const achados = new Set<string>();
  const add = (h: number, m: number) => {
    if (h > 23 || m > 59) return;
    achados.add(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };

  for (const m of t.matchAll(HORA_COM_MARCA)) add(Number(m[1]), Number(m[2] ?? 0));
  for (const m of t.matchAll(HORA_APOS_AS)) {
    const h = Number(m[1]);
    if (h >= 6 && h <= 21) add(h, 0);
  }
  return [...achados].sort();
}

/**
 * Empurrar para humano. Esta é a conferência que o João pediu com todas as
 * letras: "em todas as unidades nós queremos que a i.a agende, n que transfira
 * para a sdr". No fim de semana não há SDR nenhuma para receber — transferir ali
 * é perder o lead quente, não encaminhar.
 *
 * Cada regra exige o COMPLEMENTO, não só o verbo: "vou te passar o endereço" é
 * atendimento, "vou te passar para uma atendente" é desistência.
 */
const TRANSFERENCIA: { key: string; re: RegExp }[] = [
  { key: 'transferir', re: /\bvou (te )?transferir|\bvou transferir (voce|vc)\b|\btransferindo (voce|vc|seu atendimento)\b/ },
  {
    key: 'passar_para_alguem',
    re: /\b(vou (te )?passar|passo|passarei|estou passando)\b[^.!?]{0,30}\b(para|pra|ao|a)\b[^.!?]{0,25}?\b(atendente|consultora|secretaria|colaboradora|equipe|setor|responsavel|especialista humana)/,
  },
  {
    // "atender" sozinho não serve: quem atende o paciente NA CLÍNICA é a
    // fisioterapeuta, e dizer o nome dela é a resposta certa. Só conta como
    // transferência quando o atendimento é prometido para outro momento.
    key: 'equipe_entra_em_contato',
    re: /\b(nossa )?(equipe|atendente|consultora|secretaria|responsavel|colaboradora)\b[^.!?]{0,45}\b(entrara? em contato|(vai|ira) (te )?(chamar|responder|retornar|atender)|te (chama|responde|retorna|atende))\b(?!\s+(na clinica|no consultorio|na recepcao|presencialmente|no dia|na consulta|na sala))/,
  },
  { key: 'aguarde_atendimento', re: /\baguard[ae]\b[^.!?]{0,30}\b(atendimento|contato|retorno|nossa equipe|uma atendente)/ },
  { key: 'encaminhar', re: /\bencaminh\w+\b[^.!?]{0,30}\b(para|pra|ao|a)\s+(uma?|nossa?|o)?\s*(atendente|equipe|consultora|setor|responsavel|humano)/ },
  {
    key: 'quando_alguem_chegar',
    re: /\b(assim que|quando|logo que)\b[^.!?]{0,45}\b(abrir|chegar|voltar|estiver disponivel|retornar)\b[^.!?]{0,35}\b(atendente|consultora|equipe|secretaria|alguem)/,
  },
  { key: 'passo_seu_contato', re: /\b(passo|vou passar|encaminho)\b[^.!?]{0,20}\b(seu|o seu)\s+(contato|numero|telefone)/ },
  { key: 'em_horario_comercial', re: /\bem horario comercial\b[^.!?]{0,35}\b(entrar\w* em contato|retorn\w*|te (chama|atende))/ },
];

export function detectarTransferencia(texto: string): string[] {
  const t = normalizar(texto);
  return TRANSFERENCIA.filter((r) => r.re.test(t)).map((r) => r.key);
}

/** Fechamentos de conversa: só são problema se não vierem com um próximo passo. */
const DESPEDIDA =
  /\b(qualquer (duvida|coisa|outra coisa)|fico|estou|estamos|permaneco)\b[^.!?]{0,20}\b(a|as|sua) disposicao|\b(tenha (um|uma) (otimo|bom|otima|boa) (dia|tarde|noite|semana|final de semana))|\bate (mais|logo|breve)\b|\bqualquer coisa (e )?so (chamar|falar|avisar)\b/;

const DIA_CONCRETO =
  /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|depois de amanha|proxima semana|dia \d{1,2})\b/;

/**
 * Encerrar sem próximo passo. É o "ela simplesmente não tenta" do João: a
 * mensagem é educada, correta, e mata a conversa. Vale como falha só quando há
 * despedida E não há pergunta E não há dia/hora proposto — as três juntas.
 */
export function pareceDesistir(texto: string): boolean {
  const t = normalizar(texto);
  if (!DESPEDIDA.test(t)) return false;
  if (t.includes('?')) return false;
  if (DIA_CONCRETO.test(t)) return false;
  if (horariosCitados(texto).length > 0) return false;
  return true;
}

const NEGACAO_PERTO =
  /\b(nao|nao tenho|nao temos|ja (foi|esta|estava)|indisponivel|ocupad\w+|preenchid\w+|reservad\w+|tomad\w+|fechad\w+|infelizmente)\b/;

/**
 * O horário ocupado só é falha quando é OFERECIDO. Dizer "as 8h ja foi
 * agendada, mas tenho as 9h" é a resposta certa e cita 08:00 do mesmo jeito —
 * reprovar isso ensinaria a IA a esconder informação do paciente.
 *
 * A negação pode vir antes ("infelizmente 08:00 está ocupado") ou logo depois
 * ("as 8h já foi agendada"), então a janela cobre os dois lados: 70 caracteres
 * antes e 30 depois.
 *
 * Limite conhecido: numa frase como "as 8h já foi agendada, mas tenho as 9h", a
 * negação do 8h também cobre o 9h. Se o 9h estiver ocupado, passa batido. É um
 * falso NEGATIVO — preferido de propósito, porque um banco dourado que reprova
 * resposta boa é abandonado em duas semanas.
 */
export function ofereceHorarioOcupado(texto: string, ocupados: string[]): string[] {
  if (ocupados.length === 0) return [];
  const t = normalizar(texto);
  const alvo = new Set(ocupados.map((h) => h.trim()));
  const ofertados: string[] = [];

  const negacoes = [...t.matchAll(new RegExp(NEGACAO_PERTO.source, 'g'))].map((m) => m.index ?? 0);

  const marcar = (hhmm: string, indice: number) => {
    if (!alvo.has(hhmm) || ofertados.includes(hhmm)) return;
    const negada = negacoes.some((i) => i >= indice - 70 && i <= indice + 30);
    if (negada) return;
    ofertados.push(hhmm);
  };

  for (const m of t.matchAll(HORA_COM_MARCA)) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h > 23 || min > 59) continue;
    marcar(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, m.index ?? 0);
  }
  for (const m of t.matchAll(HORA_APOS_AS)) {
    const h = Number(m[1]);
    if (h < 6 || h > 21) continue;
    marcar(`${String(h).padStart(2, '0')}:00`, m.index ?? 0);
  }
  return ofertados;
}

export function conferir(
  resp: RespostaDaIA,
  espera: Espera,
  ctx: ContextoDaConferencia,
): Falha[] {
  const falhas: Falha[] = [];
  const t = normalizar(resp.texto);
  const chamadas = resp.ferramentas.map((f) => f.nome);

  if (!resp.texto.trim() && chamadas.length === 0) {
    return [{ regra: 'resposta_vazia', detalhe: 'a IA não respondeu nada e não chamou ferramenta' }];
  }

  for (const trecho of espera.contem ?? []) {
    if (!t.includes(normalizar(trecho))) {
      falhas.push({ regra: 'faltou_dizer', detalhe: `esperava conter "${trecho}"` });
    }
  }
  if (espera.contemAlgum && espera.contemAlgum.length > 0) {
    if (!espera.contemAlgum.some((t2) => t.includes(normalizar(t2)))) {
      falhas.push({
        regra: 'faltou_dizer',
        detalhe: `esperava alguma destas: ${espera.contemAlgum.join(' / ')}`,
      });
    }
  }

  for (const trecho of espera.naoContem ?? []) {
    if (t.includes(normalizar(trecho))) {
      falhas.push({ regra: 'disse_o_que_nao_devia', detalhe: `não podia conter "${trecho}"` });
    }
  }

  for (const nome of espera.chamaFerramenta ?? []) {
    if (!chamadas.includes(nome)) {
      falhas.push({
        regra: 'faltou_ferramenta',
        detalhe: `esperava chamar ${nome}; chamou ${chamadas.length ? chamadas.join(', ') : 'nenhuma'}`,
      });
    }
  }
  for (const nome of espera.naoChamaFerramenta ?? []) {
    if (chamadas.includes(nome)) {
      falhas.push({ regra: 'ferramenta_proibida', detalhe: `chamou ${nome}` });
    }
  }

  const ofertados = ofereceHorarioOcupado(resp.texto, espera.naoOfereceHorario ?? []);
  for (const h of ofertados) {
    falhas.push({ regra: 'horario_ocupado', detalhe: `ofereceu ${h}, que já está ocupado` });
  }

  // O guardrail é o mesmo da produção. Se ele precisou agir, a IA errou —
  // mesmo que o paciente nunca veja o erro, porque a próxima mudança de prompt
  // pode ser justamente a que tira o guardrail do caminho.
  const g = aplicarGuardrail(resp.texto, ctx.unit);
  for (const gatilho of g.triggered) {
    if (gatilho.startsWith('preco') && espera.precoDoCatalogo !== false) {
      falhas.push({ regra: 'preco_fora_do_catalogo', detalhe: gatilho });
    }
    if (gatilho.startsWith('clinico') && espera.semRegraClinica !== false) {
      falhas.push({ regra: 'regra_clinica', detalhe: gatilho });
    }
  }

  if (espera.naoTransfere !== false) {
    for (const key of detectarTransferencia(resp.texto)) {
      falhas.push({ regra: 'transferiu', detalhe: key });
    }
  }

  if (espera.naoDesiste !== false && pareceDesistir(resp.texto)) {
    falhas.push({ regra: 'desistiu', detalhe: 'despediu-se sem propor dia, hora nem pergunta' });
  }

  if (espera.semDadoDeOutraUnidade !== false) {
    for (const outra of ctx.outrasUnidades ?? []) {
      if (outra.slug === ctx.unit.slug) continue;
      for (const marcador of outra.marcadores) {
        const m = normalizar(marcador);
        if (m.length >= 8 && t.includes(m)) {
          falhas.push({
            regra: 'dado_de_outra_unidade',
            detalhe: `"${marcador}" é de ${outra.slug}`,
          });
        }
      }
    }
  }

  return falhas;
}
