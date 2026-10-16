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
  | { tipo: 'sem_resposta' };

/** Últimos 8 dígitos: imune ao +55, ao DDD escrito de outro jeito e ao nono dígito. */
function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

export async function pacienteExistente(unit: Unit, nome: string, tituloDoCartao: string, fone: string): Promise<Achado> {
  const alvo = fim8(fone);
  if (!alvo) return { tipo: 'sem_resposta' };
  const porId = new Map<number, string | null>();
  let falhou = false;
  for (const termo of termosDeBusca(tituloDoCartao, nome)) {
    const r = await SpineService.searchClients(unit, termo, 100).catch(() => null);
    if (!r?.ok) {
      falhou = true;
      continue;
    }
    for (const c of r.data?.clients ?? []) {
      if (c.idClient && fim8(c.whatsapp) === alvo) porId.set(c.idClient, c.name);
    }
  }
  if (falhou) return { tipo: 'sem_resposta' };

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
