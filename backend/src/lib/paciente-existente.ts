/**
 * "Este paciente já existe na franquia?" — a pergunta que vem ANTES de qualquer cadastro feito pelo widget
 * ("Marcar consulta" e "Só cadastrar"). Errar aqui é o paciente em dobro na franquia, ou no prontuário de outro.
 *
 * A franquia NÃO busca por telefone (`/api/clients/search` ignora o parâmetro e devolve a 1ª página inteira), então
 * a busca é por nome, em vários termos — título do cartão, nome digitado, "primeiro último", só o primeiro — e quem
 * decide é o telefone (8 últimos dígitos). Três regras, todas do review de 16/10/2026:
 *
 * - **Qualquer busca que falhar = não sei.** Achar "não existe" com uma busca fora do ar é como nasce o cadastro em
 *   dobro: o termo que falhou era justamente o que acharia a pessoa.
 * - **Junta todos os termos antes de decidir.** Dois cadastros com o mesmo telefone (mãe e filha no mesmo WhatsApp,
 *   caso real em Petrópolis) só aparecem quando se olha o conjunto.
 * - **Mais de um com o mesmo telefone:** fica com o de nome igual, se for um só; senão, ninguém escolhe no chute.
 *
 * Só o primeiro nome (o widget aceita desde 20/10/2026): a busca por ele tem de ter visto TODO mundo com esse nome. Se
 * ela nem pôde ser feita (a franquia só busca com 3+ letras) ou veio com a página cheia (nome comum: há gente fora da
 * 1ª página), não dá para dizer que o paciente é novo, nem que o achado pelo telefone é o único — outro com o mesmo
 * telefone pode estar fora da página (review do Codex, 20/10). `inconclusivo`: nada é criado nem ligado.
 */
import type { Unit } from '@prisma/client';
import { SpineService } from '../services/spine.service.js';
import { limparNome, termosDeBusca } from './widget-agenda.js';
import { normalizar } from './franquia-sync.js';

export interface PacienteDaFranquia {
  idClient: number;
  nome: string | null;
}

export type Achado =
  | ({ tipo: 'achou' } & PacienteDaFranquia)
  | { tipo: 'nao_achou' }
  | { tipo: 'ambiguo'; candidatos: PacienteDaFranquia[] }
  | { tipo: 'sem_resposta' }
  /** Só o primeiro nome, e a busca por ele não prova que o paciente é novo (curto demais ou página cheia). */
  | { tipo: 'inconclusivo' };

/** A franquia devolve só a 1ª página da busca; com este tamanho, página cheia = pode haver mais gente com esse nome. */
const POR_PAGINA = 100;

/** Últimos 8 dígitos: imune ao +55, ao DDD escrito de outro jeito e ao nono dígito. */
export function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

export async function pacienteExistente(
  unit: Unit,
  nome: string,
  tituloDoCartao: string,
  fone: string,
  opcoes: { soPrimeiroNome?: boolean } = {},
): Promise<Achado> {
  const alvo = fim8(fone);
  if (!alvo) return { tipo: 'sem_resposta' };
  const porId = new Map<number, string | null>();
  /** termos cuja página NÃO veio cheia: a busca por eles viu todo mundo com esse nome */
  const completos = new Set<string>();
  let falhou = false;
  for (const termo of termosDeBusca(tituloDoCartao, nome)) {
    const r = await SpineService.searchClients(unit, termo, POR_PAGINA).catch(() => null);
    if (!r?.ok) {
      falhou = true;
      continue;
    }
    const clientes = r.data?.clients ?? [];
    if (clientes.length < POR_PAGINA) completos.add(termo);
    for (const c of clientes) {
      if (c.idClient && fim8(c.whatsapp) === alvo) porId.set(c.idClient, c.name);
    }
  }
  if (falhou) return { tipo: 'sem_resposta' };
  // só o primeiro nome: a busca POR ELE (o título pode ser outro nome) tem de ter sido feita e visto todo mundo — senão
  // nem "não existe" nem "é este" se sustentam
  if (opcoes.soPrimeiroNome) {
    const primeiro = limparNome(nome).split(' ').filter(Boolean)[0] ?? '';
    if (!completos.has(primeiro)) return { tipo: 'inconclusivo' };
  }

  const lista: PacienteDaFranquia[] = [...porId].map(([idClient, n]) => ({ idClient, nome: n }));
  if (lista.length === 0) return { tipo: 'nao_achou' };
  if (lista.length === 1) return { tipo: 'achou', ...lista[0] };

  const alvos = new Set([normalizar(limparNome(nome)), normalizar(limparNome(tituloDoCartao))].filter(Boolean));
  const exatos = lista.filter((c) => c.nome && alvos.has(normalizar(c.nome)));
  if (exatos.length === 1) return { tipo: 'achou', ...exatos[0] };
  return { tipo: 'ambiguo', candidatos: lista };
}

/** Frase para a SDR quando há dois ou mais pacientes com o mesmo telefone e nenhum com o nome igual. */
export function motivoAmbiguo(candidatos: PacienteDaFranquia[], acao: 'cadastrado' | 'marcado'): string {
  const nomes = candidatos.slice(0, 3).map((c) => c.nome ?? `idClient ${c.idClient}`).join(', ');
  return `A franquia tem mais de um paciente com este telefone (${nomes}). Nada foi ${acao}: confira na franquia qual é o paciente e use o nome completo dele.`;
}

/** Frase para a SDR quando só o primeiro nome não deu para conferir se o paciente já existe. */
export function motivoInconclusivo(acao: 'cadastrado' | 'marcado'): string {
  return `Só com o primeiro nome não consegui conferir se este paciente já existe na franquia (nome muito comum ou curto demais para a busca). Nada foi ${acao}: coloque o sobrenome.`;
}
