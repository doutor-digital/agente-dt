/**
 * Retroativo do `nome-no-contato`: nos cartões em que a IA JÁ confirmou o nome, copia o nome para o
 * contato do Kommo — é de lá que sai o "Olá, {{contact.name}}" dos modelos do WhatsApp.
 *
 * Por que existe (19/10/2026, Canaã): até hoje a Sofia gravava o nome só no TÍTULO. Daqui pra frente a
 * ferramenta grava também no contato (`lib/nome-no-contato.ts`); isto aqui é o passado.
 *
 * DE ONDE VEM O NOME: só do passo "Título do lead … atualizado" / "Título já está como …" que a
 * FERRAMENTA `atualizar_titulo_lead` deixa no trace. A rede de segurança ("[safety-net] …") fica de fora
 * — foi ela que gravou "Obg", "Mas", "Unable".
 *
 * O QUE PULA:
 *   - cartão cujo título mudou depois (a equipe corrigiu: o nome da IA não vale mais);
 *   - conversa com sinal de que o nome é de OUTRA pessoa ("seu esposo", "pra minha mãe"): as chamadas
 *     antigas não traziam `nomeDeOutraPessoa`, então aqui vale a desconfiança;
 *   - nome que o paciente não ESCREVEU em nenhuma mensagem (veio de áudio ou a IA leu errado: o
 *     28320108 ficou "Lamanadion" no título e o paciente digitou "Dionizio");
 *   - contato que já tem o nome ou uma versão mais completa (mesma regra de `decidirNomeDoContato`).
 *
 * Simula por padrão. Só grava com --aplicar. Usa os traces de TODAS as unidades do mesmo Kommo
 * (Canaã tem a comercial e a de resgate na mesma conta).
 *
 *   node dist/scripts/nome-no-contato-retroativo.js --unidade=doutor-hernia-canaa --dias=14
 *   node dist/scripts/nome-no-contato-retroativo.js --unidade=doutor-hernia-canaa --dias=14 --aplicar
 */
import { prisma } from '../lib/prisma.js';
import { createKommoClient } from '../services/kommo.service.js';
import { decidirNomeDoContato } from '../lib/nome-no-contato.js';
import { addChangeLog } from '../services/change-log.service.js';

const APLICAR = process.argv.includes('--aplicar');
const arg = (nome: string) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=')[1] ?? '';
const SLUG = arg('unidade');
const DIAS = Number(arg('dias')) || 14;

/** "Flávio 07/10/2026" → "Flávio" */
const semData = (titulo: string) => titulo.replace(/\s+\d{2}\/\d{2}\/\d{4}\s*$/, '').trim();
const chave = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** A Sofia ou o paciente falando de terceiro: "é o seu esposo que está sentindo", "marcar pra minha mãe". */
const OUTRA_PESSOA =
  /\b(?:seu|sua|meu|minha|pro meu|pra minha|para o meu|para a minha)\s+(?:esposo|esposa|marido|mulher|filho|filha|m[ãa]e|pai|irm[ãa]o?|av[óô]|neto|neta|sogr[oa]|ti[oa])\b|\b(?:pra|para) (?:ele|ela)\b/i;

async function main() {
  if (!SLUG) throw new Error('falta --unidade=<slug>');
  const unit = await prisma.unit.findUnique({ where: { slug: SLUG } });
  if (!unit) throw new Error(`unidade ${SLUG} não existe`);
  const mesmaConta = await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } });
  const desde = new Date(Date.now() - DIAS * 86_400_000);

  const passos = await prisma.executionStep.findMany({
    where: {
      kind: 'KOMMO_ACTION',
      createdAt: { gte: desde },
      OR: [{ title: { startsWith: 'Título do lead ' } }, { title: { startsWith: 'Título já está como' } }],
      trace: { unitId: { in: mesmaConta.map((u) => u.id) } },
    },
    select: { payload: true, createdAt: true, trace: { select: { leadId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  // o último nome confirmado por cartão
  const nomePorLead = new Map<number, string>();
  for (const p of passos) {
    const desejado = (p.payload as { desired?: string } | null)?.desired;
    const leadId = Number(p.trace.leadId);
    if (typeof desejado === 'string' && Number.isFinite(leadId)) nomePorLead.set(leadId, semData(desejado));
  }

  const kommo = createKommoClient(unit);
  const cont = { gravar: 0, manteve: 0, titulo: 0, naoEscreveu: 0, outra: 0, semContato: 0, erro: 0 };
  const gravados: string[] = [];
  for (const [leadId, nome] of nomePorLead) {
    try {
      const lead = await kommo.getLead(leadId);
      if (chave(semData(lead.name ?? '')) !== chave(nome)) {
        cont.titulo++;
        console.log(`pula   ${leadId}  título agora é "${lead.name}" (IA tinha posto "${nome}")`);
        continue;
      }
      const conversas = await prisma.conversation.findMany({
        where: { leadId: String(leadId), unitId: { in: mesmaConta.map((u) => u.id) } },
        select: { messages: { select: { content: true, role: true } } },
      });
      const doPaciente = chave(conversas.flatMap((c) => c.messages).filter((m) => m.role === 'user').map((m) => m.content).join(' '));
      if (!chave(nome).split(' ').every((t) => new RegExp(`(^|[^a-z])${t}($|[^a-z])`).test(doPaciente))) {
        cont.naoEscreveu++;
        console.log(`pula   ${leadId}  "${nome}" não aparece no que o paciente escreveu`);
        continue;
      }
      // "Marcio Nunes +55 94 9135-0042" / "Meu amor ❤️ Paulo +55 94 99115-4449": nome com telefone costuma ser
      // alguém passando o contato de OUTRA pessoa
      const comTelefone = conversas
        .flatMap((c) => c.messages)
        .find((m) => m.role === 'user' && /\+?\b55\s?\(?\d{2}\)?\s?9?\d{4}/.test(m.content) && chave(m.content).includes(chave(nome).split(' ')[0]));
      const terceiro = comTelefone ?? conversas.flatMap((c) => c.messages).find((m) => OUTRA_PESSOA.test(m.content));
      if (terceiro) {
        cont.outra++;
        console.log(`pula   ${leadId}  "${nome}" pode ser de outra pessoa: …${terceiro.content.match(OUTRA_PESSOA)?.[0] ?? terceiro.content.slice(0, 40)}…`);
        continue;
      }
      const contatos = lead._embedded?.contacts ?? [];
      const contatoId = (contatos.find((c) => c.is_main) ?? contatos[0])?.id;
      if (!contatoId) {
        cont.semContato++;
        continue;
      }
      const atual = await kommo.getContactNome(contatoId);
      const d = decidirNomeDoContato(atual, nome);
      if (!d.gravar) {
        cont.manteve++;
        console.log(`mantém ${leadId}  contato ${contatoId}: ${d.motivo}`);
        continue;
      }
      cont.gravar++;
      console.log(`${APLICAR ? 'GRAVA ' : 'gravaria'} ${leadId}  contato ${contatoId}: "${atual}" → "${d.nome}"`);
      if (APLICAR) {
        await kommo.updateContactName(contatoId, d.nome);
        gravados.push(`${leadId}: "${atual}" → "${d.nome}"`);
      }
    } catch (err) {
      cont.erro++;
      console.log(`ERRO   ${leadId}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${nomePorLead.size} cartões com nome confirmado pela IA em ${DIAS} dias:`, cont, APLICAR ? '(GRAVADO)' : '(simulação)');
  if (APLICAR && gravados.length > 0) {
    await addChangeLog(unit.id, {
      category: 'kommo',
      summary: `Nome confirmado pela IA copiado para o contato em ${gravados.length} cartões (retroativo de ${DIAS} dias)`,
      details: gravados.join('\n'),
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
