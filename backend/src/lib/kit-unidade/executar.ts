/**
 * Executa o plano (`--aplicar`), ETAPA POR ETAPA e com confirmação: banco (fase 1) e, na fase 2, o Chatwoot (conta, etiquetas, atributos,
 * automações, caixa, time, atendentes, robô, webhook, aba do Funil) e os modelos na Meta via Kapso (`fase2.ts`). O que não dá para automatizar
 * (número, subdomínio, segredos da VPS, franquia, pastas) fica MANUAL e vai para o relatório. Nada de segredo passa por aqui.
 *
 * Idempotente: rodar de novo recalcula o plano com o estado atual e só mexe no que falta. Portas injetáveis (teste não toca em banco).
 */
import { MAX_REGRAS_DA_UNIDADE } from '../aprendizados-unidade.js';
import { AUTOMACOES } from '../automacoes.js';
import { gerenteDaConta, novoEstado, passoAtendentes, passoAutomacoesDaConta, passoAtributos, passoCaixa, passoConta, passoDashboardApp, passoEtiquetas, passoMensagensProntas, passoModelos, passoRobo, passoTime, passoUsuarioCelular, passoWebhook, type EstadoDaExecucao } from './fase2.js';
import { ErroSoLeitura, type PortasExternas } from './portas.js';
import { CAMPOS_SO_NA_CRIACAO, camposDaSofia, camposDaUnidade, licoesDaAssistente } from './molde-sofia.js';
import { aGravar, dadosDosModelosAGravar } from './protecao.js';
import { automacoesEmSeco, conflitoDoSoCrm, type Passo, type Plano } from './plano.js';
import { configChatwootDoQuestionario, type Questionario } from './questionario.js';

/** O banco, como o executor o enxerga. A implementação real (prisma) está em `scripts/nova-unidade.ts`. */
export interface ConfigGravada {
  prefixoModelos: string;
  metaAgendamentosDia: number | null;
  kapsoPhoneNumberId: string | null;
  wabaId: string | null;
  envSufixo: string;
  dadosModelos: Record<string, unknown>;
  /** a conta do Chatwoot da clínica (null = ainda não criada, ou a do ambiente) */
  contaId?: number | null;
  /** subdomínio do CRM da clínica: a origem que as telas por iframe aceitam */
  subdominio?: string | null;
  gerenteId?: number | null;
  usuarioCelularId?: number | null;
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
  /** aprendizados (regras) da unidade: `listar` devolve os textos que já existem; `criar` grava novos com fonte «unidade». Opcional: sem isto o passo avisa e não grava aprendizados */
  licoes?: {
    listar(unitId: string): Promise<string[]>;
    criar(unitId: string, textos: string[]): Promise<void>;
    /** quantas regras da clínica (fonte «unidade») estão LIGADAS: a página /aprendizados aceita no máximo 25 */
    contarDaUnidade(unitId: string): Promise<number>;
    /** marca em units.kit_aprendizados_em que o kit já importou: depois disso nunca regrava */
    marcarImportado(unitId: string): Promise<void>;
  };
  /** ids das caixas já registradas para a unidade */
  caixasRegistradas(unitId: string): Promise<number[]>;
  /** registra a caixa (idempotente: a mesma caixa não duplica) */
  registrarCaixa(unitId: string, caixa: { id: number; tipo: 'cloud' | 'evolution' | 'historico' }): Promise<void>;
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
  /** `--so-crm`: a unidade já existe (pode estar ATIVA) e o kit monta SÓ o CRM dela; a linha de `units` e a Sofia dela não são escritas. Não combina com `sobrescrever`. */
  soCrm?: boolean;
  /** repete a importação dos aprendizados da clínica (sem duplicar). Flag PRÓPRIA: `sobrescrever` NÃO mexe nos aprendizados que a clínica já administra em /aprendizados. */
  reimportarAprendizados?: boolean;
  /** escreve uma linha para quem está acompanhando */
  dizer: (linha: string) => void;
  /** as portas do Chatwoot, do Kapso e do cofre; sem elas os passos de fora do banco ficam bloqueados */
  externas?: PortasExternas | null;
  /** liga o robô Sofia na caixa (só depois do teste da Sofia) */
  ligarRobo?: boolean;
}

export type SituacaoDoPasso = 'feito' | 'nada-a-fazer' | 'recusado' | 'esqueleto' | 'manual' | 'bloqueado' | 'falhou';

/** Passos de fora do banco que o executor roda (e que, quando o plano diz «nada», rodam só para LER o que existe e passar os ids adiante). */
const PASSOS_EXTERNOS = new Set(['conta', 'etiquetas', 'atributos', 'automacoes-conta', 'mensagens-prontas', 'caixa', 'time', 'atendentes', 'usuario-celular', 'webhook', 'dashboard-app', 'robo-sofia', 'modelos']);

export interface Resultado {
  id: string;
  situacao: SituacaoDoPasso;
  notas: string[];
}

export async function executarPlano(plano: Plano, q: Questionario, o: OpcoesDeExecucao): Promise<Resultado[]> {
  const conflito = conflitoDoSoCrm(o);
  if (conflito) throw new Error(conflito);
  const resultados: Resultado[] = [];
  const deu = new Map<string, SituacaoDoPasso>();
  let unitId: string | null = null;
  const execucao = novoEstado();
  for (const p of plano.passos) {
    const registrar = (situacao: SituacaoDoPasso, notas: string[] = []) => {
      resultados.push({ id: p.id, situacao, notas });
      deu.set(p.id, situacao);
      o.dizer(`  → ${p.id}: ${situacao}${notas.length ? ` — ${notas.join(' | ')}` : ''}`);
    };
    o.dizer(`\n[${p.sistema}] ${p.titulo}`);
    // passo de Chatwoot que o plano deu como «nada»: roda sem perguntar só para achar os ids que os seguintes precisam (não cria nada: já existe)
    const soLer = p.acao === 'nada' && p.sistema === 'chatwoot' && PASSOS_EXTERNOS.has(p.id) && !!o.externas;
    if (p.acao === 'nada' && !soLer) {
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
      // o «nada» do plano só vale para quem NÃO rodou; passo que rodou e foi recusado, bloqueado ou falhou (inclusive na leitura) trava os que dependem dele
      return !(s === 'feito' || s === 'nada-a-fazer' || (s === undefined && passo?.acao === 'nada'));
    });
    if (travado.length && (p.execucao === 'sim' || soLer)) {
      registrar('bloqueado', [`depende de: ${travado.join(', ')}`]);
      continue;
    }
    if (p.execucao === 'manual') {
      registrar('manual', p.itens);
      continue;
    }
    if (p.execucao === 'esqueleto') {
      registrar('esqueleto', ['não implementado (depende de API externa) — está no relatório final']);
      continue;
    }
    if (PASSOS_EXTERNOS.has(p.id) && !o.externas) {
      registrar('bloqueado', ['sem acesso ao Chatwoot/Kapso neste ambiente (CHATWOOT_URL, CHATWOOT_API_TOKEN ou o cofre KIT_SEGREDOS_DIR faltando)']);
      continue;
    }
    let leu = false;
    if (soLer) {
      // tenta SÓ LENDO; se o passo precisar escrever (o plano achava que estava pronto, mas não está), cai no caminho normal: pergunta e roda
      try {
        execucao.somenteLeitura = true;
        const notas = await aplicarPasso(p, q, o, () => unitId, (id) => (unitId = id), execucao);
        registrar('nada-a-fazer', notas);
        leu = true;
      } catch (err) {
        if (!(err instanceof ErroSoLeitura)) {
          registrar('falhou', [String((err as Error).message ?? err)]);
          o.dizer('  (parei aqui: nada depois deste passo roda)');
          break;
        }
        o.dizer(`  (o plano achava que «${p.id}» estava pronto, mas falta algo: ${err.o_que})`);
      } finally {
        execucao.somenteLeitura = false;
      }
    }
    if (leu) continue;
    // o texto EXATO que vai para a Sofia (fonte «negócio» e aprendizados) aparece ANTES de a etapa ser confirmada: o João lê, não confia
    if (p.id === 'sofia') for (const it of p.itens) o.dizer(`      · ${it}`);
    if (!(await o.confirmar(p))) {
      registrar('recusado');
      continue;
    }
    try {
      const notas = await aplicarPasso(p, q, o, () => unitId, (id) => (unitId = id), execucao);
      registrar('feito', notas);
    } catch (err) {
      registrar('falhou', [String((err as Error).message ?? err)]);
      o.dizer('  (parei aqui: nada depois deste passo roda)');
      break;
    }
  }
  return resultados;
}

async function aplicarPasso(p: Passo, q: Questionario, o: OpcoesDeExecucao, unitIdAtual: () => string | null, definirUnitId: (id: string) => void, execucao: EstadoDaExecucao): Promise<string[]> {
  const { banco } = o;
  const x = o.externas as PortasExternas;
  const garantirUnidade = async (): Promise<string> => {
    // --so-crm nunca cria a unidade (nem vazia): ela tem de existir
    const achada = unitIdAtual() ?? (await banco.lerUnidade(q.unidade.slug))?.id;
    if (!achada && o.soCrm) throw new Error(`a unidade ${q.unidade.slug} não existe: --so-crm só vale para unidade que já existe`);
    const id = achada ?? (await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, {})).id;
    definirUnitId(id);
    return id;
  };
  switch (p.id) {
    case 'unidade': {
      const atual = await banco.lerUnidade(q.unidade.slug);
      if (o.soCrm) {
        if (!atual) throw new Error(`a unidade ${q.unidade.slug} não existe: --so-crm só vale para unidade que já existe`);
        definirUnitId(atual.id);
        return [`--so-crm: unidade ${atual.id}${atual.ativa ? ' (ATIVA)' : ''} só lida; nenhum campo de units foi escrito`];
      }
      if (atual?.ativa && !o.sobrescrever) throw new Error(`a unidade ${q.unidade.slug} já está ATIVA: o script não mexe numa unidade no ar sem --sobrescrever`);
      const novos = camposDaUnidade(q);
      const { gravar, preservados } = atual ? aGravar(atual.campos, novos, !!o.sobrescrever) : { gravar: novos, preservados: [] as string[] };
      // unidade que existe e não tem campo vazio a preencher: nem chama o banco (segunda rodada não escreve nada)
      const r = atual && !Object.keys(gravar).length ? { id: atual.id, criada: false } : await banco.gravarUnidade(q.unidade.slug, q.unidade.nome, gravar, CAMPOS_SO_NA_CRIACAO);
      definirUnitId(r.id);
      return [
        r.criada ? `unidade criada (inativa): ${r.id}` : `unidade já existia (${r.id}): preenchi ${Object.keys(gravar).length} campo(s) vazio(s)${Object.keys(gravar).length ? `: ${Object.keys(gravar).join(', ')}` : ''}`,
        ...(preservados.length ? [`ficaram como estão (já preenchidos, diferem do questionário; --sobrescrever troca): ${preservados.join(', ')}`] : []),
      ];
    }
    case 'config-chatwoot': {
      const id = await garantirUnidade();
      const c = configChatwootDoQuestionario(q);
      const novos: ConfigGravada = { subdominio: c.subdominio ?? null, prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: { ...c.dadosModelos } };
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
      const id = await garantirUnidade();
      const ja = new Set(await banco.automacoesDaUnidade(id));
      const novas = automacoesEmSeco(q).filter((a) => !ja.has(a.id)).map((a) => a.id);
      if (novas.length) await banco.criarAutomacoesEmSeco(id, novas);
      return [novas.length ? `em seco: ${novas.join(', ')}` : 'nenhuma a criar'];
    }
    case 'sofia': {
      if (o.soCrm) return ['--so-crm: a Sofia da unidade (persona, fontes, prompt e aprendizados) não foi tocada'];
      if (q.assistente?.quer === false) return ['a clínica NÃO quer a assistente: Sofia não configurada (nada gravado)'];
      const id = await garantirUnidade();
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
      // aprendizados da clínica (idempotente: texto igual a um que já existe não duplica)
      const lic = licoesDaAssistente(q);
      for (const r of lic.recusadas) notas.push(`aprendizado RECUSADO pelas travas da rede (não gravei): «${r.texto}» — ${r.motivo}`);
      if (lic.textos.length) {
        const importadoEm = hoje.kitAprendizadosEm as Date | string | null | undefined;
        if (!banco.licoes) notas.push(`${lic.textos.length} aprendizado(s) da clínica NÃO gravados (este ambiente não tem a porta de aprendizados)`);
        else if (importadoEm && !o.reimportarAprendizados) {
          // UM escritor só: o kit grava os aprendizados uma vez; depois a clínica manda neles (edita, apaga, desliga em /aprendizados) e um --aplicar novo (ex.: --ligar-robo) não os desfaz
          notas.push(`aprendizados da clínica: o kit JÁ os importou em ${new Date(importadoEm).toISOString().slice(0, 10)}; não regravo (a clínica os administra em /aprendizados; --reimportar-aprendizados repete a importação, sem duplicar)`);
        } else {
          const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
          const jaTem = new Set((await banco.licoes.listar(id)).map(norm));
          const novos = lic.textos.filter((t) => !jaTem.has(norm(t)));
          // teto de 25 NA GRAVAÇÃO (não só no aviso do plano): a página /aprendizados só aceita 25 regras da clínica ligadas
          const cabem = Math.max(0, MAX_REGRAS_DA_UNIDADE - (await banco.licoes.contarDaUnidade(id)));
          const gravar = novos.slice(0, cabem);
          if (gravar.length) await banco.licoes.criar(id, gravar);
          await banco.licoes.marcarImportado(id);
          notas.push(`aprendizados da clínica: ${gravar.length} gravado(s), ${lic.textos.length - novos.length} já existiam${novos.length > gravar.length ? `, ${novos.length - gravar.length} NÃO gravado(s) por causa do teto de ${MAX_REGRAS_DA_UNIDADE} da página /aprendizados (a clínica desliga uma regra e os adiciona lá)` : ''}`);
        }
      }
      return notas;
    }
    case 'conta': {
      const unitId = await garantirUnidade();
      const cfg = await banco.lerConfigChatwoot(unitId);
      return passoConta(q, x, execucao, { contaId: cfg?.contaId ?? null, caixasRegistradas: await banco.caixasRegistradas(unitId), gravarContaId: (id) => banco.gravarConfigChatwoot(unitId, { contaId: id }, false) });
    }
    case 'etiquetas':
      return passoEtiquetas(x, execucao);
    case 'atributos':
      return passoAtributos(x, execucao);
    case 'automacoes-conta':
      return passoAutomacoesDaConta(x, execucao);
    case 'mensagens-prontas':
      return passoMensagensProntas(q, execucao);
    case 'caixa':
      return passoCaixa(q, x, execucao);
    case 'time':
      return passoTime(q, execucao);
    case 'atendentes':
      return passoAtendentes(q, execucao);
    case 'usuario-celular':
      return passoUsuarioCelular(q, execucao);
    case 'registrar-caixa': {
      const unitId = await garantirUnidade();
      const caixa = execucao.caixaId;
      if (!caixa) throw new Error('a caixa ainda não existe (passo «caixa»)');
      const ja = await banco.caixasRegistradas(unitId);
      if (!ja.includes(caixa)) await banco.registrarCaixa(unitId, { id: caixa, tipo: 'cloud' });
      // gerente e usuário do celular: só se ainda não estão gravados (nunca troco um que a equipe já definiu)
      const cfg = await banco.lerConfigChatwoot(unitId);
      const parcial: Partial<ConfigGravada> = {};
      const gerente = gerenteDaConta(q, execucao);
      if (gerente && (cfg?.gerenteId == null || o.sobrescrever)) parcial.gerenteId = gerente;
      if (execucao.celularId && (cfg?.usuarioCelularId == null || o.sobrescrever)) parcial.usuarioCelularId = execucao.celularId;
      if (Object.keys(parcial).length) await banco.gravarConfigChatwoot(unitId, parcial, false);
      return [ja.includes(caixa) ? `caixa ${caixa} já estava registrada` : `caixa ${caixa} registrada (tipo cloud)`, ...(q.whatsapp.modo === 'demonstracao' ? ['ATENÇÃO: a caixa da demonstração é canal API mas fica registrada como «cloud» (não existe tipo «api»): NÃO ligue as automações do Chatwoot nesta clínica — a régua tentaria mandar modelo por um canal que não é WhatsApp'] : []), Object.keys(parcial).length ? `gravei ${Object.keys(parcial).join(' e ')}` : 'gerente e usuário do celular já estavam gravados', 'a unidade passa a valer para o servidor quando ele relê a configuração (reinício do serviço)'];
    }
    case 'webhook':
      return passoWebhook(x, execucao);
    case 'dashboard-app':
      return passoDashboardApp(x, execucao);
    case 'robo-sofia':
      return passoRobo(q, x, execucao, !!o.ligarRobo);
    case 'modelos':
      return passoModelos(q, x);
    default:
      throw new Error(`passo sem executor: ${p.id}`);
  }
}

/**
 * O código de saída do `--aplicar`: 0 = nada de errado (feito, já estava ou manual); 1 = alguma etapa FALHOU; 3 = alguma etapa foi RECUSADA («não» na pergunta), ficou BLOQUEADA ou NÃO RODOU
 * (a execução parou antes): a clínica NÃO está pronta e quem encadeia o kit (abrir-clinica-joao.sh) não pode seguir para o proxy nem dizer «pronto».
 */
export function codigoDeSaida(plano: Plano, resultados: Resultado[]): number {
  if (resultados.some((r) => r.situacao === 'falhou')) return 1;
  const naoRodou = plano.passos.some((p) => !resultados.some((r) => r.id === p.id));
  if (naoRodou || resultados.some((r) => r.situacao === 'recusado' || r.situacao === 'bloqueado')) return 3;
  return 0;
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
