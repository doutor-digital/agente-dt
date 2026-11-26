/**
 * PRÉVIA DO DIA da régua: o que ela MANDARIA nas próximas horas (24 por padrão) a uma unidade, sem mandar nada, sem gravar nada e sem tocar no Chatwoot além de LER.
 * Serve para o João e a unidade aprovarem antes de ligar a régua («o que o paciente vai receber amanhã?»).
 *
 * Como é feita: a MESMA `decidirRegua` que o worker usa, rodada de 10 em 10 minutos (o ritmo do worker) de agora até o fim da janela, com a memória do banco
 * (o que a régua já viu e já mandou) e registrando o que «sairia» como feito, igual ao worker faz — então janela de horário (08h–20h, segunda a sábado), atraso
 * máximo, «nunca repete», robô desligado na tela «Robôs», retomada de lead, cobrança e dois horários no dia valem aqui exatamente como valem no envio.
 * A saída NÃO leva telefone: modelo, primeiro nome, horário do compromisso e quando sairia.
 *
 * O que a prévia NÃO sabe (diz na saída): se a janela de 24 h do WhatsApp estará aberta (decide texto ou template), se o template está aprovado na Meta e o que o
 * paciente fizer até lá (confirmar, remarcar, escrever). O cartão ativo no Kommo é conferido quando a unidade tem Kommo (só leitura).
 */
import {
  atualizarVistos,
  camposDoModelo,
  CAMPO_PARTIDA,
  decidirRegua,
  precisaUltimaPublica,
  SUFIXO_FALTA,
  type Memoria,
  type ConversaRegua,
  type DadosDaUnidade,
  type AjustesDaRegua,
  type Visto,
} from './chatwoot-regua.js';
import { lerConversas, MAX_MENSAGENS_POR_CICLO, quemFalaPorTelefone, type Armazem, type Chat, type CartaoNoKommo } from './chatwoot-regua-worker.js';

const PASSO_MS = 10 * 60_000;
export const HORAS_DA_PREVIA = 24;
const DIAS_DE_FEITOS = 130;

export interface LinhaDaPrevia {
  /** o id da conversa no Chatwoot (para achar o caso; não é telefone) */
  conversa: number;
  regra: string;
  /** o modelo (nome do modelo da régua, ou `interna:<ação>`) */
  modelo: string;
  /** o primeiro nome que o texto leva; null = a régua cumprimenta sem nome */
  nome: string | null;
  /** a data/hora do compromisso que o texto cita («18/11 às 09:00 e 14:30»); null = o modelo não cita horário */
  horario: string | null;
  /** quando a régua mandaria (no ritmo de 10 min do worker) */
  saiEm: Date;
  /** regra interna (nota para a equipe, não mensagem ao paciente) */
  interna: boolean;
  /** o que falta para o texto sair (campo vazio); vazio = sairia */
  faltando: string[];
  /** o paciente tem cartão ativo no Kommo da unidade: a régua NÃO mandaria (os robôs de lá falam) */
  noKommo: boolean;
  /** não deu para conferir o Kommo: no ligado a régua NÃO manda até conferir */
  semConferirKommo: boolean;
}

/** A parte pura: as linhas de UMA conversa. `memoria.feitos` não é alterado. */
export function previaDaConversa(c: ConversaRegua, memoria: Memoria, agora: Date, horas: number, unidade: DadosDaUnidade, ajustes?: AjustesDaRegua, desligados: ReadonlySet<string> = new Set()): LinhaDaPrevia[] {
  const feitos = new Set(memoria.feitos);
  const linhas: LinhaDaPrevia[] = [];
  const fim = agora.getTime() + horas * 3600_000;
  for (let t = agora.getTime(); t <= fim; t += PASSO_MS) {
    for (const d of decidirRegua(c, { vistos: memoria.vistos, feitos }, new Date(t), unidade, ajustes).disparos) {
      if (desligados.has(d.regra)) continue; // robô desligado na tela «Robôs»: nem manda, nem registra (se religarem, sai)
      feitos.add(d.texto === null ? `${d.regra}${SUFIXO_FALTA}|${d.chave}` : `${d.regra}|${d.chave}`);
      for (const ch of d.texto === null || d.interna ? [] : ((d as { cobre?: string[] }).cobre ?? []) /* `cobre`: o PR dos dois horários no dia; sem ele a lista é vazia */) feitos.add(`${d.regra}|${ch}`);
      const campos = d.interna ? [] : camposDoModelo(d.modelo, unidade.textos);
      const vars = d.variaveis ?? [];
      const nome = campos.includes('contact.name') ? (vars[campos.indexOf('contact.name')] ?? null) : null;
      linhas.push({
        conversa: c.id,
        regra: d.regra,
        modelo: d.modelo,
        nome: nome && nome.length ? nome : null,
        horario: vars.find((v) => /^\d{2}\/\d{2}( às \d{2}:\d{2})?/.test(v)) ?? null,
        saiEm: new Date(t),
        interna: !!d.interna,
        faltando: d.faltando,
        noKommo: false,
        semConferirKommo: false,
      });
    }
  }
  return linhas;
}

export interface PortasDaPrevia {
  armazem: Pick<Armazem, 'vistos' | 'feitos'>;
  chat: Pick<Chat, 'pagina' | 'ultimaPublica'>;
  /** sem ela a prévia não confere o Kommo */
  kommo?: CartaoNoKommo;
}

/**
 * As linhas de uma caixa inteira. Só LÊ (Chatwoot, banco, Kommo). A memória da régua NÃO é gravada: o que ela veria de novo agora conta só dentro desta conta.
 * `ajustes`: o que a Gestora configurou na tela «Robôs» (robôs desligados, tempos, modelos).
 */
export async function previaDaCaixa(
  portas: PortasDaPrevia,
  caixa: number,
  unidade: DadosDaUnidade,
  agora: Date,
  horas: number = HORAS_DA_PREVIA,
  ajustes: { regua?: AjustesDaRegua; desligados?: ReadonlySet<string> } = {},
): Promise<{ linhas: LinhaDaPrevia[]; conversas: number; truncada: boolean; semConferirKommo: number }> {
  const { conversas, atividades, truncada } = await lerConversas(portas.chat, caixa, agora);
  const quemFala = quemFalaPorTelefone(conversas.map((c) => ({ c, atividade: atividades.get(c.id) ?? 0 })));

  const linhasVistas = await portas.armazem.vistos(caixa);
  const partidaLinha = linhasVistas.find((l) => l.conversationId === 0 && l.campo === CAMPO_PARTIDA);
  const partida = { primeiraVez: !partidaLinha, desde: partidaLinha?.desde ?? agora };
  const vistosPorConversa = new Map<number, Map<string, Visto>>();
  for (const l of linhasVistas) {
    if (l.conversationId === 0) continue;
    const m = vistosPorConversa.get(l.conversationId) ?? new Map<string, Visto>();
    m.set(l.campo, { valor: l.valor, desde: l.desde, inicial: l.inicial });
    vistosPorConversa.set(l.conversationId, m);
  }
  const feitosPorConversa = new Map<number, Set<string>>();
  for (const f of await portas.armazem.feitos(caixa, new Date(agora.getTime() - DIAS_DE_FEITOS * 86_400_000))) {
    const s = feitosPorConversa.get(f.conversationId) ?? new Set<string>();
    s.add(`${f.regra}|${f.chave}`);
    feitosPorConversa.set(f.conversationId, s);
  }

  const linhas: LinhaDaPrevia[] = [];
  let semConferirKommo = 0;
  for (const c of conversas) {
    const { fala, irmas } = quemFala.get(c.id) ?? { fala: true, irmas: [] };
    if (!fala) continue;
    if (precisaUltimaPublica(c)) c.ultima = await portas.chat.ultimaPublica(c.id);
    // a memória como o worker a teria NESTE ciclo (a observação de agora entra), sem gravar nada
    const { vistos } = atualizarVistos(c, vistosPorConversa.get(c.id) ?? new Map(), agora, partida);
    const feitos = new Set<string>(feitosPorConversa.get(c.id) ?? []);
    for (const id of irmas) for (const f of feitosPorConversa.get(id) ?? []) feitos.add(f);
    const dela = previaDaConversa(c, { vistos, feitos }, agora, horas, unidade, ajustes.regua, ajustes.desligados);
    // o Kommo só é conferido para quem FALARIA com o paciente (mensagem com texto), como no worker
    const falariam = dela.filter((l) => !l.interna && l.faltando.length === 0);
    if (falariam.length && portas.kommo && c.telefone) {
      try {
        const cartao = await portas.kommo(c.telefone);
        if (cartao) for (const l of falariam) l.noKommo = true;
      } catch {
        semConferirKommo++;
        for (const l of falariam) l.semConferirKommo = true;
      }
    }
    linhas.push(...dela);
  }
  linhas.sort((a, b) => a.saiEm.getTime() - b.saiEm.getTime() || a.conversa - b.conversa);
  return { linhas, conversas: conversas.length, truncada, semConferirKommo };
}

const hhmm = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/** O texto para o João ler: uma linha por mensagem, SEM telefone. */
export function formatarPrevia(r: Awaited<ReturnType<typeof previaDaCaixa>>, slug: string, agora: Date, horas: number): string {
  const sairiam = r.linhas.filter((l) => !l.interna && !l.noKommo && !l.semConferirKommo && l.faltando.length === 0);
  const l: string[] = [];
  l.push(`Prévia da régua — ${slug} — próximas ${horas} h a partir de ${hhmm(agora)} (Belém)`);
  l.push(`${r.conversas} conversas lidas${r.truncada ? ' (LISTAGEM TRUNCADA: pode faltar conversa)' : ''}. Mandaria ${sairiam.length} mensagem(ns) ao paciente.`);
  l.push('');
  for (const x of r.linhas) {
    const estado = x.interna ? 'INTERNA (nota para a equipe)' : x.noKommo ? 'NÃO manda: cartão ativo no Kommo' : x.semConferirKommo ? 'NÃO manda até conferir o Kommo (não consegui agora)' : x.faltando.length ? `NÃO manda, falta: ${x.faltando.join('; ')}` : 'manda';
    l.push(`${hhmm(x.saiEm)} | conversa ${x.conversa} | ${x.regra} | ${x.modelo} | nome: ${x.nome ?? '(sem nome)'} | horário: ${x.horario ?? '—'} | ${estado}`);
  }
  if (!r.linhas.length) l.push('(nada a mandar neste período)');
  l.push('');
  // o worker manda no máximo MAX_MENSAGENS_POR_CICLO por ciclo (10 min): se mais do que isso vence de uma vez, o resto sai nos ciclos seguintes
  const porPasso = new Map<number, number>();
  for (const x of sairiam) porPasso.set(x.saiEm.getTime(), (porPasso.get(x.saiEm.getTime()) ?? 0) + 1);
  const maior = Math.max(0, ...porPasso.values());
  if (maior > MAX_MENSAGENS_POR_CICLO) l.push(`Atenção: ${maior} mensagens vencem no mesmo ciclo e o worker manda no máximo ${MAX_MENSAGENS_POR_CICLO} por ciclo (10 min): as demais saem nos ciclos seguintes, e algumas podem passar do prazo.`);
  l.push('Não está na prévia: se a janela de 24 h estará aberta (texto ou template), se o template está aprovado na Meta, e o que o paciente fizer até lá.');
  if (r.semConferirKommo) l.push(`Atenção: não consegui conferir o Kommo para ${r.semConferirKommo} conversa(s); no ligado a régua NÃO mandaria nelas até conferir.`);
  return l.join('\n');
}
