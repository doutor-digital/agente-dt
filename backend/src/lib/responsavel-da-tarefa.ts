/**
 * Para quem vai a tarefa que o agente cria no Kommo.
 *
 * Medido em 26/10/2026 nas 22 contas: toda conta tem só dois usuários — "Doutor Digital" (o login da consultoria)
 * e o da clínica ("Doutor Hérnia Marabá", "Açailandia"…). E 90–100% dos leads novos nascem com o Doutor Digital
 * de responsável (só a Açailândia distribui para a clínica). Como as tarefas seguem o responsável do lead, o
 * LIGAR AGORA de sinal de alerta caía no login do João e a SDR não via (Marabá, lead 29029780, tarefa 2484344).
 *
 * Regra (decisão do João, 26/10: "vai para quem está com o lead"): tarefa sem dono ou do Doutor Digital vai para
 * o usuário da clínica — mas só quando ele é UM só. Conta com mais gente fica como pedido: não adivinhamos a SDR.
 */

export type UsuarioKommo = { id: number; name: string; rights?: { is_active?: boolean } };

const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const ehDaConsultoria = (u: UsuarioKommo): boolean => normalizar(u.name) === 'doutor digital';

export function responsavelDaTarefa(usuarios: UsuarioKommo[], pedido?: number): number | undefined {
  const ativos = usuarios.filter((u) => u.rights?.is_active !== false);
  const consultoria = new Set(ativos.filter(ehDaConsultoria).map((u) => u.id));
  const clinica = ativos.filter((u) => !consultoria.has(u.id));
  if (clinica.length !== 1) return pedido;
  if (pedido === undefined || consultoria.has(pedido)) return clinica[0].id;
  return pedido;
}
