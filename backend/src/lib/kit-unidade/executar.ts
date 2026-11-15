/**
 * Executa o plano (`--aplicar`), ETAPA POR ETAPA e com confirmação. Só os passos de BANCO estão implementados nesta fase; os que
 * dependem de API externa (Chatwoot, Kapso/Meta, VPS) ficam como ESQUELETO: o plano mostra o que fariam, a execução PARA no passo
 * e o relatório final o lista como pendente. Nada de segredo passa por aqui.
 *
 * Idempotente: rodar de novo recalcula o plano com o estado atual e só mexe no que falta. Portas injetáveis (teste não toca em banco).
 */
import { AUTOMACOES } from '../automacoes.js';
import { CAMPOS_SO_NA_CRIACAO, camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import { aGravar, dadosDosModelosAGravar } from './protecao.js';
import type { Passo, Plano } from './plano.js';
import { configChatwootDoQuestionario, type Questionario } from './questionario.js';

/** O banco, como o executor o enxerga. A implementação real (prisma) está em `scripts/nova-unidade.ts`. */
export interface ConfigGravada {
  prefixoModelos: string;
  metaAgendamentosDia: number | null;
  kapsoPhoneNumberId: string | null;
  wabaId: string | null;
  envSufixo: string;
  dadosModelos: Record<string, unknown>;
}

export interface BancoPorta {
  /** a unidade como está no banco (todas as colunas em `campos`), ou null se não existe */
  lerUnidade(slug: string): Promise<{ id: string; ativa: boolean; campos: Record<string, unknown> } | null>;
  /** cria a unidade (inativa) com `campos` + `soNaCriacao`, ou atualiza SÓ os campos dados; devolve o id. Quem chama decide o que mandar (ver `protecao.ts`) */
  gravarUnidade(slug: string, nome: string, campos: Record<string, unknown>, soNaCriacao?: Record<string, unknown>): Promise<{ id: string; criada: boolean }>;
  lerConfigChatwoot(unitId: string): Promise<ConfigGravada | null>;
  /** `criar`: a linha não existe, grava tudo; senão atualiza SÓ as chaves dadas (nunca grava `null` por cima do que já está) */
  gravarConfigChatwoot(unitId: string, cfg: Partial<ConfigGravada>, criar: boolean): Promise<void>;
  /** ids das automações que a unidade já tem linha */
  automacoesDaUnidade(unitId: string): Promise<string[]>;
  criarAutomacoesEmSeco(unitId: string, ids: string[]): Promise<void>;
  /** persona/fontes/prompt hoje */
  sofiaDaUnidade(unitId: string): Promise<Record<string, unknown>>;
  gravarSofia(unitId: string, campos: Record<string, unknown>): Promise<void>;
}

export interface OpcoesDeExecucao {
  /** pergunta antes de cada etapa; `false` = pula a etapa */
  confirmar: (p: Passo) => Promise<boolean>;
  banco: BancoPorta;
  molde: string | null;
  /** deixa o roteiro novo substituir um systemPrompt que já existe e é diferente */
  sobrescreverPrompt?: boolean;
  /** troca também os campos JÁ preenchidos de uma unidade que existe (e deixa tocar numa unidade ATIVA). Sem isto só se preenche campo vazio. */
  sobrescrever?: boolean;
  /** escreve uma linha para quem está acompanhando */
  dizer: (linha: string) => void;
}

export type SituacaoDoPasso = 'feito' | 'nada-a-fazer' | 'recusado' | 'esqueleto' | 'manual' | 'bloqueado' | 'falhou';

export interface Resultado {
  id: string;
  situacao: SituacaoDoPasso;
  notas: string[];
}

export async function executarPlano(plano: Plano, q: Questionario, o: OpcoesDeExecucao): Promise<Resultado[]> {
  const resultados: Resultado[] = [];
  const deu = new Map<string, SituacaoDoPasso>();
  let unitId: string | null = null;
  for (const p of plano.passos) {
    const registrar = (situacao: SituacaoDoPasso, notas: string[] = []) => {
      resultados.push({ id: p.id, situacao, notas });
      deu.set(p.id, situacao);
      o.dizer(`  → ${p.id}: ${situacao}${notas.length ? ` — ${notas.join(' | ')}` : ''}`);
    };
    o.dizer(`\n[${p.sistema}] ${p.titulo}`);
    if (p.acao === 'nada') {
      registrar('nada-a-fazer');
      continue;
    }
    if (p.acao === 'bloqueado') {
      registrar('bloqueado', p.avisos);
      continue;
    }
    const travado = p.depende.filter((d) => {
      const s = deu.get(d);
      const passo = plano.passos.find((x) => x.id === d);
      return !(s === 'feito' || s === 'nada-a-fazer' || (passo?.acao === 'nada'));
    });
    if (travado.length && p.execucao === 'sim') {
      registrar('bloqueado', [`depende de: ${travado.join(', ')}`]);
      continue;
    }
    if (p.execucao === 'manual') {
      registrar('manual', p.itens);
      continue;
    }
    if (p.execucao === 'esqueleto') {
      registrar('esqueleto', ['não implementado nesta fase (depende de API externa) — está no relatório final']);
      continue;
    }
    if (!(await o.confirmar(p))) {
      registrar('recusado');
      continue;
    }
    try {
      registrar('feito', await aplicarPasso(p, q, o, () => unitId, (id) => (unitId = id)));
    } catch (err) {
      registrar('falhou', [String((err as Error).message ?? err)]);
      o.dizer('  (parei aqui: nada depois deste passo roda)');
      break;
    }
  }
  return resultados;
}

async function aplicarPasso(p: Passo, q: Questionario, o: OpcoesDeExecucao, unitIdAtual: () => string | null, definirUnitId: (id: string) => void): Promise<string[]> {
  const { banco } = o;
  switch (p.id) {
    case 'unidade': {
      const atual = await banco.lerUnidade(q.unidade.slug);
      if (atual?.ativa && !o.sobrescrever) throw new Error(`a unidade ${q.unidade.slug} já está ATIVA: o script não mexe numa unidade no ar sem --sobrescrever`);
      const novos = camposDaUnidade(q);
      const { gravar, preservados } = atual ? aGravar(atual.campos, novos, !!o.sobrescrever) : { gravar: novos, preservados: [] as string[] };
      const r = await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, gravar, CAMPOS_SO_NA_CRIACAO);
      definirUnitId(r.id);
      return [
        r.criada ? `unidade criada (inativa): ${r.id}` : `unidade já existia (${r.id}): preenchi ${Object.keys(gravar).length} campo(s) vazio(s)${Object.keys(gravar).length ? `: ${Object.keys(gravar).join(', ')}` : ''}`,
        ...(preservados.length ? [`ficaram como estão (já preenchidos, diferem do questionário; --sobrescrever troca): ${preservados.join(', ')}`] : []),
      ];
    }
    case 'config-chatwoot': {
      const id = unitIdAtual() ?? (await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, {})).id;
      definirUnitId(id);
      const c = configChatwootDoQuestionario(q);
      const novos: ConfigGravada = { prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: { ...c.dadosModelos } };
      const atual = await banco.lerConfigChatwoot(id);
      if (!atual) {
        await banco.gravarConfigChatwoot(id, novos, true);
        return ['configuração do CRM gravada (sem caixas: a unidade só passa a valer depois de «registrar-caixa»)'];
      }
      const { dadosModelos: dm, ...resto } = novos;
      const simples = aGravar(atual as unknown as Record<string, unknown>, resto as unknown as Record<string, unknown>, !!o.sobrescrever);
      const dados = dadosDosModelosAGravar(atual.dadosModelos, dm, !!o.sobrescrever);
      const parcial: Partial<ConfigGravada> = { ...(simples.gravar as Partial<ConfigGravada>), ...(Object.keys(dados.gravar).length ? { dadosModelos: dados.mesclado } : {}) };
      if (Object.keys(parcial).length) await banco.gravarConfigChatwoot(id, parcial, false);
      const ficaram = [...simples.preservados, ...dados.preservados.map((k) => `dadosModelos.${k}`)];
      return [
        Object.keys(parcial).length ? `configuração já existia: preenchi ${Object.keys(parcial).join(', ')}` : 'configuração já existia e não tinha campo vazio a preencher',
        ...(ficaram.length ? [`ficaram como estão (já preenchidos, diferem do questionário; --sobrescrever troca): ${ficaram.join(', ')}`] : []),
      ];
    }
    case 'automacoes-seco': {
      const id = unitIdAtual() ?? (await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, {})).id;
      definirUnitId(id);
      const ja = new Set(await banco.automacoesDaUnidade(id));
      const novas = AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco && !ja.has(a.id)).map((a) => a.id);
      if (novas.length) await banco.criarAutomacoesEmSeco(id, novas);
      return [novas.length ? `em seco: ${novas.join(', ')}` : 'nenhuma a criar'];
    }
    case 'sofia': {
      const id = unitIdAtual() ?? (await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, {})).id;
      definirUnitId(id);
      const { campos, avisos } = camposDaSofia(q, o.molde);
      const hoje = await banco.sofiaDaUnidade(id);
      const notas = [...avisos];
      if (typeof campos.systemPrompt === 'string' && typeof hoje.systemPrompt === 'string' && hoje.systemPrompt.trim() && hoje.systemPrompt !== campos.systemPrompt && !o.sobrescreverPrompt && !o.sobrescrever) {
        delete campos.systemPrompt;
        notas.push('a unidade JÁ tem systemPrompt diferente: não sobrescrevi (use --sobrescrever-prompt depois de ler o diff)');
      }
      // persona e fontes: só o que está VAZIO (a equipe pode ter editado; um número ou frase trocada muda o que a Sofia diz)
      const { gravar, preservados } = aGravar(hoje, campos, !!o.sobrescrever);
      if (typeof campos.systemPrompt === 'string' && o.sobrescreverPrompt && !('systemPrompt' in gravar)) gravar.systemPrompt = campos.systemPrompt;
      if (Object.keys(gravar).length) await banco.gravarSofia(id, gravar);
      notas.push(Object.keys(gravar).length ? `gravados: ${Object.keys(gravar).join(', ')}` : 'nada a gravar (tudo já preenchido)');
      const ficaram = preservados.filter((k) => k !== 'systemPrompt');
      if (ficaram.length) notas.push(`ficaram como estão (já preenchidos, diferem do questionário; --sobrescrever troca): ${ficaram.join(', ')}`);
      return notas;
    }
    default:
      throw new Error(`passo sem executor: ${p.id}`);
  }
}

/** O relatório do que a execução fez e do que ainda falta. */
export function relatorioFinal(plano: Plano, resultados: Resultado[]): string {
  const l: string[] = ['', 'RELATÓRIO FINAL', ''];
  const rotulo: Record<SituacaoDoPasso, string> = { feito: 'feito', 'nada-a-fazer': 'já estava', recusado: 'RECUSADO (não rodei)', esqueleto: 'PENDENTE (esqueleto, Fase 2)', manual: 'MANUAL', bloqueado: 'BLOQUEADO', falhou: 'FALHOU' };
  for (const r of resultados) l.push(`  ${r.id.padEnd(18)} ${rotulo[r.situacao]}`);
  const naoRodou = plano.passos.filter((p) => !resultados.some((r) => r.id === p.id));
  for (const p of naoRodou) l.push(`  ${p.id.padEnd(18)} NÃO RODOU (execução parou antes)`);
  l.push('', 'O QUE FALTA:');
  plano.relatorio.forEach((x, i) => l.push(`  ${i + 1}. ${x}`));
  return l.join('\n');
}
