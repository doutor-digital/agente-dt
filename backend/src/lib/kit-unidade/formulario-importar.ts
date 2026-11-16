/**
 * Importar um formulário já recebido para o kit: achar o formulário (por código, id ou slug), conferir colisões com unidades que já existem e gerar o
 * questionário privado. Tudo por PORTAS (`BancoFormularios`), então o teste não precisa de banco.
 */
import { hashDoCodigo, FORMATO_DO_CODIGO } from './convites.js';
import { RespostasFormulario } from './formulario.js';
import { paraYaml, prefixoDeModelos, questionarioDoFormulario, type Ajustes, type QuestionarioGerado } from './formulario-para-questionario.js';

export interface FormularioRecebido {
  id: string;
  enviadoEm: Date | null;
  importadoEm: Date | null;
  slugSugerido: string | null;
  respostas: unknown;
}

export interface BancoFormularios {
  /** formulários cujo código (hash), id ou slug sugerido é `ref` — SÓ os já enviados */
  acharEnviados(ref: { hash: string; ref: string }): Promise<FormularioRecebido[]>;
  /** unidades (de outro slug) que já usam o subdomínio, o sufixo ou o prefixo de modelos */
  colisoes(d: { slug: string; subdominio: string; sufixo: string; prefixo: string }): Promise<string[]>;
  marcarImportado(id: string, agora: Date): Promise<void>;
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
  const colisoes = await banco.colisoes({ slug: gerado.slug, subdominio: gerado.subdominio, sufixo: gerado.sufixo, prefixo: String((gerado.objeto.whatsapp as { prefixo_modelos: string }).prefixo_modelos) });
  const linhas: string[] = [
    `Formulário ${f.id}${f.enviadoEm ? ` (recebido em ${f.enviadoEm.toISOString().slice(0, 10)})` : ''}, preenchido por ${r.data.quem.nome}${f.importadoEm ? ' — já foi importado antes (gero de novo, igual)' : ''}.`,
    `Clínica: ${r.data.clinica.nome} (${r.data.clinica.cidade}/${r.data.clinica.uf}) · slug ${gerado.slug} · subdomínio ${gerado.subdominio} · sufixo das chaves ${gerado.sufixo}`,
  ];
  if (colisoes.length) {
    linhas.push(...colisoes.map((c) => `COLISÃO: ${c}`), 'Nada foi gerado. Troque o nome com --set (unidade.slug, chatwoot.subdominio, whatsapp.prefixo_modelos ou sufixo) e rode de novo.');
    return { ok: false, linhas, gerado, formularioId: f.id };
  }
  const yaml = paraYaml(gerado.objeto, `Gerado do formulário ${f.id} (${agora.toISOString().slice(0, 10)}). DADO PESSOAL: fica em unidades/privado/ (modo 600), nunca no GitHub.\nSegredo nunca entra aqui: só os NOMES das variáveis.`);
  if (gerado.valido) linhas.push('Questionário COMPLETO: passa na validação do kit.');
  else linhas.push(`FALTA COMPLETAR (${gerado.pendencias.length}) — o que só o João/Suzanne sabem, ou o dono não soube dizer:`, ...gerado.pendencias.map((p) => `  PENDENTE ${p}`), 'Complete com --set caminho=valor (ex.: --set whatsapp.waba_id=123 --set whatsapp.kapso_phone_number_id=456) e rode de novo.');
  return { ok: true, linhas, yaml, gerado, formularioId: f.id };
}

export { prefixoDeModelos };
