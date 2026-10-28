/**
 * Formatação e regras de leitura do resultado de um disparo. Tudo puro: a tela só desenha o que sai daqui.
 * Regra de ouro: número ausente (null) NUNCA vira zero nem traço mudo — vira "indisponível" com a fonte e a hora.
 */
import type { DisparoFonte, DisparoPessoa, DisparoResultado } from '../../types/disparo';

// O fuso da unidade não vem no contrato; as unidades de hoje (Canaã/PA, Brasília) estão em UTC-3.
const FUSO = 'America/Sao_Paulo';

const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
const fmtHoraCheia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: 'numeric', hour12: false });
const fmtChaveDia = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });

export const numero = (n: number): string => n.toLocaleString('pt-BR');

export function porcento(parte: number, base: number): string {
  if (!base) return '0%';
  const p = (parte / base) * 100;
  if (p === 0) return '0%';
  if (p < 10) return `${p.toFixed(1).replace('.', ',')}%`;
  return `${Math.round(p)}%`;
}

/** Fração 0..1 para a largura das barras (nunca passa de 1). */
export function fracao(parte: number, base: number): number {
  return base > 0 ? Math.min(1, Math.max(0, parte / base)) : 0;
}

export function reais(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function dolares(n: number): string {
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "14:32" */
export function horaMinuto(iso: string): string {
  return fmtHora.format(new Date(iso)).replace(/^24/, '00');
}

/** "às 14:32" se for hoje; "em 27/10 às 14:32" se for outro dia. */
export function quando(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  const hoje = fmtChaveDia.format(agora) === fmtChaveDia.format(d);
  return hoje ? `às ${horaMinuto(iso)}` : `em ${fmtDia.format(d)} às ${horaMinuto(iso)}`;
}

/** "14:32" se for hoje; "27/10 14:32" se for outro dia (para rótulos curtos). */
export function quandoCurto(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  const hoje = fmtChaveDia.format(agora) === fmtChaveDia.format(d);
  return hoje ? horaMinuto(iso) : `${fmtDia.format(d)} ${horaMinuto(iso)}`;
}

export function hora(iso: string): number {
  return Number(fmtHoraCheia.format(new Date(iso))) % 24;
}

export function dia(iso: string): string {
  return fmtDia.format(new Date(iso));
}

export function chaveDoDia(iso: string): string {
  return fmtChaveDia.format(new Date(iso));
}

export function nomeDaFonte(f: DisparoFonte): string {
  switch (f) {
    case 'meta-template-analytics':
      return 'estatísticas do modelo na Meta';
    case 'meta-pricing-analytics':
      return 'cobrança da Meta';
    case 'kommo':
      return 'Kommo';
    case 'franquia':
      return 'agenda da franquia';
    default:
      return 'nenhuma fonte ligada ainda';
  }
}

/**
 * A linha que explica um número ausente: de onde viria e até quando se sabe.
 * Quando o servidor mandou o motivo (`nota`), ele vem primeiro: é mais exato que qualquer texto genérico daqui.
 */
export function explicarAusencia(fonte: DisparoFonte, atualizadoEm: string | null, agora: Date = new Date()): string {
  const checado = atualizadoEm ? `conferido ${quando(atualizadoEm, agora)}` : 'ainda não conferido';
  if (fonte === 'indisponivel') return `Sem fonte ligada ainda · ${checado}`;
  return `Fonte: ${nomeDaFonte(fonte)} · ${checado}`;
}

/** "Maria S." — o gestor reconhece a pessoa, a tela não carrega o nome inteiro. */
export function nomeCurto(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'Sem nome';
  const primeiro = partes[0]!;
  const ultimo = partes.length > 1 ? partes[partes.length - 1]! : '';
  return ultimo ? `${primeiro} ${ultimo.charAt(0).toUpperCase()}.` : primeiro;
}

export function inicial(nome: string): string {
  return nome.trim().charAt(0).toUpperCase() || '?';
}

/** Cor do avatar a partir do nome: sempre a mesma pessoa, sempre a mesma cor. Índice na paleta do CSS (0..5). */
export function corDoAvatar(nome: string): number {
  let h = 0;
  for (const c of nome) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}

export type TomDaPessoa = 'ok' | 'espera' | 'falha' | 'saiu' | 'barrada';

export interface LeituraDaPessoa {
  tom: TomDaPessoa;
  texto: string;
}

/** Os seis estados do banco viram o que o gestor entende. A cor nunca vai sozinha: sempre há o texto. */
export function lerPessoa(p: DisparoPessoa, agora: Date = new Date()): LeituraDaPessoa {
  switch (p.estado) {
    case 'enviado':
      return { tom: 'ok', texto: 'Recebeu' };
    case 'enviando':
      return { tom: 'espera', texto: 'Enviando agora' };
    case 'pendente':
      return { tom: 'espera', texto: 'Na fila' };
    case 'falhou':
      return { tom: 'falha', texto: 'Falhou' };
    case 'saiu':
      return { tom: 'saiu', texto: p.enviadoEm ? 'Pediu SAIR' : 'Já tinha pedido SAIR' };
    case 'descartado':
      return { tom: 'barrada', texto: 'Fora da lista' };
    default:
      void agora;
      return { tom: 'espera', texto: p.estado };
  }
}

export type TomDoEstado = 'andando' | 'pausada' | 'concluida' | 'parada' | 'espera';

export interface LeituraDoEstado {
  tom: TomDoEstado;
  titulo: string;
  porque: string;
}

/** Os seis estados do banco viram quatro ideias que o gestor entende: andando, pausada, concluída, parada. */
export function lerEstado(o: DisparoResultado['onda'], janela: string): LeituraDoEstado {
  const quem = o.aprovadaPor ? `Liberada por ${o.aprovadaPor}${o.aprovadaEm ? ` ${quando(o.aprovadaEm)}` : ''}.` : '';
  switch (o.estado) {
    case 'aprovada':
      return {
        tom: 'andando',
        titulo: 'Andando',
        porque: `Enviando dentro do horário (${janela}). Fora dele a fila espera sozinha. ${quem}`.trim(),
      };
    case 'pausada':
      return {
        tom: 'pausada',
        titulo: 'Pausada',
        porque: `${o.pausaMotivo ?? 'Sem motivo registrado.'} Nada é enviado até alguém retomar no painel da onda.`,
      };
    case 'concluida':
      return { tom: 'concluida', titulo: 'Concluída', porque: `Todas as pessoas da lista foram tratadas. ${quem}`.trim() };
    case 'cancelada':
      return { tom: 'parada', titulo: 'Parada', porque: o.pausaMotivo ?? 'A onda foi cancelada e não envia mais.' };
    case 'montada':
      return { tom: 'espera', titulo: 'Esperando liberação', porque: 'A lista está pronta, mas nada foi enviado. Falta quem aprova liberar.' };
    case 'montando':
      return { tom: 'espera', titulo: 'Montando a lista', porque: 'Estamos separando as pessoas desta campanha. Nada foi enviado ainda.' };
    default:
      return { tom: 'espera', titulo: o.estado, porque: o.pausaMotivo ?? 'Estado não reconhecido por esta tela.' };
  }
}

export type NivelDoFreio = 'folga' | 'perto' | 'no-limite' | 'passou';

export function nivelDoFreio(usado: number, teto: number): NivelDoFreio {
  if (usado > teto) return 'passou';
  if (teto <= 0) return 'no-limite';
  const r = usado / teto;
  if (r >= 1) return 'no-limite';
  if (r >= 0.8) return 'perto';
  return 'folga';
}

export const TEXTO_DO_NIVEL: Record<NivelDoFreio, string> = {
  folga: 'Dentro do limite',
  perto: 'Perto do limite',
  'no-limite': 'No limite',
  passou: 'Passou do limite',
};

/** Ordena as horas do mais antigo ao mais novo, sem mexer no original. */
export function horasEmOrdem(porHora: DisparoResultado['porHora']): DisparoResultado['porHora'] {
  return [...porHora].sort((a, b) => new Date(a.hora).getTime() - new Date(b.hora).getTime());
}

/**
 * Variação da última hora com envio contra a anterior. Null quando não há duas horas para comparar:
 * não se inventa uma tendência com um ponto só.
 */
export function variacaoDaHora(porHora: DisparoResultado['porHora']): { de: number; para: number; pct: number } | null {
  const h = horasEmOrdem(porHora);
  if (h.length < 2) return null;
  const para = h[h.length - 1]!.enviados;
  const de = h[h.length - 2]!.enviados;
  if (de <= 0) return null;
  return { de, para, pct: Math.round(((para - de) / de) * 100) };
}
