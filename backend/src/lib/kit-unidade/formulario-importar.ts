/**
 * Importar um formulário já recebido para o kit: achar o formulário (por código, id ou slug), conferir colisões com unidades que já existem e gerar o
 * questionário privado. Tudo por PORTAS (`BancoFormularios`), então o teste não precisa de banco.
 */
import { hashDoCodigo, FORMATO_DO_CODIGO } from './convites.js';
import { RespostasFormulario } from './formulario.js';
import { paraYaml, questionarioDoFormulario, type Ajustes, type QuestionarioGerado } from './formulario-para-questionario.js';

export interface FormularioRecebido {
  id: string;
  enviadoEm: Date | null;
  importadoEm: Date | null;
  slugSugerido: string | null;
  respostas: unknown;
}

export interface BancoFormularios {
  /** formulários cujo código (hash), id, slug sugerido ou os ÚLTIMOS 6 caracteres do id (a «Referência» que o dono vê) é `ref` — SÓ os já enviados */
  acharEnviados(ref: { hash: string; ref: string }): Promise<FormularioRecebido[]>;
  /**
   * O que já é de OUTRA unidade: subdomínio, prefixo de modelos e SUFIXO das variáveis (`bloqueios`: nada é gerado) e o que só merece confirmação (`avisos`: variáveis que já
   * existem no ambiente e podem ser desta mesma clínica, preparadas antes).
   */
  colisoes(d: { slug: string; nome: string; subdominio: string; sufixo: string; prefixo: string }): Promise<{ bloqueios: string[]; avisos: string[] }>;
  marcarImportado(id: string, agora: Date): Promise<void>;
}

const SUFIXO_DA_REGRA_ANTIGA = (slug: string): string => slug.replace(/^doutor-hernia-/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * As ~25 unidades do Kommo NÃO têm linha em `unit_chatwoot`: o sufixo das variáveis do rastreio delas sai do slug (`doutor-hernia-timbo` → `TIMBO`, a regra de
 * `sufixoEnvDaUnidade`). Uma 2ª clínica em Timbó herdaria META_ADS_TOKEN_TIMBO / META_DATASET_ID_TIMBO (eventos da Meta no dataset da outra): por isso o sufixo é conferido contra o
 * slug de TODAS as unidades e contra o ambiente (CHATWOOT_API_TOKEN_<SUF>: a conta de outra clínica).
 */
export function colisoesDoSufixo(d: { slug: string; sufixo: string; slugsExistentes: readonly string[]; unidadeExiste: boolean; env: Readonly<Record<string, string | undefined>> }): { bloqueios: string[]; avisos: string[] } {
  const bloqueios: string[] = [];
  const avisos: string[] = [];
  for (const outro of d.slugsExistentes) {
    if (outro !== d.slug && SUFIXO_DA_REGRA_ANTIGA(outro) === d.sufixo) bloqueios.push(`o sufixo das chaves «${d.sufixo}» já é da unidade ${outro} (META_ADS_TOKEN_${d.sufixo} e META_DATASET_ID_${d.sufixo} são dela)`);
  }
  // variável que o PRÓPRIO kit cria para esta clínica só conta como colisão quando a unidade ainda não existe (rodar de novo depois de criada é normal)
  if (!d.unidadeExiste && d.env[`CHATWOOT_API_TOKEN_${d.sufixo}`]?.trim()) bloqueios.push(`a variável CHATWOOT_API_TOKEN_${d.sufixo} já existe no ambiente e a unidade ${d.slug} ainda não foi criada: é a conta de OUTRA clínica`);
  for (const nome of ['META_ADS_TOKEN_', 'META_DATASET_ID_', 'META_ADS_CONTA_', 'FRANQUIA_TOKEN_']) {
    if (d.env[`${nome}${d.sufixo}`]?.trim()) avisos.push(`a variável ${nome}${d.sufixo} já existe no ambiente: confirme que é DESTA clínica (preparada antes), não de outra unidade`);
  }
  return { bloqueios, avisos };
}

export type Escolha = { ok: true; formulario: FormularioRecebido } | { ok: false; erro: string };

export function escolherFormulario(ref: string, candidatos: FormularioRecebido[]): Escolha {
  if (!candidatos.length) return { ok: false, erro: `Não achei formulário RECEBIDO para «${ref}» (confira o id com: convite-clinica-joao.sh --listar; um convite ainda não preenchido não conta).` };
  if (candidatos.length > 1) return { ok: false, erro: `Mais de um formulário recebido combina com «${ref}»: ${candidatos.map((c) => c.id).join(', ')}. Use o id do formulário.` };
  return { ok: true, formulario: candidatos[0]! };
}

export interface ResultadoDaImportacao {
  ok: boolean;
  /** linhas para mostrar ao João (sem dado pessoal) */
  linhas: string[];
  /** o YAML (com dado pessoal) — quem chama grava com modo 600 e NUNCA imprime */
  yaml?: string;
  gerado?: QuestionarioGerado;
  formularioId?: string;
}

export async function importarFormulario(banco: BancoFormularios, ref: string, ajustes: Ajustes, agora: Date = new Date()): Promise<ResultadoDaImportacao> {
  const candidatos = await banco.acharEnviados({ hash: FORMATO_DO_CODIGO.test(ref) ? hashDoCodigo(ref) : '', ref });
  const e = escolherFormulario(ref, candidatos);
  if (!e.ok) return { ok: false, linhas: [e.erro] };
  const f = e.formulario;
  const r = RespostasFormulario.safeParse(f.respostas);
  if (!r.success) return { ok: false, linhas: [`O formulário ${f.id} está gravado num formato que o kit não reconhece (versão antiga?). Peça para a pessoa preencher de novo.`], formularioId: f.id };

  const gerado = questionarioDoFormulario(r.data, ajustes);
  const colisaoBanco = await banco.colisoes({ slug: gerado.slug, nome: r.data.clinica.nome, subdominio: gerado.subdominio, sufixo: gerado.sufixo, prefixo: String((gerado.objeto.whatsapp as { prefixo_modelos: string }).prefixo_modelos) });
  const colisoes = colisaoBanco.bloqueios;
  const linhas: string[] = [
    // dado pessoal NUNCA é impresso: nem o nome de quem preencheu (só o id do formulário, o nome da clínica e a cidade)
    `Formulário ${f.id}${f.enviadoEm ? ` (recebido em ${f.enviadoEm.toISOString().slice(0, 10)})` : ''}${f.importadoEm ? ' — já foi importado antes (gero de novo, igual)' : ''}.`,
    `Clínica: ${r.data.clinica.nome} (${r.data.clinica.cidade}/${r.data.clinica.uf}) · slug ${gerado.slug} · subdomínio ${gerado.subdominio} · sufixo das chaves ${gerado.sufixo}`,
  ];
  if (colisoes.length) {
    linhas.push(...colisoes.map((c) => `COLISÃO: ${c}`), 'Nada foi gerado. Troque o nome com --set (unidade.slug, chatwoot.subdominio, whatsapp.prefixo_modelos ou sufixo) e rode de novo.');
    return { ok: false, linhas, gerado, formularioId: f.id };
  }
  linhas.push(...colisaoBanco.avisos.map((a) => `ATENÇÃO: ${a}`));
  const yaml = paraYaml(gerado.objeto, `Gerado do formulário ${f.id}. DADO PESSOAL: fica em unidades/privado/ (modo 600), nunca no GitHub.\nSegredo nunca entra aqui: só os NOMES das variáveis.`);
  const prefixo = String((gerado.objeto.whatsapp as { prefixo_modelos: string }).prefixo_modelos);
  linhas.push(`CONFIRME (o kit SUGERIU pelo nome da cidade e vira nome permanente — modelos da Meta, subdomínio, chaves): prefixo dos modelos «${prefixo}» · subdomínio «${gerado.subdominio}» · sufixo «${gerado.sufixo}» · caixa «${String((gerado.objeto.chatwoot as { caixa_nome: string }).caixa_nome)}». Troque com --set se não servir.`);
  if (gerado.valido) linhas.push('Questionário COMPLETO: passa na validação do kit.');
  else linhas.push(`FALTA COMPLETAR (${gerado.pendencias.length}) — o que só o João/Suzanne sabem, ou o dono não soube dizer:`, ...gerado.pendencias.map((p) => `  PENDENTE ${p}`), 'Complete com --set caminho=valor (ex.: --set whatsapp.waba_id=123 --set whatsapp.kapso_phone_number_id=456) e rode de novo.');
  return { ok: true, linhas, yaml, gerado, formularioId: f.id };
}

