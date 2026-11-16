/**
 * Gera o QUESTIONÁRIO PRIVADO de uma clínica a partir do formulário que o franqueado preencheu (`--do-formulario` do kit). Roda DENTRO do contêiner do agente
 * (é lá que está o banco); o `ops/kit-unidade/do-formulario-joao.sh` chama e leva o arquivo para `unidades/privado/` da VPS (modo 600).
 *
 *   node dist/scripts/do-formulario.js <codigo|id|slug> --so-conferir                       # lê o banco, mostra o que falta; não grava nada
 *   node dist/scripts/do-formulario.js <codigo|id|slug> --saida <pasta> [--set k=v]...       # grava <pasta>/<slug>.yaml (modo 600); NÃO marca importado
 *   node dist/scripts/do-formulario.js <codigo|id|slug> --marcar-importado                    # o script do host chama depois de o arquivo chegar em unidades/privado/
 *
 * Imprime só linhas sem dado pessoal (nome da clínica, da cidade, de quem preencheu; campos que faltam) e UMA linha de máquina para o script do host:
 *   KIT_RESUMO slug=<slug> subdominio=<sub> sufixo=<SUF> modo=real valido=<sim|nao> ia=<sim|nao>
 * O conteúdo do questionário (e-mails, Pix, telefone) NUNCA é impresso.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDoCodigo } from '../lib/kit-unidade/convites.js';
import { escolherFormulario, importarFormulario, type BancoFormularios } from '../lib/kit-unidade/formulario-importar.js';
import { lerAjustes } from '../lib/kit-unidade/formulario-para-questionario.js';

export interface SaidaDoScript {
  linhas: string[];
  codigo: number;
}

/** O núcleo, testável: recebe o banco e uma função de gravação; devolve o que imprimir e o código de saída. */
export async function executar(args: string[], banco: BancoFormularios, gravar: (pasta: string, slug: string, yaml: string) => void, agora: Date = new Date()): Promise<SaidaDoScript> {
  const posicionais: string[] = [];
  const sets: string[] = [];
  let saida: string | undefined;
  let soConferir = false;
  let soMarcar = false;
  let soPosicionais = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // `--` encerra as opções: o que vem depois é o formulário, mesmo que comece com «-» (um código do link pode)
    if (soPosicionais) posicionais.push(a);
    else if (a === '--') soPosicionais = true;
    else if (a === '--so-conferir') soConferir = true;
    else if (a === '--marcar-importado') soMarcar = true;
    else if (a === '--saida') saida = args[++i];
    else if (a === '--set') sets.push(args[++i] ?? '');
    else if (a.startsWith('--')) return { linhas: [`argumento desconhecido: ${a}`], codigo: 2 };
    else posicionais.push(a);
  }
  if (posicionais.length !== 1) return { linhas: ['uso: do-formulario <codigo|id|slug> [--so-conferir | --saida <pasta>] [--set caminho=valor]...'], codigo: 2 };
  if (soMarcar) {
    // chamado pelo script do host DEPOIS de o questionário chegar em unidades/privado/: só então o formulário conta como importado
    const c = await banco.acharEnviados({ hash: /^[A-Za-z0-9_-]{24}$/.test(posicionais[0]!) ? hashDoCodigo(posicionais[0]!) : '', ref: posicionais[0]! });
    const e = escolherFormulario(posicionais[0]!, c);
    if (!e.ok) return { linhas: [e.erro], codigo: 1 };
    await banco.marcarImportado(e.formulario.id, agora);
    return { linhas: [`Formulário ${e.formulario.id} marcado como importado.`], codigo: 0 };
  }
  if (!soConferir && !saida) return { linhas: ['falta --saida <pasta> (ou use --so-conferir)'], codigo: 2 };
  const aj = lerAjustes(sets);
  if (!aj.ok) return { linhas: [aj.erro], codigo: 2 };

  const r = await importarFormulario(banco, posicionais[0]!, aj.ajustes, agora);
  const linhas = [...r.linhas];
  if (!r.ok || !r.yaml || !r.gerado) return { linhas, codigo: 1 };
  const g = r.gerado;
  if (soConferir) {
    linhas.push('SÓ CONFERIR: nada foi gravado.');
  } else {
    gravar(saida!, g.slug, r.yaml);
    linhas.push(`Questionário gerado: ${g.slug}.yaml (modo 600; o conteúdo não é impresso).`);
  }
  linhas.push(`KIT_RESUMO slug=${g.slug} subdominio=${g.subdominio} sufixo=${g.sufixo} modo=${g.modo} valido=${g.valido ? 'sim' : 'nao'} ia=${(g.objeto.assistente as { quer?: boolean } | undefined)?.quer === false ? 'nao' : 'sim'}`);
  return { linhas, codigo: 0 };
}

/** Grava com modo 600 numa pasta 700 (dado pessoal: só o dono lê). */
export function gravarPrivado(pasta: string, slug: string, yaml: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) throw new Error('slug inválido');
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  chmodSync(pasta, 0o700);
  const arquivo = join(pasta, `${slug}.yaml`);
  writeFileSync(arquivo, yaml, { mode: 0o600 });
  chmodSync(arquivo, 0o600);
}

async function main(): Promise<void> {
  const { bancoFormulariosPrisma } = await import('../lib/kit-unidade/formulario-importar-prisma.js');
  const { prisma } = await import('../lib/prisma.js');
  try {
    const r = await executar(process.argv.slice(2), bancoFormulariosPrisma, gravarPrivado);
    for (const l of r.linhas) console.log(l);
    process.exitCode = r.codigo;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
