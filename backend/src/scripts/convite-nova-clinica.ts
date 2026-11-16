/**
 * Convites do formulário «nova clínica». Roda DENTRO do contêiner do agente (é lá que estão o banco e o ambiente); o João chama pelo
 * `ops/kit-unidade/convite-clinica-joao.sh`, do computador dele.
 *
 *   node dist/scripts/convite-nova-clinica.js --rotulo "Dra. Fulana (Serra)" [--dias 14] [--por email]   # cria e imprime o link UMA vez
 *   node dist/scripts/convite-nova-clinica.js --listar                                                  # o que existe (sem códigos: eles não são guardados)
 *   node dist/scripts/convite-nova-clinica.js --revogar <id>                                            # encerra um convite que ainda não foi usado
 *
 * O link é o segredo: só o hash fica no banco, então o código NÃO pode ser reimpresso; perdeu, revogue e crie outro. `--por` precisa ser um
 * administrador da Doutor Digital (a mesma lista do kit: KIT_ADMINS_DD ou o padrão).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { criarConvite, DIAS_DE_VALIDADE, type BancoConvites } from '../lib/kit-unidade/convites.js';
import { ADMINS_DD_PADRAO, lerAdminsDD } from '../lib/kit-unidade/fase2.js';

const ORIGEM_PADRAO = 'https://agente.doutordigitalconsultoria.com';

export function origemPublica(env: NodeJS.ProcessEnv = process.env): string {
  try {
    if (env.MCP_URL_PUBLICA) return new URL(env.MCP_URL_PUBLICA).origin;
  } catch {
    /* cai no padrão */
  }
  return ORIGEM_PADRAO;
}

const quando = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

function valorDe(args: string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Roda um comando. Devolve o texto para imprimir e o código de saída (testável sem processo nem banco). */
export async function executar(args: string[], banco: BancoConvites, env: NodeJS.ProcessEnv = process.env, agora: Date = new Date()): Promise<{ saida: string[]; codigo: number }> {
  const conhecidos = new Set(['--rotulo', '--dias', '--por', '--listar', '--revogar']);
  for (const a of args) if (a.startsWith('--') && !conhecidos.has(a)) return { saida: [`argumento desconhecido: ${a}`], codigo: 2 };

  if (args.includes('--listar')) {
    const lista = await banco.listar();
    if (!lista.length) return { saida: ['Nenhum convite ainda.'], codigo: 0 };
    return {
      saida: lista.map((c) => {
        const estado = c.importadoEm ? 'importado no kit' : c.enviadoEm ? 'RECEBIDO (falta abrir a clínica)' : c.expiraEm.getTime() <= agora.getTime() ? 'vencido/revogado' : `aberto até ${quando(c.expiraEm)}`;
        return `${c.id}  ${estado}${c.rotulo ? `  · ${c.rotulo}` : ''}${c.slugSugerido ? `  · sugestão: ${c.slugSugerido}` : ''}`;
      }),
      codigo: 0,
    };
  }

  const revogar = valorDe(args, '--revogar');
  if (args.includes('--revogar')) {
    if (!revogar) return { saida: ['--revogar precisa do id do convite (veja --listar)'], codigo: 2 };
    const ok = await banco.revogar(revogar, agora);
    return { saida: [ok ? `Convite ${revogar} encerrado (nada foi apagado).` : `Não encerrei ${revogar}: não existe, já foi usado ou já venceu.`], codigo: ok ? 0 : 1 };
  }

  const por = valorDe(args, '--por');
  if (por) {
    const admins = lerAdminsDD(env.KIT_ADMINS_DD).lista.map((e) => e.toLowerCase());
    if (!admins.includes(por.toLowerCase())) return { saida: [`--por precisa ser um administrador da Doutor Digital (${ADMINS_DD_PADRAO.length ? 'a lista do kit: KIT_ADMINS_DD ou o padrão' : 'KIT_ADMINS_DD'}).`], codigo: 2 };
  }
  const diasTexto = valorDe(args, '--dias');
  const dias = diasTexto === undefined ? DIAS_DE_VALIDADE : Number(diasTexto);
  if (!Number.isInteger(dias) || dias < 1 || dias > 60) return { saida: ['--dias precisa ser um número inteiro de 1 a 60'], codigo: 2 };
  const rotulo = valorDe(args, '--rotulo');
  if (!rotulo?.trim()) return { saida: ['uso: --rotulo "para quem é" [--dias 14] [--por email]   |   --listar   |   --revogar <id>'], codigo: 2 };

  const c = await criarConvite(banco, { rotulo, criadoPor: por ?? 'script da VPS (root)', dias, agora });
  return {
    saida: [
      `Convite criado (id ${c.id}), para: ${rotulo.trim()}. Vale até ${quando(c.expiraEm)} e serve para UM envio.`,
      '',
      'Link para mandar à pessoa:',
      `  ${origemPublica(env)}/nova-clinica/${c.codigo}`,
      '',
      'O link é o segredo: mande só para ela, direto (WhatsApp). Não cole em grupo nem no chat do Claude. Ele aparece UMA vez; perdeu, revogue (--revogar) e crie outro.',
    ],
    codigo: 0,
  };
}

async function main(): Promise<void> {
  const { bancoConvitesPrisma } = await import('../lib/kit-unidade/convites-prisma.js');
  const { prisma } = await import('../lib/prisma.js');
  try {
    const r = await executar(process.argv.slice(2), bancoConvitesPrisma);
    for (const l of r.saida) console.log(l);
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
